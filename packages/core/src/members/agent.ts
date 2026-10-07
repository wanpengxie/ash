import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID, wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import { Ledger } from "../world/ledger";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";
import { AgentInbox, type StoredTurn } from "../world/agent-inbox";
import { DEFAULT_TURN_TEXT_BUDGET, TurnTextBudgetError, renderTurnBatch } from "./agent-render";
import { AgentStatus } from "./agent-status";
import type { AgentMind, MindSnapshot } from "./agent-mind";

/** Full messages are control data. A model adapter must inject only `rendered`, never stringify `messages`. */
export interface AgentTurnInput {
  turn: string;
  messages: readonly Message[];
  rendered: string;
  stopFacts: readonly string[];
  managedSnapshot?: MindSnapshot;
  /** Trusted per-turn peripheral instruction, never derived from the owner message renderer. */
  peripheralContext?: string;
}
export interface AgentTurnOutput { id: string; text: string }
export interface AgentTurnRunner {
  /** Optional lower text cap; not a claim about the provider's total context window. */
  renderBudgetBytes?: number;
  /**
   * Hand messages that arrived mid-turn to the work in progress (they are seen at the agent's next step). True only when
   * the running work took them; false leaves them for the next turn.
   */
  steer?(input: { turn: string; messages: readonly Message[]; rendered: string }, signal: AbortSignal): Promise<boolean>;
  /** Settlement must prove the underlying session is idle, including after abort. A turn/end event alone is insufficient. */
  runTurn(input: AgentTurnInput, emit: (output: AgentTurnOutput) => Promise<void>, signal: AbortSignal): Promise<{ reason: "completed" | "error"; error?: string }>;
}

export interface AgentMemberOptions {
  /** agent:main (the default) is the one the owner talks with; any other id is a declared agent. */
  id?: string;
  ledger: Ledger;
  router: WorldRouter;
  stateDir: string;
  runner: AgentTurnRunner;
  name?: string;
  isPaused?: () => boolean;
  currentAdminPauseTargets?: (requestId: unknown, turn: unknown) => boolean;
  managedSnapshot?: () => Promise<MindSnapshot>;
  /** Ash lifecycle capture, after durable start and before dispatching the runner. Bounded by the router. */
  beforeTurn?: (turn: string) => Promise<string | void>;
  mind?: () => AgentMind | null;
}

const say = wordContract("agent:main", "say") as WordSpec | undefined;
const cancelTurn = wordContract("agent:main", "cancel_turn") as WordSpec | undefined;
const typing = wordContract("agent:main", "typing") as WordSpec | undefined;
const wake = wordContract("agent:main", "wake") as WordSpec | undefined;
if (!say || say.kind !== "request" || !cancelTurn || cancelTurn.kind !== "request" || !typing || typing.kind !== "event" || !wake || wake.kind !== "request") throw new Error("agent contract unavailable");

/** Durable one-at-a-time intake. The secondary session is added by later work. */
export class AgentMember implements Member {
  readonly id: string;
  readonly kind = "agent" as const;
  /** Only the main agent speaks in the owner's conversation. */
  readonly main: boolean;
  /** A stopped agent keeps its inbox but takes no turns; the Agent system starts and stops it. */
  get online(): boolean { return this.enabled; }
  readonly idempotentRecovery = ["say", "cancel_turn", "wake"] as const;
  readonly name: string;
  readonly inbox: AgentInbox;
  readonly status: AgentStatus;
  private readonly ledger: Ledger;
  private readonly router: WorldRouter;
  private readonly runner: AgentTurnRunner;
  private readonly isPaused: () => boolean;
  private readonly currentAdminPauseTargets: (requestId: unknown, turn: unknown) => boolean;
  private readonly managedSnapshot?: () => Promise<MindSnapshot>;
  private readonly beforeTurn?: (turn: string) => Promise<string | void>;
  private readonly mind?: () => AgentMind | null;
  private lastManagedSeq: number;
  private started = false;
  private closed = false;
  private draining = false;
  private active: AbortController | null = null;
  private activeTurn: string | null = null;
  private prepared = false;
  private quiescenceBlocked = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private receiptTask: Promise<void> | null = null;
  private steering: Promise<void> = Promise.resolve();
  private steered: { turn: string; ids: string[] } | null = null;
  private activeAudience: string | null = null;
  private enabled = true;
  private error: Error | null = null;

