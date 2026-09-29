// The ash core: members, agents and their queues, the event log, timers, notify.
// Transport-free — server.ts (SDK over HTTP) and mcp.ts (system services for agents) call in.

import { randomBytes } from "node:crypto";
import type { AgentInfo, AgentStatus, AshEvent, DeliverRequest, DeliverResult, EventType, Member, NotifyRequest, Timer, TimerRequest } from "../../sdk/src/api";
import { API_VERSION, AshApiError } from "../../sdk/src/api";
import type { AshWorld } from "./dsh/door";
import type { AgentRuntime, InboundMessage, RuntimeContext } from "./runtime";
import type { Store } from "./store";

export interface Notifier {
  (n: NotifyRequest & { from: string }): Promise<void>;
}

interface AgentSlot {
  info: AgentInfo;
  runtime: AgentRuntime;
  ctx: RuntimeContext;
  queue: InboundMessage[];
  running: InboundMessage | null;
  abort: AbortController | null;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export class Core {
  private readonly agents = new Map<string, AgentSlot>();
  private readonly members = new Map<string, Member>();
  private readonly subscribers = new Set<(e: AshEvent) => void>();
  private timerLoop: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly space: string,
    private readonly store: Store,
    private readonly notifiers: Notifier[] = [],
    readonly log: (...a: unknown[]) => void = () => {},
  ) {
    this.addMember({ id: "person:owner", kind: "person", name: "owner", online: true, capabilities: [] });
    this.addMember({ id: "service:ash", kind: "service", name: "ash core", online: true, capabilities: [] });
  }

  // ---------------------------------------------------------------- events

  emit(workspace: string, member: string, type: EventType, data: Record<string, unknown>): AshEvent {
    const e = this.store.append(workspace, member, type, data);
    for (const s of this.subscribers) {
      try {
        s(e);
      } catch (err) {
        this.log("subscriber failed", err);
      }
    }
    return e;
  }

