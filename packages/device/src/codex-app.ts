/**
 * The Codex desktop app, remote-controlled from this computer: look at its sessions, send
 * a message, stop a turn, answer an approval. The sessions stay with the desktop app; this only joins the app's own local
 * channel (`~/.codex/ipc/ipc.sock`) as one more follower of the sessions it has open, the way its phone remote does.
 *
 * The channel is private to the app and not a stable interface. It carries 4-byte little-endian length + JSON frames;
 * the app routes them: a request goes to whichever client says `canHandle` in its discovery round (we always say no),
 * a broadcast goes to the clients it names. Nothing here checks the app's version.
 *
 * Not on the channel: the list of sessions. That is read from the Codex runtime (`app-server`, read only), merged with
 * what the app tells us about the sessions it has open (running, waiting for an approval).
 */
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { CapabilitySpec } from "../../sdk/src/link";
import { WordError } from "../../sdk/src/message";
import type { CallOutcome } from "../../link/src/hand";
import { findRuntime } from "./agents/detect";
import { JsonProcess, childEnv, type Frame } from "./agents/process";
import { redactText } from "./redact";

// ---------------------------------------------------------------------------------------------------------------------
// the capabilities
// ---------------------------------------------------------------------------------------------------------------------

const THREAD = { type: "string", minLength: 1, description: "The session id from x.codex.sessions." };
// Remote control of the owner's own app: no approval card for the owner or for an agent (the owner decided so).
const REMOTE = { risk: "none" as const, callers: ["owner", "agent", "app"] as ("owner" | "agent" | "app")[] };

export const CODEX_CAPABILITIES: CapabilitySpec[] = [
  { name: "x.codex.sessions", label: "在看 Codex 的会话", description: "The owner's own Codex App (the desktop app on this computer, his workbench, not your helper agents): its sessions, past ones included: id, title, state (running, waiting_approval or idle), working directory and when it last changed. Running sessions come first. open=false means the app does not have it open now; x.codex.send and x.codex.open open it there.",
    input_schema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "How many (default 30)." }, helpers: { type: "boolean", description: "Also the sessions your own helper agents ran on this computer's Codex runtime (default false: the owner's only)." } } },
    effect: "read", risk: "none", callers: ["owner", "agent", "app"], timeout_ms: 60_000 },
  { name: "x.codex.session", label: "在看 Codex 会话的过程", description: "One Codex session: its state and the last turns, each with what the user said, what Codex said and the tools it ran (long texts cut), and the approvals it is waiting for.",
    input_schema: { type: "object", additionalProperties: false, required: ["thread"], properties: { thread: THREAD, turns: { type: "integer", minimum: 1, maximum: 20, description: "How many of the last turns (default 6)." }, max_chars: { type: "integer", minimum: 40, maximum: 4000, description: "Cut each text to this length (default 600)." } } },
    effect: "read", risk: "none", callers: ["owner", "agent", "app"], timeout_ms: 60_000 },
  { name: "x.codex.approvals", label: "在看 Codex 等的批准", description: "The requests Codex is waiting for the owner to approve, across the sessions the app has open: which session, what it wants to run or change.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
    effect: "read", risk: "none", callers: ["owner", "agent", "app"], timeout_ms: 30_000 },
  { name: "x.codex.open", label: "在打开 Codex 会话", description: "Open a session (a past one too) in the Codex app on this computer, so it can be messaged, stopped and approved from here and is seen on the computer's screen.",
    input_schema: { type: "object", additionalProperties: false, required: ["thread"], properties: { thread: THREAD } },
    effect: "act", timeout_ms: 60_000, ...REMOTE },
  { name: "x.codex.new", label: "在开新的 Codex 会话", description: "Start a new Codex session in a project (cwd: its working directory, as x.codex.sessions shows them, or any absolute path) with its first message; it opens in the Codex app on this computer. Returns the new session's id (thread).",
    input_schema: { type: "object", additionalProperties: false, required: ["cwd", "text"], properties: { cwd: { type: "string", minLength: 1, description: "The project's directory." }, text: { type: "string", minLength: 1, maxLength: 20_000 }, title: { type: "string", maxLength: 80, description: "The session's name (default: the first line of text)." } } },
    effect: "act", timeout_ms: 130_000, ...REMOTE },
  { name: "x.codex.send", label: "在给 Codex 发消息", description: "Say something to a Codex session, a past one too (it is opened in the app first): a new turn when it is idle, added to the running turn when it is busy. If the answer is lost the result is unknown and nothing is sent again by itself; read the session before repeating. Pass the same client_id to repeat safely.",
    input_schema: { type: "object", additionalProperties: false, required: ["thread", "text"], properties: { thread: THREAD, text: { type: "string", minLength: 1, maxLength: 20_000 }, client_id: { type: "string", minLength: 1, maxLength: 80, description: "Makes a repeat of the same send a no-op." } } },
    effect: "act", timeout_ms: 130_000, ...REMOTE },
  { name: "x.codex.stop", label: "在停下 Codex 的任务", description: "Stop the turn a Codex session is running now.",
    input_schema: { type: "object", additionalProperties: false, required: ["thread"], properties: { thread: THREAD } },
    effect: "act", timeout_ms: 30_000, ...REMOTE },
  { name: "x.codex.approve", label: "在回 Codex 的批准请求", description: "Answer one approval request Codex is waiting for (ids from x.codex.approvals): approve, approve_session (do not ask again this session) or deny.",
    input_schema: { type: "object", additionalProperties: false, required: ["thread", "request_id", "decision"], properties: { thread: THREAD, request_id: { type: "string", minLength: 1 }, decision: { type: "string", enum: ["approve", "approve_session", "deny"] } } },
    effect: "act", timeout_ms: 30_000, ...REMOTE },
];

