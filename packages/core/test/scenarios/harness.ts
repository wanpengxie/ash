/**
 * The scenario harness: starts the new hub (`startHub`) and talks to it the way the outside world does, and only that way.
 *
 *   - a person: a `packages/link` client on the human channel of the local connection (`Authorization: Bearer <local
 *     token>` + a signed challenge), the way the phone app's chat page connects;
 *   - a hand: a `packages/link` client on the device channel, with a signed identity and a manifest;
 *   - an agent: `scriptedDriver()`, a fake `AgentDriver` that takes its turns from a script and calls the hub's tools on
 *     `/mcp` with the token the hub gave it in `start()` (SPEC-08 §1.4 `spec.tools`);
 *   - the host: the T15 `FakeHost` (the hub reports to it, the harness plays its events).
 *
 * Nothing here imports a hub module, opens the database or reads a file of the hub's. If the hub does something, a test
 * sees it as a frame a person gets, a call a hand gets, a message an agent is given, a call the host gets, or a record
 * `service:history` returns.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createNodeClient, type CallOutcome, type HandClient, type HandHandlers, type PresentOutcome } from "../../../link/src";
import type { CallFrame, CapabilitySpec, HandKind, HelloChannels, ManifestAckFrame, PresentFrame, SendRequest, SendResultFrame, SyncPageFrame } from "../../../sdk/src/link";
import { base64url, deviceId, handId } from "../../../sdk/src/ids";
import type { Message, Reply } from "../../../sdk/src/message";
import { standardAction } from "../../../sdk/src/namespaces";
import type { AgentDriver, AgentDriverFactory, AgentEvent, AgentStartSpec, DriverMessage } from "../../../sdk/src/driver";
import { startHub, type Hub } from "../../src/next";
import { FakeGateway } from "../../../link/test/fixtures/fake-gateway";
import { FakeHost, type FakeHostConnection } from "../fixtures/host";
import { hubKey } from "../edges/link-server/control-harness";
import { eventually } from "../fixtures/wait";

export type { DriverMessage };

export const OWNER = "person:owner";
export const MAIN = "agent:main";
export const GATE = "service:gate";

// --- small things every test uses ----------------------------------------------------------------------------------------

export function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Lets things that must NOT happen have their chance to happen. The only fixed wait in the scenarios; it is used for
 * negative checks (nothing woke the agent, no card appeared) and never to wait for something that should arrive.
 */
export const quiet = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const bodyOf = (m: { body: unknown }): Record<string, unknown> => (m.body && typeof m.body === "object" ? (m.body as Record<string, unknown>) : {});
export const textOf = (m: { body: unknown }): string => {
  const text = bodyOf(m).text;
  return typeof text === "string" ? text : "";
};

/** Predicates over ledger messages (what a person's `sync` shows). */
export const sentBy = (from: string, word?: string) => (m: Message): boolean => m.from === from && (word === undefined || m.word === word);
export const toOwner = (word: string, from?: string) => (m: Message): boolean => m.kind !== "response" && m.to === OWNER && m.word === word && (from === undefined || m.from === from);
/** The approval card: the gate asks the owner. */
export const isApprovalAsk = (m: Message): boolean => m.kind === "request" && m.from === GATE && m.to === OWNER && m.word === "ask";

export const ownerMessage = (text: string) => (m: DriverMessage): boolean => m.from === OWNER && m.word === "say" && m.text === text;
/** The gate telling the agent that asked: an `agent:<x>/tell` from `service:gate` (BUILD-PROGRESS §7, decision 4). */
/** The owner's answer to an approval, said to the agent in the conversation: `[answers <pending id>, option once] 批准：…`. */
export const ownerApproval = (m: DriverMessage): boolean => m.from === OWNER && m.word === "say" && m.text.startsWith("[answers ");
/** A background `tell` whose text names this id (a `pending_id`, a `setup_id`). */
export const tellAbout = (id: string) => (m: DriverMessage): boolean => m.word === "tell" && m.text.includes(id);

// --- identities (a hand proves itself by signing the challenge, SPEC-03 §2.2) --------------------------------------------

export interface Identity {
  /** SPKI, base64url */
  publicKey: string;
  handId: string;
  /** ECDSA P-256 over the UTF-8 bytes of the nonce, ASN.1 DER, base64url */
  sign(nonce: string): string;
}

export async function newIdentity(): Promise<Identity> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey: base64url(spki),
    handId: await handId(spki),
    sign: (nonce) => base64url(signBytes("sha256", Buffer.from(nonce, "utf8"), { key: privateKey, dsaEncoding: "der" })),
  };
}

// --- capabilities a hand can offer -----------------------------------------------------------------------------------------

/** A capability as the standard namespaces define it (SPEC-02 §4.3); [over] changes fields for the scenario. */
export function standardCapability(name: string, over: Partial<CapabilitySpec> = {}): CapabilitySpec {
  const action = standardAction(name);
  if (!action) throw new Error(`${name} is not a standard action`);
  return {
    name: action.name, description: action.description, label: action.label, input_schema: action.input_schema as Record<string, unknown>,
    result_schema: action.result_schema as Record<string, unknown>, effect: action.effect, risk: action.risk,
    ...(action.foreground ? { foreground: true } : {}), ...(action.per_call_risk ? { per_call_risk: true } : {}),
    ...(action.callers ? { callers: [...action.callers] } : {}), ...over,
  };
}

