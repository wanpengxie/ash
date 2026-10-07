import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import { WorldRouter, type RouteHandlerContext } from "../world/router";
import { DecisionRuntime, type DecisionRoute } from "../world/decision/runtime";
import { ConversationControlRoute, type ConversationControlOptions } from "./reflex/conversation-control";
import { ScreenReconcileRoute, type ScreenHost } from "./reflex/screen-reconcile";
import type { DecisionModel } from "../world/decision/jev";
import { ScreenExecutionRoute, screenExecutionContext } from "./reflex/screen-execution";
import { TaskOutcomeRoute } from "./reflex/task-outcome";
import { decisionContext } from "../world/decision/runtime";

/** Stable world identity for Ash's extensible peripheral decision runtime. */
export class ReflexMember implements Member {
  readonly id = "service:reflex";
  readonly kind = "service" as const;
  readonly name = "Decisions";
  readonly online = true;
  readonly runtime: DecisionRuntime;
  private readonly execution?: ScreenExecutionRoute;
  private readonly stop: () => void;
  constructor(private readonly router: WorldRouter, private readonly busyTurn: () => string | null,
    private readonly options: ConversationControlOptions & { model?: DecisionModel; screenHost?: ScreenHost;
      conversationEnabled?: boolean; screenEnabled?: boolean; screenExecutionEnabled?: boolean; taskOutcomeEnabled?: boolean;
      ready?: () => boolean; paused?: () => boolean; routes?: DecisionRoute[] } = {}) {
    this.runtime = new DecisionRuntime(router);
    if (options.conversationEnabled !== false) this.runtime.register(new ConversationControlRoute(router, busyTurn, options));
    if (options.screenHost && options.screenExecutionEnabled !== false) {
      this.execution = new ScreenExecutionRoute(router, options.screenHost, busyTurn, options.model);
      this.runtime.register(this.execution);
    }
    if (options.screenHost && options.screenEnabled !== false) this.runtime.register(new ScreenReconcileRoute(router, options.model, busyTurn,
      options.ready ?? (() => busyTurn() === null), () => this.runtime.supersede("phone-screen"), options.paused ?? (() => false), options.screenHost, this.execution));
    if (options.model && options.taskOutcomeEnabled !== false) this.runtime.register(new TaskOutcomeRoute(router, options.model));
    for (const route of options.routes ?? []) this.runtime.register(route);
    this.stop = router.subscribe((message) => this.runtime.observe(message));
  }
  words(): readonly WordSpec[] {
    return ["task.stop", "task.end", "before_turn", "surface.get", "screen.get", "screen.return", "virtual.close"].map((word) => wordContract(this.id, word)!);
  }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (message.word === "task.end") {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "owner only" } };
      const turn = String(message.body.turn);
      const rows = this.router.ledger.turnMessages(turn);
      const actor = rows.find(r => r.from.startsWith("agent:") && r.word === "turn.start")?.from;
      if (!actor) return { ok: true, result: { ended: false } };
      const active = actor === "agent:main" ? this.busyTurn() : !rows.some(r => r.from === actor && r.word === "turn.end") ? turn : null;
      if (active && active !== turn) return { ok: true, result: { ended: false } };
      const ids = message.body.pending_ids as string[];
      const ownedTask = (agent: string, pendingTurn: string | null | undefined) => agent === actor || !!pendingTurn &&
        this.router.ledger.threadAncestors(pendingTurn).some(work => work.parent_turn === turn);
      const legacyAskOwned = (id: string) => {
        const ask = this.router.ledger.byId(id);
        if (!ask || ask.turn !== turn || ask.to !== "person:owner" || ask.word !== "ask" || ask.kind !== "request") return false;
        if (ask.from === actor) return true;
        const gate = this.router.ledger.gateCaseByAsk(id);
        return ask.from === "service:gate" && !!gate && this.router.ledger.byId(gate.requestId)?.from === actor;
      };
      if (ids.some((id) => {
        const p = this.router.ledger.humanPending(id);
        return p ? !ownedTask(p.agent, p.turn) || !this.router.ledger.humanOwnedBy(p.agent, p.pending_id) : !legacyAskOwned(id);
      }))
        return { ok: false, error: { code: "forbidden", message: "pending request is not owned by this agent" } };
      const withdraw = () => {
        // Include requests created in this exact turn since the last displayed frame.
        // Other turns are touched only when the owner explicitly saw and selected their cards.
        const selected = new Set(ids);
        for (const p of this.router.ledger.activeHumanPending()) {
          if (!ownedTask(p.agent, p.turn) || !(p.turn === turn || selected.has(p.pending_id) || p.agent !== actor)) continue;
          if (p.state === "waiting") this.router.withdrawHuman(p.agent, p.pending_id, "主人结束了本次交互");
          else if (p.state === "answered" && p.type === "approval") this.router.withdrawHuman(p.agent, p.pending_id, "主人结束了本次交互，未执行", true);
        }
        // Internal DSH confirmations and old synchronous approvals have no human_pending row.
        this.router.cancel(this.router.ledger.trackedRequests().map((p) => p.message.id).filter(legacyAskOwned));
      };
      withdraw();
      if (!active) return { ok: true, result: { ended: true } };
      const sent = await this.router.send({ ...decisionContext, turn }, { to: actor, kind: "request", word: "cancel_turn",
        body: { reason: "Owner ended the capsule interaction", by: message.id }, client_id: `task-end:${message.id}`, wait: true });
      const ended = sent.reply?.body.ok === true && ((sent.reply.body.result as { cancelled?: unknown })?.cancelled === true || this.busyTurn() === null);
      if (ended) withdraw();
      return { ok: true, result: { ended } };
    }
    if (message.word === "task.stop") {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "owner only" } };
      const rows = this.router.ledger.turnMessages(String(message.body.turn));
      const actor = rows.find(r => r.from.startsWith("agent:") && r.word === "turn.start")?.from;
      if (!actor || rows.some(r => r.from === actor && r.word === "turn.end") || actor === "agent:main" && this.busyTurn() !== message.body.turn) return { ok: true, result: { cancelled: false } };
      const sent = await this.router.send({ ...decisionContext, turn: String(message.body.turn) }, {
        to: actor, kind: "request", word: "cancel_turn", body: { reason: "Owner stopped the task from its status display", by: message.id },
        client_id: `task-stop:${message.id}`, wait: true });
      return { ok: true, result: { cancelled: sent.reply?.body.ok === true && (sent.reply.body.result as { cancelled?: unknown })?.cancelled === true } };
    }
    if (message.word === "before_turn") {
      if (message.turn !== message.body.turn || this.busyTurn() !== message.body.turn) return { ok: true, result: { captured: false } };
      try { return { ok: true, result: await this.runtime.beforeTurn(String(message.body.turn), context.signal) }; }
      catch { return { ok: true, result: { captured: false } }; }
    }
    if (!this.options.screenHost) return { ok: false, error: { code: "offline", message: "screen host unavailable" } };
    try { return { ok: true, result: await this.options.screenHost.decisionCall(message.word, { ...message.body, turn: message.turn }, context.signal) }; }
    catch { return { ok: false, error: { code: "offline", message: "screen host unavailable" } }; }
  }
  get lastError(): Error | null { return this.runtime.lastError; }
  executionContext(turn: string): string | undefined {
    const plan = this.execution?.plan(turn);
    return plan ? screenExecutionContext(plan) : undefined;
  }
  executionViolation(message: Message): string | null { return this.execution?.violation(message) ?? null; }
  settled(): Promise<void> { return this.runtime.settled(); }
  async close(): Promise<void> {
    this.stop();
    // Stop accepted lifecycle hooks too, not just observed post-turn jobs. Their
    // timers and late handler replies must not outlive the service/ledger.
    this.router.cancel(this.router.ledger.trackedRequests().filter((row) => row.message.to === this.id).map((row) => row.message.id));
    await this.runtime.close();
  }
}
