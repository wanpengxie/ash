/**
 * The word contract v4: the one definition of what a word is, of effect and risk, and of the rules every word must
 * pass (lint). Service words (words.ts), standard hand actions (namespaces.ts), app tools (app.ts) and hand
 * manifests all compile to a `WordContract`.
 *
 * An agent's name never appears in a contract; which agent may call which word is that agent's own declaration.
 */
import Ajv2020 from "ajv/dist/2020";
import { idKind, type MemberKind } from "./ids";
import type { HandleContext, Message, Reply, WordResult } from "./message";

/** A JSON Schema (draft 2020-12) document. Kept loose on purpose: the validator is Ajv, not this type. */
export type JsonSchema = Record<string, any>;

// ---------------------------------------------------------------------------------------------------------------------
// effect and risk (SPEC-01 §6.2): the only definition in the repository
// ---------------------------------------------------------------------------------------------------------------------

/**
 * read: only looks. write: changes data (files, calendar, a setting). act: does something (tap, open, send).
 * execute: runs code or a command.
 */
export type Effect = "read" | "write" | "act" | "execute";
/**
 * none: the consequences stay inside the kernel or the hand's own sandbox, can be undone, nobody sees them.
 * outward: other people can see it, or it leaves this device. structure: a lasting change to the system, its
 * permissions, installed software, or running code.
 */
export type Risk = "none" | "outward" | "structure";
export const EFFECTS: readonly Effect[] = Object.freeze(["read", "write", "act", "execute"]);
export const RISKS: readonly Risk[] = Object.freeze(["none", "outward", "structure"]);
export const isEffect = (value: unknown): value is Effect => typeof value === "string" && (EFFECTS as readonly string[]).includes(value);
export const isRisk = (value: unknown): value is Risk => typeof value === "string" && (RISKS as readonly string[]).includes(value);

/** The problem with an effect/risk pair, or null. `read` never carries risk; `execute` is always structure. */
export function effectRiskProblem(effect: unknown, risk: unknown): string | null {
  if (!isEffect(effect)) return `effect must be one of ${EFFECTS.join(", ")}`;
  if (!isRisk(risk)) return `risk must be one of ${RISKS.join(", ")}`;
  if (effect === "read" && risk !== "none") return "effect read requires risk none";
  if (effect === "execute" && risk !== "structure") return "effect execute requires risk structure";
  return null;
}

/**
 * The effect of a word. The only implementation: the router, the app bridge and the hands' manifests all call this.
 * A word that has no valid effect gets one from its risk (none -> read, outward -> act, structure -> write). A word
 * that claims to only read while its risk says otherwise is treated by its risk: a mismatch never relaxes the gate.
 */
export function wordEffect(spec: { effect?: unknown; risk?: unknown }): Effect {
  const derived: Effect = spec.risk === "outward" ? "act" : spec.risk === "structure" ? "write" : "read";
  if (!isEffect(spec.effect)) return derived;
  return spec.effect === "read" && derived !== "read" ? derived : spec.effect;
}

// ---------------------------------------------------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Who may call a word (SPEC-01 §5.2), the first layer of authorization.
 *
 * `kernel` is the hub's own code (services, edges). The rule (`mayCall`): the kernel passes this layer for every word;
 * a word whose callers are exactly `["kernel"]` is for the kernel alone, and owner, agent and app are refused.
 * `kernel` therefore only ever stands alone (lint: callers): next to other kinds it would be redundant and misleading.
 * Passing this layer says who may call, not that the call has no risk: effect, risk and the gate still apply.
 */
export type CallerKind = "owner" | "agent" | "app" | "kernel";
export const CALLER_KINDS: readonly CallerKind[] = Object.freeze(["owner", "agent", "app", "kernel"]);
export const DEFAULT_CALLERS: readonly CallerKind[] = Object.freeze(["owner", "agent", "app"]);
/** The first layer of authorization: may this kind of caller call a word with these `callers`? The kernel always may. */
export const mayCall = (callers: readonly CallerKind[], who: CallerKind): boolean => who === "kernel" || callers.includes(who);

/** Names of the call envelope (SPEC-02 §3.3). No word's input may use them. */
export const RESERVED_INPUT_NAMES: readonly string[] = Object.freeze(["approval_ttl_minutes", "purpose", "wait"]);

/** Schema markers (SPEC-01 §10.0): a secret input is never stored or shown; a sensitive result is masked for all but the owner. */
export const SECRET_KEYWORD = "x-ash-secret";
export const SENSITIVE_KEYWORD = "x-ash-sensitive";
export const SENSITIVE_MASKS = ["hidden", "email", "tail4", "ip"] as const;
export type SensitiveMask = (typeof SENSITIVE_MASKS)[number];
export const secret = (schema: JsonSchema): JsonSchema => ({ ...schema, [SECRET_KEYWORD]: true });
export const sensitive = (schema: JsonSchema, mask: SensitiveMask): JsonSchema => ({ ...schema, [SENSITIVE_KEYWORD]: { mask } });