/** An extension capability (`x.<name>.<action>`) for scenarios that need a particular effect and risk. */
export function extensionCapability(name: string, over: Partial<CapabilitySpec> = {}): CapabilitySpec {
  return { name, description: `${name}: a capability of the scenario hand.`, label: `在${name}`, input_schema: { type: "object" }, effect: "read", risk: "none", ...over };
}

export const textResult = (text: string, data?: unknown): CallOutcome => ({ ok: true, content: [{ type: "text", text }], ...(data !== undefined ? { data } : {}) });

// --- the scripted agent driver ---------------------------------------------------------------------------------------------

/**
 * What a tool call on `/mcp` gave back (decision 5 of BUILD-PROGRESS §7): a success carries the word's result as
 * `structuredContent` (and its content, or the data as JSON text, in `content`); a failure has `isError` and
 * `structuredContent: {error: ErrorBody}`. A receipt's data is `{status, request_id | pending_id, ...}`.
 */
export interface ToolResult {
  isError: boolean;
  /** `structuredContent` */
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The text parts of `content`, joined. */
  text: string;
}
/** The error code of a failed tool result. */
export const errorCode = (r: ToolResult): string | undefined => r.data?.error?.code;

/** The data of a reply (`Reply.result` is a `WordResult {data, content}`). */
export const dataOf = (reply: Reply): any => (reply.ok ? reply.result?.data : undefined); // eslint-disable-line @typescript-eslint/no-explicit-any

/** The data of a tool result (a receipt is `{status, request_id | pending_id}`). */
export const resultOf = (r: ToolResult): any => r.data; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ToolCallRecord { agent: string; key: string; turn: string; name: string; args: Record<string, unknown>; result: ToolResult }

export interface TurnContext {
  agent: string;
  /** The lane (session key). */
  key: string;
  turn: string;
  /** What the hub gave this turn. */
  messages: DriverMessage[];
  /** Aborted when the hub interrupts the turn. */
  signal: AbortSignal;
  /** Text said into the running turn by `steer`. */
  steers: string[];
  /** The agent speaks: the hub turns it into a `say` to the owner (front lane). */
  say(text: string): void;
  /** One tool of the hub's tool surface. */
  tool(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** `capability_call`; [envelope] holds the call metadata (`wait`, `approval_ttl_minutes`, `purpose`, SPEC-02 §3.3). */
  call(member: string, word: string, body?: Record<string, unknown>, envelope?: { wait?: boolean; approval_ttl_minutes?: number; purpose?: string }): Promise<ToolResult>;
  /** Waits for [promise] but gives up (resolves undefined) when the turn is interrupted. */
  until<T>(promise: Promise<T>): Promise<T | undefined>;
}
export type TurnScript = (turn: TurnContext) => void | Promise<void>;

export type TurnOutcome = "running" | "completed" | "cancelled" | "error" | "interrupted";
export interface TurnRecord {
  agent: string;
  key: string;
  turn: string;
  messages: DriverMessage[];
  outcome: TurnOutcome;
  /** The script's own error, when the turn ended in `error`. */
  error?: string;
  said: string[];
  steers: string[];
  /** Resolves when the turn has ended. */
  done: Promise<void>;
}

export interface Delivery { via: "send" | "followup" | "steer"; agent: string; key: string; messages: DriverMessage[] }

/** The tool surface as one agent sees it: a Streamable HTTP MCP client with the agent's own bearer token. */
class ToolLine {
  private client: Promise<Client> | undefined;
  constructor(private readonly tools: AgentStartSpec["tools"], private readonly lane: string) {}
  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "scripted-driver", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(this.tools.mcp_url), { requestInit: { headers: { Authorization: `Bearer ${this.tools.tokens[this.lane]}` } } }));
      return client;
    })();
    return this.client;
  }
  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.connect();
    const res = (await client.callTool({ name, arguments: args })) as { content?: unknown; structuredContent?: unknown; isError?: unknown };
    const parts = Array.isArray(res.content) ? (res.content as { type?: string; text?: string }[]) : [];
    const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
    return { isError: Boolean(res.isError), data: res.structuredContent, text };
  }
  async close(): Promise<void> {
    const client = await this.client?.catch(() => undefined);
    await client?.close().catch(() => {});
  }
}

interface Running { abort: AbortController; record: TurnRecord; /** The process was killed: nothing more is said about this turn. */ killed?: boolean }

/**
 * A fake agent runtime. It registers under `dsh` by default and under any other runtime kind a scenario names, keeps one
 * script per agent (or one for all), and runs it as the body of each turn. Everything the hub asked of it is recorded.
 */
export class ScriptedDriver {
  readonly drivers: Record<string, AgentDriverFactory>;
  readonly turns: TurnRecord[] = [];
  readonly calls: ToolCallRecord[] = [];
  readonly starts: { agent: string; spec: AgentStartSpec }[] = [];
  readonly stops: { agent: string; reason: string }[] = [];
  /** Everything handed to `send`, `followup` and `steer`, in order. */
  readonly deliveries: Delivery[] = [];
  /** The prompt modules the hub injected into a lane (the content of each). */
  readonly injections: { agent: string; key: string; modules: { id: string; content: string }[] }[] = [];
  readonly interrupts: { agent: string; key: string }[] = [];
  /** While set, `start()` waits for it: the runtime is still coming up. */
  private startGate: Promise<void> | null = null;
  private readonly reporters: ((event: AgentEvent) => void)[] = [];
  /** The first-meeting wake gets a greeting, as the real agent gives (the hub counts the meeting held only once the agent has spoken); every other turn does nothing. */
  private fallback: TurnScript = async (turn) => {
    if (turn.messages.some((m) => m.word === "wake" && m.text.startsWith("Wake · first_meeting"))) await turn.tool("human_say", { text: "你好，我是 Ash。" });
  };
  private readonly scripts = new Map<string, TurnScript>();
  private readonly lines = new Map<string, ToolLine>();
  private readonly running = new Map<string, Running>();
  private readonly queued = new Map<string, DriverMessage[][]>();
  private serial = 0;

