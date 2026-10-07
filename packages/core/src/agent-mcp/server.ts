import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID, AGENT_RUNTIME_SCHEMA } from "../../../sdk/src/words";
import { DEVICE_WORDS, deviceToolName } from "../../../sdk/src/device-words";
import type { Ledger } from "../world/ledger";
import type { WorldMembers } from "../world/member";
import { RouterError, type TrustedRouteContext, type WorldRouter } from "../world/router";

/** The closed set of error codes every ash tool may return. A test keeps the code honest. */
export const TOOL_ERROR_CODES = ["payload_invalid", "forbidden", "denied", "unreachable", "timeout", "result_unknown", "internal_error", "capability_error"] as const;
export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];
export type ToolResult = { ok: true; result: unknown } | { ok: false; error: { code: ToolErrorCode; message: string; recovery_hint: string; detail?: unknown } };

/** One agent's connection: its credential, and the turn it is working in right now (if any). */
export class AgentBinding {
  readonly token = randomBytes(24).toString("base64url");
  private current: { turn: string; signal: AbortSignal } | null = null;
  readonly jobs = new Map<string, Job>();
  /** Replaced when the owner or a manager changes the agent's declaration; applies from the next call. */
  policy: AgentPolicy;
  constructor(readonly member: string, readonly label: string, readonly sessionId: () => string | null, policy: AgentPolicy = {}) { this.policy = policy; }
  /** The fixed tools this agent may use (its declaration); all when it says nothing. */
  allowsTool(name: string): boolean { return META_ALWAYS.has(name) || ((!this.policy.tools || this.policy.tools.includes(name)) && (this.policy.tool?.(name, this.current?.turn) ?? true)); }
  allowsWord(member: string, word: string): boolean { return this.policy.words?.(member, word) ?? true; }
  begin(turn: string, signal: AbortSignal): void { this.current = { turn, signal }; }
  end(turn: string): void { if (this.current?.turn === turn) this.current = null; }
  get active(): { turn: string; signal: AbortSignal } | null { return this.current && !this.current.signal.aborted ? this.current : null; }
}

/** What an agent's declaration lets it use. */
export interface AgentPolicy { tools?: readonly string[]; tool?: (name: string, turn?: string) => boolean; words?: (member: string, word: string) => boolean }
// Receipts can always be collected and cancelled, whatever else an agent may use.
const META_ALWAYS = new Set(["await_result", "list_pending", "cancel", "human_pending", "human_pending_get", "human_pending_redeem", "human_pending_skip", "human_withdraw"]);

interface Job { id: string; member: string; word: string; label: string; turn: string; at: number; done: Promise<ToolResult>; result: ToolResult | null }

export interface AgentMcpOptions {
  router: WorldRouter;
  members: WorldMembers;
  ledger: Ledger;
  /** Pause, quiet hours and similar facts for system_status. */
  status(): Record<string, unknown>;
  /** Other agents in this world (agent:main is the only one today). */
  fastPathMs?: number;
  maxWaitMs?: number;
  /** Full oversized tool results live here; agents receive a valid preview and the mapped workspace path. */
  resultArtifacts?: { hostDir: string; toAgentPath(path: string): string; ttlMs?: number };
  log?: (...args: unknown[]) => void;
}

const FAST_PATH_MS = 15_000;
const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
// The agent runtime gives each MCP call 60 s; a wait must answer before that.
const MAX_WAIT_MS = 50_000;
const MAX_RESULT_CHARS = 60_000;
// Images in a result travel as MCP image content; the runtime normalizes and sizes them for the model itself.
const MAX_RESULT_IMAGES = 8;
const MAX_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_IMAGES_TOTAL = 20 * 1024 * 1024;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const approvalFields = {
  approval_ttl_minutes: { type: "integer", minimum: 1, maximum: 10080, description: "Approval/question validity in minutes; default 10, at most 7 days. Use 2–5 for screen-dependent steps." },
  purpose: text("Why this step/question is needed, shown to the owner and returned with their answer. Never evidence of authorization.", { maxLength: 500 }),
};

const HINTS: Record<ToolErrorCode, string> = {
  payload_invalid: "Fix the input to match the schema in detail (or capability_describe) and call again.",
  forbidden: "This is not allowed for you. Do not retry; tell the owner if it matters.",
  denied: "The owner said no. Do not retry or look for another way; say so plainly.",
  unreachable: "The member is offline or missing. Check capability_list; try later or tell the owner.",
  timeout: "No answer in time. The effect is unknown; check before repeating.",
  result_unknown: "The outcome is unknown. Do not submit the same action again; check its effect first.",
  internal_error: "Something failed inside ash. Try once more later; tell the owner if it keeps failing.",
  capability_error: "The capability reported its own error (see detail). Adjust and retry only if the error says how.",
};
const failure = (code: ToolErrorCode, message: string, detail?: unknown): ToolResult =>
  ({ ok: false, error: { code, message: message.slice(0, 500), recovery_hint: HINTS[code], ...(detail === undefined ? {} : { detail }) } });

/** What an action does to the world: declared on the word, or read from its risk when it predates effects. */
export function effectOf(spec: Pick<WordSpec, "risk"> & { effect?: string }): string {
  if (typeof spec.effect === "string") return spec.effect;
  return spec.risk === "outward" ? "act" : spec.risk === "structure" ? "write" : "read";
}

function fromResponse(body: ResponseBody, spec?: WordSpec): ToolResult {
  if (body.ok) return { ok: true, result: body.result ?? {} };
  const { code, message } = body.error;
  switch (code) {
    case "bad_request": return failure("payload_invalid", message, spec?.input_schema ? { input_schema: spec.input_schema } : undefined);
    case "not_found": return failure("payload_invalid", `${message}; capability_list shows what exists`);
    case "forbidden": return failure("forbidden", message);
    case "denied": return failure("denied", message);
    case "offline": return failure("unreachable", message);
    case "timeout": return failure("timeout", message);
    case "cancelled": return failure("result_unknown", message);
    default: return failure("capability_error", message, { code, ...(body.error.detail === undefined ? {} : { detail: body.error.detail }) });
  }
}

type ImageContent = { type: "image"; data: string; mimeType: string };