/** The events this program reports to the hub while the app is connected. */
export const CODEX_EVENTS = [
  { word: "codex.turn_ended", description: "A Codex session finished a turn (thread, title, outcome, a short end of what it said)." },
  { word: "codex.approval_pending", description: "A Codex session is waiting for the owner to approve something (thread, title, request_id, what it wants)." },
];

// ---------------------------------------------------------------------------------------------------------------------
// the app's channel
// ---------------------------------------------------------------------------------------------------------------------

/** Frame versions as the installed app (26.1007) speaks them; the receiver compares them exactly. */
const VERSION: Record<string, number> = {
  "thread-stream-following-changed": 1, "thread-stream-following-status-requested": 1, "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2, "thread-follower-steer-turn": 1, "thread-follower-interrupt-turn": 4,
  "thread-follower-command-approval-decision": 1, "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1, "thread-follower-submit-mcp-server-elicitation-response": 1,
};
const MAX_FRAME = 256 * 1024 * 1024;
const MAX_FOLLOWS = 40;
const APPROVALS = new Set(["item/commandExecution/requestApproval", "execCommandApproval", "item/fileChange/requestApproval", "applyPatchApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request"]);

type Rec = Record<string, any>;
const rec = (v: unknown): Rec | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const clip = (v: unknown, max: number): string => { const s = typeof v === "string" ? v : ""; return s.length > max ? `${s.slice(0, max)}…` : s; };

/** A saved session. [helper]: made by one of Ash's own helper agents (the Codex runtime it runs), not by the owner. */
export interface Listed { id: string; title: string; cwd?: string; updated_at?: number; helper?: boolean }

/**
 * Who starts a Codex runtime says so (`clientInfo.name`), and Codex records it on the session (`originator`). Ash's helper
 * agents start theirs as "ash"; a session this program makes for the owner (x.codex.new) is his, so it says otherwise.
 */
export const HELPER_ORIGINATOR = "ash";
const OWNER_CLIENT = "ash-for-owner";
interface Conv { id: string; hostId: string; raw: Rec; owner?: string; revision?: number }
interface Follow { hostId: string; owner?: string }
interface Pending { method: string; owner: string; resolve(v: Rec): void; reject(e: Error): void; timer: NodeJS.Timeout }
/** What was last reported for a session, so only a change is told. */
interface Seen { running: boolean; approvals: Set<string> }

export interface CodexAppOptions {
  socketPath?: string;
  /** The sessions the Codex runtime lists, newest first (default: ask `codex app-server`). */
  listThreads?: (limit: number) => Promise<Listed[]>;
  /** A session's turns when the app does not have it open (default: ask `codex app-server`). */
  readThread?: (id: string) => Promise<Rec | null>;
  /** Told when the app connects or goes away (the capabilities depend on it). */
  onChange?: () => void;
  /** Reported to the hub: codex.turn_ended, codex.approval_pending. */
  onEvent?: (word: string, body: Record<string, unknown>) => void;
  log?: (message: string, error?: unknown) => void;
  reconnectMs?: number;
  /** How long to wait for the app to say it has a session open (default 2.5 s). */
  ownerWaitMs?: number;
  /** Make a new, empty session in [cwd] named [title], and give its id (default: the Codex runtime). */
  startThread?: (cwd: string, title: string) => Promise<string>;
  /** Have the app open a session (default: its own link codex://threads/<id>, opened in the background). */
  openThread?: (id: string) => Promise<void>;
  /** How long to wait for the app to take up a session it was asked to open (default 20 s). */
  openWaitMs?: number;
  now?: () => number;
}

export const defaultSocket = (): string => join(homedir(), ".codex", "ipc", "ipc.sock");

/** The message of a refusal or a failure: used to tell "the turn had already ended" from "we do not know what happened". */
const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e ?? ""));
const INACTIVE = /SteerTurnInactiveError|active turn already ended|NoActiveTurn|no active turn|without an active turn id/i;
const UNCERTAIN = /timed out|connection closed|socket.*closed|owner.*disconnected|not the active owner/i;

export class CodexApp {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private clientId: string | null = null;
  private initId = "";
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private generation = 0;
  private readonly follows = new Map<string, Follow>();
  private readonly convs = new Map<string, Conv>();
  private readonly waiters = new Map<string, Set<(c: Conv | null) => void>>();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Map<string, Seen>();
  private readonly sends = new Map<string, { at: number; done: Promise<Rec> }>();
  private listed: { at: number; rows: Listed[] } | null = null;
  private listing: Promise<Listed[]> | null = null;
  /** Sessions made here (x.codex.new): known to exist before the runtime lists them. */
  private readonly made = new Set<string>();
  private readonly o: Required<Pick<CodexAppOptions, "socketPath" | "reconnectMs" | "ownerWaitMs" | "openWaitMs" | "openThread" | "now">> & CodexAppOptions;

  constructor(options: CodexAppOptions = {}) {
    this.o = { socketPath: defaultSocket(), reconnectMs: 2000, ownerWaitMs: 2500, openWaitMs: 20_000, openThread: openWithLink, now: Date.now, ...options };
  }

