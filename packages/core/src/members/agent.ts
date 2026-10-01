import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import { Ledger } from "../world/ledger";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";
import { AgentInbox, type StoredTurn } from "../world/agent-inbox";
import { DEFAULT_TURN_TEXT_BUDGET, TurnTextBudgetError, renderTurnBatch } from "./agent-render";
import { AgentStatus } from "./agent-status";

/** Full messages are control data. A model adapter must inject only `rendered`, never stringify `messages`. */
export interface AgentTurnInput {
  turn: string;
  messages: readonly Message[];
  rendered: string;
  stopFacts: readonly string[];
}
export interface AgentTurnOutput { id: string; text: string }
export interface AgentTurnRunner {
  /** Optional lower text cap; not a claim about the provider's total context window. */
  renderBudgetBytes?: number;
  /** Settlement must prove the underlying session is idle, including after abort. A turn/end event alone is insufficient. */
  runTurn(input: AgentTurnInput, emit: (output: AgentTurnOutput) => Promise<void>, signal: AbortSignal): Promise<{ reason: "completed" | "error"; error?: string }>;
}

export interface AgentMemberOptions {
  ledger: Ledger;
  router: WorldRouter;
  stateDir: string;
  runner: AgentTurnRunner;
  name?: string;
  isPaused?: () => boolean;
}

const say = wordContract("agent:main", "say") as WordSpec | undefined;
const cancelTurn = wordContract("agent:main", "cancel_turn") as WordSpec | undefined;
const typing = wordContract("agent:main", "typing") as WordSpec | undefined;
if (!say || say.kind !== "request" || !cancelTurn || cancelTurn.kind !== "request" || !typing || typing.kind !== "event") throw new Error("agent contract unavailable");

/** Durable one-at-a-time intake. The secondary session is added by later work. */
export class AgentMember implements Member {
  readonly id = "agent:main";
  readonly kind = "agent" as const;
  readonly online = true;
  readonly idempotentRecovery = ["say", "cancel_turn"] as const;
  readonly name: string;
  readonly inbox: AgentInbox;
  readonly status: AgentStatus;
  private readonly ledger: Ledger;
  private readonly router: WorldRouter;
  private readonly runner: AgentTurnRunner;
  private started = false;
  private closed = false;
  private draining = false;
  private active: AbortController | null = null;
  private activeTurn: string | null = null;
  private prepared = false;
  private quiescenceBlocked = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private receiptTask: Promise<void> | null = null;
  private error: Error | null = null;

  constructor(options: AgentMemberOptions) {
    this.name = options.name ?? "Assistant";
    this.ledger = options.ledger;
    this.router = options.router;
    this.runner = options.runner;
    this.inbox = new AgentInbox(options.stateDir);
    this.status = new AgentStatus(this.router, Date.now, options.isPaused);
  }

  words(): readonly WordSpec[] { return [say!, cancelTurn!, typing!]; }
  get lastError(): Error | null { return this.error ?? this.status.lastError; }
  get waitingForQuiescence(): boolean { return this.quiescenceBlocked; }
  counts(): { pending: number; read: number; active: number } { return this.inbox.counts(); }

  handle(message: Message, _context: RouteHandlerContext): ResponseBody {
    if (this.closed) return { ok: false, error: { code: "offline", message: "agent inbox is closed" } };
    if (message.word === "typing" && message.kind === "event") return { ok: true };
    if (message.word === "cancel_turn") return this.handleCancel(message);
    if (message.word !== "say") return { ok: false, error: { code: "not_found", message: "agent word not available" } };
    this.inbox.accept(message); // sync durable commit before acknowledging the route
    if (this.started) void this.receipts().catch((error) => { this.error = error instanceof Error ? error : new Error(String(error)); this.later(); });
    this.schedule();
    return { ok: true, result: { accepted: true } };
  }