  constructor(kinds: readonly string[] = ["dsh"]) {
    this.drivers = Object.fromEntries(kinds.map((kind) => [kind, (report: (event: AgentEvent) => void) => this.driver(report)]));
  }

  /** The script of every turn of every agent that has no script of its own. */
  script(fn: TurnScript): void { this.fallback = fn; }
  /** Makes every `start()` from now on wait for [until] (the runtime takes its time to come up); `null` lets starts through again. */
  holdStarts(until: Promise<void> | null): void { this.startGate = until; }
  /**
   * The runtime process of [agent] dies (kill -9): the hub hears `ended` and nothing else. Its running turns are gone with it
   * and never report `turn.ended` (a real process killed in the middle of a prompt says nothing more): ending them is the hub's.
   */
  die(agent: string, reason = "killed"): void {
    for (const [slot, run] of [...this.running]) if (slot.startsWith(`${agent}/`)) { run.killed = true; run.abort.abort(); this.running.delete(slot); }
    for (const report of this.reporters) report({ event: "ended", agent, reason });
  }
  /** The script of one agent (`agent:main`). */
  scriptFor(agent: string, fn: TurnScript): void { this.scripts.set(agent, fn); }

  /** The first turn that matches, waiting for it. */
  turn(match: (record: TurnRecord) => boolean, what: string): Promise<TurnRecord> {
    return eventually(() => this.turns.find(match), what);
  }
  /** The first delivery that holds a message that matches (any of send, followup, steer), waiting for it. */
  async delivery(match: (message: DriverMessage) => boolean, what: string): Promise<{ delivery: Delivery; message: DriverMessage }> {
    return eventually(() => {
      for (const delivery of this.deliveries) {
        const message = delivery.messages.find(match);
        if (message) return { delivery, message };
      }
      return null;
    }, what);
  }
  /** Every message the driver was given (send and followup), flattened. */
  messages(): DriverMessage[] { return this.deliveries.flatMap((d) => d.messages); }
  /** The first tool call of this name, waiting for it. */
  toolCall(name: string, what = `a ${name} call`): Promise<ToolCallRecord> {
    return eventually(() => this.calls.find((call) => call.name === name), what);
  }

  /** Empties what was recorded about turns, deliveries and tool calls. */
  forget(): void {
    for (const list of [this.turns, this.calls, this.deliveries, this.injections]) list.length = 0;
  }

  private async closeLines(agent: string): Promise<void> {
    for (const [slot, line] of [...this.lines]) if (slot.startsWith(`${agent}/`)) { this.lines.delete(slot); await line.close(); }
  }

  /** Ends everything (the scenario is over or the hub is being restarted). */
  async dispose(): Promise<void> {
    for (const run of this.running.values()) run.abort.abort();
    this.running.clear();
    this.queued.clear();
    await Promise.all([...this.lines.values()].map((line) => line.close()));
    this.lines.clear();
  }

  private driver(report: (event: AgentEvent) => void): AgentDriver {
    const safe = (event: AgentEvent) => { try { report(event); } catch { /* the hub is gone */ } };
    this.reporters.push(safe);
    const handles = new Map<string, string>();
    const handleOf = (agent: string, key: string) => handles.get(`${agent}/${key}`) ?? null;
    const open = (agent: string, key: string) => { const handle = `h_${++this.serial}`; handles.set(`${agent}/${key}`, handle); safe({ event: "handle.updated", agent, key, handle }); return handle; };
    return {
      info: { kind: "dsh", models: [], abilities: { resume: true, steer: true, inject_live: true, images: false, compact: false, configure: [], plugins: false, mcp: true, system_prompt: "inject", credentials: false, usage: false } },
      status: () => ({ state: "running" }),
      restart: async () => {},
      session: {
        get: handleOf,
        set: async (agent, key, handle) => { handles.set(`${agent}/${key}`, handle); },
        new: async (agent, key) => ({ handle: open(agent, key) }),
        reload: async (agent, key) => ({ handle: open(agent, key) }),
        compact: async () => ({ compacted: false }),
      },
      inject: async (agent, key, content) => { this.injections.push({ agent, key, modules: (content.modules ?? []).map((m) => ({ id: m.id, content: m.content })) }); },
      configure: async () => ({}),
      plugins: async () => ({}),
      start: async (agent, spec) => {
        this.starts.push({ agent, spec });
        if (this.startGate) await this.startGate;
        await this.closeLines(agent);
        for (const key of spec.lanes) this.lines.set(`${agent}/${key}`, new ToolLine(spec.tools, key));
        for (const key of spec.lanes) if (!spec.sessions[key]) open(agent, key);
      },
      stop: async (agent, reason) => {
        this.stops.push({ agent, reason });
        for (const [slot, run] of this.running) if (slot.startsWith(`${agent}/`)) run.abort.abort();
        await this.closeLines(agent);
      },
      send: async (agent, key, batch) => {
        this.deliveries.push({ via: "send", agent, key, messages: batch });
        this.begin(safe, agent, key, batch);
      },
      followup: async (agent, key, batch) => {
        this.deliveries.push({ via: "followup", agent, key, messages: batch });
        const slot = `${agent}/${key}`;
        if (this.running.has(slot)) this.queued.set(slot, [...(this.queued.get(slot) ?? []), batch]);
        else this.begin(safe, agent, key, batch);
      },
      steer: async (agent, key, text) => {
        this.deliveries.push({ via: "steer", agent, key, messages: [{ id: `steer-${++this.serial}`, from: OWNER, word: "say", lane: key, at: Date.now(), text }] });
        const run = this.running.get(`${agent}/${key}`);
        run?.record.steers.push(text);
        return run !== undefined;
      },
      interrupt: async (agent, key) => {
        this.interrupts.push({ agent, key });
        this.running.get(`${agent}/${key}`)?.abort.abort();
      },
    };
  }

