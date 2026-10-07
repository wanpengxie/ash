import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { redact } from "../redact";
import { CodexSession } from "./codex";
import { ClaudeSession } from "./claude";
import { WorkBuddySession } from "./workbuddy";
import type { AgentEvent, AgentSession, OpenOptions, Tool } from "./types";

export interface AgentStream {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (message: string | Uint8Array) => void): () => void;
  onClose(handler: (result: { code: number; reason: string }) => void): () => void;
}
type Kind = "codex" | "claude" | "workbuddy";
type Factory = (kind: Kind, options: OpenOptions) => Promise<AgentSession>;
type Frame = Record<string, any>;
interface SessionRecord {
  id: string; generation: string; kind: Kind; cwd: string; seed?: string; model?: string; effort?: string; system?: string;
  runtime?: AgentSession; opening?: Promise<AgentSession>; busy?: string; latest?: Frame; operating?: boolean;
}
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const toolSurface: Tool[] = [
  { name: "agent_list", description: "List agents registered with Ash.", inputSchema: { type: "object", additionalProperties: false } },
  ...["agent_ask", "agent_tell"].map(name => ({ name, description: name === "agent_ask" ? "Ask an Ash agent and wait for its answer." : "Tell an Ash agent something.", inputSchema: { type: "object", properties: { agent: { type: "string" }, text: { type: "string" } }, required: ["agent", "text"], additionalProperties: false } })),
];
const defaultFactory: Factory = (kind, options) => ({ codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession })[kind].open(options);
function short(text: string, bytes = 4096): string {
  const buffer = Buffer.from(text); if (buffer.length <= bytes) return text;
  let end = bytes; while ((buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

/** Device-local sessions, one duplex link. No persistent action queue or automatic task replay. */
export class AgentHost {
  accepting = true;
  get busy(): boolean { return [...this.sessions.values()].some(record => !!record.busy || !!record.opening || !!record.operating); }
  readonly epoch = randomUUID();
  private stream?: AgentStream;
  private sessions = new Map<string, SessionRecord>();
  private operations = new Map<string, { input: string; result: Promise<Frame> }>();
  private outbound = new Map<string, { frame: Frame; finish(value?: unknown, error?: Error): void }>();
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  constructor(private stateDir: string, private workdir: string, private factory: Factory = defaultFactory) {
    mkdirSync(join(stateDir, "agents"), { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "results"), { recursive: true, mode: 0o700 });
  }
  attach(stream: AgentStream): void {
    this.stream?.close(4409, "replaced");
    if (this.closed) { stream.close(4410, "device stopping"); return; }
    this.stream = stream; let ownerEpoch: string | undefined; let heard = Date.now();
    const receive = stream.onMessage(raw => {
      if (this.stream !== stream) return;
      try {
        if (typeof raw !== "string") throw new Error();
        const frame: Frame = JSON.parse(raw); heard = Date.now();
        if (frame.type === "hello" && typeof frame.epoch === "string" && frame.epoch.length <= 100) {
          if (ownerEpoch && ownerEpoch !== frame.epoch) throw new Error();
          ownerEpoch = frame.epoch;
          this.send({ type: "hello", epoch: this.epoch, sessions: [...this.sessions.values()].map(s => ({ session: s.id, generation: s.generation, turn: s.busy ?? null })) });
          for (const s of this.sessions.values()) if (s.latest) this.send(s.latest);
          for (const call of this.outbound.values()) this.send(call.frame);
        } else if (!ownerEpoch) throw new Error();
        else if (frame.type === "ping") this.send({ type: "pong" });
        else if (frame.type === "pong") { /* heartbeat */ }
        else if (frame.type === "op") void this.operation(frame, ownerEpoch).then(response => { if (this.stream === stream) this.send(response); });
        else if (frame.type === "outbound_result") {
          const item = this.outbound.get(frame.request_id);
          if (item && frame.session === item.frame.session && frame.generation === item.frame.generation && frame.turn === item.frame.turn) item.finish(frame.result, frame.ok === true ? undefined : new Error("Ash communication rejected"));
        } else throw new Error();
      } catch { stream.close(4400, "invalid device protocol"); }
    });
    stream.onClose(() => {
      receive();
      if (this.stream === stream) { this.stream = undefined; clearInterval(this.heartbeat); }
    });
    this.heartbeat = setInterval(() => { if (Date.now() - heard > 90_000) stream.close(4410, "silent"); else this.send({ type: "ping" }); }, 30_000);
    this.heartbeat.unref();
    this.send({ type: "hello", epoch: this.epoch });
  }
  private send(frame: Frame): void {
    try { this.stream?.send(JSON.stringify(frame)); } catch { /* reconnect queries result; never rerun the action here */ }
  }
  private async operation(frame: Frame, ownerEpoch: string): Promise<Frame> {
    const error = (code: string, message: string) => ({ type: "op_result", id: frame.id, ok: false, error: { code, message } });
    if (typeof frame.id !== "string" || !idPattern.test(frame.id)) return error("invalid", "Invalid operation id");
    if (frame.epoch !== this.epoch) return error("result_unknown", "Device process changed; do not replay actions");
    if (!this.accepting && ["open", "send", "steer"].includes(frame.op)) return error("busy", "Device update is in progress");
    const key = ownerEpoch + ":" + frame.id, input = JSON.stringify(frame), previous = this.operations.get(key);
    if (previous) return previous.input === input ? previous.result : error("invalid", "Operation id reused with different arguments");
    // Do not evict accepted operation IDs and silently make an old retry executable again.
    if (this.operations.size >= 10_000) return error("busy", "Device operation cache full; reconnect after restarting idle device");
    const promise = this.execute(frame).then(result => ({ type: "op_result", id: frame.id, ok: true, result }), e => error(e instanceof TypeError ? "invalid" : "result_unknown", e instanceof TypeError ? e.message : "Operation did not complete reliably; inspect session/result before retrying"));
    this.operations.set(key, { input, result: promise }); return promise;
  }
  private file(id: string): string { return join(this.stateDir, "agents", id + ".json"); }
  private save(record: SessionRecord): void {
    const { runtime, opening, busy, latest, operating, ...data } = record;
    const path = this.file(record.id); writeFileSync(path + ".tmp", JSON.stringify(data), { mode: 0o600 }); renameSync(path + ".tmp", path);
  }
  private resultFile(session: string, turn: string): string { return join(this.stateDir, "results", session, turn + ".json"); }
  private async execute(frame: Frame): Promise<unknown> {
    if (this.closed) throw new TypeError("Device stopping");
    const args = frame.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("Invalid arguments");
    if (frame.op === "open") {
      if (this.sessions.size >= 8) throw new TypeError("Close an idle session before opening another");
      const id = args.session ?? randomUUID(); if (typeof id !== "string" || !idPattern.test(id) || this.sessions.has(id)) throw new TypeError("Invalid or open session");
      const saved = existsSync(this.file(id)) ? JSON.parse(readFileSync(this.file(id), "utf8")) : {};
      const kind = args.kind ?? saved.kind;
      if (!["codex", "claude", "workbuddy"].includes(kind) || (saved.kind && kind !== saved.kind)) throw new TypeError("Invalid runtime");
      for (const key of ["cwd", "model", "effort", "seed", "system"]) if (args[key] !== undefined && typeof args[key] !== "string") throw new TypeError(`Invalid ${key}`);
      const record: SessionRecord = { id, kind, cwd: resolve(args.cwd ?? saved.cwd ?? this.workdir), generation: randomUUID(),
        seed: args.seed ?? saved.seed, model: args.model ?? saved.model, effort: args.effort ?? saved.effort, system: args.system ?? saved.system };
      this.sessions.set(id, record);
      try { await this.launch(record); this.save(record); return { session: id, generation: record.generation }; }
      catch (e) { this.sessions.delete(id); throw e; }
    }
    if (typeof frame.session !== "string" || !idPattern.test(frame.session)) throw new TypeError("Invalid session");
    if (frame.op === "result") {
      if (typeof args.turn !== "string" || !idPattern.test(args.turn)) throw new TypeError("Invalid turn");
      const file = this.resultFile(frame.session, args.turn);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { state: "unknown", message: "No final result recorded; do not automatically rerun" };
    }
    const record = this.sessions.get(frame.session);
    if (!record || record.generation !== frame.generation) throw new TypeError("Session generation is no longer current");
    if (frame.op === "status") return { session: record.id, generation: record.generation, running: !!record.runtime, turn: record.busy ?? null, latest: record.latest };
    if (record.operating) throw new TypeError("Session control operation in progress");
    record.operating = true;
    try {
      if (frame.op === "close") { await record.runtime?.close(); this.sessions.delete(record.id); return {}; }
      if (frame.op === "clear" || frame.op === "select") {
        if (record.busy) throw new TypeError("Session busy");
        for (const key of ["model", "effort"] as const) if (args[key] !== undefined) {
          if (typeof args[key] !== "string") throw new TypeError(`Invalid ${key}`);
        }
        if (frame.op === "clear" || (record.kind === "claude" && args.effort !== undefined && args.effort !== record.effort)) {
          await record.runtime?.close(); record.runtime = undefined; record.generation = randomUUID();
          if (frame.op === "clear") record.seed = undefined;
          record.model = args.model ?? record.model; record.effort = args.effort ?? record.effort;
          await this.launch(record);
        } else {
          await record.runtime?.select(args.model ?? record.model, args.effort ?? record.effort);
          record.model = args.model ?? record.model; record.effort = args.effort ?? record.effort;
        }
        this.save(record); return { generation: record.generation };
      }
      if (!record.runtime) throw new TypeError("Runtime ended; close and reopen this session");
      if (typeof args.turn !== "string" || !idPattern.test(args.turn)) throw new TypeError("Invalid turn");
      if (frame.op === "send") {
        if (record.busy || existsSync(this.resultFile(record.id, args.turn))) throw new TypeError("Turn is already running or completed");
        if (typeof args.text !== "string" || !args.text.trim()) throw new TypeError("Text required");
        record.busy = args.turn;
        await record.runtime.send(args.turn, args.text); return { turn: args.turn };
      }
      if (record.busy !== args.turn) throw new TypeError("Turn is not running");
      if (frame.op === "interrupt") { await record.runtime.interrupt(args.turn); return { accepted: true }; }
      if (frame.op === "steer" && typeof args.text === "string") return { accepted: await record.runtime.steer(args.turn, args.text) };
      throw new TypeError("Unknown operation");
    } finally { record.operating = false; }
  }
  private async launch(record: SessionRecord): Promise<void> {
    const generation = record.generation;
    record.opening = this.factory(record.kind, {
      cwd: record.cwd, seed: record.seed, model: record.model, effort: record.effort, system: record.system, tools: toolSurface,
      onEvent: event => { if (record.generation === generation) this.event(record, event); },
      onOutbound: call => {
        if (record.generation !== generation || record.busy !== call.turn) return Promise.reject(new Error("turn no longer current"));
        const request_id = randomUUID();
        const frame = { type: "outbound", session: record.id, generation, turn: call.turn, request_id, tool: call.tool, args: call.args };
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => finish(undefined, new Error("Ash communication timed out")), 600_000);
          const finish = (value?: unknown, error?: Error) => { clearTimeout(timer); this.outbound.delete(request_id); error ? reject(error) : resolve(value); };
          this.outbound.set(request_id, { frame, finish }); this.send(frame);
        });
      },
    }).then(async runtime => {
      if (this.closed || record.generation !== generation) { await runtime.close(); throw new Error("Session retired while starting"); }
      record.runtime = runtime;
      return runtime;
    });
    try { await record.opening; } finally { record.opening = undefined; }
  }
  private event(record: SessionRecord, raw: AgentEvent): void {
    const event = redact(raw) as AgentEvent;
    if (event.type === "seed_updated") { record.seed = event.seed; this.save(record); return; }
    if ("turn" in event && event.turn !== record.busy) return;
    if (event.type === "ended") record.runtime = undefined;
    if (event.type === "note") event.text = short(event.text);
    if (event.type === "tool" && event.summary) event.summary = short(event.summary);
    const frame: Frame = { type: "event", session: record.id, generation: record.generation, event };
    if (event.type === "turn_ended") {
      record.busy = undefined;
      for (const item of this.outbound.values()) if (item.frame.session === record.id && item.frame.generation === record.generation && item.frame.turn === event.turn) item.finish(undefined, new Error("turn ended"));
      const file = this.resultFile(record.id, event.turn);
      mkdirSync(join(this.stateDir, "results", record.id), { recursive: true, mode: 0o700 });
      if (Buffer.byteLength(event.reply) > 48 * 1024) {
        const replyPath = file + ".txt"; writeFileSync(replyPath, event.reply, { mode: 0o600 });
        frame.event = { ...event, reply: short(event.reply, 16 * 1024), reply_path: replyPath, truncated: true };
      }
      writeFileSync(file + ".tmp", JSON.stringify(frame), { mode: 0o600 }); renameSync(file + ".tmp", file);
    }
    if (event.type !== "ended") record.latest = frame;
    this.send(frame);
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.heartbeat); this.stream?.close(4410, "device stopping"); this.stream = undefined;
    for (const call of this.outbound.values()) call.finish(undefined, new Error("device stopping"));
    await Promise.all([...this.sessions.values()].map(async record => {
      if (record.opening) { try { await record.opening; } catch { /* failed startup */ } }
      await record.runtime?.close();
    })); this.sessions.clear();
  }
}