  get online(): boolean { return this.clientId !== null && this.socket?.writable === true; }
  capabilities(): CapabilitySpec[] { return this.online ? CODEX_CAPABILITIES : []; }
  events(): typeof CODEX_EVENTS { return this.online ? CODEX_EVENTS : []; }

  start(): void { this.connect(); }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
    this.dropAll(new Error("closed"));
  }

  // ---- connection ----

  private connect(): void {
    if (this.stopped || this.socket) return;
    const socket = createConnection(this.o.socketPath);
    this.socket = socket;
    const generation = ++this.generation;
    socket.on("connect", () => {
      this.initId = randomUUID();
      this.write({ type: "request", requestId: this.initId, method: "initialize", params: { clientType: "ash" } });
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket || generation !== this.generation) return;
      const was = this.clientId !== null;
      this.socket = undefined; this.clientId = null; this.buffer = Buffer.alloc(0);
      this.dropAll(new Error("connection closed"));
      if (was) this.o.onChange?.();
      if (!this.stopped) { this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, this.o.reconnectMs); this.retry.unref?.(); }
    });
  }

  /** The connection is gone or reset: nothing we knew of the sessions holds. */
  private dropAll(reason: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
    for (const set of this.waiters.values()) for (const w of set) w(null);
    this.waiters.clear();
    for (const f of this.follows.values()) delete f.owner;
    this.convs.clear();
  }

  private write(frame: unknown): void {
    const socket = this.socket;
    if (!socket?.writable) return;
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME) { this.socket?.destroy(); return; }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try { this.onFrame(JSON.parse(body.toString("utf8")) as Rec); }
      catch (error) { this.o.log?.("codex app: bad frame", error); this.socket?.destroy(); return; }
    }
  }

  private broadcast(method: string, params: Rec, targets: string[] | null = null): void {
    this.write({ type: "broadcast", method, sourceClientId: this.clientId, targetClientIds: targets, version: VERSION[method] ?? 0, params });
  }

  private announce(id: string, to?: string): void {
    const f = this.follows.get(id);
    if (!f || !this.clientId) return;
    this.broadcast("thread-stream-following-changed", { conversationId: id, hostId: f.hostId, following: true }, to ? [to] : f.owner ? [f.owner] : null);
  }

  private follow(id: string, hostId = "local"): boolean {
    if (!this.follows.has(id)) {
      if (this.follows.size >= MAX_FOLLOWS) return false;
      this.follows.set(id, { hostId });
    }
    this.announce(id);
    return true;
  }

  // ---- frames ----

  private onFrame(f: Rec): void {
    if (f.type === "client-discovery-request" && str(f.requestId)) {
      // We never take a request; the desktop windows do.
      this.write({ type: "client-discovery-response", requestId: f.requestId, response: { canHandle: false } });
      return;
    }
    if (f.type === "response") {
      if (f.requestId === this.initId && f.method === "initialize" && str(f.result?.clientId)) {
        this.clientId = f.result.clientId; this.initId = "";
        this.broadcast("thread-stream-following-status-requested", {});
        for (const id of this.follows.keys()) this.announce(id);
        this.o.onChange?.();
        return;
      }
      const p = this.pending.get(f.requestId);
      if (!p || (f.method && f.method !== p.method) || (f.handledByClientId && f.handledByClientId !== p.owner)) return;
      clearTimeout(p.timer); this.pending.delete(f.requestId);
      if (f.error != null || f.resultType === "error" || f.result?.resultType === "error") p.reject(new Error(errorText(f.error ?? f.result?.error ?? `${p.method} failed`)));
      else p.resolve(f.result ?? {});
      return;
    }
    if (f.type !== "broadcast" || !f.method) return;
    if (Array.isArray(f.targetClientIds) && (!this.clientId || !f.targetClientIds.includes(this.clientId))) return;
    const p = rec(f.params) ?? {};
    switch (f.method) {
      case "ipc-connection-reset":
        for (const q of this.pending.values()) { clearTimeout(q.timer); q.reject(new Error("connection reset")); }
        this.pending.clear();
        for (const x of this.follows.values()) delete x.owner;
        this.convs.clear();
        for (const id of this.follows.keys()) this.announce(id);
        return;
      case "thread-stream-following-status-requested": {
        const id = str(p.conversationId);
        if (id) { if (this.follows.has(id)) this.announce(id, f.sourceClientId); }
        else for (const known of this.follows.keys()) this.announce(known, f.sourceClientId);
        return;
      }
      case "thread-stream-following-changed": {
        const id = str(p.conversationId);
        if (!id || f.sourceClientId === this.clientId) return;
        if (p.following === true) this.follow(id, str(p.hostId) ?? "local");
        else if (p.following === false) {
          const target = this.follows.get(id);
          if (target && target.owner === f.sourceClientId) { delete target.owner; this.convs.delete(id); }
        }
        return;
      }
      case "thread-stream-state-changed": this.onState(f, p); return;
      default: return;
    }
  }

  private onState(f: Rec, p: Rec): void {
    const id = str(p.conversationId), change = rec(p.change), source = str(f.sourceClientId);
    const target = id ? this.follows.get(id) : undefined;
    if (!id || !change || !source || !target) return;
    if (change.type === "snapshot") {
      const state = rec(change.conversationState);
      if (!state) return;
      const revision = typeof change.revision === "number" ? change.revision : undefined;
      const have = this.convs.get(id);
      if (revision !== undefined && have?.revision !== undefined && revision < have.revision) return;
      if (target.owner && target.owner !== source) return;
      target.owner = source;
      const conv: Conv = { id, hostId: str(p.hostId) ?? target.hostId, raw: state, owner: source, ...(revision !== undefined ? { revision } : {}) };
      this.convs.set(id, conv);
      const waiting = this.waiters.get(id);
      if (waiting) { this.waiters.delete(id); for (const w of waiting) w(conv); }
      this.noticed(conv);
    } else if (change.type === "patches") {
      const have = this.convs.get(id);
      if (target.owner !== source) return;
      const patches = Array.isArray(change.patches) ? change.patches : null;
      const base = change.baseRevision, revision = change.revision;
      if (typeof revision === "number" && have?.revision !== undefined && revision <= have.revision) return;
      if (!have || !patches || typeof base !== "number" || typeof revision !== "number" || base !== have.revision) { this.refollow(id); return; }
      try { have.raw = applyPatches(have.raw, patches); have.revision = revision; this.noticed(have); }
      catch (error) { this.o.log?.("codex app: patch failed", error); this.refollow(id); }
    }
  }

  private refollow(id: string): void { const t = setTimeout(() => this.announce(id), 120); t.unref?.(); }

  /** Compare with what was told before; a turn that ended or a new request for approval is reported. */
  private noticed(conv: Conv): void {
    const view = this.view(conv);
    const before = this.seen.get(conv.id);
    const now: Seen = { running: isActive(conv.raw), approvals: new Set(view.approvals.map((a) => a.request_id)) };
    this.seen.set(conv.id, now);
    if (!this.o.onEvent) return;
    if (before?.running && !now.running) {
      const last = view.turns.at(-1);
      const said = [...(last?.items ?? [])].reverse().find((i) => i.kind === "agent")?.text ?? "";
      this.o.onEvent("codex.turn_ended", { thread: conv.id, title: view.title, outcome: last?.status ?? "completed", ...(said ? { said: clip(said, 200) } : {}) });
    }
    for (const a of view.approvals) {
      if (before?.approvals.has(a.request_id)) continue;
      this.o.onEvent("codex.approval_pending", { thread: conv.id, title: view.title, request_id: a.request_id, kind: a.kind, summary: clip(a.summary, 200) });
    }
  }

  // ---- what a session looks like ----

  private titleOf(raw: Rec, id: string): string {
    return clip(str(raw.name) ?? str(raw.title) ?? str(raw.preview) ?? this.listed?.rows.find((r) => r.id === id)?.title ?? "", 80) || "（未命名）";
  }

  private view(conv: Conv, turnCount = 6, max = 600) {
    const raw = conv.raw;
    const turns = canonicalTurns(raw);
    const approvals = approvalsOf(raw);
    const active = isActive(raw, turns);
    return {
      id: conv.id, title: this.titleOf(raw, conv.id), open: true,
      state: approvals.length ? "waiting_approval" as const : active ? "running" as const : "idle" as const,
      ...(str(raw.cwd) ? { cwd: raw.cwd as string } : {}),
      turns: turns.slice(-turnCount).map((t) => turnView(t, max)),
      approvals,
    };
  }

  // ---- reading ----

  /**
   * The saved sessions. Reading them starts a Codex runtime, which takes seconds and now and then times out: the last good list
   * is answered at once and read again behind it, and a failed read never replaces it (the list would shrink to the open ones).
   */
  private async listRows(limit: number): Promise<Listed[]> {
    const fresh = () => {
      this.listing ??= (this.o.listThreads ?? listWithAppServer)(Math.max(limit, 100))
        .then((rows) => { this.listed = { at: this.o.now(), rows }; return rows; })
        .catch((error) => { this.o.log?.("codex app: listing sessions failed", error); return this.listed?.rows ?? []; })
        .finally(() => { this.listing = null; });
      return this.listing;
    };
    if (!this.listed) return fresh();
    if (this.o.now() - this.listed.at >= 5000) void fresh();
    return this.listed.rows;
  }

  /** Ask the windows which sessions they have open, and give them a moment to answer. */
  private async discover(): Promise<void> {
    if (!this.online) return;
    this.broadcast("thread-stream-following-status-requested", {});
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async sessions(limit = 30, helpers = false) {
    this.requireOnline();
    await this.discover();
    const rows = await this.listRows(limit);
    const out = new Map<string, Rec>();
    for (const r of rows) if (helpers || !r.helper) out.set(r.id, { id: r.id, title: r.title, state: "idle", open: false, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.updated_at ? { updated_at: r.updated_at } : {}) });
    for (const conv of this.convs.values()) {
      const v = this.view(conv, 0);
      const prior = out.get(conv.id) ?? {};
      out.set(conv.id, { ...prior, id: conv.id, title: prior.title && v.title === "（未命名）" ? prior.title : v.title, state: v.state, open: true, ...(v.cwd ?? prior.cwd ? { cwd: v.cwd ?? prior.cwd } : {}), ...(prior.updated_at ? { updated_at: prior.updated_at } : {}) });
    }
    const order = { running: 0, waiting_approval: 1, idle: 2 } as Record<string, number>;
    const sessions = [...out.values()].sort((a, b) => order[a.state] - order[b.state] || (b.updated_at ?? 0) - (a.updated_at ?? 0)).slice(0, limit);
    return { sessions };
  }

  async session(id: string, turns = 6, max = 600) {
    this.requireOnline();
    const conv = await this.owned(id, this.o.ownerWaitMs);
    if (conv) return this.view(conv, turns, max);
    // Not open in the app: read what was saved. It cannot be messaged until it is opened there.
    const saved = await (this.o.readThread ?? readWithAppServer)(id).catch(() => null);
    if (!saved) throw new WordError("not_found", `Codex has no session ${id}`);
    const all = canonicalTurns(saved);
    return { id, title: this.titleOf(saved, id), open: false, state: "idle" as const, ...(str(saved.cwd) ? { cwd: saved.cwd as string } : {}), turns: all.slice(-turns).map((t) => turnView(t, max)), approvals: [] };
  }

  async approvals() {
    this.requireOnline();
    await this.discover();
    const approvals = [...this.convs.values()].flatMap((c) => approvalsOf(c.raw).map((a) => ({ thread: c.id, title: this.titleOf(c.raw, c.id), ...a })));
    return { approvals };
  }

  // ---- acting ----

  private requireOnline(): void {
    if (!this.online) throw new WordError("unavailable", "The Codex app is not running on this computer", { recovery_hint: "open the Codex app" });
  }

  private owned(id: string, timeoutMs: number): Promise<Conv | null> {
    const have = this.convs.get(id);
    if (have?.owner) return Promise.resolve(have);
    if (!this.follow(id)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      const done = (c: Conv | null) => { clearTimeout(timer); set.delete(done); resolve(c); };
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref?.();
      set.add(done); this.waiters.set(id, set);
    });
  }

  /** The session as the app has it open; asked to open it first when it does not (a past session). */
  private async opened(id: string): Promise<Conv> {
    const have = await this.owned(id, this.o.ownerWaitMs);
    if (have) return have;
    const saved = this.convs.has(id) || this.made.has(id) || (await this.listRows(50)).some((r) => r.id === id) || !!(await (this.o.readThread ?? readWithAppServer)(id).catch(() => null));
    if (!saved) throw new WordError("not_found", `Codex has no session ${id}`, { recovery_hint: "x.codex.sessions" });
    try { await this.o.openThread(id); }
    catch (error) { throw new WordError("failed", `the Codex app could not be asked to open the session: ${clip(errorText(error), 200)}`); }
    const until = this.o.now() + this.o.openWaitMs;
    while (this.o.now() < until) {
      await this.discover();
      const conv = await this.owned(id, 1000);
      if (conv) return conv;
    }
    throw new WordError("unavailable", "The Codex app was asked to open the session but has not taken it up", { recovery_hint: "the computer may be locked or asleep; try again, or open the session in the Codex app" });
  }

  /**
   * A new session in a project (its working directory), with its first message. The app has no way to be asked for a new
   * session, so it is made by the Codex runtime (named, so it is kept), opened in the app like a past one, and spoken to there.
   */
  async create(cwd: string, text: string, title?: string): Promise<Rec> {
    this.requireOnline();
    if (!isAbsolute(cwd) || !(await stat(cwd).then((s) => s.isDirectory(), () => false))) throw new WordError("bad_request", `${cwd} is not a directory on this computer`, { recovery_hint: "use the cwd of a session from x.codex.sessions, or an absolute path" });
    const name = clip(title?.trim() || text.trim().split("\n")[0], 60);
    let id: string;
    try { id = await (this.o.startThread ?? startWithAppServer)(cwd, name); }
    catch (error) { throw new WordError("failed", `Codex could not make the session: ${clip(errorText(error), 200)}`); }
    if (this.listed) this.listed.at = 0;
    this.made.add(id);
    const sent = await this.send(id, text);
    return { thread: id, title: name, cwd, ...sent };
  }

  async open(id: string) {
    this.requireOnline();
    const was = !!(await this.owned(id, this.o.ownerWaitMs));
    const conv = was ? this.convs.get(id)! : await this.opened(id);
    return { opened: true, already: was, ...this.view(conv, 0) };
  }

  private async toOwner(id: string, method: string, params: Rec, timeoutMs = 30_000): Promise<Rec> {
    const conv = await this.owned(id, this.o.ownerWaitMs);
    const owner = conv?.owner;
    if (!owner || !this.clientId) throw new WordError("unavailable", "The Codex app does not have this session open", { recovery_hint: "open the session in the Codex app" });
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`timed out: ${method}`)); }, timeoutMs);
      this.pending.set(requestId, { method, owner, resolve, reject, timer });
      this.write({ type: "request", requestId, method, version: VERSION[method] ?? 0, sourceClientId: this.clientId, targetClientIds: [owner], params });
    });
  }

  /** Idle: a new turn. Running: added to it. A lost answer is never turned into a second send. */
  async send(id: string, text: string, clientId?: string) {
    this.requireOnline();
    const key = `${id}\u0000${clientId ?? randomUUID()}`;
    const again = this.sends.get(key);
    if (clientId && again) { const result = await again.done; return { ...result, repeated: true }; }
    const done = this.deliver(id, text, clientId ?? randomUUID());
    if (clientId) {
      this.sends.set(key, { at: this.o.now(), done });
      for (const [k, v] of this.sends) if (this.o.now() - v.at > 600_000) this.sends.delete(k);
      done.catch(() => this.sends.delete(key));
    }
    return done;
  }

  private async deliver(id: string, text: string, messageId: string): Promise<Rec> {
    const input = [{ type: "text", text, text_elements: [] }];
    const conv = await this.opened(id);
    const uncertain = (error: unknown): never => {
      throw new WordError("result_unknown", `Codex did not confirm the message (${errorText(error)}); read the session before sending again`, { recovery_hint: "x.codex.session" });
    };
    const start = async (): Promise<Rec> => {
      const request = { threadId: id, input, clientUserMessageId: messageId };
      const restoreMessage = { id: randomUUID(), text, context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: str(conv.raw.cwd) ? [conv.raw.cwd] : [] }, cwd: str(conv.raw.cwd) ?? "", createdAt: this.o.now() };
      // The app's own windows send `{request, context}`; the older flat form is kept beside it. UNVERIFIED against a live app.
      const turnStart = { request, context: { restoreMessage, attachments: [], commentAttachments: [] }, ...request };
      try { await this.toOwner(id, "thread-follower-start-turn", { conversationId: id, turnStart }, 120_000); }
      catch (error) { if (error instanceof WordError) throw error; if (UNCERTAIN.test(errorText(error))) uncertain(error); throw new WordError("failed", clip(errorText(error), 300)); }
      return { sent: true, mode: "start" };
    };
    if (!isActive(conv.raw, canonicalTurns(conv.raw))) return start();
    // Never decide from a view that may be a moment old: ask to join the turn, and start one only when the app says it had ended.
    const restore = { id: randomUUID(), text, context: { prompt: text, addedFiles: [], fileAttachments: [], ideContext: null, imageAttachments: [], workspaceRoots: str(conv.raw.cwd) ? [conv.raw.cwd] : [] }, cwd: str(conv.raw.cwd) ?? "", createdAt: this.o.now() };
    try {
      await this.toOwner(id, "thread-follower-steer-turn", { conversationId: id, clientUserMessageId: messageId, input, serviceTier: null, attachments: [], additionalContext: null, restoreMessage: restore }, 120_000);
      return { sent: true, mode: "steer" };
    } catch (error) {
      if (error instanceof WordError) throw error;
      const message = errorText(error);
      if (INACTIVE.test(message)) return start();
      if (UNCERTAIN.test(message)) return uncertain(error);
      throw new WordError("failed", clip(message, 300));
    }
  }

  async stop(id: string) {
    this.requireOnline();
    const conv = await this.owned(id, this.o.ownerWaitMs);
    if (!conv) throw new WordError("unavailable", "The Codex app does not have this session open", { recovery_hint: "open the session in the Codex app" });
    const turns = canonicalTurns(conv.raw);
    if (!isActive(conv.raw, turns)) return { stopped: false, reason: "nothing is running" };
    const turn = rec(turns.at(-1));
    const expected = str(turn?.id) ?? str(turn?.turnId);
    try {
      const done = await this.toOwner(id, "thread-follower-interrupt-turn", { conversationId: id, mode: "user", ...(expected ? { expectedTurnId: expected } : {}) });
      return { stopped: true, turn: str(done.result?.interruptedTurnId) ?? expected ?? null };
    } catch (error) {
      if (error instanceof WordError) throw error;
      throw new WordError(UNCERTAIN.test(errorText(error)) ? "result_unknown" : "failed", clip(errorText(error), 300));
    }
  }

  async approve(id: string, requestId: string, decision: "approve" | "approve_session" | "deny") {
    this.requireOnline();
    const conv = await this.owned(id, this.o.ownerWaitMs);
    const request = conv && (Array.isArray(conv.raw.requests) ? conv.raw.requests : []).map(rec).find((r) => r && String(r.id) === requestId && APPROVALS.has(String(r.method)));
    if (!conv || !request) throw new WordError("not_found", "That approval is no longer waiting");
    const method = String(request.method), p = rec(request.params) ?? {};
    const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
    const word = legacy ? { approve: "approved", approve_session: "approved_for_session", deny: "denied" }[decision] : { approve: "accept", approve_session: "acceptForSession", deny: "decline" }[decision];
    let call: [string, Rec];
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") call = ["thread-follower-command-approval-decision", { conversationId: id, requestId: request.id, decision: word }];
    else if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") call = ["thread-follower-file-approval-decision", { conversationId: id, requestId: request.id, decision: word }];
    else if (method === "item/permissions/requestApproval") call = ["thread-follower-permissions-request-approval-response", { conversationId: id, requestId: request.id, response: decision === "deny" ? { permissions: {}, scope: "turn" } : { permissions: p.permissions ?? {}, scope: decision === "approve_session" ? "session" : "turn" } }];
    else call = ["thread-follower-submit-mcp-server-elicitation-response", { conversationId: id, requestId: request.id, response: { action: decision === "deny" ? "decline" : "accept", content: null } }];
    try { await this.toOwner(id, call[0], call[1]); }
    catch (error) {
      if (error instanceof WordError) throw error;
      throw new WordError(UNCERTAIN.test(errorText(error)) ? "result_unknown" : "failed", clip(errorText(error), 300), { recovery_hint: "x.codex.approvals" });
    }
    return { answered: true, decision };
  }

  // ---- the hand's call ----

  async call(name: string, args: Rec, signal?: AbortSignal): Promise<CallOutcome> {
    signal?.throwIfAborted();
    const thread = (): string => { const t = str(args.thread); if (!t) throw new WordError("bad_request", "thread is required"); return t; };
    let data: unknown;
    switch (name) {
      case "x.codex.sessions": data = await this.sessions(typeof args.limit === "number" ? args.limit : 30, args.helpers === true); break;
      case "x.codex.session": data = await this.session(thread(), typeof args.turns === "number" ? args.turns : 6, typeof args.max_chars === "number" ? args.max_chars : 600); break;
      case "x.codex.approvals": data = await this.approvals(); break;
      case "x.codex.open": data = await this.open(thread()); break;
      case "x.codex.new": {
        const cwd = str(args.cwd), text = str(args.text);
        if (!cwd || !text) throw new WordError("bad_request", "cwd and text are required");
        data = await this.create(cwd, text, str(args.title) ?? undefined); break;
      }
      case "x.codex.send": { const text = str(args.text); if (!text) throw new WordError("bad_request", "text is required"); data = await this.send(thread(), text, str(args.client_id) ?? undefined); break; }
      case "x.codex.stop": data = await this.stop(thread()); break;
      case "x.codex.approve": {
        const decision = args.decision, request = str(args.request_id);
        if (!request || (decision !== "approve" && decision !== "approve_session" && decision !== "deny")) throw new WordError("bad_request", "request_id and decision are required");
        data = await this.approve(thread(), request, decision); break;
      }
      default: throw new WordError("not_found", `This computer does not offer ${name}`);
    }
    return { ok: true, data: data as Record<string, unknown>, content: [{ type: "text", text: redactText(JSON.stringify(data)) }] };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the shape of a session, as the app sends it (read generously: it is not our format)
// ---------------------------------------------------------------------------------------------------------------------

/** Turns in order. The app may leave `turns` empty and keep the history in `turnHistory`. */
export function canonicalTurns(conv: Rec): Rec[] {
  const legacy = (Array.isArray(conv.turns) ? conv.turns : []).map(rec).filter((t): t is Rec => !!t);
  const history = rec(rec(conv.turnHistory)?.history);
  const entities = rec(history?.entitiesByKey);
  const islands = Array.isArray(history?.islands) ? history!.islands : [];
  if (!entities || !islands.length) return legacy;
  const turns: Rec[] = [], keys = new Set<string>(), ids = new Set<string>();
  const add = (v: unknown) => {
    const t = rec(v);
    if (!t || !Array.isArray(t.items)) return;
    const identity = str(t.id) ?? str(t.turnId);
    if (identity && ids.has(identity)) return;
    if (identity) ids.add(identity);
    turns.push(t);
  };
  for (const island of islands) for (const entry of (Array.isArray(rec(island)?.entries) ? rec(island)!.entries : [])) {
    const key = str(rec(entry)?.value) ?? str(rec(entry)?.key);
    if (!key || keys.has(key)) continue;
    keys.add(key); add(entities[key]);
  }
  for (const t of legacy) add(t);
  return turns.length ? turns : legacy;
}

export function isActive(conv: Rec, turns = canonicalTurns(conv)): boolean {
  const status = rec(conv.threadRuntimeStatus) ?? rec(conv.status);
  if (String(status?.type ?? "").toLowerCase() === "active") return true;
  return String(turns.at(-1)?.status ?? "").toLowerCase().includes("progress");
}

function approvalsOf(conv: Rec) {
  const out: { request_id: string; method: string; kind: string; summary: string; cwd?: string }[] = [];
  for (const value of Array.isArray(conv.requests) ? conv.requests : []) {
    const r = rec(value);
    if (!r || !APPROVALS.has(String(r.method)) || (typeof r.id !== "string" && typeof r.id !== "number")) continue;
    const p = rec(r.params) ?? {};
    const method = String(r.method);
    const kind = /command|exec/i.test(method) ? "command" : /file|patch/i.test(method) ? "file" : /permission/i.test(method) ? "permissions" : "mcp";
    const command = Array.isArray(p.command) ? p.command.join(" ") : str(p.command);
    const summary = command ?? str(p.reason) ?? str(p.message) ?? (kind === "file" ? `改动文件${p.grantRoot ? `（${p.grantRoot}）` : ""}` : kind === "permissions" ? JSON.stringify(p.permissions ?? {}) : method);
    out.push({ request_id: String(r.id), method, kind, summary: redactText(clip(summary, 400)), ...(str(p.cwd) ? { cwd: p.cwd as string } : {}) });
  }
  return out;
}

function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join("\n");
  const r = rec(v);
  return r ? textOf(r.text ?? r.content ?? r.summary ?? "") : "";
}