  private begin(report: (event: AgentEvent) => void, agent: string, key: string, batch: DriverMessage[]): void {
    const slot = `${agent}/${key}`;
    if (this.running.has(slot)) { this.queued.set(slot, [...(this.queued.get(slot) ?? []), batch]); return; }
    void this.run(report, agent, key, batch);
  }

  private async run(report: (event: AgentEvent) => void, agent: string, key: string, batch: DriverMessage[]): Promise<void> {
    const slot = `${agent}/${key}`;
    const turn = `t_${++this.serial}`;
    const abort = new AbortController();
    const finished = deferred();
    const record: TurnRecord = { agent, key, turn, messages: batch, outcome: "running", said: [], steers: [], done: finished.promise };
    this.turns.push(record);
    const running: Running = { abort, record };
    this.running.set(slot, running);
    report({ event: "turn.started", agent, key, turn, ids: batch.map((m) => m.id) });

    const aborted = new Promise<undefined>((resolve) => abort.signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const line = this.lines.get(slot);
      if (!line) throw new Error(`${slot} has no tool line (the hub never called start())`);
      report({ event: "tool", agent, key, turn, phase: "start", name });
      const result = await line.call(name, args);
      this.calls.push({ agent, key, turn, name, args, result });
      report({ event: "tool", agent, key, turn, phase: "end", name, summary: result.text.slice(0, 120) });
      return result;
    };
    const ctx: TurnContext = {
      agent, key, turn, messages: batch, signal: abort.signal, steers: record.steers,
      say: (text) => { record.said.push(text); report({ event: "output", agent, key, turn, text }); },
      tool,
      call: (member, word, body = {}, envelope = {}) => tool("capability_call", { member, word, body, ...envelope }),
      until: <T>(promise: Promise<T>) => Promise.race([promise, aborted]),
    };

    let outcome: Exclude<TurnOutcome, "running"> = "completed";
    try {
      await (this.scripts.get(agent) ?? this.fallback)(ctx);
      if (abort.signal.aborted) outcome = "interrupted";
    } catch (error) {
      outcome = abort.signal.aborted ? "interrupted" : "error";
      if (outcome === "error") record.error = error instanceof Error ? error.message : String(error);
    }
    record.outcome = outcome;
    if (this.running.get(slot) === running) this.running.delete(slot);
    if (!running.killed) report({ event: "turn.ended", agent, key, turn, outcome, ...(record.error ? { error: record.error } : {}) });
    finished.resolve();
    const next = this.queued.get(slot)?.shift();
    if (next) void this.run(report, agent, key, next);
  }
}

/** A script that does something different for each of the owner's exact sentences (and nothing for other turns). */
export function byOwnerText(handlers: Record<string, TurnScript>): TurnScript {
  return async (turn) => {
    for (const message of turn.messages) {
      if (message.from !== OWNER) continue;
      const handler = handlers[message.text];
      if (handler) return handler(turn);
    }
  };
}

/** The first `{$blob, ...}` reference inside a ledger body (long text is stored as an attachment, SPEC-01 §4.3). */
export function findBlob(value: unknown): { $blob: string; mime?: string; size?: number; summary?: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.$blob === "string") return record as { $blob: string };
  for (const child of Object.values(record)) {
    const found = findBlob(child);
    if (found) return found;
  }
  return undefined;
}

export const scriptedDriver = (kinds?: readonly string[]): ScriptedDriver => new ScriptedDriver(kinds);

// --- a person --------------------------------------------------------------------------------------------------------------

export type HumanSurface = "chat" | "notification" | "island" | "widget" | "status";
export interface HumanOptions {
  name?: string;
  label?: string;
  /** What this channel can show (SPEC-03 §2.1); the hub only presents on surfaces that are declared. Default: chat. */
  surfaces?: HumanSurface[];
  /** Reuse an identity: a new connection of the same phone/browser. */
  identity?: Identity;
}

/**
 * The owner on one channel: a hand that opened the human channel on the local connection. Everything the hub puts in the
 * conversation arrives through `sync`; everything it presents arrives as `present` frames.
 */
export class Human {
  /** Every message seen through sync, in arrival order (each id once). */
  readonly messages: Message[] = [];
  readonly presents: PresentFrame[] = [];
  /** `client:<sid>` of this channel. */
  clientId = "";
  private cursor = 0;
  private presentCursor = 0;
  private readonly known = new Set<string>();
  private presenter: (frame: PresentFrame) => PresentOutcome | Promise<PresentOutcome> = () => ({ ok: true });
  private firstPage = deferred();

  constructor(readonly client: HandClient, readonly identity: Identity) {}

