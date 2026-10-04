import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID } from "../../../sdk/src/words";
import type { Ledger } from "../world/ledger";
import type { WorldMembers } from "../world/member";
import { RouterError, type TrustedRouteContext, type WorldRouter } from "../world/router";

/** The closed set of error codes every ash tool may return. A test keeps the code honest. */
export const TOOL_ERROR_CODES = ["payload_invalid", "forbidden", "denied", "unreachable", "timeout", "result_unknown", "internal_error", "capability_error"] as const;
export type ToolErrorCode = typeof TOOL_ERROR_CODES[number];
export type ToolResult = { ok: true; result: unknown } | { ok: false; error: { code: ToolErrorCode; message: string; recovery_hint: string; detail?: unknown } };
export type ConfirmOutcome = "approved" | "rejected" | "cancelled" | "unavailable";

/** One agent's connection: its credential, and the turn it is working in right now (if any). */
export class AgentBinding {
  readonly token = randomBytes(24).toString("base64url");
  private current: { turn: string; signal: AbortSignal } | null = null;
  readonly jobs = new Map<string, Job>();
  /** Replaced when the owner or a manager changes the agent's declaration; applies from the next call. */
  policy: AgentPolicy;
  constructor(readonly member: string, readonly label: string, readonly sessionId: () => string | null, policy: AgentPolicy = {}) { this.policy = policy; }
  /** The fixed tools this agent may use (its declaration); all when it says nothing. */
  allowsTool(name: string): boolean { return !this.policy.tools || this.policy.tools.includes(name) || META_ALWAYS.has(name); }
  allowsWord(member: string, word: string): boolean { return this.policy.words?.(member, word) ?? true; }
  begin(turn: string, signal: AbortSignal): void { this.current = { turn, signal }; }
  end(turn: string): void { if (this.current?.turn === turn) this.current = null; }
  get active(): { turn: string; signal: AbortSignal } | null { return this.current && !this.current.signal.aborted ? this.current : null; }
}

/** What an agent's declaration lets it use. */
export interface AgentPolicy { tools?: readonly string[]; words?: (member: string, word: string) => boolean }
// Receipts can always be collected and cancelled, whatever else an agent may use.
const META_ALWAYS = new Set(["await_result", "list_pending", "cancel"]);

interface Job { id: string; member: string; word: string; label: string; turn: string; at: number; done: Promise<ToolResult>; result: ToolResult | null }

export interface AgentMcpOptions {
  router: WorldRouter;
  members: WorldMembers;
  ledger: Ledger;
  /** The agent asks the owner to approve something it is about to do; the same card as any approval. */
  confirm(input: { binding: AgentBinding; turn: string; callId: string; title: string; detail: string; signal: AbortSignal }): Promise<ConfirmOutcome>;
  /** Pause, quiet hours and similar facts for system_status. */
  status(): Record<string, unknown>;
  /** Other agents in this world (agent:main is the only one today). */
  fastPathMs?: number;
  maxWaitMs?: number;
  log?: (...args: unknown[]) => void;
}

const FAST_PATH_MS = 15_000;
const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
// The agent runtime gives each MCP call 60 s; a wait must answer before that.
const MAX_WAIT_MS = 50_000;
const MAX_RESULT_CHARS = 60_000;
const DEFERRED = new Set(["human_confirm"]);

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });

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
    default: return failure("capability_error", message, { code });
  }
}

function fromError(error: unknown): ToolResult {
  if (error instanceof RouterError) return fromResponse({ ok: false, error: { code: error.code, message: error.message } });
  return failure("internal_error", error instanceof Error ? error.message : "tool failed");
}