  private handleCancel(message: Message): ResponseBody {
    if (message.to !== this.id || message.kind !== "request" || !["service:reflex", "service:admin"].includes(message.from)) {
      return { ok: false, error: { code: "forbidden", message: "internal cancellation only" } };
    }
    const reason = String(message.body.reason ?? "Stop requested");
    const by = typeof message.body.by === "string" ? message.body.by : undefined;
    const active = this.inbox.activeTurn();
    // Reflex captures the turn when the owner spoke. A late decision must never
    // cancel a newer turn that happened to start before this request dispatched.
    if (message.from === "service:reflex" && message.turn && active?.id !== message.turn)
      return { ok: true, result: { cancelled: false } };
    const inFlight = active ? this.ledger.trackedRequests().filter((item) => item.message.from === this.id && item.message.turn === active.id) : [];
    const action = inFlight.at(-1)?.message;
    const safeReason = [...reason].slice(0, 160).join("");
    const fact = `The previous turn was stopped${action ? ` while ${action.to}/${action.word} was pending` : "; the exact last action is unknown"}. Reason: ${safeReason}. Any external effect may be unknown.`;
    const receipt = this.inbox.recordCancel(message.id, reason, by, fact); // durable before cross-database settlement or abort
    if (!receipt.cancelled || !receipt.turn) return { ok: true, result: { cancelled: false } };
    this.router.cancelTurn(this.id, receipt.turn); // wake pending tool promises before aborting the runtime
    const ended = this.inbox.finish(receipt.turn, "cancelled", "External effect may be unknown; waiting for runner to become idle");
    if (this.activeTurn === receipt.turn && this.active) { this.quiescenceBlocked = true; this.active.abort(); }
    void this.turnEvents(ended).catch((error) => { this.error = error instanceof Error ? error : new Error(String(error)); this.later(); });
    return { ok: true, result: { cancelled: true } };
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
    if (!this.started || this.closed || this.draining) return;
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
        const ids = this.inbox.pendingIds();
        if (!ids.length) break;
        const messages = ids.map((id) => this.message(id));
        const budget = this.runner.renderBudgetBytes ?? DEFAULT_TURN_TEXT_BUDGET;
        const stopFacts = this.inbox.stopFacts();
        const rendered = renderTurnBatch(messages, budget, stopFacts.map((fact) => fact.text)); // failure leaves all pending
        const turn = this.inbox.claim(ids);
        if (!turn) break;
        currentTurn = turn.id;
        await this.turnEvents(turn);
        if (this.closed) break; // close during read/start must not dispatch a fresh runner
        if (this.inbox.turn(turn.id).status !== "active") { currentTurn = null; continue; }
        const controller = new AbortController();
        this.active = controller;
        this.activeTurn = turn.id;
        let emitOpen = true;
        let result: { reason: "completed" | "error"; error?: string };
        try {
          result = await this.runner.runTurn({ turn: turn.id, messages, rendered, stopFacts: stopFacts.map((fact) => fact.text) }, async (output) => {
            if (!emitOpen || this.closed || controller.signal.aborted || this.active !== controller) return;
            if (!output.id || output.id.length > 80 || !output.text.trim()) throw new TypeError("invalid agent output");
            await this.router.send(this.context(turn.id), { to: "person:owner", kind: "request", word: "say",
              body: { text: output.text, kind: "reply" }, client_id: `reply:${turn.id}:${output.id}` }, controller.signal);
          }, controller.signal);
        } catch (error) {
          result = { reason: "error", error: error instanceof Error ? error.message : "runner failed" };
        } finally { emitOpen = false; controller.abort(); this.active = null; this.activeTurn = null; this.quiescenceBlocked = false; }
        if (this.closed) break; // an interrupted turn is closed and explained on restart
        const ended = this.inbox.finish(turn.id, result.reason, result.error);
        if (ended.reason === "completed") this.inbox.consumeStopFacts(stopFacts.map((fact) => fact.turn));
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
