import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import { WorldRouter, type RouteHandlerContext } from "../world/router";
import { DecisionRuntime, type DecisionRoute } from "../world/decision/runtime";
import { ConversationControlRoute, type ConversationControlOptions } from "./reflex/conversation-control";
import { ScreenReconcileRoute, type ScreenHost } from "./reflex/screen-reconcile";
import type { DecisionModel } from "../world/decision/jev";

/** Stable world identity for Ash's extensible peripheral decision runtime. */
export class ReflexMember implements Member {
  readonly id = "service:reflex";
  readonly kind = "service" as const;
  readonly name = "Decisions";
  readonly online = true;
  readonly runtime: DecisionRuntime;
  private readonly stop: () => void;
  constructor(private readonly router: WorldRouter, private readonly busyTurn: () => string | null,
    private readonly options: ConversationControlOptions & { model?: DecisionModel; screenHost?: ScreenHost;
      conversationEnabled?: boolean; screenEnabled?: boolean;
      ready?: () => boolean; paused?: () => boolean; routes?: DecisionRoute[] } = {}) {
    this.runtime = new DecisionRuntime(router);
    if (options.conversationEnabled !== false) this.runtime.register(new ConversationControlRoute(router, busyTurn, options));
    if (options.screenHost && options.screenEnabled !== false) this.runtime.register(new ScreenReconcileRoute(router, options.model, busyTurn,
      options.ready ?? (() => busyTurn() === null), () => this.runtime.supersede("phone-screen"), options.paused ?? (() => false), options.screenHost));
    for (const route of options.routes ?? []) this.runtime.register(route);
    this.stop = router.subscribe((message) => this.runtime.observe(message));
  }
  words(): readonly WordSpec[] {
    return ["before_turn", "surface.get", "screen.get", "screen.return", "virtual.close"].map((word) => wordContract(this.id, word)!);
  }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
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
  settled(): Promise<void> { return this.runtime.settled(); }
  async close(): Promise<void> { this.stop(); await this.runtime.close(); }
}
