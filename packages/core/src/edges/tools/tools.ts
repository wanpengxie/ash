/**
 * The tools an agent sees (SPEC-02 §3.2). Three groups:
 *
 *   fixed      each is one word under another name; its input schema IS the word's `input_schema` (plus the call
 *              envelope fields where the word may ask the owner, §3.3). Built from the contracts in sdk/words.ts, so a
 *              change to a word shows up here by itself; nothing is described twice.
 *   meta       capability_list / capability_describe / capability_call: the way to every other word.
 *   receipt    await_result / list_pending / cancel: the tool surface's own mechanism for calls that take long.
 */
import { glob } from "../../kernel/router";
import { mayCall, RESERVED_INPUT_NAMES, type JsonSchema, type WordContract } from "../../../../sdk/src/word";
import { WORD_CONTRACTS, wordContract } from "../../../../sdk/src/words";

/** How a fixed tool waits for its word. */
export type WaitMode =
  /** Answers at once; if it still takes over `maxWaitMs` the caller gets a receipt anyway. */
  | "sync"
  /** Up to `fastPathMs` (15 s), then a receipt. `wait: true` waits up to `maxWaitMs`, `wait: false` does not wait. */
  | "receipt"
  /** A question to the owner: the receipt comes as soon as the request is out, unless it fails right away. */
  | "ask";

export interface FixedTool {
  name: string;
  member: string;
  word: string;
  mode: WaitMode;
  /** The call may be put to the owner for approval: `approval_ttl_minutes` and `purpose` are accepted. */
  approval: boolean;
  /** `wait` is accepted (§3.3: only capability_call and agent_ask). */
  wait: boolean;
  /** With `wait` not given: wait as long as `wait: true` would (agent_ask: the answer is usually quick). */
  waitByDefault?: boolean;
  /** What the tool fills in so the word's own rules hold; never new meaning. */
  adapt?: (body: Record<string, unknown>, ctx: { now: number; ttlMinutes: number }) => Record<string, unknown>;
  description: string;
  contract: WordContract;
}

export const ENVELOPE_APPROVAL = ["approval_ttl_minutes", "purpose"] as const;
export const ENVELOPE_WAIT = "wait";
if (!RESERVED_INPUT_NAMES.every((name) => [...ENVELOPE_APPROVAL, ENVELOPE_WAIT].includes(name))) throw new Error("the call envelope changed in sdk/word.ts");

const APPROVAL_PROPERTIES: Record<string, JsonSchema> = {
  approval_ttl_minutes: { type: "integer", minimum: 1, maximum: 10080, description: "How long the owner's card stays open, in minutes; default 10, at most 7 days. Use 2-5 for steps that depend on the screen." },
  purpose: { type: "string", maxLength: 500, description: "Why this step is needed, shown to the owner on the card. It is a reason, never proof of authorization." },
};
const WAIT_PROPERTY: JsonSchema = { type: "boolean", description: "true: wait up to 50 s for the result; false: do not wait, return a receipt at once. Default: wait up to 15 s, then a receipt." };

// ---------------------------------------------------------------------------------------------------------------------
// the fixed tools: name -> word. Everything else about a tool comes from the word's contract.
// ---------------------------------------------------------------------------------------------------------------------

type Row = [name: string, member: string, word: string, mode: WaitMode, flags?: { approval?: boolean; wait?: boolean; waitByDefault?: boolean; adapt?: FixedTool["adapt"]; description?: string }];

/** `kind` is what the tool stands for when `human_kind` is left out; `expires_at` follows approval_ttl_minutes. Nothing else is filled in. */
const asking = (kind?: "confirmation"): FixedTool["adapt"] => (body, { now, ttlMinutes }) => ({
  ...body,
  ...(kind && body.human_kind === undefined ? { human_kind: kind } : {}),
  ...(body.expires_at === undefined ? { expires_at: now + ttlMinutes * 60_000 } : {}),
});