  private cached: HandHandlers | undefined;
  /** @internal wired by the scenario */
  handlers(): HandHandlers {
    return (this.cached ??= {
      welcome: (welcome) => {
        const grant = welcome.channels.human;
        if (grant && "client" in grant) this.clientId = grant.client;
        this.client.openSync({ after: 0, follow: true, summary: true }, {
          page: (frame) => { this.take(frame.messages); if (frame.end) this.firstPage.resolve(); },
          message: (frame) => this.take([frame.message]),
        });
      },
      present: async (frame) => {
        this.presents.push(frame);
        return this.presenter(frame);
      },
    });
  }
  /** @internal */
  ready(): Promise<void> { return this.firstPage.promise; }

  private take(messages: Record<string, unknown>[]): void {
    for (const raw of messages) {
      const message = raw as unknown as Message;
      if (this.known.has(message.id)) continue;
      this.known.add(message.id);
      this.messages.push(message);
    }
  }

  /** How this channel answers `present` frames (default: shown). */
  onPresent(fn: (frame: PresentFrame) => PresentOutcome | Promise<PresentOutcome>): void { this.presenter = fn; }

  // --- saying things

  send(request: SendRequest): Promise<SendResultFrame> {
    return this.client.send({ client_id: `c_${Math.random().toString(36).slice(2)}`, ...request });
  }
  /** The owner says something to an agent (default `agent:main`) or answers an option card (`inReplyTo` + `optionId`). */
  say(text: string, o: { to?: string; clientId?: string; inReplyTo?: string; optionId?: string } = {}): Promise<SendResultFrame> {
    const body: Record<string, unknown> = {};
    if (text) body.text = text;
    if (o.inReplyTo) { body.in_reply_to = o.inReplyTo; body.option_id = o.optionId; }
    return this.send({ to: o.to ?? MAIN, kind: "request", word: "say", body, ...(o.clientId ? { client_id: o.clientId } : {}) });
  }
  /** Calls a word as the owner and waits for the response. */
  async call(to: string, word: string, body: Record<string, unknown> = {}): Promise<Reply> {
    const sent = await this.send({ to, kind: "request", word, body, wait: true });
    if (!sent.ok) return { ok: false, error: sent.error };
    return (sent.response as Reply | undefined) ?? { ok: true };
  }
  /** Answers a card the hub asked (`ask`) by option id: `once`, `always` or `deny` on an approval card. The answer is the response to that request. */
  answer(ask: Message, choice: string, text?: string): Promise<SendResultFrame> {
    return this.send({ to: ask.from, kind: "response", word: "ask", reply_to: ask.id, body: { ok: true, result: { data: { choice, ...(text ? { text } : {}) } } } });
  }
  /** The ids of the options on a card the hub asked. */
  optionIds(ask: Message): string[] {
    return ((bodyOf(ask).options as { id: string }[] | undefined) ?? []).map((o) => o.id);
  }
  /** Goes away (a normal close). */
  disconnect(): void { this.client.stop(); }
  presence(state: { visible?: boolean; watching?: boolean; typing?: boolean; agent?: string }): void { this.client.presence(state); }

  // --- seeing things

  /** The next message (after the ones already taken by `next`) that matches. */
  next(match: (m: Message) => boolean, what: string): Promise<Message> {
    return eventually(() => {
      for (let i = this.cursor; i < this.messages.length; i++) {
        if (match(this.messages[i]!)) { this.cursor = i + 1; return this.messages[i]!; }
      }
      return null;
    }, what);
  }
  /** Any message seen so far that matches, waiting for one; does not move the cursor. */
  seen(match: (m: Message) => boolean, what: string): Promise<Message> {
    return eventually(() => this.messages.find(match), what);
  }
  /** The next presented frame that matches. */
  nextPresent(match: (f: PresentFrame) => boolean, what: string): Promise<PresentFrame> {
    return eventually(() => {
      for (let i = this.presentCursor; i < this.presents.length; i++) {
        if (match(this.presents[i]!)) { this.presentCursor = i + 1; return this.presents[i]!; }
      }
      return null;
    }, what);
  }
  /** One page of history without following (scrolling up): messages before [seq]. */
  page(params: { after?: number; before?: number; limit?: number }): Promise<SyncPageFrame> {
    return new Promise((resolve) => {
      const handle = this.client.openSync({ ...params, summary: true }, {
        page: (frame) => { if (frame.end) { handle.close(); resolve(frame); } },
        message: () => {},
      });
    });
  }
  /** Everything the hub's ledger holds that the owner may read, newest first (`service:history/query`, all pages). */
  async ledger(filter: Record<string, unknown> = {}): Promise<Message[]> {
    const all: Message[] = [];
    let before: number | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const reply = await this.call("service:history", "query", { limit: 200, ...filter, ...(before ? { before } : {}) });
      if (!reply.ok) throw new Error(`history query failed: ${reply.error.code} ${reply.error.message}`);
      const result = dataOf(reply) as { messages?: Message[]; next_before?: number };
      all.push(...(result.messages ?? []));
      if (!result.next_before) break;
      before = result.next_before;
    }
    return all;
  }
}

/** The send result, asserted ok. */
export function accepted(result: SendResultFrame): { message: { id: string; seq: number }; duplicate?: boolean; response?: Record<string, unknown> } {
  if (!result.ok) throw new Error(`the hub refused: ${result.error.code}: ${result.error.message}`);
  return result;
}

// --- a hand ---------------------------------------------------------------------------------------------------------------

export type Responder = (call: CallFrame, ctx: { signal: AbortSignal; progress(text: string): void }) => CallOutcome | Promise<CallOutcome>;