const TOOLS = [
  // system
  { name: "system_status", description: "Current time and time zone, whether ash is paused by the owner, and quiet hours. Read-only.", inputSchema: object({}) },
  { name: "vault_list", description: "Names and kinds of the credentials in the owner's vault. Values are never returned; model keys are used by ash on your behalf.", inputSchema: object({}) },
  { name: "vault_describe", description: "One vault entry's name, kind and when it was set. Never the value.", inputSchema: object({ ref: text("Entry name, e.g. DEEPSEEK_API_KEY") }, ["ref"]) },
  { name: "timer_set", description: "Schedule a message for later: deliver=owner sends text to the owner as a due reminder; deliver=self wakes you with the text. Give at (epoch ms) for once, every (seconds, >= 60) to repeat. Returns the timer id.",
    inputSchema: object({ label: text("Short name shown in the owner's timer list"), text: text("What to deliver"), deliver: { type: "string", enum: ["owner", "self"] },
      at: { type: "number", description: "Epoch ms of the first delivery" }, every: { type: "integer", minimum: 60, description: "Repeat interval in seconds" } }, ["label", "text", "deliver"]) },
  { name: "timer_list", description: "Active timers.", inputSchema: object({}) },
  { name: "timer_cancel", description: "Cancel a timer by id; cancelled=false means it already fired or never existed.", inputSchema: object({ id: text("Timer id from timer_set or timer_list") }, ["id"]) },
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
      allow_custom: { type: "boolean", description: "Let the owner type their own answer" } }, ["question", "options"]) },
  { name: "human_show", description: "Show the owner a card: a link {type:link,url,title,summary?}, a workspace file {type:file,workspace:'home',path,name,mime_type,size}, a workspace image {type:image,workspace:'home',path,alt?}, or a permission card {type:permission,permission,why} naming an Android setting to switch on (calendar, notifications, battery, accessibility, all_files, usage, write_settings, overlay, shizuku). Paths are relative to your workspace.",
    inputSchema: object({ card: { type: "object", description: "The card, see the description" } }, ["card"]) },
  { name: "human_confirm", description: "Ask the owner to approve something before you do it; they see an approval card with your title and detail. Use it when you are about to do something consequential that ash would not ask about by itself, or when you are unsure the owner wants it. Returns {decision: approved|rejected}. If the owner takes longer than 15 s you get {status:accepted, request_id}; then call await_result.",
    inputSchema: object({ title: text("One line: what you want to do"), detail: text("Exactly what will happen: the text to send, the command, the target") }, ["title", "detail"]) },
  // agents
  { name: "agent_list", description: "Every agent in ash: id, name, what it does, and whether it is idle, working or stopped. agent:main is the assistant the owner talks with and the only one that speaks to the owner.", inputSchema: object({}) },
  { name: "agent_describe", description: "One agent's declaration: what it is for, its job, the tools and ash capabilities it was given, its schedule, its state.",
    inputSchema: object({ agent: text("Agent id, e.g. agent:keeper") }, ["agent"]) },
  { name: "agent_ask", description: "Ask another agent and get its answer: {ok, result: {agent, answer}}. It answers in a turn of its own; if that takes longer than 50 s (or wait=false) you get {status:accepted, request_id} and collect the answer with await_result.",
    inputSchema: object({ agent: text("Agent id from agent_list"), text: text("The question"), wait: { type: "boolean" } }, ["agent", "text"]) },
  { name: "agent_tell", description: "Tell another agent something without waiting. It handles it in a turn of its own; what it says back arrives later as a message to you, which you need not answer.",
    inputSchema: object({ agent: text("Agent id from agent_list"), text: text("The message") }, ["agent", "text"]) },
  // system: managing agents (only for agents given it)
  { name: "agent_create", description: "Create a new agent. It runs at once in its own session and workspace. Give id (agent:<lowercase name>), name, summary (what others are told it does), brief (its job, in its own words), and optionally tools (fixed tool names; default: discovery, talking to agents, history, status), words (ash capabilities as member/word patterns, e.g. service:self/read; default none) and every (seconds between scheduled wakes, >= 600). It may need the owner's approval.",
    inputSchema: object({ id: text("agent:<lowercase name>"), name: text("Short name"), summary: text("One line others see"), brief: text("Its job"),
      tools: { type: "array", items: { type: "string" } }, words: { type: "array", items: { type: "string" } }, every: { type: "integer", minimum: 600 } }, ["id", "name", "summary", "brief"]) },
  { name: "agent_update", description: "Change an agent's declaration (name, summary, brief, tools, words, every); it applies from its next turn. It may need the owner's approval.",
    inputSchema: object({ agent: text("Agent id"), name: text("Short name"), summary: text("One line others see"), brief: text("Its job"),
      tools: { type: "array", items: { type: "string" } }, words: { type: "array", items: { type: "string" } }, every: { type: "integer", minimum: 600 } }, ["agent"]) },
  { name: "agent_start", description: "Let a stopped agent take turns again.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_stop", description: "Stop an agent: its current turn is cancelled and it takes no new ones until started; messages wait for it.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_restart", description: "Cancel an agent's current turn and reopen its session (history is kept).", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  { name: "agent_remove", description: "Remove an agent you created. Built-in agents can only be stopped. It may need the owner's approval.", inputSchema: object({ agent: text("Agent id") }, ["agent"]) },
  // meta
  { name: "capability_list", description: "Everything else ash can do for you, live: each member (the phone, the owner's other devices, ash services) with its capabilities' names, one-line summaries and effect (read, act, write, send, execute, structure). New devices appear here as soon as they connect. Next: capability_describe, then capability_call.",
    inputSchema: object({ member: text("Only this member") }) },
  { name: "capability_describe", description: "Full contract of one member's capabilities, or of one capability: description, input_schema, output_schema, effect, label, timeout.",
    inputSchema: object({ member: text("Member id, e.g. device:phone"), word: text("Capability name; omit for all of the member's") }, ["member"]) },
  { name: "capability_call", description: "Call one capability with a body matching its input_schema. Read-only capabilities run at once; others may first ask the owner (the call then waits for their answer). Returns {ok, result} or {ok:false, error}. If it takes longer than 15 s (wait=true: 50 s) you get {status:accepted, request_id}: use await_result. wait=false returns the receipt at once.",
    inputSchema: object({ member: text("Member id"), word: text("Capability name"), body: { type: "object", description: "Input matching the capability's input_schema" }, wait: { type: "boolean" } }, ["member", "word"]) },
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

  bind(member: string, label: string, sessionId: () => string | null, policy: AgentPolicy = {}): AgentBinding {
    const binding = new AgentBinding(member, label, sessionId, policy);
    this.bindings.set(binding.token, binding);
    return binding;
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => { void this.serve(request, response); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.http = server;
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    return this.url;
  }

  async close(): Promise<void> {
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
        let body = JSON.stringify(result);
        if (body.length > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}… [truncated: result too large]`;
        return { content: [{ type: "text", text: body }], ...(result && typeof result === "object" && "ok" in result && result.ok === false ? { isError: true } : {}) };
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
    if (name === "await_result") return this.awaitResult(binding, args);
    if (name === "list_pending") return { ok: true, result: { pending: [...binding.jobs.values()].filter((job) => !job.result).map((job) => ({ request_id: job.id, member: job.member, word: job.word, label: job.label, since: job.at })) } };
    if (name === "cancel") {
      const job = typeof args.request_id === "string" ? binding.jobs.get(args.request_id) : undefined;
      if (!job) return failure("payload_invalid", "no call of yours has this request_id");
      if (!job.result) this.options.router.cancel([job.id]);
      return { ok: true, result: { cancelled: !job.result } };
    }
    const active = binding.active;
    if (!active) return failure("forbidden", "no turn is running for you; ash tools work only while you are handling a message or wake");
    const turnSignal = AbortSignal.any([active.signal, signal]);
    try {
      switch (name) {
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
        case "human_say": return await this.send(binding, active.turn, "person:owner", "say", { text: args.text, kind: args.kind ?? "reply" }, turnSignal);
        case "human_notify": return await this.send(binding, active.turn, "person:owner", "say", { text: args.text, kind: "heads_up" }, turnSignal);
        case "human_ask": {
          const options = Array.isArray(args.options) ? args.options : [];
          const sent = await this.send(binding, active.turn, "person:owner", "show", { card: { type: "options", prompt: args.question, options,
            ...(args.allow_custom === true ? { allow_custom: true } : {}) } }, turnSignal);
          return sent.ok ? { ok: true, result: { asked: true, note: "The owner's answer will arrive as their next message to you." } } : sent;
        }
        case "human_show": return await this.send(binding, active.turn, "person:owner", "show", { card: args.card }, turnSignal);
        case "human_confirm": return await this.confirm(binding, active.turn, args, turnSignal);
        // Discovery and communication (agent words) and management (system words) are the Agent system's; these tools
        // only carry the request, as this agent. What each agent may use is its declaration's business.
        case "agent_list": return await this.send(binding, active.turn, "service:agents", "list", {}, turnSignal);
        case "agent_describe": return await this.send(binding, active.turn, "service:agents", "describe", { agent: args.agent }, turnSignal);
        case "agent_tell": return await this.send(binding, active.turn, "service:agents", "tell", { agent: args.agent, text: args.text }, turnSignal);
        case "agent_ask": return await this.job(binding, active.turn, "service:agents", "ask", { agent: args.agent, text: args.text },
          args.wait === false ? 0 : (this.options.maxWaitMs ?? MAX_WAIT_MS), turnSignal);
        case "agent_create": return await this.job(binding, active.turn, "service:agents", "declare", pick(args, ["id", "name", "summary", "brief", "tools", "words", "every"]), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "agent_update": return await this.job(binding, active.turn, "service:agents", "update", pick(args, ["agent", "name", "summary", "brief", "tools", "words", "every"]), this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "agent_start":
        case "agent_stop":
        case "agent_restart":
        case "agent_remove": return await this.job(binding, active.turn, "service:agents", name.slice("agent_".length), { agent: args.agent }, this.options.fastPathMs ?? FAST_PATH_MS, turnSignal);
        case "capability_list": return this.list(binding, typeof args.member === "string" ? args.member : undefined);
        case "capability_describe": return this.describe(binding, String(args.member ?? ""), typeof args.word === "string" ? args.word : undefined);
        case "capability_call": {
          if (typeof args.member !== "string" || typeof args.word !== "string") return failure("payload_invalid", "member and word are required");
          if (args.member === "service:agents") return failure("forbidden", "use the agent tools for other agents");
          if (!binding.allowsWord(args.member, args.word)) return failure("forbidden", `${args.member}/${args.word} is not among the capabilities you may use`);
          if (args.body !== undefined && (typeof args.body !== "object" || args.body === null || Array.isArray(args.body))) return failure("payload_invalid", "body must be an object");
          return await this.job(binding, active.turn, args.member, args.word, (args.body ?? {}) as Record<string, unknown>,
            args.wait === false ? 0 : args.wait === true ? (this.options.maxWaitMs ?? MAX_WAIT_MS) : (this.options.fastPathMs ?? FAST_PATH_MS), turnSignal);
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
  private async job(binding: AgentBinding, turn: string, member: string, word: string, body: Record<string, unknown>, waitMs: number, signal: AbortSignal): Promise<ToolResult | Record<string, unknown>> {
    const spec = this.spec(member, word);
    let sent: { id: string };
    try {
      sent = await this.options.router.send(this.context(binding, turn), { to: member, kind: "request", word, body,
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
    void done.then((result) => { job.result = result; });
    binding.jobs.set(job.id, job);
    if (binding.jobs.size > 200) for (const [id, old] of binding.jobs) { if (old.result) binding.jobs.delete(id); if (binding.jobs.size <= 100) break; }
    return this.within(job, waitMs);
  }

  private async within(job: Job, waitMs: number): Promise<ToolResult | Record<string, unknown>> {
    if (job.result) return job.result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    const result = await Promise.race([job.done, late]);
    clearTimeout(timer);
    if (result) return result;
    return { status: "accepted", request_id: job.id, member: job.member, word: job.word,
      guidance: "Still running (it may be waiting for the owner). Call await_result with this request_id; do not call the capability again." };
  }

  private async awaitResult(binding: AgentBinding, args: Record<string, unknown>): Promise<ToolResult | Record<string, unknown>> {
    const job = typeof args.request_id === "string" ? binding.jobs.get(args.request_id) : undefined;
    if (!job) return failure("payload_invalid", "no call of yours has this request_id");
    const timeout = typeof args.timeout_ms === "number" ? Math.max(0, Math.min(args.timeout_ms, this.options.maxWaitMs ?? MAX_WAIT_MS)) : (this.options.maxWaitMs ?? MAX_WAIT_MS);
    return this.within(job, timeout);
  }

  private async confirm(binding: AgentBinding, turn: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult | Record<string, unknown>> {
    if (typeof args.title !== "string" || !args.title.trim() || typeof args.detail !== "string") return failure("payload_invalid", "title and detail are required");
    const callId = `confirm${++this.callSeq}${randomBytes(4).toString("hex")}`;
    const done = this.options.confirm({ binding, turn, callId, title: args.title.trim().slice(0, 120), detail: args.detail.slice(0, 2000), signal })
      .then((outcome): ToolResult => outcome === "approved" ? { ok: true, result: { decision: "approved" } }
        : outcome === "rejected" ? { ok: true, result: { decision: "rejected" } }
        : outcome === "cancelled" ? failure("result_unknown", "the confirmation was cancelled before the owner answered")
        : failure("unreachable", "the approval card could not be shown"))
      .catch((error) => fromError(error));
    const job: Job = { id: callId, member: "person:owner", word: "confirm", label: "Confirm", turn, at: Date.now(), done, result: null };
    void done.then((result) => { job.result = result; });
    binding.jobs.set(job.id, job);
    return this.within(job, this.options.fastPathMs ?? FAST_PATH_MS);
  }

  private list(binding: AgentBinding, only?: string): ToolResult {
    const summary = this.options.members.describe("agent");
    // Agents reach each other through the agent tools, not as capabilities.
    const members = summary.members.filter((member) => !AGENT_ID.test(member.id) && member.id !== "service:agents" && (!only || member.id === only)).map((member) => {
      let words: WordSpec[] = [];
      try { words = this.options.members.describe("agent", member.id).members[0]?.words ?? []; } catch { /* vanished */ }
      return { id: member.id, kind: member.kind, name: member.name, ...(member.online === undefined ? {} : { online: member.online }),
        capabilities: words.filter((word) => word.kind === "request" && binding.allowsWord(member.id, word.word)).map((word) => ({ word: word.word, ...(word.label ? { label: word.label } : {}),
          summary: word.description.split(/(?<=[.。])\s/u)[0]!.slice(0, 160), effect: effectOf(word) })) };
    }).filter((member) => member.capabilities.length);
    if (only && !members.length) return failure("payload_invalid", `no member ${only}; call capability_list without member`);
    return { ok: true, result: { members } };
  }

  private describe(binding: AgentBinding, member: string, word?: string): ToolResult {
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