export interface WordContract {
  /** service:clock, person:owner, agent:* , device:* , body:* , app:* ; the starred forms stand for every member of that kind. */
  member: string;
  /** set, screen.tap, rules.list ... */
  word: string;
  kind: "request" | "event";
  /** in: somebody calls it. out: the member emits it (events). */
  direction: "in" | "out";
  /** For the agent: what it does and when to use it. At least 20 characters. */
  description: string;
  input_schema: JsonSchema;
  result_schema?: JsonSchema;
  effect: Effect;
  risk: Risk;
  /** The risk is assessed per call by the hand or member that runs it (SPEC-01 §6.3); `risk` is the most cautious answer. */
  per_call_risk?: boolean;
  /** The word operates the screen the owner is looking at on that hand (the reflex guard reads this). */
  foreground?: boolean;
  callers: CallerKind[];
  /** A human caller must come in through a channel on this machine. */
  local_only?: boolean;
  /** Events only: true = goes into the ledger. */
  record?: boolean;
  timeout_ms?: number;
  /** What the owner sees while it runs, in the present continuous, e.g. 「在看提醒」. The one label. */
  label: { doing: string };
}

// ---------------------------------------------------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------------------------------------------------

/** Something with an address that speaks words: a service, an agent, a hand, a body, an app. The registry holds these. */
export interface Member {
  /** The address. */
  id: string;
  kind: MemberKind;
  name: string;
  /** The words it speaks. */
  words(): WordContract[];
  /** Events it wants to hear besides those addressed to it, e.g. "sense.location" or "sense.*". */
  listens?: string[];
  /**
   * Handles a request or event addressed to it (or an event it listens to). A request returns a `WordResult` or
   * throws a `WordError`; an event returns nothing.
   */
  handle(msg: Message, ctx: HandleContext): Promise<WordResult | void>;
  cancel?(requestId: string): void;
  /** Runs before the gate: a Reply that is not null refuses the request without asking anyone (it may look outside first). */
  precheck?(msg: Message): Reply | null | Promise<Reply | null>;
  /** What the approval card should add about this request (e.g. what an app install will be allowed to do), or null. */
  cardDetail?(msg: Message): string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// lint (SPEC-02 §2.3)
// ---------------------------------------------------------------------------------------------------------------------

export const LINT_RULES = [
  "member", "word-name", "description", "label", "input-schema", "result-schema", "effect-risk",
  "event-shape", "callers", "local-only", "record", "timeout", "reserved-name", "secret", "sensitive",
] as const;
export type LintRule = (typeof LINT_RULES)[number];
export interface LintIssue { member: string; word: string; rule: LintRule; message: string }

export const WORD_NAME_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;
export const MIN_DESCRIPTION_LENGTH = 20;
const MEMBER_PATTERN_WILDCARD = /^(agent|device|body|app):\*$/;

let lintAjv: Ajv2020 | undefined;
function validator(): Ajv2020 {
  if (!lintAjv) {
    lintAjv = new Ajv2020({ strict: true, allowUnionTypes: true });
    lintAjv.addKeyword({ keyword: SECRET_KEYWORD, schemaType: "boolean" });
    lintAjv.addKeyword({ keyword: SENSITIVE_KEYWORD, schemaType: "object" });
  }
  return lintAjv;
}
/** Compile a contract schema the way lint does (draft 2020-12, strict, with the two ash markers). Throws on a bad schema. */
export const compileSchema = (schema: JsonSchema) => validator().compile(schema);

function* walk(schema: unknown, path: string): Generator<[JsonSchema, string]> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const node = schema as JsonSchema;
  yield [node, path];
  for (const key of ["properties", "$defs", "patternProperties"]) {
    const group = node[key];
    if (group && typeof group === "object") for (const [name, child] of Object.entries(group)) yield* walk(child, `${path}.${key}.${name}`);
  }
  for (const key of ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"]) yield* walk(node[key], `${path}.${key}`);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
    const list = node[key];
    if (Array.isArray(list)) for (let i = 0; i < list.length; i++) yield* walk(list[i], `${path}.${key}[${i}]`);
  }
}

/** Names the caller can set in the body at the top level of an input schema (through anyOf / oneOf / allOf too). */
function topLevelNames(schema: JsonSchema, seen = new Set<unknown>()): string[] {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return [];
  seen.add(schema);
  const names = [...Object.keys(schema.properties ?? {}), ...(Array.isArray(schema.required) ? schema.required : [])];
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[key])) for (const child of schema[key]) names.push(...topLevelNames(child, seen));
  return names;
}

function memberProblem(member: unknown): string | null {
  if (typeof member !== "string") return "member must be a string";
  if (MEMBER_PATTERN_WILDCARD.test(member)) return null;
  return idKind(member) && idKind(member) !== "client" ? null : `member ${JSON.stringify(member)} is not a member id or a kind wildcard (agent:*)`;
}