function itemView(item: Rec, max: number): { kind: string; text?: string; status?: string } {
  const type = String(item.type ?? "item");
  const status = str(item.status) ?? undefined;
  const text = (kind: string, t: unknown) => ({ kind, text: redactText(clip(textOf(t), max)), ...(status ? { status } : {}) });
  switch (type) {
    case "userMessage": return text("user", item.content ?? item.text);
    case "steeringUserMessage": return text("user", rec(item.restoreMessage)?.text ?? item.content ?? item.text);
    case "agentMessage": return text("agent", item.text);
    case "reasoning": return text("thinking", item.summary ?? item.text);
    case "commandExecution": return text("command", Array.isArray(item.command) ? item.command.join(" ") : item.command);
    case "fileChange": return text("file", (Array.isArray(item.changes) ? item.changes : []).map((c) => str(rec(c)?.path)).filter(Boolean).join(", "));
    case "mcpToolCall": return text("tool", [item.server, item.tool].filter(Boolean).join("."));
    case "webSearch": return text("search", item.query);
    case "todo-list": return text("plan", (Array.isArray(item.plan) ? item.plan : []).map((s) => str(rec(s)?.step)).filter(Boolean).join("; "));
    default: return { kind: type, ...(status ? { status } : {}) };
  }
}

function turnView(turn: Rec, max: number) {
  const items = (Array.isArray(turn.items) ? turn.items : []).map(rec).filter((i): i is Rec => !!i);
  return { id: str(turn.id) ?? str(turn.turnId) ?? "", status: str(turn.status) ?? "unknown", items: items.slice(-30).map((i) => itemView(i, max)) };
}