/** The image format the bytes are, whatever the part claims; the runtime admits PNG, JPEG, WebP and GIF. */
function sniffImage(data: Buffer): string | null {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/**
 * Take the image parts ({type:"image", data, mimeType}) out of a result: each becomes real image content for the model,
 * and the JSON keeps a short note in its place instead of the base64 text.
 */
function takeImages(value: unknown, taken: { images: ImageContent[]; bytes: number; attach: boolean }, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 12) return value;
  if (Array.isArray(value)) return value.map((item) => takeImages(item, taken, depth + 1));
  const item = value as Record<string, unknown>;
  if (item.type === "image" && typeof item.data === "string") {
    const omitted = (why: string) => ({ ...item, data: undefined, omitted: why });
    const data = Buffer.from(item.data.replace(/\s+/g, ""), "base64");
    const mimeType = sniffImage(data);
    if (!mimeType) return omitted("not a PNG, JPEG, WebP or GIF image");
    if (!taken.attach) return omitted("images are not shown for a failed call");
    if (taken.images.length >= MAX_RESULT_IMAGES) return omitted(`only the first ${MAX_RESULT_IMAGES} images of one result are shown`);
    if (data.length > MAX_RESULT_IMAGE_BYTES || taken.bytes + data.length > MAX_RESULT_IMAGES_TOTAL) return omitted("image too large to show");
    taken.images.push({ type: "image", data: data.toString("base64"), mimeType });
    taken.bytes += data.length;
    return { ...item, data: undefined, mimeType, bytes: data.length, shown: `image ${taken.images.length} after this text, as an image you can see` };
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, takeImages(child, taken, depth + 1)]));
}

function fromError(error: unknown): ToolResult {
  if (error instanceof RouterError) return fromResponse({ ok: false, error: { code: error.code, message: error.message } });
  return failure("internal_error", error instanceof Error ? error.message : "tool failed");
}

