import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import { Ledger } from "../world/ledger";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";
import { AgentInbox, type StoredTurn } from "../world/agent-inbox";
import { DEFAULT_TURN_TEXT_BUDGET, TurnTextBudgetError, renderTurnBatch } from "./agent-render";

/** Full messages are control data. A model adapter must inject only `rendered`, never stringify `messages`. */
export interface AgentTurnInput {
  turn: string;
  messages: readonly Message[];
  rendered: string;
}
export interface AgentTurnOutput { id: string; text: string }
export interface AgentTurnRunner {
  /** Optional lower text cap; not a claim about the provider's total context window. */
  renderBudgetBytes?: number;
  runTurn(input: AgentTurnInput, emit: (output: AgentTurnOutput) => Promise<void>, signal: AbortSignal): Promise<{ reason: "completed" | "error"; error?: string }>;
}

export interface AgentMemberOptions {
  ledger: Ledger;
  router: WorldRouter;
  stateDir: string;
  runner: AgentTurnRunner;
  name?: string;
}

const say = wordContract("agent:main", "say") as WordSpec | undefined;
if (!say || say.kind !== "request") throw new Error("agent say contract unavailable");

/** Durable one-at-a-time intake. Cancellation and secondary-session words are added by later work. */
export class AgentMember implements Member {
  readonly id = "agent:main";
  readonly kind = "agent" as const;
  readonly online = true;
  readonly idempotentRecovery = ["say"] as const;
  readonly name: string;
  readonly inbox: AgentInbox;
  private readonly ledger: Ledger;
  private readonly router: WorldRouter;
  private readonly runner: AgentTurnRunner;
  private started = false;
  private closed = false;
  private draining = false;
  private active: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private receiptTask: Promise<void> | null = null;
  private error: Error | null = null;

  constructor(options: AgentMemberOptions) {
    this.name = options.name ?? "Assistant";
    this.ledger = options.ledger;
    this.router = options.router;
    this.runner = options.runner;
    this.inbox = new AgentInbox(options.stateDir);
  }

  words(): readonly WordSpec[] { return [say!]; }
  get lastError(): Error | null { return this.error; }
  counts(): { pending: number; read: number; active: number } { return this.inbox.counts(); }

  handle(message: Message, _context: RouteHandlerContext): ResponseBody {
    if (this.closed) return { ok: false, error: { code: "offline", message: "agent inbox is closed" } };
    this.inbox.accept(message); // sync durable commit before acknowledging the route
    if (this.started) void this.receipts().catch((error) => { this.error = error instanceof Error ? error : new Error(String(error)); this.later(); });
    this.schedule();
    return { ok: true, result: { accepted: true } };
  }

  /** Register with WorldMembers first; call after router recovery and all real endpoints exist. */
  async start(): Promise<void> {
    if (this.closed || this.started) throw new Error("agent member cannot start twice");
    this.inbox.interruptActive();
    await this.reconcile();
    if (this.closed) return;
    this.started = true;
    this.schedule();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
        const rendered = renderTurnBatch(messages, budget); // failure leaves all pending
        const turn = this.inbox.claim(ids);
        if (!turn) break;
        currentTurn = turn.id;
        await this.turnEvents(turn);
        const controller = new AbortController();
        this.active = controller;
        let result: { reason: "completed" | "error"; error?: string };
        try {
          result = await this.runner.runTurn({ turn: turn.id, messages, rendered }, async (output) => {
            if (this.closed || controller.signal.aborted) return;
            if (!output.id || output.id.length > 80 || !output.text.trim()) throw new TypeError("invalid agent output");
            await this.router.send(this.context(turn.id), { to: "person:owner", kind: "request", word: "say",
              body: { text: output.text, kind: "reply" }, client_id: `reply:${turn.id}:${output.id}` });
          }, controller.signal);
        } catch (error) {
          result = { reason: "error", error: error instanceof Error ? error.message : "runner failed" };
        } finally { this.active = null; }
        if (this.closed) break; // an interrupted turn is closed and explained on restart
        const ended = this.inbox.finish(turn.id, result.reason, result.error);
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