// ---------------------------------------------------------------------------------------------------------------------
// patches: add / replace / remove at a path of keys and indexes
// ---------------------------------------------------------------------------------------------------------------------

export function applyPatches(conv: Rec, patches: unknown[]): Rec {
  const next = structuredClone(conv) as Rec;
  for (const value of patches) {
    const patch = rec(value);
    if (!patch || !Array.isArray(patch.path) || !patch.path.length) throw new Error("bad patch path");
    const path = patch.path as (string | number)[];
    let parent: any = next;
    for (const segment of path.slice(0, -1)) {
      const child = Array.isArray(parent) ? parent[index(segment, parent.length, false)] : rec(parent)?.[String(segment)];
      if (child === null || typeof child !== "object") throw new Error("patch path is missing");
      parent = child;
    }
    const last = path.at(-1)!, op = String(patch.op);
    if (!["add", "replace", "remove"].includes(op)) throw new Error(`unknown patch op ${op}`);
    if (Array.isArray(parent)) {
      const i = index(last, parent.length, op === "add");
      if (op === "add") parent.splice(i, 0, patch.value); else if (op === "replace") parent[i] = patch.value; else parent.splice(i, 1);
    } else if (rec(parent)) {
      if (op === "remove") delete parent[String(last)]; else parent[String(last)] = patch.value;
    } else throw new Error("patch parent is not an object");
  }
  return next;
}