const TOOLS = [
  ...DEVICE_WORDS.map(spec => ({ name: deviceToolName(spec.word), description: spec.description, inputSchema: { ...spec.input_schema, properties: { ...(spec.input_schema.properties as object), ...approvalFields } } })),
  // system
  { name: "system_status", description: "Current time and time zone, whether ash is paused by the owner, and quiet hours. Read-only.", inputSchema: object({}) },
  { name: "vault_list", description: "Names and kinds of the credentials in the owner's vault. Values are never returned; model keys are used by ash on your behalf.", inputSchema: object({}) },
  { name: "vault_describe", description: "One vault entry's name, kind and when it was set. Never the value.", inputSchema: object({ ref: text("Entry name, e.g. DEEPSEEK_API_KEY") }, ["ref"]) },
  { name: "timer_set", description: "Schedule a message for later: deliver=owner sends text to the owner as a due reminder; deliver=self wakes you with the text. Give at (epoch ms) for once, every (seconds, >= 60) to repeat. Returns the timer id.",
    inputSchema: object({ label: text("Short name shown in the owner's timer list"), text: text("What to deliver"), deliver: { type: "string", enum: ["owner", "self"] },
      at: { type: "number", description: "Epoch ms of the first delivery" }, every: { type: "integer", minimum: 60, description: "Repeat interval in seconds" } }, ["label", "text", "deliver"]) },
  { name: "timer_list", description: "Active timers.", inputSchema: object({}) },
  { name: "timer_cancel", description: "Cancel a timer by id; cancelled=false means it already fired or never existed.", inputSchema: object({ id: text("Timer id from timer_set or timer_list") }, ["id"]) },
  { name: "approval_log", description: "Approval records, newest first: for each action that reached the approval gate, what was asked, the facts the reviewer saw and its verdict, the card the owner saw, the decision and who made it (rule, review, carry, owner, timeout), and whether the action then ran. Use it to work out why something was allowed, asked about or refused.",
    inputSchema: object({ request_id: text("One request"), requester: text("Only this agent, e.g. agent:main"), word: text("Only this capability, e.g. clipboard.set"),
      decision: { type: "string", enum: ["rule", "review", "carry", "device_full", "once", "always", "deny", "timeout", "cancelled", "waiting"] },
      before: { type: "integer", minimum: 1, description: "next_before from the previous page" }, limit: { type: "integer", minimum: 1, maximum: 50 } }) },
  { name: "approval_rules", description: "The owner's approval rules: which agent may use which outside capability (and target) without asking, until when, and whether it was revoked; plus the approval mode (auto: ask when needed; always: ask about non-read outside actions, except computers explicitly set to full access).",
    inputSchema: object({ before: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } }) },
  { name: "approval_rule_add", description: "Ask for a new approval rule: for up to 30 days, one agent may use one outside capability without asking, optionally only for one target (site:<host>, a calendar id, a recipient id, or browse). ALWAYS returns waiting_owner with a pending_id when the card is shown. Do not poll; reassess and redeem after the answer arrives. Commands and payments cannot be covered.",
    inputSchema: object({ agent: text("Agent id, e.g. agent:main"), member: text("Device member, e.g. device:phone"), word: text("Capability, e.g. clipboard.set"),
      target: text("Only this target; omit for every use of the capability"), days: { type: "integer", minimum: 1, maximum: 30 }, ...approvalFields }, ["agent", "member", "word"]) },
  { name: "approval_mode_set", description: "Ask to switch approval mode: auto (rules and review) or always (every outside non-read action asks). Returns waiting_owner immediately when the card is shown. Do not poll; reassess and redeem after the contextual answer arrives.",
    inputSchema: object({ mode: { type: "string", enum: ["auto", "always"] }, ...approvalFields }, ["mode"]) },
  { name: "approval_rule_remove", description: "Ask to revoke a rule. Always asks the owner; returns waiting_owner with pending_id. Do not poll; reassess and redeem after the answer arrives.",
    inputSchema: object({ id: text("Rule id from approval_rules"), ...approvalFields }, ["id"]) },
  { name: "history_query", description: "Search the conversation history with the owner. Give text to search, or read_seq to read one message in full. Returns newest first, with seq numbers; page older with before_seq.",
    inputSchema: object({ text: text("Words to look for (case-insensitive)"), speaker: { type: "string", enum: ["owner", "agent", "any"] },
      before_seq: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 }, read_seq: { type: "integer", minimum: 1 } }) },
  // human
  { name: "human_say", description: "Say one message to the owner. kind: reply (default, answering them), heads_up or offer (something you noticed), due (a reminder). May be called several times in a turn; the owner reads each as a separate message.",
    inputSchema: object({ text: text("The message"), kind: { type: "string", enum: ["reply", "heads_up", "offer", "due"] } }, ["text"]) },
  { name: "human_notify", description: "Tell the owner something that should reach them even when the app is closed: it becomes a phone notification. Quiet hours still apply.",
    inputSchema: object({ text: text("The notification text") }, ["text"]) },
  { name: "human_ask", description: "Ask the owner a question with options to tap. Returns at once: the owner's answer arrives later as their next message to you (possibly while you are still working). Do not wait for it in a loop.",
    inputSchema: object({ question: text("The question"), options: { type: "array", minItems: 1, maxItems: 8, items: object({ id: text("Stable id"), text: text("What the owner sees") }, ["id", "text"]) },
      allow_custom: { type: "boolean", description: "Let the owner type their own answer" }, ...approvalFields }, ["question", "options"]) },
  { name: "human_show", description: "Show the owner a card: a link {type:link,url,title,summary?}, a workspace file {type:file,workspace:'home',path,name,mime_type,size}, a workspace image {type:image,workspace:'home',path,alt?}, or a permission card {type:permission,permission,why} naming an Android setting to switch on (calendar, notifications, battery, accessibility, photos, all_files, usage, write_settings, overlay, shizuku). Paths are relative to your workspace.",
    inputSchema: object({ card: { type: "object", description: "The card, see the description" } }, ["card"]) },
  { name: "human_confirm", description: "Ask for an explicit confirmation; returns waiting_owner immediately with pending_id and expires_at. The contextual answer arrives later in your inbox. No action is attached to this confirmation; do not poll or use await_result.",
    inputSchema: object({ title: text("One line: what you want to do"), detail: text("Exactly what will happen: the text to send, the command, the target"), ...approvalFields }, ["title", "detail"]) },
  { name: "human_pending", description: "List durable questions, confirmations and approvals. Main sees all; helpers see only their own. Inspect when relevant, never poll for an answer.",
    inputSchema: object({ type: { type: "string", enum: ["question", "confirmation", "approval"] }, state: { type: "string", enum: ["waiting", "answered", "redeemed", "denied", "expired", "withdrawn", "skipped"] }, before: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 } }) },
  { name: "human_pending_get", description: "Read a human pending request, its original question/purpose, answer, frozen action and execution result.", inputSchema: object({ pending_id: text("Pending id") }, ["pending_id"]) },
  { name: "human_pending_redeem", description: "Execute your approved frozen action exactly once. Reassess current user intent and re-read any affected screen first. Takes no new action parameters. Fails if denied, expired, withdrawn or already redeemed; inspect human_pending_get for a recorded result.", inputSchema: object({ pending_id: text("Approved pending id") }, ["pending_id"]) },
  { name: "human_pending_skip", description: "Record why you will not execute your approved action (task changed, screen changed, no longer needed). Explain the reason to the owner.", inputSchema: object({ pending_id: text("Pending id"), reason: text("Why the approved action should not run") }, ["pending_id", "reason"]) },
  { name: "human_withdraw", description: "Withdraw your unanswered question, confirmation or approval. An already answered request is unchanged and its current state is returned. Does not cancel execution.", inputSchema: object({ pending_id: text("Pending id"), reason: text("Why this is no longer needed") }, ["pending_id", "reason"]) },
  // agents
  { name: "agent_list", description: "Every agent in ash: id, name, what it does, and whether it is idle, working or stopped. agent:main is the assistant the owner talks with and the only one that speaks to the owner.", inputSchema: object({}) },
  { name: "agent_describe", description: "One agent's declaration: what it is for, its job, the tools and ash capabilities it was given, its schedule, its state.",
    inputSchema: object({ agent: text("Agent id, e.g. agent:keeper") }, ["agent"]) },
  { name: "agent_ask", description: "Ask another agent and get its answer: {ok, result: {agent, answer}}. It answers in a turn of its own; if that takes longer than 50 s (or wait=false) you get {status:accepted, request_id} and collect the answer with await_result.",
    inputSchema: object({ agent: text("Agent id from agent_list"), text: text("The question"), wait: { type: "boolean" } }, ["agent", "text"]) },
  { name: "agent_tell", description: "Tell another agent something without waiting. It handles it in a turn of its own; what it says back arrives later as a message to you, which you need not answer.",
    inputSchema: object({ agent: text("Agent id from agent_list"), text: text("The message") }, ["agent", "text"]) },
  { name: "agent_runtimes", description: "Discover online computers allowed to host agents, their installed runtimes and models. Use before agent_create with runtime {device,kind,cwd?,model?,effort?}.", inputSchema: object({}) },
  // system: managing agents (only for agents given it)
  { name: "agent_create", description: "Create a new agent. It runs at once in its own session and workspace. Give id (agent:<lowercase name>), name, summary (what others are told it does), brief (its job, in its own words), and optionally tools (fixed tool names; default: discovery, talking to agents, history, status), words (ash capabilities as member/word patterns, e.g. service:self/read; default none) and every (seconds between scheduled wakes, >= 600).",
    inputSchema: object({ id: text("agent:<lowercase name>"), runtime: AGENT_RUNTIME_SCHEMA, name: text("Short name"), summary: text("One line others see"), brief: text("Its job"),
      tools: { type: "array", items: { type: "string" } }, words: { type: "array", items: { type: "string" } }, every: { type: "integer", minimum: 600 } }, ["id", "name", "summary", "brief"]) },
  { name: "agent_update", description: "Change an agent's declaration (name, summary, brief, tools, words, every); it applies from its next turn.",
    inputSchema: object({ agent: text("Agent id"), runtime: AGENT_RUNTIME_SCHEMA, name: text("Short name"), summary: text("One line others see"), brief: text("Its job"),
      tools: { type: "array", items: { type: "string" } }, words: { type: "array", items: { type: "string" } }, every: { type: "integer", minimum: 600 } }, ["agent"]) },
  { name: "agent_start", description: "Let a stopped agent take turns again.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_stop", description: "Stop an agent: its current turn is cancelled and it takes no new ones until started; messages wait for it.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_restart", description: "Cancel an agent's current turn and reopen its session (history is kept).", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_remove", description: "Remove an agent you created. Built-in agents can only be stopped.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  // meta
  { name: "capability_list", description: "Everything else ash can do for you, live: each member with its capabilities' names, one-line summaries and effect (read, act, write, send, execute, structure). Members are the phone (device:phone), the owner's other devices, and ash's own services such as service:widgets (cards on the phone home screen) and service:apps (installed apps). Call it without member to see them all; new devices appear as soon as they connect. Next: capability_describe, then capability_call.",
    inputSchema: object({ member: text("Only this member; omit to list every member") }) },
  { name: "capability_describe", description: "Full contract of one member's capabilities, or of one capability: description, input_schema, output_schema, effect, label, timeout.",
    inputSchema: object({ member: text("Member id, e.g. device:phone"), word: text("Capability name; omit for all of the member's") }, ["member"]) },
  { name: "capability_call", description: "Call one capability with a body matching its input_schema. Reads, rules and reviewer passes run normally. If approval is required, returns waiting_owner with pending_id as soon as the card is shown; do not poll or await_result. The answer arrives in your inbox; reassess before redeeming the frozen action. Only actual long execution returns accepted with request_id (15 s default, wait=true 50 s); collect that with await_result. wait=false returns immediately.",
    inputSchema: object({ member: text("Member id"), word: text("Capability name"), body: { type: "object", description: "Input matching the capability's input_schema" }, wait: { type: "boolean" },
      ...approvalFields }, ["member", "word"]) },
  { name: "await_result", description: "Wait for the result of an earlier call that returned {status:accepted}. Waits up to timeout_ms (at most 50000); returns the result, or the receipt again if it is still running.",
    inputSchema: object({ request_id: text("request_id from the receipt"), timeout_ms: { type: "integer", minimum: 0, maximum: 50_000 } }, ["request_id"]) },
  { name: "list_pending", description: "Your calls that have not finished yet.", inputSchema: object({}) },
  { name: "cancel", description: "Cancel one of your pending calls. Its external effect may already have happened.", inputSchema: object({ request_id: text("request_id from the receipt") }, ["request_id"]) },
] as const;
export const TOOL_NAMES: readonly string[] = TOOLS.map((tool) => tool.name);

