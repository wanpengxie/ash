import type { Message } from "../../../sdk/src/api";
import { STATUS_FALLBACK_LABEL, statusLabel } from "../../../sdk/src/labels";
import { WorldRouter, type TrustedRouteContext } from "../world/router";

export type AgentStatusState = "idle" | "listening" | "thinking" | "working" | "done" | "waiting_you" | "resting";
export interface AgentStatusSnapshot { state: AgentStatusState; text: string }

const LISTEN_MS = 1_500;
const TYPING_MS = 4_500; // screens send typing every three seconds
const DONE_MS = 4_000;
const REST_MS = 30 * 60_000;
const DEFAULT_TEXT: Record<Exclude<AgentStatusState, "working">, string> = {
  idle: "在线", listening: "在听", thinking: "在想", done: "", waiting_you: "等你一句话", resting: "休息中",
};
type PendingInput = { id: string; from: string; to: string; word: string; turn?: string };

/** Derives display status from committed route/turn facts; no model status command exists. */
export class AgentStatus {
  private readonly pending = new Map<string, PendingInput>();
  private readonly unsubscribe: () => void;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tail = Promise.resolve();
  private running = false;
  private closed = false;
  private activeTurn: string | null = null;
  private listeningUntil = 0;
  private typingUntil = 0;
  private doneUntil = 0;
  private lastActivity: number;
  private last: AgentStatusSnapshot | null = null;
  private lastQueued: AgentStatusSnapshot | null = null;
  private failure: Error | null = null;

  constructor(private readonly router: WorldRouter, private readonly now: () => number = Date.now,
    private readonly isPaused: () => boolean = () => false) {
    this.lastActivity = now();
    this.unsubscribe = router.subscribe((message) => this.observe(message));
  }

  get snapshot(): AgentStatusSnapshot | null { return this.last && { ...this.last }; }
  get lastError(): Error | null { return this.failure; }
  async settled(): Promise<void> { await this.tail; if (this.failure) throw this.failure; }

  private context(): TrustedRouteContext {
    return { transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false };
  }

  async start(): Promise<void> {
    if (this.closed || this.running) throw new Error("agent status cannot start twice");
    this.running = true;
    this.lastActivity = this.now();
    for (const request of this.router.pendingStatusInputs("agent:main")) this.pending.set(request.id, request);
    this.publish({ state: "resting", text: DEFAULT_TEXT.resting });
    await this.settled();
    this.refresh();
    await this.settled();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
  }

  /** Explicit resampling is used when durable pause state changes outside the router. */
  refresh(): void {
    if (!this.running || this.closed) return;
    const now = this.now();
    const current = this.derive(now);
    this.publish(current);
    this.arm(now);
  }

  private derive(now: number): AgentStatusSnapshot {
    if (this.isPaused() || (this.activeTurn === null && this.pending.size === 0 && now - this.lastActivity >= REST_MS))
      return { state: "resting", text: DEFAULT_TEXT.resting };
    const tool = [...this.pending.values()].reverse().find((item) => item.from === "agent:main" && !(item.to === "person:owner" && item.word === "ask"));
    if (tool) return { state: "working", text: statusLabel(tool.to, tool.word, this.router.registeredLabel(tool.to, tool.word)) };
    if ([...this.pending.values()].some((item) => item.to === "person:owner" && item.word === "ask"))
      return { state: "waiting_you", text: DEFAULT_TEXT.waiting_you };
    if (now < this.listeningUntil || now < this.typingUntil) return { state: "listening", text: DEFAULT_TEXT.listening };
    if (this.activeTurn !== null) return { state: "thinking", text: DEFAULT_TEXT.thinking };
    if (now < this.doneUntil) return { state: "done", text: DEFAULT_TEXT.done };
    return { state: "idle", text: DEFAULT_TEXT.idle };
  }

  private publish(next: AgentStatusSnapshot): void {
    const latest = this.lastQueued ?? this.last;
    if (latest?.state === next.state && latest.text === next.text) return;
    this.lastQueued = next;
    this.tail = this.tail.then(async () => {
      if (this.closed) return;
      try {
        await this.router.send(this.context(), { to: null, kind: "event", word: "status", body: { state: next.state, text: next.text } }, this.controller.signal);
        this.last = next;
        this.failure = null;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        if (this.lastQueued === next) this.lastQueued = null;
      }
    });
  }

  private arm(now: number): void {
    if (this.timer) clearTimeout(this.timer);
    const deadlines = [this.listeningUntil, this.typingUntil, this.doneUntil,
      this.activeTurn === null && this.pending.size === 0 ? this.lastActivity + REST_MS : 0].filter((at) => at > now);
    if (!deadlines.length) { this.timer = null; return; }
    this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, Math.max(1, Math.min(...deadlines) - now));
    this.timer.unref();
  }

  private observe(message: Message): void {
    if (!this.running || this.closed || (message.from === "agent:main" && message.kind === "event" && message.word === "status")) return;
    const now = this.now();
    if (message.kind === "event" && message.to === "agent:main" && message.word === "typing" && message.from.startsWith("screen:")) {
      this.typingUntil = now + TYPING_MS;
      this.lastActivity = now;
    } else if (message.from === "agent:main" && message.kind === "event") {
      if (message.word === "read" && typeof message.body.turn === "string") {
        this.listeningUntil = now + LISTEN_MS;
        this.doneUntil = 0;
        this.lastActivity = now;
      } else if (message.word === "turn.start" && typeof message.body.turn === "string") {
        this.activeTurn = message.body.turn;
        this.lastActivity = now;
      } else if (message.word === "turn.end" && message.body.turn === this.activeTurn) {
        this.activeTurn = null;
        this.listeningUntil = 0;
        this.doneUntil = message.body.reason === "completed" ? now + DONE_MS : 0;
        this.lastActivity = now;
      }
    } else if (message.kind === "request" && message.to &&
      (message.from === "agent:main" || (message.to === "person:owner" && message.word === "ask"))) {
      this.pending.set(message.id, { id: message.id, from: message.from, to: message.to, word: message.word,
        ...(message.turn ? { turn: message.turn } : {}) });
      this.lastActivity = now;
    } else if (message.kind === "response" && message.reply_to && this.pending.delete(message.reply_to)) {
      this.lastActivity = now;
    } else return;
    try { this.refresh(); }
    catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
  }
}