const FIXED_ROWS: Row[] = [
  ["human_say", "person:owner", "say", "sync"],
  ["human_show", "person:owner", "show", "sync"],
  ["human_ask", "person:owner", "ask", "ask", { approval: true, adapt: asking(),
    description: "Ask the owner a question with options to tap (human_kind question, the default). Returns a receipt at once: the answer comes back through await_result with the receipt's request_id. Only title and options are needed." }],
  ["human_confirm", "person:owner", "ask", "ask", { approval: true, adapt: asking("confirmation"),
    description: "Ask the owner for an explicit yes or no (the same word as human_ask with human_kind confirmation; without options the owner's side offers yes and no). Returns a receipt at once; the answer comes back through await_result with the receipt's request_id. Nothing is done by the confirmation itself." }],
  ["human_card_update", "person:owner", "card.update", "sync"],
  ["human_form", "person:owner", "form", "ask", { description: "Ask the owner to fill in a form card in the conversation (person:owner/form): all the fields you need in one card, password fields straight into the vault. Returns a receipt at once: the filled-in values (passwords only as {ref, masked}; use them as $vault.<ref>) come back through await_result with the receipt's request_id, or cancelled." }],
  ["human_pending", "service:gate", "pending.list", "sync"],
  ["human_pending_get", "service:gate", "pending.get", "sync"],
  ["human_pending_redeem", "service:gate", "pending.redeem", "receipt"],
  ["human_pending_skip", "service:gate", "pending.skip", "sync"],
  ["human_withdraw", "service:gate", "pending.withdraw", "sync"],
  ["timer_set", "service:clock", "set", "sync"],
  ["timer_list", "service:clock", "list", "sync"],
  ["timer_cancel", "service:clock", "cancel", "sync"],
  ["screen_lease_request", "service:gate", "lease.request", "sync"],
  ["screen_lease_status", "service:gate", "lease.status", "sync"],
  ["screen_lease_release", "service:gate", "lease.release", "sync"],
  ["approval_log", "service:gate", "audit", "sync"],
  ["approval_rules", "service:gate", "rules.list", "sync"],
  ["approval_rule_add", "service:gate", "rules.set", "receipt", { approval: true }],
  ["approval_rule_remove", "service:gate", "rules.revoke", "receipt", { approval: true }],
  ["approval_mode_set", "service:gate", "mode.set", "receipt", { approval: true }],
  ["agent_list", "service:agents", "list", "sync"],
  ["agent_runtimes", "service:agents", "runtimes", "sync"],
  ["agent_describe", "service:agents", "describe", "sync"],
  ["agent_tell", "service:agents", "tell", "sync"],
  ["agent_ask", "service:agents", "ask", "receipt", { wait: true, waitByDefault: true }],
  ["agent_create", "service:agents", "declare", "receipt"],
  ["agent_update", "service:agents", "update", "receipt"],
  ["agent_start", "service:agents", "start", "receipt"],
  ["agent_stop", "service:agents", "stop", "receipt"],
  ["agent_restart", "service:agents", "restart", "receipt"],
  ["agent_remove", "service:agents", "remove", "receipt"],
  ["vault_list", "service:vault", "list", "sync"],
  ["vault_describe", "service:vault", "describe", "sync"],
  ["history_query", "service:history", "query", "sync"],
  ["system_status", "service:admin", "status", "sync"],
];

function build(row: Row): FixedTool {
  const [name, member, word, mode, flags = {}] = row;
  const contract = wordContract(member, word);
  if (!contract) throw new Error(`tool ${name}: no word ${member}/${word} in sdk/words.ts`);
  if (contract.kind !== "request" || !mayCall(contract.callers, "agent")) throw new Error(`tool ${name}: ${member}/${word} is not a word an agent may call`);
  return { name, member, word, mode, approval: flags.approval ?? false, wait: flags.wait ?? false, ...(flags.waitByDefault ? { waitByDefault: true } : {}),
    ...(flags.adapt ? { adapt: flags.adapt } : {}), description: flags.description ?? contract.description, contract };
}

/** `device_*` come from the words of service:devices an agent may call: a new word there is a new tool. */
const deviceRows = (): Row[] => WORD_CONTRACTS
  .filter((c) => c.member === "service:devices" && c.kind === "request" && c.direction === "in" && mayCall(c.callers, "agent"))
  .map((c): Row => [`device_${c.word.replaceAll(".", "_")}`, c.member, c.word, "receipt", { approval: true }]);

export const FIXED_TOOLS: readonly FixedTool[] = Object.freeze([...FIXED_ROWS, ...deviceRows()].map(build));
const byName = new Map(FIXED_TOOLS.map((tool) => [tool.name, tool]));
export const fixedTool = (name: string): FixedTool | undefined => byName.get(name);

// ---------------------------------------------------------------------------------------------------------------------
// meta and receipt tools
// ---------------------------------------------------------------------------------------------------------------------