export interface HandOptions {
  name?: string;
  kind?: HandKind;
  capabilities?: CapabilitySpec[];
  /** The event words this hand declares (`sense.location`, ...). */
  events?: string[];
  identity?: Identity;
}

/** A hand on the device channel: answers calls from scripts, records them, reports events. */
export class Hand {
  readonly calls: CallFrame[] = [];
  /** Ids of calls the hub cancelled. */
  readonly cancelled: string[] = [];
  /** [capability, args] of every `assess` frame. */
  readonly assessed: { capability: string; args: Record<string, unknown> }[] = [];
  ack!: ManifestAckFrame;
  private readonly responders = new Map<string, Responder>();
  private readonly assessors = new Map<string, (args: Record<string, unknown>) => "none" | "outward" | "structure">();

  constructor(readonly client: HandClient, readonly identity: Identity) {}

  /** `device:<hand_id>` */
  get member(): string { return deviceId(this.identity.handId); }

  private cached: HandHandlers | undefined;
  /** @internal */
  handlers(): HandHandlers {
    return (this.cached ??= {
      call: async (call, ctx) => {
        this.calls.push(call);
        ctx.signal.addEventListener("abort", () => this.cancelled.push(call.id), { once: true });
        const responder = this.responders.get(call.capability);
        return responder ? responder(call, ctx) : textResult("ok");
      },
      assess: async (capability, args) => {
        this.assessed.push({ capability, args });
        const assess = this.assessors.get(capability);
        if (!assess) throw new Error(`no assessment scripted for ${capability}`);
        return { risk: assess(args) };
      },
    });
  }

  /** How this hand answers a capability. */
  on(capability: string, responder: Responder): this { this.responders.set(capability, responder); return this; }
  /** How this hand assesses one call of a `per_call_risk` capability. */
  assessAs(capability: string, assess: "none" | "outward" | "structure" | ((args: Record<string, unknown>) => "none" | "outward" | "structure")): this {
    this.assessors.set(capability, typeof assess === "function" ? assess : () => assess);
    return this;
  }
  /** A capability that never answers until [release] (or the hub cancels it, or the connection drops). */
  hold(capability: string): { release(outcome?: CallOutcome): void; started: Promise<CallFrame> } {
    const started = deferred<CallFrame>();
    let release: (outcome: CallOutcome) => void = () => {};
    this.on(capability, (call, ctx) => new Promise<CallOutcome>((resolve) => {
      release = resolve;
      ctx.signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "cancelled", message: "stopped" } }), { once: true });
      started.resolve(call);
    }));
    return { release: (outcome = textResult("released")) => release(outcome), started: started.promise };
  }

  /** The first call of a capability (waits for it). */
  call(capability: string, what = `a call of ${capability}`): Promise<CallFrame> {
    return eventually(() => this.calls.find((c) => c.capability === capability), what);
  }
  /** Reports an event (the word must be in this hand's manifest events). */
  emit(word: string, body: Record<string, unknown>): Promise<string> { return this.client.emit(word, body); }
  /** Goes away (a normal close). */
  disconnect(): void { this.client.stop(); }
}

// --- the scenario ----------------------------------------------------------------------------------------------------------

export interface ScenarioOptions {
  /** Give the hub a clock the test moves with `advance()`. Default: the system clock. */
  fakeNow?: boolean;
  /** Runtime kinds, besides `dsh`, that the fake driver answers for (a scenario that declares `runtime: scripted` lists it here). */
  runtimes?: string[];
  /** Where the hub's small model lives (a fake model server of the scenario). */
  llm?: { baseUrl: string };
  /**
   * Leave the first meeting to the test. By default the scenario starts after it: someone connected once, the primary agent
   * was woken for `first_meeting` and its turn is over, the connection is closed and the driver's records are empty.
   */
  firstMeeting?: boolean;
  /** Keep the hub's fast path of approvals (an agent's call waits for the owner's answer for a while). By default the scenario turns it off: its approvals take the slow way, where the answer comes as a message. */
  fastApproval?: boolean;
  /** A debug hub: host.json says `dev.script_agent`, so `agent:script` is declared and its program runs on this machine. */
  scriptAgent?: boolean;
}

/** A clock the test moves. Starts at 2026-10-10 07:00 UTC. */
export class ManualNow {
  constructor(public t: number = Date.UTC(2026, 9, 10, 7, 0, 0)) {}
  readonly now = (): number => this.t;
}

export interface RawHand {
  client: HandClient;
  identity: Identity;
  /** Every time the connection ended. */
  closes: { code: number; reason: string; willReconnect: boolean }[];
}

interface ConnectOptions {
  kind?: HandKind;
  name?: string;
  channels: HelloChannels;
  token?: string | null;
  identity: Identity;
  signWith?: Identity;
  handlers?: HandHandlers;
}

export class Scenario {
  readonly host: FakeHost;
  readonly driver: ScriptedDriver;
  readonly clock = new ManualNow();
  readonly dataDir = mkdtempSync(join(tmpdir(), "ash-scenario-"));
  private hubValue: Hub | undefined;
  private relayValue: FakeGateway | undefined;
  private readonly clients = new Set<HandClient>();
  private handoffs = 0;
  private current: { port: number; token: string } | undefined;
  private booted = false;
  /** This boot's standard input: a fresh stream per start, like a new process gets a new pipe. */
  private pipe: FakeHostConnection | undefined;