/**
 * ash's capabilities as an MCP server for the agents in the container. The tool set is fixed: system, human and agent
 * tools are written out here; everything else is reached through list → describe → call. Identity comes from the
 * connection's credential, never from a parameter, and a call is only accepted while that agent has a turn running.
 */
export class AgentMcpServer {
  private http: HttpServer | null = null;
  private readonly bindings = new Map<string, AgentBinding>();
  private readonly waiters = new Map<string, (message: Message) => void>();
  private readonly stopSubscription: () => void;
  private callSeq = 0;
  private humanTimer: ReturnType<typeof setInterval> | null = null;
  url = "";

  constructor(private readonly options: AgentMcpOptions) {
    this.stopSubscription = options.router.subscribe((message) => {
      if (message.kind !== "response" || !message.reply_to) return;
      const waiter = this.waiters.get(message.reply_to);
      if (waiter) { this.waiters.delete(message.reply_to); waiter(message); }
    });
  }

  /** A removed agent's credential stops working at once. */
  unbind(binding: AgentBinding): void { this.bindings.delete(binding.token); }

  /** Remove a declared agent's credential and durable receipt namespace. */
  retire(binding: AgentBinding): void {
    this.unbind(binding);
    for (const item of this.options.ledger.activeHumanPending().filter((item) => item.agent === binding.member))
      this.options.router.withdrawHuman(binding.member, item.pending_id, "发起此请求的 Agent 已移除", item.state === "answered");
    const pending = new Set(this.options.ledger.pendingAgentJobs(binding.member).map((job) => job.requestId));
    for (const job of binding.jobs.values()) if (!job.result) pending.add(job.id);
    if (pending.size) this.options.router.cancel([...pending]);
    binding.jobs.clear();
    this.options.ledger.forgetAgentJobs(binding.member);
  }

  bind(member: string, label: string, sessionId: () => string | null, policy: AgentPolicy = {}): AgentBinding {
    const binding = new AgentBinding(member, label, sessionId, policy);
    this.bindings.set(binding.token, binding);
    return binding;
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.serve(request, response); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.http = server;
    this.humanTimer = setInterval(() => { void this.options.router.refreshHumanPending().catch((error) => this.options.log?.("human pending refresh failed", error)); }, 1000);
    this.humanTimer.unref();
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return this.url;
  }