/** Every problem with one contract. An empty list means it passes. */
export function lintWord(contract: WordContract): LintIssue[] {
  const issues: LintIssue[] = [];
  const member = String((contract as { member?: unknown }).member);
  const word = String((contract as { word?: unknown }).word);
  const add = (rule: LintRule, message: string) => issues.push({ member, word, rule, message });
  const c = contract as unknown as Record<string, any>;

  const problem = memberProblem(c.member);
  if (problem) add("member", problem);
  if (typeof c.word !== "string" || !WORD_NAME_PATTERN.test(c.word)) add("word-name", "word must be lower-case dotted segments (a-z 0-9 _ -)");

  if (typeof c.description !== "string" || [...c.description.trim()].length < MIN_DESCRIPTION_LENGTH) add("description", `description must be at least ${MIN_DESCRIPTION_LENGTH} characters`);
  if (!c.label || typeof c.label !== "object" || typeof c.label.doing !== "string" || !c.label.doing.trim()) add("label", "label.doing is required");
  else if (Object.keys(c.label).some((key) => key !== "doing")) add("label", "label has only doing");

  const effectRisk = effectRiskProblem(c.effect, c.risk);
  if (effectRisk) add("effect-risk", effectRisk);

  if (c.kind === "event" && (c.effect !== "read" || c.risk !== "none")) add("event-shape", "an event changes nothing by itself: effect read, risk none");
  if (c.kind === "event" && (c.foreground || c.per_call_risk)) add("event-shape", "an event has no foreground or per_call_risk");

  const inputSchema = c.input_schema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) add("input-schema", "input_schema is required");
  else {
    if (inputSchema.type !== "object") add("input-schema", "input_schema must describe an object (type: object)");
    try { compileSchema(inputSchema); } catch (error) { add("input-schema", `input_schema does not compile: ${(error as Error).message}`); }
    const reserved = topLevelNames(inputSchema).filter((name) => RESERVED_INPUT_NAMES.includes(name));
    if (reserved.length) add("reserved-name", `input uses call-envelope names: ${[...new Set(reserved)].join(", ")}`);
    for (const [node, path] of walk(inputSchema, "input_schema")) {
      if (Object.hasOwn(node, SENSITIVE_KEYWORD)) add("sensitive", `${path}: ${SENSITIVE_KEYWORD} belongs on results, not on inputs`);
      if (Object.hasOwn(node, SECRET_KEYWORD) && node[SECRET_KEYWORD] !== true) add("secret", `${path}: ${SECRET_KEYWORD} must be true`);
    }
  }
  if (c.result_schema !== undefined) {
    if (!c.result_schema || typeof c.result_schema !== "object" || Array.isArray(c.result_schema)) add("result-schema", "result_schema must be a schema object");
    else {
      try { compileSchema(c.result_schema); } catch (error) { add("result-schema", `result_schema does not compile: ${(error as Error).message}`); }
      for (const [node, path] of walk(c.result_schema, "result_schema")) {
        if (Object.hasOwn(node, SECRET_KEYWORD)) add("secret", `${path}: ${SECRET_KEYWORD} belongs on inputs; a secret is never returned`);
        const marker = node[SENSITIVE_KEYWORD];
        if (marker !== undefined && !(marker && typeof marker === "object" && (SENSITIVE_MASKS as readonly string[]).includes(marker.mask))) add("sensitive", `${path}: ${SENSITIVE_KEYWORD} needs {mask: ${SENSITIVE_MASKS.join(" | ")}}`);
      }
    }
  }

  if (!Array.isArray(c.callers) || c.callers.length === 0 || c.callers.some((who: unknown) => !(CALLER_KINDS as readonly unknown[]).includes(who)) || new Set(c.callers).size !== c.callers.length) {
    add("callers", `callers must be a non-empty list without repeats from ${CALLER_KINDS.join(", ")}`);
  } else if (c.callers.includes("kernel") && c.callers.length > 1) {
    add("callers", "kernel stands alone: the kernel may call every word anyway, so list it only as [\"kernel\"] (a word for the kernel alone)");
  }
  if (c.local_only !== undefined && (c.local_only !== true || !Array.isArray(c.callers) || !c.callers.includes("owner"))) add("local-only", "local_only is true, and only for a word the owner can call");
  if (c.record !== undefined && (c.record !== true || c.kind !== "event")) add("record", "record is true, and only for events");
  if (c.timeout_ms !== undefined && (!Number.isInteger(c.timeout_ms) || c.timeout_ms <= 0)) add("timeout", "timeout_ms must be a positive integer");
  return issues;
}

/** Lint a whole list: every contract, plus no member/word pair twice. */
export function lintWords(contracts: readonly WordContract[]): LintIssue[] {
  const issues = contracts.flatMap(lintWord);
  const seen = new Set<string>();
  for (const { member, word } of contracts) {
    const key = `${member}/${word}`;
    if (seen.has(key)) issues.push({ member, word, rule: "word-name", message: `${key} is defined twice` });
    seen.add(key);
  }
  return issues;
}