  constructor(private readonly options: ScenarioOptions = {}) {
    this.host = new FakeHost(options.scriptAgent ? { dev: { owner_token: false, script_agent: true } } : {});
    this.driver = scriptedDriver(["dsh", ...(options.runtimes ?? [])]);
  }

  // --- the hub

  get hub(): Hub { if (!this.hubValue) throw new Error("the hub is not running"); return this.hubValue; }
  /** `ws://127.0.0.1:<port>/link` */
  linkUrl(): string { return `ws://127.0.0.1:${this.port()}/link`; }
  /** The port the hub told the host: known as soon as the link is open, also while the agents are still starting. */
  private port(): number {
    if (!this.current) throw new Error("the hub has not handed its port to the host");
    return this.current.port;
  }
  /** `http://127.0.0.1:<port>/mcp` */
  mcpUrl(): string { return `http://127.0.0.1:${this.port()}/mcp`; }
  /** The local connection token the hub gave the host (`hands.handoff`), the way it reaches the phone app. */
  token(): string {
    if (!this.current) throw new Error("the hub has not handed the local token to the host");
    return this.current.token;
  }

  async boot(whileStarting?: () => Promise<void>): Promise<void> {
    // The hub boots the way a host starts it (SPEC-07): the environment names host.json; the secrets, the answers to its
    // calls and the host's events come over its private pipe (standard input and output), a new one for each start.
    const launch = this.host.writeLaunch();
    this.pipe = this.host.connect();
    const starting = startHub({
      dataDir: this.dataDir, port: 0, env: { ...launch.env }, stdin: this.pipe.stdin, stdout: this.pipe.stdout, drivers: this.driver.drivers,
      // Without a fake model server of its own a scenario still never reaches a real provider (a saved key is checked at once): a closed local port.
      llm: this.options.llm ?? { baseUrl: "http://127.0.0.1:9" },
      // The health meter ticks in real milliseconds but counts the hub's time: with the moved clock a tick closes the time `advance()` gave it.
      ...(this.options.fakeNow ? { now: this.clock.now, healthTickMs: 20 } : {}),
    });
    starting.catch(() => {});
    // The host is told the port as soon as the link is open, before the agents are up (`startHub` returns after that).
    this.handoffs += 1;
    const told = eventually(() => this.host.callsOf("hands.handoff")[this.handoffs - 1], "the hub handing its port and token to the host");
    told.catch(() => {});
    const handoff = await Promise.race([told, starting.then(() => told)]); // a hub that fails to start ends the wait
    this.current = handoff.body as { port: number; token: string };
    if (whileStarting) await whileStarting();
    this.hubValue = await starting;
    this.booted = true;
    if (`http://127.0.0.1:${this.current.port}` !== this.hub.url) throw new Error(`the host was told port ${this.current.port} but the hub is at ${this.hub.url}`);
  }

  /**
   * Stops the hub and starts it again on the same data directory; every connected client reconnects.
   * [whileStarting] runs once the link is open and the hub is not done starting (an agent's runtime held with
   * `driver.holdStarts`): a person can connect and speak then, as on the phone while the agent comes up.
   */
  async restart(whileStarting?: () => Promise<void>, o: { crash?: boolean } = {}): Promise<void> {
    // A crash: the database is taken as it is now and put back after the stop, so the stop's own writes (the ends of the turns) are lost, as when the system kills the process.
    const image = o.crash ? mkdtempSync(join(tmpdir(), "ash-crash-")) : null;
    if (image) for (const name of ["ash.db", "ash.db-wal", "ash.db-shm"]) if (existsSync(join(this.dataDir, name))) cpSync(join(this.dataDir, name), join(image, name));
    // The hub goes first: it ends the turns and the tool lines it holds itself, then the fake driver lets go.
    await this.hub.stop();
    await this.driver.dispose();
    if (image) {
      for (const name of ["ash.db", "ash.db-wal", "ash.db-shm"]) rmSync(join(this.dataDir, name), { force: true });
      cpSync(image, this.dataDir, { recursive: true });
      rmSync(image, { recursive: true, force: true });
    }
    this.hubValue = undefined;
    // Events the host sends while the hub is down wait in the host's stream for the next boot's pipe.
    this.pipe?.close();
    const returning = [...this.clients].filter((client) => client.state !== "stopped");
    await eventually(() => returning.every((client) => client.state !== "ready"), "the connections noticing that the hub is gone");
    await this.boot(whileStarting);
    for (const client of returning) client.reconnectNow();
    await eventually(() => returning.every((client) => client.state === "ready"), "the connections coming back");
  }

  /**
   * The owner's first connection: the hub wakes the primary agent once for `first_meeting` (its own turn, run by the
   * fallback script). Connects, waits for that turn to end, disconnects, and empties what the driver recorded about turns,
   * deliveries and tool calls, so a scenario counts only its own.
   */
  async passFirstMeeting(): Promise<void> {
    const owner = await this.human({ name: "first meeting" });
    // A new install with no model key does not wake on a connection (the turn could only fail); the key the owner saves does.
    const saved = await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-scenario", kind: "model" });
    if (!saved.ok) throw new Error(`the scenario's model key was not saved: ${saved.error.message}`);
    if (!this.options.fastApproval) await owner.call("service:admin", "settings.set", { "approval.fast_seconds": 0 });
    const isMeeting = (m: DriverMessage): boolean => m.word === "wake" && m.text.startsWith("Wake · first_meeting");
    const turn = await this.driver.turn((record) => record.messages.some(isMeeting), "the first-meeting turn");
    await turn.done;
    owner.disconnect();
    this.driver.forget();
  }