function index(segment: string | number, length: number, allowEnd: boolean): number {
  if (allowEnd && segment === "-") return length;
  const i = typeof segment === "number" ? segment : Number(segment);
  if (!Number.isInteger(i) || i < 0 || i > (allowEnd ? length : length - 1)) throw new Error("bad patch index");
  return i;
}

// ---------------------------------------------------------------------------------------------------------------------
// the Codex runtime, read only: the list of sessions, and a saved session
// ---------------------------------------------------------------------------------------------------------------------

/** The app's own link for a session, opened in the background (`open -g`) so the computer's front window is left alone. */
async function openWithLink(id: string): Promise<void> {
  const url = `codex://threads/${encodeURIComponent(id)}`;
  const [command, args] = process.platform === "darwin" ? ["open", ["-g", url]] : ["xdg-open", [url]];
  await new Promise<void>((resolve, reject) => execFile(command, args, { timeout: 15_000 }, (error) => (error ? reject(error) : resolve())));
}

async function withRuntime<T>(use: (p: JsonProcess) => Promise<T>, client = OWNER_CLIENT): Promise<T> {
  const p = new JsonProcess({ command: (await findRuntime("codex")) ?? "codex", args: ["app-server", "--stdio"], env: childEnv({}) }, homedir());
  p.onFrame = (frame: Frame) => {
    if (frame.id !== undefined && !frame.method) p.settle(frame.id, frame.result, frame.error);
    else if (frame.id !== undefined) p.response(frame.id, undefined, { code: -32601, message: "unsupported" });
  };
  try {
    await p.request("initialize", { clientInfo: { name: client, version: "0.1.0" }, capabilities: { experimentalApi: true } }, 15_000);
    p.write({ jsonrpc: "2.0", method: "initialized", params: {} });
    return await use(p);
  } finally { await p.close(); }
}