export const META_TOOLS = ["capability_list", "capability_describe", "capability_call"] as const;
/** Collected and cancelled whatever else the declaration allows, and outside a turn. */
export const RECEIPT_TOOLS = ["await_result", "list_pending", "cancel"] as const;

/** The list the declaration's `tools` is checked against (declare time) and the order the tools are listed in. */
export const TOOL_NAMES: readonly string[] = Object.freeze([...FIXED_TOOLS.map((t) => t.name), ...META_TOOLS, ...RECEIPT_TOOLS]);

export interface ToolDefinition { name: string; description: string; inputSchema: JsonSchema }

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

function fixedDefinition(tool: FixedTool): ToolDefinition {
  const schema = tool.contract.input_schema;
  const extra: Record<string, JsonSchema> = { ...(tool.approval ? APPROVAL_PROPERTIES : {}), ...(tool.wait ? { [ENVELOPE_WAIT]: WAIT_PROPERTY } : {}) };
  return { name: tool.name, description: tool.description,
    inputSchema: Object.keys(extra).length ? { ...schema, properties: { ...(schema.properties ?? {}), ...extra } } : schema };
}

const META_DEFINITIONS: ToolDefinition[] = [
  { name: "capability_list", description: "Everything else Ash can do for you, live: each member (the phone and the owner's other devices, the computers you can work on, apps, Ash's own services) with the names, one-line summaries and effect of the words you may call. A word marked needs_approval will ask the owner first. Call it without member to see all; devices appear as soon as they connect. Next: capability_describe, then capability_call.",
    inputSchema: object({ member: { type: "string", description: "Only this member, e.g. service:widgets or a device id" } }) },
  { name: "capability_describe", description: "The full contract of one member's words, or of one word: description, input_schema, result_schema, effect, risk, label, timeout.",
    inputSchema: object({ member: { type: "string", description: "Member id from capability_list" }, word: { type: "string", description: "One word of that member; leave out for all of them" } }, ["member"]) },
  { name: "capability_call", description: "Call one word of one member with a body that matches its input_schema. If it needs the owner's approval the call waits for them for about 30 s: answered in time, it runs and its result is the result of this call (or it is refused); otherwise you get status waiting_owner with a pending_id: do not poll; the owner's answer arrives as their message in the conversation (`[answers <pending_id>, option once|always|deny] …`), then reassess and redeem it with human_pending_redeem (or skip it). A call that runs long returns status accepted with a request_id; collect it with await_result. Waits up to 15 s (wait: true: 50 s, wait: false: not at all).",
    inputSchema: object({ member: { type: "string" }, word: { type: "string" }, body: { type: "object", description: "The word's input, exactly as its input_schema says" }, ...APPROVAL_PROPERTIES, [ENVELOPE_WAIT]: WAIT_PROPERTY }, ["member", "word"]) },
];

const RECEIPT_DEFINITIONS: ToolDefinition[] = [
  { name: "await_result", description: "Wait for the result of an earlier call that returned status accepted (its request_id). Waits up to timeout_ms (at most 50000); returns the result, or the receipt again if it is still running. A receipt from before a restart of Ash may answer result_unknown: check the state before repeating the action.",
    inputSchema: object({ request_id: { type: "string" }, timeout_ms: { type: "integer", minimum: 0, maximum: 50000 } }, ["request_id"]) },
  { name: "list_pending", description: "Your calls that have not finished yet.", inputSchema: object({}) },
  { name: "cancel", description: "Cancel one of your calls that has not finished (by request_id). Its effect may already have happened.", inputSchema: object({ request_id: { type: "string" } }, ["request_id"]) },
];

let all: readonly ToolDefinition[] | undefined;
/** Every tool, in the order of `TOOL_NAMES`. */
export function toolDefinitions(): readonly ToolDefinition[] {
  return all ??= Object.freeze([...FIXED_TOOLS.map(fixedDefinition), ...META_DEFINITIONS, ...RECEIPT_DEFINITIONS]);
}

// ---------------------------------------------------------------------------------------------------------------------
// patterns: the declaration's `tools` and `words`
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The `member/word` patterns a fixed tool (or a pattern of tool names such as `device_*`) stands for. Meta and receipt
 * tools stand for none: through capability_call an agent reaches what its `words` allow. The router's authorization
 * asks this with the same meaning.
 */
export function toolWords(toolOrPattern: string): string[] {
  return FIXED_TOOLS.filter((tool) => glob(toolOrPattern, tool.name)).map((tool) => `${tool.member}/${tool.word}`);
}