  /**
   * A fake relay (the owner's side of `ash-gw/1`) that already belongs to this hub: the host signs for the hub's key, which
   * the relay knows as its owner. Nothing is connected yet; the owner points the hub at it with
   * `service:link/gateway.use {url: relay.url}`, the way they would with a relay of their own.
   */
  async relay(): Promise<FakeGateway> {
    if (this.relayValue) return this.relayValue;
    const key = await hubKey();
    this.host.results.set("identity.key", () => key.identity.key());
    this.host.results.set("identity.sign", (body: unknown) => key.identity.sign((body as { data: string }).data));
    this.relayValue = await FakeGateway.start({ claimedBy: { id: key.id, key: key.publicKey } });
    return this.relayValue;
  }

  /** Moves the hub's clock (needs `fakeNow`). */
  advance(ms: number): void {
    if (!this.options.fakeNow) throw new Error("advance() needs startScenario(t, { fakeNow: true })");
    this.clock.t += ms;
  }
  /** Plays a host event on the hub's standard input (`wake.fired`, `env.changed`, `lifecycle.stop`). */
  hostEvent(event: Record<string, unknown>): void { this.host.sendEvent(event); }

  // --- connections

  /**
   * A connection with whatever channels, token and signature the test wants (`token: null` sends no token, `signWith`
   * signs the challenge with another key). Started, not waited for.
   */
  async raw(o: Omit<ConnectOptions, "identity"> & { identity?: Identity }): Promise<RawHand> {
    return this.connect({ ...o, identity: o.identity ?? (await newIdentity()) });
  }

  private connect(o: ConnectOptions): RawHand {
    const identity = o.identity;
    const closes: RawHand["closes"] = [];
    const client = createNodeClient({
      url: () => this.linkUrl(),
      headers: (): Record<string, string> => (o.token === null ? {} : { authorization: `Bearer ${o.token ?? this.token()}` }),
      hand: { kind: o.kind ?? "phone", name: o.name ?? "scenario hand", version: "0.0.0-scenario", platform: "test", public_key: identity.publicKey },
      channels: o.channels,
      sign: (nonce) => (o.signWith ?? identity).sign(nonce),
      handlers: { ...o.handlers, closed: (info) => { closes.push({ code: info.code, reason: info.reason, willReconnect: info.willReconnect }); o.handlers?.closed?.(info); } },
    });
    this.clients.add(client);
    client.start();
    return { client, identity, closes };
  }

  /** The owner on a new channel of the local connection (the phone app's chat page). */
  async human(o: HumanOptions = {}): Promise<Human> {
    const identity = o.identity ?? (await newIdentity());
    let human!: Human;
    const proxy: HandHandlers = {
      welcome: (w) => human.handlers().welcome?.(w),
      present: (f) => human.handlers().present!(f),
    };
    const { client } = this.connect({
      kind: "phone", name: o.name ?? "scenario phone", identity,
      channels: { human: { label: o.label ?? "手机 · 对话", surfaces: o.surfaces ?? ["chat"] } },
      handlers: proxy,
    });
    human = new Human(client, identity);
    await client.ready();
    await human.ready();
    return human;
  }

  /** A hand on the device channel of the local connection: declares its manifest and waits for the ack. */
  async hand(o: HandOptions = {}): Promise<Hand> {
    const identity = o.identity ?? (await newIdentity());
    let hand!: Hand;
    const proxy: HandHandlers = {
      call: (call, ctx) => hand.handlers().call!(call, ctx),
      assess: (capability, args) => hand.handlers().assess!(capability, args),
    };
    const { client } = this.connect({ kind: o.kind ?? "phone", name: o.name ?? "scenario hand", identity, channels: { device: {} }, handlers: proxy });
    hand = new Hand(client, identity);
    await client.ready();
    hand.ack = await client.setManifest(o.capabilities ?? [], (o.events ?? []).map((word) => ({ word, description: `${word} from the scenario hand` })));
    return hand;
  }

  /** A phone with the capabilities most scenarios use: reading the location (read, none) and opening an app (act, outward). */
  phone(o: HandOptions = {}): Promise<Hand> {
    return this.hand({
      name: "scenario phone", kind: "phone",
      capabilities: [standardCapability("location.get"), standardCapability("apps.open"), standardCapability("clipboard.set"), ...(o.capabilities ?? [])],
      events: ["sense.location", "sense.battery", "sense.geofence", "sense.calendar", "sense.source", "sense.activity", ...(o.events ?? [])],
      ...(o.identity ? { identity: o.identity } : {}),
    });
  }

  // --- the end

  async dispose(): Promise<void> {
    for (const client of this.clients) client.stop();
    this.clients.clear();
    await this.driver.dispose();
    await this.hubValue?.stop().catch(() => {});
    this.hubValue = undefined;
    await this.relayValue?.stop().catch(() => {});
    this.relayValue = undefined;
    await this.host.stop().catch(() => {});
    rmSync(this.dataDir, { recursive: true, force: true });
    if (this.booted) this.booted = false;
  }
}

/**
 * Starts a hub for one test and stops it when the test ends. Until the hub is assembled this throws
 * "hub not assembled yet" (and the directory, host and clients are cleaned up all the same).
 */
export async function startScenario(t: TestContext, options: ScenarioOptions = {}): Promise<Scenario> {
  const scenario = new Scenario(options);
  t.after(() => scenario.dispose());
  await scenario.boot();
  if (!options.firstMeeting) await scenario.passFirstMeeting();
  return scenario;
}