const seconds = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined);

async function listWithAppServer(limit: number): Promise<Listed[]> {
  return withRuntime(async (p) => {
    const page = await p.request("thread/list", { limit }, 30_000);
    return (Array.isArray(page?.data) ? page.data : []).map(rec).filter((t: Rec | null): t is Rec => !!t && !!str(t.id)).map((t: Rec) => ({
      id: t.id as string,
      title: clip((str(t.name) ?? str(t.preview) ?? "").split("\n")[0], 80) || "（未命名）",
      ...(str(t.cwd) ? { cwd: t.cwd as string } : {}),
      ...(seconds(t.updatedAt) ? { updated_at: seconds(t.updatedAt) } : {}),
      ...(t.originator === HELPER_ORIGINATOR ? { helper: true } : {}),
    }));
  });
}

async function startWithAppServer(cwd: string, title: string): Promise<string> {
  return withRuntime(async (p) => {
    const id = str(rec((await p.request("thread/start", { cwd }, 30_000))?.thread)?.id);
    if (!id) throw new Error("the runtime gave no session id");
    // An empty session is not kept until something is written to it; its name is.
    await p.request("thread/name/set", { threadId: id, name: title }, 30_000);
    return id;
  });
}

async function readWithAppServer(id: string): Promise<Rec | null> {
  return withRuntime(async (p) => rec((await p.request("thread/read", { threadId: id, includeTurns: true }, 30_000))?.thread));
}