  constructor(options: AgentMemberOptions) {
    this.id = options.id ?? "agent:main";
    if (!AGENT_ID.test(this.id)) throw new TypeError("invalid agent id");
    this.main = this.id === "agent:main";
    this.name = options.name ?? "Assistant";
    this.ledger = options.ledger;
    this.router = options.router;
    this.runner = options.runner;
    this.isPaused = options.isPaused ?? (() => false);
    this.currentAdminPauseTargets = options.currentAdminPauseTargets ?? (() => false);
    this.managedSnapshot = options.managedSnapshot;
    this.beforeTurn = options.beforeTurn;
    this.mind = options.mind;
    this.lastManagedSeq = options.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }).at(-1)?.seq ?? 0;
    this.inbox = new AgentInbox(options.stateDir);
    this.status = new AgentStatus(this.router, Date.now, options.isPaused, this.id);
  }

  words(): readonly WordSpec[] {
    const specs = !this.main ? [say!, cancelTurn!] : this.mind ? [say!, cancelTurn!, wake!, typing!] : [say!, cancelTurn!, typing!];
    // The agent words are written once under the main agent; each agent registers them as its own.
    return this.main ? specs : specs.map((spec) => ({ ...spec, member: this.id }) as WordSpec);
  }
  get lastError(): Error | null { return this.error ?? this.status.lastError; }
  get waitingForQuiescence(): boolean { return this.quiescenceBlocked; }
  /** Agent system cancellation is scoped to one delegated turn, never whichever work happens to be current. */
  cancelWork(turn: string, reason: string): void {
    if (this.inbox.activeTurn()?.id === turn) this.cancelActive(`delegation:${turn}`, reason, undefined);
  }
  /** The Agent system's switch: a stopped agent's turn is cancelled and it takes no new ones until started again. */
  setEnabled(enabled: boolean, reason = "Stopped by ash"): void {
    this.enabled = enabled;
    if (!enabled && this.inbox.activeTurn()) this.cancelActive(`agent-stop:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, reason, undefined);
    if (enabled) this.schedule();
  }

  /** Resample the single durable admin pause fact after a committed transition. */
  resamplePause(): void { this.status.refresh(); this.schedule(); }
  counts(): { pending: number; read: number; active: number } { return this.inbox.counts(); }

  handle(message: Message, context: RouteHandlerContext): ResponseBody | Promise<ResponseBody> {
    if (this.closed) return { ok: false, error: { code: "offline", message: "agent inbox is closed" } };
    if (message.word === "typing" && message.kind === "event") return { ok: true };
    if (message.word === "cancel_turn") return this.handleCancel(message);
    if (message.word === "wake") {
      const mind = this.mind?.();
      return mind ? mind.handleWake(message, context.signal) : { ok: false, error: { code: "offline", message: "mind unavailable" } };
    }
    if (message.word !== "say") return { ok: false, error: { code: "not_found", message: "agent word not available" } };
    this.inbox.accept(message, this.id); // sync durable commit before acknowledging the route
    if (this.started) void this.receipts().catch((error) => { this.error = error instanceof Error ? error : new Error(String(error)); this.later(); });
    this.schedule();
    if (this.started && this.activeTurn && this.runner.steer) this.steering = this.steering.then(() => this.steer()).catch(() => { /* left pending for the next turn */ });
    return { ok: true, result: { accepted: true } };
  }

  private handleCancel(message: Message): ResponseBody {
    if (message.to !== this.id || message.kind !== "request" || !["service:reflex", "service:admin"].includes(message.from)) {
      return { ok: false, error: { code: "forbidden", message: "internal cancellation only" } };
    }
    const reason = String(message.body.reason ?? "Stop requested");
    const by = typeof message.body.by === "string" ? message.body.by : undefined;
    const active = this.inbox.activeTurn();
    if (message.from === "service:admin" && (!message.turn || active?.id !== message.turn ||
      !this.currentAdminPauseTargets(message.body.by, message.turn)))
      return { ok: true, result: { cancelled: false } };
    // Reflex captures the turn when the owner spoke. A late decision must never
    // cancel a newer turn that happened to start before this request dispatched.
    if (message.from === "service:reflex" && message.turn && active?.id !== message.turn)
      return { ok: true, result: { cancelled: false } };
    return this.cancelActive(message.id, reason, by);
  }

  /** Stop the running turn, durably, before anything else can replay its effects. */
  private cancelActive(requestId: string, reason: string, by: string | undefined): ResponseBody {
    const active = this.inbox.activeTurn();
    const inFlight = active ? this.ledger.trackedRequests().filter((item) => item.message.from === this.id && item.message.turn === active.id) : [];
    const action = inFlight.at(-1)?.message;
    const safeReason = [...reason].slice(0, 160).join("");
    const fact = `The previous turn was stopped${action ? ` while ${action.to}/${action.word} was pending` : "; the exact last action is unknown"}. Reason: ${safeReason}. Any external effect may be unknown.`;
    const receipt = this.inbox.recordCancel(requestId, reason, by, fact); // durable before cross-database settlement or abort
    if (!receipt.cancelled || !receipt.turn) return { ok: true, result: { cancelled: false } };
    this.router.cancelTurn(this.id, receipt.turn); // wake pending tool promises before aborting the runtime
    const ended = this.inbox.finish(receipt.turn, "cancelled", "External effect may be unknown; waiting for runner to become idle");
    // Words the owner added mid-turn were never answered; the next turn takes them up again.
    if (this.steered?.turn === receipt.turn) { this.inbox.release(this.steered.ids, receipt.turn); this.steered = null; this.schedule(); }
    if (this.activeTurn === receipt.turn && this.active) { this.quiescenceBlocked = true; this.active.abort(); }
    void this.turnEvents(ended).catch((error) => { this.error = error instanceof Error ? error : new Error(String(error)); this.later(); });
    return { ok: true, result: { cancelled: true } };
  }

  /** Must run after member registration and before router.recover(), so cancelled effects cannot replay. */
  reconcileCommittedPause(pauseRequestId: string, targetTurn: string | null): void {
    if (this.closed || this.started || this.prepared) throw new Error("pause reconciliation must precede recovery");
    const active = this.inbox.activeTurn();
    if (!active) return;
    if (!targetTurn || active.id !== targetTurn || !this.currentAdminPauseTargets(pauseRequestId, targetTurn))
      throw new Error("active turn does not match current durable pause target");
    const action = this.ledger.trackedRequests().filter((item) => item.message.from === this.id && item.message.turn === active.id).at(-1)?.message;
    const fact = `The previous turn was stopped${action ? ` while ${action.to}/${action.word} was pending` : "; the exact last action is unknown"}. Reason: Paused by owner. Any external effect may be unknown.`;
    this.inbox.recordCancel(`admin-recovery:${pauseRequestId}`, "Paused by owner", pauseRequestId, fact);
  }

  /** Must run after member registration and before router.recover(), so cancelled effects cannot replay. */
  prepareRecovery(): void {
    if (this.closed || this.started) throw new Error("cancellation recovery must precede start");
    for (const turn of this.inbox.cancelIntents()) {
      this.router.cancelTurn(this.id, turn);
      this.inbox.finish(turn, "cancelled", "Interrupted during cancellation; external effect may be unknown");
    }
    this.prepared = true;
  }

  /** Register with WorldMembers first; call after router recovery and all real endpoints exist. */
  async start(): Promise<void> {
    if (this.closed || this.started) throw new Error("agent member cannot start twice");
    if (!this.prepared) throw new Error("prepareRecovery must run before router recovery and start");
    this.inbox.interruptActive();
    await this.reconcile();
    if (this.closed) return;
    await this.status.start();
    this.started = true;
    this.schedule();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.status.close();
    if (this.retry) clearTimeout(this.retry);
    this.active?.abort();
    this.inbox.close();
  }

  /** Messages that arrive while a turn runs join it at the agent's next step, instead of waiting for the turn to end. */
  private async steer(): Promise<void> {
    const turn = this.activeTurn;
    const controller = this.active;
    if (this.closed || !turn || !controller || controller.signal.aborted || !this.runner.steer || this.isPaused()) return;
    // Only words meant for the same audience join a running turn; anything else waits so its answer goes to the right place.
    const leading = this.leadingBatch();
    if (!leading.messages.length || leading.audience !== "owner" || this.activeAudience !== "owner") return;
    const { ids, messages } = leading;
    const rendered = renderTurnBatch(messages, this.runner.renderBudgetBytes ?? DEFAULT_TURN_TEXT_BUDGET, []);
    if (!await this.runner.steer({ turn, messages, rendered }, controller.signal)) return;
    if (this.closed || this.inbox.turn(turn).status !== "active") return;
    this.inbox.attach(ids, turn);
    this.steered = { turn, ids: [...(this.steered?.turn === turn ? this.steered.ids : []), ...ids] };
    await this.event("read", { ids, turn }, `read:${turn}:${ids[0]}`, turn);
  }

  /** Who hears a turn's words: the owner (main agent), the agent that wrote, or nobody (wakes, and replies to replies). */
  private audienceOf(message: Message): string {
    // A question or news from another agent comes through the Agent system, which takes the answer; an answer it passes
    // back is the end of that exchange, so the turn that reads it says nothing (no ping-pong).
    if (message.from === "service:agents") return typeof message.body.reply_from === "string" ? "silent" : "service:agents";
    if (message.from === "person:owner") return "owner";
    if (!AGENT_ID.test(message.from)) return this.main ? "owner" : "silent";
    return "silent";
  }

  /** The oldest pending messages that share one audience: a turn answers one audience at a time. */
  private leadingBatch(): { ids: string[]; messages: Message[]; audience: string | null } {
    const ids: string[] = [];
    const messages: Message[] = [];
    let audience: string | null = null;
    for (const id of this.inbox.pendingIds()) {
      const message = this.message(id);
      const next = this.audienceOf(message);
      if (audience !== null && next !== audience) break;
      audience = next;
      ids.push(id);
      messages.push(message);
      if (audience === "service:agents") break; // each delivered question gets a turn of its own, so its answer is its own
    }
    return { ids, messages, audience };
  }

  private steeredMessages(turn: string): Message[] {
    return this.steered?.turn === turn ? this.steered.ids.map((id) => this.message(id)) : [];
  }

  private context(turn?: string): TrustedRouteContext {
    return { transport: "agent", transportPrincipal: this.id, member: this.id, local: true, remote: false, ownerProxy: false,
      ...(turn ? { turn } : {}) };
  }

  private message(id: string): Message {
    const message = this.ledger.byId(id);
    if (!message || message.to !== this.id || message.kind !== "request" || message.word !== "say") throw new Error("inbox references a missing say request");
    return message;
  }

  private async event(word: "received" | "read" | "turn.start" | "turn.end", body: Record<string, unknown>, clientId: string, turn?: string): Promise<void> {
    await this.router.send(this.context(turn), { to: null, kind: "event", word, body, client_id: clientId });
  }

  private async receipts(): Promise<void> {
    while (!this.closed) {
      const task = this.receiptTask ?? (this.receiptTask = (async () => {
        while (!this.closed) {
          const id = this.inbox.unreceivedIds()[0];
          if (!id) break;
          await this.event("received", { ids: [id] }, `received:${id}`);
          if (this.closed) break; // a restart retries the stable event id before marking it
          this.inbox.markReceived(id);
        }
      })());
      try { await task; } finally { if (this.receiptTask === task) this.receiptTask = null; }
      if (this.closed || !this.inbox.unreceivedIds().length) break;
    }
  }

  private async turnEvents(turn: StoredTurn): Promise<void> {
    if (this.closed) return;
    const ids = this.inbox.turnIds(turn.id);
    if (!turn.readLogged) {
      await this.event("read", { ids, turn: turn.id }, `read:${turn.id}`, turn.id);
      if (this.closed) return;
      this.inbox.markTurnEvent(turn.id, "read_logged");
    }
    if (!turn.startLogged) {
      await this.event("turn.start", { turn: turn.id, ids }, `start:${turn.id}`, turn.id);
      if (this.closed) return;
      this.inbox.markTurnEvent(turn.id, "start_logged");
    }
    if (turn.status === "ended" && !turn.endLogged) {
      await this.event("turn.end", { turn: turn.id, reason: turn.reason, ...(turn.error ? { error: turn.error } : {}) }, `end:${turn.id}`, turn.id);
      if (this.closed) return;
      this.inbox.markTurnEvent(turn.id, "end_logged");
    }
  }

  private async reconcile(): Promise<void> {
    if (this.closed) return;
    await this.receipts();
    if (this.closed) return;
    for (const turn of this.inbox.turnsNeedingEvents()) await this.turnEvents(turn);
  }

  private schedule(): void {
    if (!this.started || this.closed || this.draining || !this.enabled) return;
    try { if (this.isPaused()) return; }
    catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); return; }
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  private later(): void {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.schedule(); }, 1_000);
    this.retry.unref();
  }

  private async drain(): Promise<void> {
    let currentTurn: string | null = null;
    try {
      while (!this.closed) {
        await this.reconcile();
        if (this.closed) break;
        if (this.isPaused() || !this.enabled) break;
        const batch = this.leadingBatch();
        if (!batch.ids.length) break;
        const { ids, messages } = batch;
        const audience = batch.audience!;
        const budget = this.runner.renderBudgetBytes ?? DEFAULT_TURN_TEXT_BUDGET;
        const stopFacts = this.inbox.stopFacts();
        const recent = this.managedSnapshot ? this.ledger.list({ after: this.lastManagedSeq, limit: 1000 }) : [];
        const changes = recent.filter((item) => item.from === "service:self" && item.to === null && item.kind === "event" && item.word === "self.changed");
        const changeText = changes.length ? `\n[self.changed facts since the previous turn]\n${changes.map((item) =>
          `${String(item.body.path)}: ${JSON.stringify(String(item.body.summary ?? "changed"))} (by ${String(item.body.by)})`).join("\n")}\n` : "";
        const rendered = renderTurnBatch(messages, budget - Buffer.byteLength(changeText), stopFacts.map((fact) => fact.text)) + changeText; // failure leaves all pending
        const turn = this.inbox.claim(ids);
        if (!turn) break;
        currentTurn = turn.id;
        const managedSnapshot = this.managedSnapshot ? await this.managedSnapshot() : undefined;
        await this.turnEvents(turn);
        if (this.ledger.threadForTurn(turn.id)?.state === "cancelled") {
          const ended = this.inbox.finish(turn.id, "cancelled", "Delegation stopped before execution");
          await this.turnEvents(ended); currentTurn = null; continue;
        }
        let peripheralContext: string | void = undefined;
        if (this.beforeTurn && !this.closed && this.inbox.turn(turn.id).status === "active") {
          try { peripheralContext = await this.beforeTurn(turn.id); } catch { /* unavailable peripheral capture does not prevent a turn */ }
        }
        if (this.closed) break; // close during read/start must not dispatch a fresh runner
        if (this.inbox.turn(turn.id).status !== "active") { currentTurn = null; continue; }
        const controller = new AbortController();
        this.active = controller;
        this.activeTurn = turn.id;
        this.activeAudience = audience;
        let emitOpen = true;
        let result: { reason: "completed" | "error"; error?: string };
        try {
          result = await this.runner.runTurn({ turn: turn.id, messages, rendered, stopFacts: stopFacts.map((fact) => fact.text), managedSnapshot,
            ...(typeof peripheralContext === "string" ? { peripheralContext } : {}) }, async (output) => {
            if (!emitOpen || this.closed || controller.signal.aborted || this.active !== controller) return;
            if (!output.id || output.id.length > 80 || !output.text.trim()) throw new TypeError("invalid agent output");
            if (audience === "silent") return;
            if (audience === "owner") {
              await this.router.send(this.context(turn.id), { to: "person:owner", kind: "request", word: "say",
                body: { text: output.text, kind: "reply" }, client_id: `reply:${turn.id}:${output.id}` }, controller.signal);
              return;
            }
            // A delivered question or news: the words go back to the Agent system, which answers the asker.
            await this.router.send(this.context(turn.id), { to: "service:agents", kind: "request", word: "answer",
              body: { in_reply_to: messages[0]!.id, text: output.text }, client_id: `reply:${turn.id}:${output.id}` }, controller.signal);
          }, controller.signal);
        } catch (error) {
          result = { reason: "error", error: error instanceof Error ? error.message : "runner failed" };
        } finally { emitOpen = false; controller.abort(); this.active = null; this.activeTurn = null; this.activeAudience = null; this.quiescenceBlocked = false; }
        if (this.closed) break; // an interrupted turn is closed and explained on restart
        const ended = this.inbox.finish(turn.id, result.reason, result.error);
        if (ended.reason === "completed") {
          this.inbox.consumeStopFacts(stopFacts.map((fact) => fact.turn));
          this.lastManagedSeq = recent.at(-1)?.seq ?? this.lastManagedSeq;
        }
        currentTurn = null;
        await this.turnEvents(ended);
        this.error = null;
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
      if (currentTurn && !this.closed) this.inbox.finish(currentTurn, "error", "Interrupted before turn completion");
      if (!(this.error instanceof TurnTextBudgetError)) this.later();
    } finally {
      this.draining = false;
      if (!this.closed && !this.error && this.inbox.pendingIds().length) this.schedule();
    }
  }
}

export function createAgentMember(options: AgentMemberOptions): AgentMember { return new AgentMember(options); }