  async close(): Promise<void> {
    if (this.humanTimer) clearInterval(this.humanTimer);
    this.humanTimer = null;
    this.stopSubscription();
    const server = this.http;
    this.http = null;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private authenticate(request: IncomingMessage): AgentBinding | null {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : null;
    if (!presented) return null;
    for (const binding of this.bindings.values()) {
      const expected = Buffer.from(binding.token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) return binding;
    }
    return null;
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      // A web page on the phone could reach a loopback port; only the agent runtime (no Origin) may talk here.
      if (request.headers.origin) { response.writeHead(403).end(); return; }
      if (!(request.url ?? "").startsWith("/mcp")) { response.writeHead(404).end(); return; }
      const binding = this.authenticate(request);
      if (!binding) { response.writeHead(401).end(); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 4 * 1024 * 1024) { response.writeHead(413).end(); return; } }
      // No resources, said explicitly: the agent runtime asks, and otherwise prints a warning on its protocol stream.
      const server = new Server({ name: "ash", version: "3.0.0" }, { capabilities: { tools: {}, resources: {} } });
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.filter((tool) => binding.allowsTool(tool.name)).map((tool) => ({ ...tool })) }));
      server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
        const result = await this.call(binding, call.params.name, (call.params.arguments ?? {}) as Record<string, unknown>, extra.signal);
        const taken = { images: [] as ImageContent[], bytes: 0, attach: !(result && typeof result === "object" && "ok" in result && result.ok === false) };
        const encoded = this.encodeResult(takeImages(result, taken) as ToolResult | Record<string, unknown>);
        return { content: [{ type: "text", text: encoded.body }, ...taken.images], ...(encoded.isError ? { isError: true } : {}) };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
    } catch (error) {
      this.options.log?.("agent tool request failed", error);
      if (!response.headersSent) response.writeHead(500).end();
    }
  }

  private context(binding: AgentBinding, turn: string): TrustedRouteContext {
    return { transport: "agent", transportPrincipal: binding.member, member: binding.member, local: true, remote: false, ownerProxy: false, turn };
  }

  /** One tool call. Exposed for tests; the HTTP path above is the only production entry. */
  async call(binding: AgentBinding, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult | Record<string, unknown>> {
    if (!TOOL_NAMES.includes(name)) return failure("payload_invalid", `unknown tool ${name}`);
    if (!binding.allowsTool(name)) return failure("forbidden", `${name} is not one of your tools`);
    if (args.approval_ttl_minutes !== undefined && (!Number.isInteger(args.approval_ttl_minutes) || Number(args.approval_ttl_minutes) < 1 || Number(args.approval_ttl_minutes) > 10080))
      return failure("payload_invalid", "approval_ttl_minutes must be an integer from 1 to 10080");
    if (args.purpose !== undefined && (typeof args.purpose !== "string" || args.purpose.length > 500)) return failure("payload_invalid", "purpose must be text up to 500 characters");
    if (name === "await_result") return this.awaitResult(binding, args);
    if (name === "list_pending") {
      const durable = this.options.ledger.pendingAgentJobs(binding.member)
        .filter((job) => !this.options.ledger.humanPending(job.requestId) || this.options.ledger.humanPending(job.requestId)?.state === "redeemed")
        .map((job) => ({ request_id: job.requestId, member: job.member, word: job.word, label: job.label, since: job.at }));
      const ids = new Set(durable.map((job) => job.request_id));
      const local = [...binding.jobs.values()].filter((job) => !job.result && !ids.has(job.id) && (!this.options.ledger.humanPending(job.id) || this.options.ledger.humanPending(job.id)?.state === "redeemed"))
        .map((job) => ({ request_id: job.id, member: job.member, word: job.word, label: job.label, since: job.at }));
      return { ok: true, result: { pending: [...durable, ...local].sort((a, b) => a.since - b.since) } };
    }
    if (name === "cancel") {
      const job = typeof args.request_id === "string" ? this.restoreJob(binding, args.request_id) : null;
      if (!job) return this.unknownReceipt(args.request_id);
      if (!job.result) this.options.router.cancel([job.id]);
      return { ok: true, result: { cancelled: !job.result } };
    }
    const active = binding.active;
    if (!active) return failure("forbidden", "no turn is running for you; ash tools work only while you are handling a message or wake");
    const turnSignal = AbortSignal.any([active.signal, signal]);
    if (turnSignal.aborted) return failure("result_unknown", "this turn or tool call was cancelled before acceptance");
    try {
      const deviceWord = DEVICE_WORDS.find(spec => deviceToolName(spec.word) === name);
      if (deviceWord) return await this.job(binding, active.turn, "service:devices", deviceWord.word,
        pick(args, Object.keys(deviceWord.input_schema.properties ?? {})), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal, args);
      switch (name) {
        case "human_pending":
          await this.options.router.refreshHumanPending();
          return { ok: true, result: this.options.ledger.humanPendingList(binding.member === "agent:main" ? undefined : binding.member, args) };
        case "human_pending_get": {
          await this.options.router.refreshHumanPending();
          const item = this.options.ledger.humanPending(String(args.pending_id));
          return item && (binding.member === "agent:main" || this.options.ledger.humanOwnedBy(binding.member, item.pending_id)) ? { ok: true, result: item } : failure("forbidden", "pending request is not visible to you");
        }
        case "human_pending_skip":
        case "human_withdraw":
          if (typeof args.reason !== "string" || !args.reason.trim()) return failure("payload_invalid", "reason is required");
          return { ok: true, result: this.options.router.withdrawHuman(binding.member, String(args.pending_id), args.reason.slice(0, 1000), name === "human_pending_skip") };
        case "human_pending_redeem": {
          if (Object.keys(args).some((key) => key !== "pending_id") || typeof args.pending_id !== "string") return failure("payload_invalid", "redemption takes only pending_id, never new action parameters");
          const item = this.options.ledger.humanPending(String(args.pending_id));
          if (!item?.action || item.agent !== binding.member || !this.options.ledger.agentJob(binding.member, item.pending_id)) return failure("forbidden", "no frozen action for your current identity");
          if (item.state === "redeemed") return failure("denied", "approval already redeemed; inspect human_pending_get for the recorded result or unknown outcome");
          if (item.action.member !== "service:gate" && !binding.allowsWord(item.action.member, item.action.word)) return failure("forbidden", "this capability is no longer allowed for you");
          const actionTool = item.action.member === "service:devices" ? deviceToolName(item.action.word) : item.action.member === "service:gate" ? ({ "rules.set": "approval_rule_add", "rules.revoke": "approval_rule_remove", "mode.set": "approval_mode_set" } as Record<string, string>)[item.action.word] : "capability_call";
          if (!actionTool || !binding.allowsTool(actionTool)) return failure("forbidden", "the original tool is no longer allowed for you");
          // The usual job collector handles long execution, but never a human wait.
          const execution = this.options.router.redeemHuman(this.context(binding, active.turn), item.pending_id,
            () => !turnSignal.aborted && binding.active?.turn === active.turn)
            .then((message) => fromResponse(message.body as ResponseBody, this.spec(item.action!.member, item.action!.word))).catch(fromError);
          const job = this.restoreJob(binding, item.pending_id);
          return job ? Promise.race([execution, this.within(job, this.options.fastPathMs ?? FAST_PATH_MS, true)]) : execution;
        }
        case "system_status": return { ok: true, result: { now: new Date().toISOString(), epoch_ms: Date.now(), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...this.options.status() } };
        case "vault_list": return await this.send(binding, active.turn, "service:vault", "list", {}, turnSignal);
        case "vault_describe": return await this.send(binding, active.turn, "service:vault", "describe", { ref: args.ref }, turnSignal);
        case "timer_set": {
          if (typeof args.text !== "string" || !args.text.trim()) return failure("payload_invalid", "text is required");
          const target = args.deliver === "self" ? { to: binding.member, word: "say", body: { text: `[timer] ${args.text}` } }
            : { to: "person:owner", word: "say", body: { text: args.text, kind: "due" } };
          return await this.send(binding, active.turn, "service:clock", "set", { ...target, label: args.label,
            ...(args.at === undefined ? {} : { at: args.at }), ...(args.every === undefined ? {} : { every: args.every }) }, turnSignal);
        }
        case "timer_list": return await this.send(binding, active.turn, "service:clock", "list", {}, turnSignal);
        case "timer_cancel": return await this.send(binding, active.turn, "service:clock", "cancel", { id: args.id }, turnSignal);
        case "history_query": return this.history(args);
        case "approval_log": return await this.send(binding, active.turn, "service:gate", "audit", pick(args, ["request_id", "requester", "word", "decision", "before", "limit"]), turnSignal);
        case "approval_rules": return await this.send(binding, active.turn, "service:gate", "rules.list", pick(args, ["before", "limit"]), turnSignal);
        // Changing rules produces a durable owner card; its answer never dispatches the change automatically.
        case "approval_rule_add": return await this.job(binding, active.turn, "service:gate", "rules.set", pick(args, ["agent", "member", "word", "target", "days"]), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal, args);
        case "approval_rule_remove": return await this.job(binding, active.turn, "service:gate", "rules.revoke", { id: args.id }, this.options.fastPathMs ?? FAST_PATH_MS, turnSignal, args);
        case "approval_mode_set": return await this.job(binding, active.turn, "service:gate", "mode.set", { mode: args.mode }, this.options.fastPathMs ?? FAST_PATH_MS, turnSignal, args);
        case "human_say": return await this.send(binding, active.turn, "person:owner", "say", { text: args.text, kind: args.kind ?? "reply" }, turnSignal);
        case "human_notify": return await this.send(binding, active.turn, "person:owner", "say", { text: args.text, kind: "heads_up" }, turnSignal);
        case "human_ask": {
          if (typeof args.question !== "string" || !args.question.trim() || !Array.isArray(args.options) || !args.options.length) return failure("payload_invalid", "question and options are required");
          const item = this.options.router.createHumanQuestion(this.context(binding, active.turn), { type: "question", title: args.question, detail: String(args.purpose ?? ""),
            purpose: String(args.purpose ?? ""), ttlMinutes: Number(args.approval_ttl_minutes ?? 10), options: args.options.map((value) => ({ id: value.id, label: value.text })), allowCustom: args.allow_custom === true });
          return this.humanReceipt(item.pending_id)!;
        }
        case "human_show": return await this.send(binding, active.turn, "person:owner", "show", { card: args.card }, turnSignal);
        case "human_confirm": {
          if (typeof args.title !== "string" || !args.title.trim() || typeof args.detail !== "string") return failure("payload_invalid", "title and detail are required");
          const item = this.options.router.createHumanQuestion(this.context(binding, active.turn), { type: "confirmation", title: args.title, detail: args.detail,
            purpose: String(args.purpose ?? ""), ttlMinutes: Number(args.approval_ttl_minutes ?? 10), options: [{ id: "once", label: "确认" }, { id: "deny", label: "不确认" }] });
          return this.humanReceipt(item.pending_id)!;
        }
        // Discovery and communication (agent words) and management (system words) are the Agent system's; these tools
        // only carry the request, as this agent. What each agent may use is its declaration's business.
        case "agent_list": return await this.send(binding, active.turn, "service:agents", "list", {}, turnSignal);
        case "agent_runtimes": return await this.send(binding, active.turn, "service:agents", "runtimes", {}, turnSignal);
        case "agent_describe": return await this.send(binding, active.turn, "service:agents", "describe", { agent: args.agent }, turnSignal);
        case "agent_tell": return await this.send(binding, active.turn, "service:agents", "tell", { agent: args.agent, text: args.text }, turnSignal);
        case "agent_ask": return await this.job(binding, active.turn, "service:agents", "ask", { agent: args.agent, text: args.text },
          args.wait === false ? 0 : (this.options.maxWaitMs ?? MAX_WAIT_MS), turnSignal);
        case "agent_create": return await this.job(binding, active.turn, "service:agents", "declare", pick(args, ["id", "name", "summary", "brief", "tools", "words", "every", "runtime"]), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "agent_update": return await this.job(binding, active.turn, "service:agents", "update", pick(args, ["agent", "name", "summary", "brief", "tools", "words", "every", "runtime"]), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "agent_start":
        case "agent_stop":
        case "agent_restart":
        case "agent_remove": return await this.job(binding, active.turn, "service:agents", name.slice("agent_".length), { agent: args.agent }, this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "capability_list": return this.list(binding, typeof args.member === "string" ? args.member : undefined);
        case "capability_describe": return this.describe(binding, String(args.member ?? ""), typeof args.word === "string" ? args.word : undefined);
        case "capability_call": {
          if (typeof args.member !== "string" || typeof args.word !== "string") return failure("payload_invalid", "member and word are required");
          if (args.member === "service:agents") return failure("forbidden", "use the agent tools for other agents");
          if (args.member === "service:gate") return failure("forbidden", "use the approval tools for approval records and rules");
          if (args.member === "service:devices") return failure("forbidden", "use the device management tools");
          if (!binding.allowsWord(args.member, args.word)) return failure("forbidden", `${args.member}/${args.word} is not among the capabilities you may use`);
          if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return failure("payload_invalid", "body must be an object");
          return await this.job(binding, active.turn, args.member, args.word, (args.body ?? {}) as Record<string, unknown>,
            args.wait === false ? 0 : args.wait === true ? (this.options.maxWaitMs ?? MAX_WAIT_MS) : (this.options.fastPathMs ?? FAST_PATH_MS), turnSignal, args);
        }
      }
      return failure("payload_invalid", `unknown tool ${name}`);
    } catch (error) { return fromError(error); }
  }

  private spec(member: string, word: string): WordSpec | undefined {
    try { return (this.options.members.describe("agent", member).members[0]?.words ?? []).find((item) => item.word === word); } catch { return undefined; }
  }

  /** A quick request: wait for the answer (these words answer at once). */
  private async send(binding: AgentBinding, turn: string, to: string, word: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    const sent = await this.options.router.send(this.context(binding, turn), { to, kind: "request", word, body, wait: true,
      client_id: `mcp:${turn}:${++this.callSeq}:${randomBytes(4).toString("hex")}` }, signal);
    return sent.reply ? fromResponse(sent.reply.body as ResponseBody, this.spec(to, word)) : failure("result_unknown", "no answer was recorded");
  }

  /** A call that may take long: accepted first, answered inline if it finishes within the wait, otherwise a receipt. */
  private async job(binding: AgentBinding, turn: string, member: string, word: string, body: Record<string, unknown>, waitMs: number, signal: AbortSignal, approval: Record<string, unknown> = {}): Promise<ToolResult | Record<string, unknown>> {
    const spec = this.spec(member, word);
    let sent: { id: string };
    try {
      sent = await this.options.router.send({ ...this.context(binding, turn), approval: { ttlMinutes: Number(approval.approval_ttl_minutes ?? 10), purpose: String(approval.purpose ?? "") } }, { to: member, kind: "request", word, body,
        client_id: `mcp:${turn}:${++this.callSeq}:${randomBytes(4).toString("hex")}` }, signal);
    } catch (error) {
      if (error instanceof RouterError) return fromResponse({ ok: false, error: { code: error.code, message: error.message } }, spec);
      throw error;
    }
    const done = new Promise<ToolResult>((resolve) => {
      const settled = this.options.ledger.responseTo(sent.id);
      if (settled) { resolve(fromResponse(settled.body as ResponseBody, spec)); return; }
      this.waiters.set(sent.id, (message) => resolve(fromResponse(message.body as ResponseBody, spec)));
    });
    const job: Job = { id: sent.id, member, word, label: spec?.label ?? word, turn, at: Date.now(), done, result: null };
    this.options.ledger.recordAgentJob({ requestId: job.id, owner: binding.member, turn, member, word, label: job.label, at: job.at });
    void done.then((result) => { job.result = result; });
    binding.jobs.set(job.id, job);
    if (binding.jobs.size > 200) for (const [id, old] of binding.jobs) { if (old.result) binding.jobs.delete(id); if (binding.jobs.size <= 100) break; }
    return this.within(job, waitMs);
  }

  private humanReceipt(id: string): Record<string, unknown> | null {
    const item = this.options.ledger.humanPending(id);
    return item && ["waiting", "answered"].includes(item.state) ? { status: "waiting_owner", pending_id: item.pending_id, expires_at: item.expires_at,
      state: item.state, card: { title: item.title }, guidance: "The contextual answer arrives in your inbox. Do not poll or await_result. End this turn or do independent work. Approval alone never executes; reassess before human_pending_redeem." } : null;
  }

  private async within(job: Job, waitMs: number, redeeming = false): Promise<ToolResult | Record<string, unknown>> {
    if (!redeeming) { const receipt = this.humanReceipt(job.id); if (receipt) return receipt; }
    if (job.result) return job.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    const human = new Promise<Record<string, unknown>>((resolve) => {
      if (!redeeming) unsubscribe = this.options.router.subscribe(() => { const receipt = this.humanReceipt(job.id); if (receipt) resolve(receipt); });
    });
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    const result = await Promise.race([job.done, late, human]);
    clearTimeout(timer);
    unsubscribe();
    if (result) return result;
    return { status: "accepted", request_id: job.id, member: job.member, word: job.word,
      guidance: "Execution is still running. Call await_result with this request_id; do not call the capability again. Human waits use waiting_owner and never need polling." };
  }

  private async awaitResult(binding: AgentBinding, args: Record<string, unknown>): Promise<ToolResult | Record<string, unknown>> {
    const job = typeof args.request_id === "string" ? this.restoreJob(binding, args.request_id) : null;
    if (!job) return this.unknownReceipt(args.request_id);
    const timeout = typeof args.timeout_ms === "number" ? Math.max(0, Math.min(args.timeout_ms, this.options.maxWaitMs ?? MAX_WAIT_MS)) : (this.options.maxWaitMs ?? MAX_WAIT_MS);
    return this.within(job, timeout);
  }

  private unknownReceipt(value: unknown): ToolResult {
    if (typeof value !== "string" || !/^(?:m_|confirm)[A-Za-z0-9_-]{4,}$/.test(value))
      return failure("payload_invalid", "request_id must be an earlier receipt");
    return failure("result_unknown", "this receipt is not recoverable for your current agent identity");
  }

  /** Rebuild an in-memory waiter from the durable request, response and ownership records. */
  private restoreJob(binding: AgentBinding, id: string): Job | null {
    const live = binding.jobs.get(id);
    if (live) return live;
    const stored = this.options.ledger.agentJob(binding.member, id);
    if (!stored) return null;
    const spec = this.spec(stored.member, stored.word);
    let resolveDone!: (result: ToolResult) => void;
    const done = new Promise<ToolResult>((resolve) => { resolveDone = resolve; });
    const job: Job = { id, member: stored.member, word: stored.word, label: stored.label, turn: stored.turn, at: stored.at, done, result: null };
    binding.jobs.set(id, job);
    const finish = (result: ToolResult) => { if (job.result) return; job.result = result; resolveDone(result); };
    const settled = this.options.ledger.responseTo(id);
    if (settled) finish(fromResponse(settled.body as ResponseBody, spec));
    else if (stored.phase !== "settled") {
      this.waiters.set(id, (message) => finish(fromResponse(message.body as ResponseBody, spec)));
      const raced = this.options.ledger.responseTo(id);
      if (raced) { this.waiters.delete(id); finish(fromResponse(raced.body as ResponseBody, spec)); }
    } else finish(failure("result_unknown", "the request settled but its response is unavailable"));
    return job;
  }

  private encodeResult(result: ToolResult | Record<string, unknown>): { body: string; isError: boolean } {
    const full = JSON.stringify(result);
    const originalError = result && typeof result === "object" && "ok" in result && result.ok === false;
    if (full.length <= MAX_RESULT_CHARS) return { body: full, isError: originalError };
    const artifacts = this.options.resultArtifacts;
    if (!artifacts) return { body: JSON.stringify(failure("internal_error", "result was too large and result storage is unavailable")), isError: true };
    const now = Date.now();
    mkdirSync(artifacts.hostDir, { recursive: true, mode: 0o700 });
    const name = `result-${now}-${randomBytes(6).toString("hex")}.json`;
    const file = join(artifacts.hostDir, name);
    const temp = `${file}.tmp`;
    writeFileSync(temp, full, { mode: 0o600 });
    renameSync(temp, file);
    const ttl = artifacts.ttlMs ?? 24 * 3_600_000;
    try {
      for (const entry of readdirSync(artifacts.hostDir)) {
        if (!/^result-\d+-[a-f0-9]+\.json$/.test(entry)) continue;
        const old = join(artifacts.hostDir, entry);
        if (now - statSync(old).mtimeMs > ttl) unlinkSync(old);
      }
    } catch (error) { this.options.log?.("result artifact cleanup failed", error); }
    const artifact = { path: artifacts.toAgentPath(file), bytes: Buffer.byteLength(full), sha256: createHash("sha256").update(full).digest("hex"),
      mime_type: "application/json", expires_at: now + ttl };
    if (originalError) {
      const source = (result as ToolResult & { ok: false }).error;
      return { body: JSON.stringify({ ok: false, error: { code: source.code, message: source.message, recovery_hint: source.recovery_hint,
        detail: { truncated: true, preview: full.slice(0, 40_000), artifact, note: "The complete JSON error is in artifact.path." } } }), isError: true };
    }
    return { body: JSON.stringify({ ok: true, result: { truncated: true, preview: full.slice(0, 40_000), artifact,
      note: "The complete JSON result is in artifact.path." } }), isError: false };
  }

  private list(binding: AgentBinding, only?: string): ToolResult {
    const summary = this.options.members.describe("agent");
    // Agents reach each other through the agent tools, not as capabilities.
    const all = summary.members.filter((member) => !AGENT_ID.test(member.id) && member.id !== "service:agents" && member.id !== "service:gate" && member.id !== "service:devices").map((member) => {
      let words: WordSpec[] = [];
      try { words = this.options.members.describe("agent", member.id).members[0]?.words ?? []; } catch { /* vanished */ }
      return { id: member.id, kind: member.kind, name: member.name, ...(member.online === undefined ? {} : { online: member.online }),
        capabilities: words.filter((word) => word.kind === "request" && binding.allowsWord(member.id, word.word)).map((word) => ({ word: word.word, ...(word.label ? { label: word.label } : {}),
          summary: word.description.split(/(?<=[.。])\s/u)[0]!.slice(0, 160), effect: effectOf(word) })) };
    }).filter((member) => member.capabilities.length);
    if (!only) return { ok: true, result: { members: all } };
    // One member's list must not read as everything there is: name the others, so a missing ability is looked for there.
    const members = all.filter((member) => member.id === only);
    const others = all.filter((member) => member.id !== only).map((member) => member.id);
    if (!members.length) return failure("payload_invalid", `no member ${only}; members are ${others.join(", ") || "none"}; call capability_list without member to see what each can do`);
    return { ok: true, result: { members, other_members: others, note: "Only this member is listed. Call capability_list without member to see every member and its capabilities." } };
  }

  private describe(binding: AgentBinding, member: string, word?: string): ToolResult {
    if (member === "service:devices") return failure("payload_invalid", "use device_describe for device management");
    if (member === "service:agents") return failure("payload_invalid", "other agents are reached with the agent tools");
    let words: WordSpec[];
    try { words = this.options.members.describe("agent", member).members[0]?.words ?? []; }
    catch { return failure("payload_invalid", `no member ${member}; capability_list shows what exists`); }
    const chosen = words.filter((item) => item.kind === "request" && binding.allowsWord(member, item.word) && (!word || item.word === word));
    if (!chosen.length) return failure("payload_invalid", `${member} has no capability ${word}; capability_describe without word lists them`);
    return { ok: true, result: { member, capabilities: chosen.map((item) => ({ word: item.word, label: item.label, description: item.description,
      input_schema: item.input_schema ?? { type: "object" }, output_schema: item.result_schema ?? null, effect: effectOf(item),
      timeout_ms: item.timeout_ms ?? null })) } };
  }

  private history(args: Record<string, unknown>): ToolResult {
    const line = (message: Message) => ({ seq: message.seq, ts: new Date(message.ts).toISOString(), from: message.from, to: message.to, word: message.word,
      text: typeof message.body.text === "string" ? message.body.text : JSON.stringify(message.body).slice(0, 400) });
    if (typeof args.read_seq === "number") {
      const [message] = this.options.ledger.list({ after: args.read_seq - 1, limit: 1 });
      if (!message || message.seq !== args.read_seq) return failure("payload_invalid", "no message with this seq");
      if (!["person:owner", "agent:main"].includes(message.from) && !["person:owner", "agent:main"].includes(message.to ?? "")) return failure("forbidden", "only conversation messages can be read");
      return { ok: true, result: { message: { ...line(message), body: message.body } } };
    }
    const needle = typeof args.text === "string" ? args.text.toLowerCase() : "";
    const from = args.speaker === "owner" ? "person:owner" : args.speaker === "agent" ? "agent:main" : null;
    const limit = typeof args.limit === "number" ? Math.min(Math.max(1, Math.trunc(args.limit)), 50) : 20;
    let before = typeof args.before_seq === "number" ? args.before_seq : Number.MAX_SAFE_INTEGER;
    const hits: ReturnType<typeof line>[] = [];
    let scanned = 0;
    while (hits.length < limit && scanned < 20_000) {
      const page = this.options.ledger.list({ before, limit: 1000 });
      if (!page.length) break;
      scanned += page.length;
      for (const message of page.reverse()) {
        const conversation = message.kind === "request" && message.word === "say" &&
          ((message.from === "person:owner" && message.to === "agent:main") || (message.from === "agent:main" && message.to === "person:owner"));
        if (!conversation || (from && message.from !== from) || typeof message.body.text !== "string") continue;
        if (needle && !message.body.text.toLowerCase().includes(needle)) continue;
        hits.push({ ...line(message), text: message.body.text.slice(0, 300) });
        if (hits.length >= limit) break;
      }
      before = page[page.length - 1]!.seq;
    }
    return { ok: true, result: { messages: hits, ...(hits.length ? { next_before_seq: hits[hits.length - 1]!.seq } : {}) } };
  }
}
