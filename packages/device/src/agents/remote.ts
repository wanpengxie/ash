import { randomUUID } from "node:crypto";
import type { AgentStream } from "./host";
type Frame = Record<string, any>;

/** Phone-side half of the device stream; authorization belongs to the caller. */
export class RemoteAgents {
  private readonly epoch = randomUUID();
  private remoteEpoch?: string;
  private stream?: AgentStream;
  private ready = false;
  private assignments = new Map<string, { generation: string; turn?: string }>();
  private pending = new Map<string, { frame: Frame; finish(value?: unknown, error?: Error): void }>();
  private outbound = new Map<string, Promise<Frame>>();
  private heartbeat?: NodeJS.Timeout;
  get connected(): boolean { return this.ready; }
  constructor(private handlers: {
    event(frame: Frame): void;
    outbound(frame: { session: string; generation: string; turn: string; request_id: string; tool: string; args: Record<string, unknown> }): Promise<unknown>;
    manifestChanged?(): void;
  }) {}

  attach(stream: AgentStream): void {
    this.stream?.close(4409, "replaced"); this.stream = stream; this.ready = false;
    let heard = Date.now();
    const unsubscribe = stream.onMessage(raw => {
      if (this.stream !== stream) return;
      try {
        if (typeof raw !== "string") throw new Error();
        const frame = JSON.parse(raw); heard = Date.now();
        if (frame.type === "hello") {
          if (typeof frame.epoch !== "string" || !frame.epoch || frame.epoch.length > 100) throw new Error();
          if (this.remoteEpoch && this.remoteEpoch !== frame.epoch) {
            for (const pending of this.pending.values()) pending.finish(undefined, new Error("result_unknown: device restarted; do not replay actions"));
            this.assignments.clear(); this.outbound.clear();
          }
          const first = !this.ready; this.remoteEpoch = frame.epoch; this.ready = true;
          if (first) for (const pending of this.pending.values()) this.send(pending.frame);
        } else if (!this.ready) throw new Error();
        else if (frame.type === "ping") this.send({ type: "pong" });
        else if (frame.type === "pong") { /* heartbeat */ }
        else if (frame.type === "op_result") {
          const pending = this.pending.get(frame.id);
          if (pending) {
            if (frame.ok) this.accept(pending.frame, frame.result);
            pending.finish(frame.result, frame.ok ? undefined : new Error(`${frame.error?.code ?? "failed"}: ${frame.error?.message ?? "device operation failed"}`));
          }
        } else if (frame.type === "event") {
          if (this.matches(frame, frame.event?.turn)) {
            this.handlers.event(frame);
            if (frame.event?.type === "turn_ended") this.assignments.get(frame.session)!.turn = undefined;
          }
        } else if (frame.type === "outbound") void this.answer(frame);
        else if (frame.type === "manifest_changed") this.handlers.manifestChanged?.();
        else throw new Error();
      } catch { stream.close(4400, "invalid device protocol"); }
    });
    stream.onClose(() => { unsubscribe(); if (this.stream === stream) { this.stream = undefined; this.ready = false; clearInterval(this.heartbeat); } });
    this.send({ type: "hello", epoch: this.epoch });
    this.heartbeat = setInterval(() => { if (Date.now() - heard > 90_000) stream.close(4410, "silent"); else this.send({ type: "ping" }); }, 30_000); this.heartbeat.unref();
  }
  private send(frame: Frame): void {
    try { this.stream?.send(JSON.stringify(frame)); } catch { /* same-process reconnect can resend stable IDs */ }
  }
  async op(op: string, args: Frame = {}, target?: { session: string; generation: string }, timeoutMs = 45_000): Promise<any> {
    if (!this.ready) throw new Error("device_offline: wait for device connection");
    if (op === "send") {
      const assignment = target && this.assignments.get(target.session);
      if (!assignment || assignment.generation !== target!.generation || assignment.turn) throw new Error("session unavailable or busy");
      assignment.turn = args.turn;
    }
    const id = randomUUID(), frame = { type: "op", epoch: this.remoteEpoch, id, op, ...target, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(undefined, new Error("result_unknown: operation timed out; inspect result before retrying")), timeoutMs);
      const finish = (value?: unknown, error?: Error) => { clearTimeout(timer); this.pending.delete(id); error ? reject(error) : resolve(value); };
      this.pending.set(id, { frame, finish }); this.send(frame);
    });
  }
  private accept(request: Frame, result: Frame): void {
    if (request.op === "open" && typeof result?.session === "string" && typeof result.generation === "string") this.assignments.set(result.session, { generation: result.generation });
    if (request.op === "close") this.assignments.delete(request.session);
    if (["clear", "select"].includes(request.op) && typeof result?.generation === "string") this.assignments.set(request.session, { generation: result.generation });
    if (request.op === "status" && result?.generation === request.generation && result.session === request.session)
      this.assignments.set(request.session, { generation: request.generation, turn: result.turn ?? undefined });
  }
  private matches(frame: Frame, turn: unknown): boolean {
    const assignment = this.assignments.get(frame.session);
    return !!assignment && frame.generation === assignment.generation && typeof turn === "string" && turn === assignment.turn;
  }
  private async answer(frame: Frame): Promise<void> {
    if (typeof frame.request_id !== "string" || frame.request_id.length > 100) return;
    const key = `${this.remoteEpoch}:${frame.request_id}`;
    let reply = this.outbound.get(key);
    if (!reply) {
      const base = { type: "outbound_result", session: frame.session, generation: frame.generation, turn: frame.turn, request_id: frame.request_id };
      if (!this.matches(frame, frame.turn) || !["agent_list", "agent_ask", "agent_tell"].includes(frame.tool)) {
        this.send({ ...base, ok: false, error: { code: "cancelled", message: "Turn is no longer assigned to this device session" } }); return;
      }
      if (this.outbound.size >= 10_000) { this.send({ ...base, ok: false, error: { code: "busy" } }); return; }
      reply = Promise.resolve().then(() => this.handlers.outbound(frame as any)).then(result => ({ ...base, ok: true, result }), () => ({ ...base, ok: false, error: { code: "failed", message: "Ash communication failed" } }));
      this.outbound.set(key, reply);
    }
    const result = await reply;
    if (`${this.remoteEpoch}:${frame.request_id}` === key) this.send(result);
  }
  close(): void {
    clearInterval(this.heartbeat); this.stream?.close(4410, "owner stopping"); this.stream = undefined; this.ready = false;
    for (const call of this.pending.values()) call.finish(undefined, new Error("result_unknown: owner disconnected"));
  }
}