  subscribe(fn: (e: AshEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  events(q: { after?: number; limit?: number; workspace?: string; type?: string }): { events: AshEvent[]; next: number } {
    const events = this.store.events(q);
    return { events, next: events.length ? events[events.length - 1].seq : (q.after ?? 0) };
  }

  recent(limit: number, workspace?: string): AshEvent[] {
    return this.store.recent(limit, workspace);
  }

  // ---------------------------------------------------------------- members & agents

  addMember(m: Member): void {
    this.members.set(m.id, m);
  }

  listMembers(): Member[] {
    return [...this.members.values()].map((m) => (m.kind === "agent" ? { ...m, online: this.agents.get(m.id)?.info.status !== "stopped" } : m));
  }

  listAgents(): AgentInfo[] {
    return [...this.agents.values()].map((a) => ({ ...a.info, queued: a.queue.length, handle: a.runtime.handle?.() }));
  }

  async addAgent(id: string, workspace: string, runtime: AgentRuntime, ctx: RuntimeContext): Promise<void> {
    if (!id.startsWith("agent:")) throw new Error(`agent ids look like agent:<name> (got ${id})`);
    const info: AgentInfo = { id, runtime: runtime.kind, workspace, status: "starting", capabilities: runtime.capabilities, queued: 0 };
    const slot: AgentSlot = { info, runtime, ctx, queue: [], running: null, abort: null };
    this.agents.set(id, slot);
    this.addMember({ id, kind: "agent", name: id.slice(6), online: true, capabilities: [] });
    try {
      await runtime.start(ctx);
      this.setStatus(slot, "idle");
    } catch (e) {
      this.setStatus(slot, "error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private agent(id: string): AgentSlot {
    const a = this.agents.get(id);
    if (!a) throw new AshApiError(404, "unknown_agent", `no agent ${id}`);
    return a;
  }

  private setStatus(slot: AgentSlot, status: AgentStatus, error?: string): void {
    slot.info.status = status;
    slot.info.last_error = error;
    this.emit(slot.info.workspace, slot.info.id, "agent.status", error ? { status, error } : { status });
  }

  // ---------------------------------------------------------------- control plane

  deliver(agentId: string, req: DeliverRequest, caller: string): DeliverResult {
    const slot = this.agent(agentId);
    if (typeof req.text !== "string" || !req.text.trim()) throw new AshApiError(400, "bad_request", "text is required");
    const mode = req.mode ?? "queue";
    if (mode === "steer" && !slot.runtime.capabilities.deliver_steer) throw new AshApiError(409, "unsupported", `${slot.runtime.kind} cannot steer`);
    const message_id = req.message_id ?? newId("msg");
    if (!this.store.claimMessageId(message_id)) return { accepted: true, message_id, position: -1 }; // duplicate retry
    const msg: InboundMessage = { message_id, from: req.from ?? caller, text: req.text, mode };
    this.emit(slot.info.workspace, msg.from, "message.delivered", { to: agentId, from: msg.from, text: msg.text, message_id, mode });
    if (mode === "steer" && slot.running && slot.runtime.steer) {
      void slot.runtime.steer(msg).catch((e) => this.log("steer failed", e));
      return { accepted: true, message_id, position: 0 };
    }
    slot.queue.push(msg);
    const position = slot.queue.length + (slot.running ? 0 : -1);
    void this.pump(slot);
    return { accepted: true, message_id, position };
  }

  async cancel(agentId: string): Promise<{ cancelled: boolean }> {
    const slot = this.agent(agentId);
    if (!slot.running) return { cancelled: false };
    slot.abort?.abort();
    await slot.runtime.cancel?.().catch((e) => this.log("cancel failed", e));
    return { cancelled: true };
  }

  private async pump(slot: AgentSlot): Promise<void> {
    if (slot.running || slot.info.status === "starting" || slot.info.status === "stopped") return;
    const msg = slot.queue.shift();
    if (!msg) return;
    slot.running = msg;
    slot.abort = new AbortController();
    this.setStatus(slot, "running");
    const ws = slot.info.workspace;
    const id = slot.info.id;
    this.emit(ws, id, "agent.turn.started", { message_id: msg.message_id });
    let result: { reason: "completed" | "error" | "cancelled"; error?: string };
    try {
      result = await slot.runtime.runTurn(
        msg,
        (e) => {
          if (e.type === "text") this.emit(ws, id, "agent.text", { text: e.text, message_id: msg.message_id });
          else if (e.type === "tool.call") this.emit(ws, id, "agent.tool.call", { name: e.name, args: e.args as Record<string, unknown>, message_id: msg.message_id });
          else this.emit(ws, id, "agent.tool.result", { name: e.name, ok: e.ok, preview: e.preview, message_id: msg.message_id });
        },
        slot.abort.signal,
      );
    } catch (e) {
      result = { reason: slot.abort.signal.aborted ? "cancelled" : "error", error: e instanceof Error ? e.message : String(e) };
    }
    this.emit(ws, id, "agent.turn.ended", { message_id: msg.message_id, ...result });
    slot.running = null;
    slot.abort = null;
    // One failed turn does not stop the agent: back to idle, the error stays on the turn and last_error.
    this.setStatus(slot, "idle", result.error);
    void this.pump(slot);
  }

  // ---------------------------------------------------------------- system services

  setTimer(req: TimerRequest, caller: string): Timer {
    const owner = req.owner ?? caller;
    if (!this.members.has(owner)) throw new AshApiError(404, "unknown_member", `no member ${owner}`);
    if (!req.text?.trim()) throw new AshApiError(400, "bad_request", "text is required");
    let fire_at: number;
    if (typeof req.at === "number") fire_at = req.at;
    else if (typeof req.in_seconds === "number" && req.in_seconds >= 1) fire_at = Date.now() + req.in_seconds * 1000;
    else throw new AshApiError(400, "bad_request", "give in_seconds (>= 1) or at (unix ms)");
    if (fire_at < Date.now() - 1000) throw new AshApiError(400, "bad_request", "time is in the past");
    const repeat = typeof req.repeat_seconds === "number" && req.repeat_seconds >= 60 ? req.repeat_seconds : null;
    const t: Timer = { id: newId("tmr"), owner, text: req.text, fire_at, repeat_seconds: repeat, created_by: caller };
    this.store.putTimer(t);
    this.emit(this.workspaceOf(owner), caller, "timer.set", { timer: t });
    return t;
  }

  listTimers(owner?: string): Timer[] {
    return this.store.timers(owner);
  }

  cancelTimer(id: string, caller: string, ownerOnly?: string): { cancelled: boolean } {
    const t = this.store.timers().find((x) => x.id === id);
    if (!t || (ownerOnly && t.owner !== ownerOnly)) return { cancelled: false };
    this.store.deleteTimer(id);
    this.emit(this.workspaceOf(t.owner), caller, "timer.cancelled", { id });
    return { cancelled: true };
  }

  startTimers(): void {
    if (this.timerLoop) return;
    this.timerLoop = setInterval(() => this.fireDue(), 1000);
  }

  private fireDue(): void {
    const now = Date.now();
    for (const t of this.store.timers()) {
      if (t.fire_at > now) continue;
      if (t.repeat_seconds) {
        let next = t.fire_at;
        while (next <= now) next += t.repeat_seconds * 1000;
        this.store.putTimer({ ...t, fire_at: next });
      } else this.store.deleteTimer(t.id);
      this.emit(this.workspaceOf(t.owner), "service:ash", "timer.fired", { timer: t });
      if (this.agents.has(t.owner)) {
        this.deliver(t.owner, { text: t.text, from: `timer:${t.id}` }, "service:ash");
      }
    }
  }

  async notify(req: NotifyRequest, caller: string): Promise<{ ok: true }> {
    if (!req.title?.trim() && !req.text?.trim()) throw new AshApiError(400, "bad_request", "title or text is required");
    const n = { title: req.title ?? "", text: req.text ?? "", urgency: req.urgency ?? "normal" };
    this.emit(this.workspaceOf(caller), caller, "notify", n);
    await Promise.all(this.notifiers.map((f) => f({ ...n, from: caller }).catch((e) => this.log("notifier failed", e))));
    return { ok: true };
  }

  private workspaceOf(member: string): string {
    return this.agents.get(member)?.info.workspace ?? "home";
  }

  /** Handle ② — what an agent world (e.g. DSH) may do with ash, always on behalf of a named member. */
  world(): AshWorld {
    return {
      api: API_VERSION,
      members: () => this.listMembers().map(({ id, kind, name, online }) => ({ id, kind, name, online })),
      agents: () => this.listAgents().map(({ id, runtime, status, queued }) => ({ id, runtime, status, queued })),
      send: (from, to, text) => ({ message_id: this.deliver(to, { text }, from).message_id }),
      setTimer: (owner, req) => this.setTimer({ ...req, owner }, owner),
      listTimers: (owner) => this.listTimers(owner),
      cancelTimer: (owner, id) => this.cancelTimer(id, owner, owner),
      notify: (from, title, text, urgency) => this.notify({ title, text, urgency }, from),
      log: (n) => this.recent(n),
    };
  }

  async stop(): Promise<void> {
    if (this.timerLoop) clearInterval(this.timerLoop);
    for (const a of this.agents.values()) await a.runtime.stop().catch(() => {});
  }
}
