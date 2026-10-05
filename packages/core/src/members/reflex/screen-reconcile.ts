import type { Message } from "../../../../sdk/src/api";
import type { WorldRouter } from "../../world/router";
import { choiceAnswer, type DecisionModel } from "../../world/decision/jev";
import { decisionContext, type DecisionJob, type DecisionRoute } from "../../world/decision/runtime";
import { captureScreenOrigin, type ScreenExecutionRoute, type ScreenOrigin } from "./screen-execution";

export interface SurfaceSnapshot { home_visible: boolean; page_live: boolean; visibility_epoch: number; virtual_available?: boolean }
export interface ScreenSnapshot {
  foreground_package: string; state_epoch: number;
  virtual_generation: number; virtual_owner_turn: string; virtual_open: boolean;
}
export interface ScreenHost { decisionCall(word: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }
export const screenQuestions = {
  virtual_screen: { type: "choice", instructions: "Choose what to do with the virtual screen belonging to this turn.", criteria: {
    close: "This turn's virtual-screen work is finished and no further owner action or task step needs that screen.",
    keep: "The virtual screen is still needed or its outcome is uncertain.", none: "This turn does not own an open virtual screen.",
  } },
};
const realActions = new Set(["apps.open", "settings.open", "intent.view", "input.key", "screen.tap", "screen.type", "screen.scroll",
  "screen.swipe", "screen.hold", "screen.touch", "screen.gesture", "screen.global_action", "browser.show"]);
const virtualActions = new Set(["vscreen.create", "vscreen.launch", "vscreen.tap", "vscreen.swipe", "vscreen.key", "vscreen.type", "vscreen.close"]);

export class ScreenReconcileRoute implements DecisionRoute {
  readonly id = "screen.reconcile";
  readonly version = 3;
  private readonly armed = new Map<string, ScreenOrigin>();
  private latestTurn: string | null = null;
  constructor(private readonly router: WorldRouter, private readonly model: DecisionModel | undefined,
    private readonly activeTurn: () => string | null, private readonly ready: () => boolean,
    private readonly supersede: () => void, private readonly paused: () => boolean, private readonly host: ScreenHost,
    private readonly execution?: ScreenExecutionRoute) {}
  observe(message: Message): void {
    if (message.from === "agent:main" && message.kind === "event" && message.word === "turn.start") {
      this.latestTurn = String(message.body.turn);
      this.supersede();
      for (const turn of this.armed.keys()) if (turn !== this.latestTurn) this.armed.delete(turn);
    }
  }
  async beforeTurn(turn: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    // Capture is a subordinate read of the durable before_turn hook, not another
    // ledger request. Its non-sensitive result is persisted in that hook's reply.
    const origin = this.execution ? await this.execution.prepare(turn, signal)
      : await captureScreenOrigin(this.router, this.host, this.activeTurn, turn, signal);
    if (!origin || signal.aborted || this.activeTurn() !== turn) return null;
    this.armed.set(turn, origin);
    return { surface: origin.surface, owner_ids: origin.ownerIds };
  }
  private async call(word: string, body: Record<string, unknown>, signal: AbortSignal, turn: string, clientId?: string): Promise<unknown> {
    const sent = await this.router.send({ ...decisionContext, turn }, { to: "service:reflex", kind: "request", word, body,
      ...(clientId ? { client_id: clientId } : {}), wait: false }, signal);
    // Router signals guard acceptance; explicitly cancel this accepted request on route supersession.
    const reply = await new Promise<Message>((resolve) => {
      let stop = () => {};
      const finish = (row: Message) => { stop(); signal.removeEventListener("abort", abort); resolve(row); };
      const abort = () => {
        this.router.cancel([sent.id]);
        const row = this.router.ledger.responseTo(sent.id);
        if (row) finish(row);
      };
      stop = this.router.subscribe((row) => { if (row.kind === "response" && row.reply_to === sent.id) finish(row); });
      signal.addEventListener("abort", abort, { once: true });
      const existing = this.router.ledger.responseTo(sent.id);
      if (existing) finish(existing);
      else if (signal.aborted) abort();
    });
    if (signal.aborted) throw signal.reason ?? new Error("superseded");
    if (!reply.body.ok) throw new Error("screen host unavailable");
    return reply.body.result;
  }
  match(message: Message): DecisionJob | null {
    if (message.from !== "agent:main" || message.kind !== "event" || message.word !== "turn.end") return null;
    const turn = String(message.body.turn), origin = this.armed.get(turn);
    this.armed.delete(turn);
    if (!origin) return null;
    const rows = this.router.ledger.turnMessages(turn);
    const actions = rows.filter((row) => row.from === "agent:main" && row.kind === "request" && row.to === "device:phone" &&
      (realActions.has(row.word) || virtualActions.has(row.word)));
    const successful = actions.filter((row) => this.router.ledger.responseTo(row.id)?.body.ok === true);
    if (!successful.length) return null;
    const realUsed = successful.some((row) => realActions.has(row.word)), virtualUsed = successful.some((row) => virtualActions.has(row.word));
    // The capsule delivers replies and owner interactions in place. Never take real-screen focus.
    // JEV remains only for the separate virtual-screen resource lifecycle.
    if (!virtualUsed) return null;
    const pending = this.router.ledger.trackedRequests().some((row) => row.message.turn === turn);
    const facts = this.router.ledger.turnFacts(turn, "agent:main", message.seq + 1);
    const state = { owner_request: facts.ownerSaid.map((text) => text.slice(0, 4000)),
      final_replies: rows.filter((row) => row.from === "agent:main" && row.to === "person:owner" && row.word === "say")
        .map((row) => String(row.body.text ?? "").slice(0, 4000)), turn_reason: message.body.reason, origin: origin.surface,
        execution_plan: origin.plan ?? null,
        real_used: realUsed, virtual_used: virtualUsed, actions: successful.map((row) => ({ word: row.word, body: row.body })),
      uncertain_actions: actions.filter((row) => !this.router.ledger.responseTo(row.id)?.body.ok).map((row) => row.word), pending };
    let snapshot: ScreenSnapshot | undefined;
    return { trigger: message, turn, group: "phone-screen", state, evidence: [origin.start.id, ...origin.ownerIds,
      ...rows.filter((row) => row.kind === "request" && row.to === "service:reflex" && row.word === "before_turn").map((row) => row.id),
      ...successful.map((row) => row.id), message.id],
      judge: async (signal) => {
        if (!this.model || !(this.model.available?.() ?? true)) throw new Error("JEV unavailable");
        if (pending || !this.ready() || this.paused() || this.latestTurn !== turn || message.body.reason !== "completed")
          return { stage: "guard", outcome: { real_screen: "leave_unchanged", virtual_screen: "keep" } };
        snapshot = await this.call("screen.get", {}, signal, turn) as ScreenSnapshot;
        const raw = await this.model.evaluate({ ...state, screen: snapshot }, { virtual_screen: screenQuestions.virtual_screen }, signal);
        const virtual = choiceAnswer(raw, "virtual_screen", ["close", "keep", "none"]);
        return { stage: "jev", confidence: virtual.confidence,
          outcome: { real_screen: "leave_unchanged", virtual_screen: virtual.choice } };
      },
      current: () => this.ready() && !this.paused() && this.latestTurn === turn,
      apply: async (verdict, id, signal) => {
        if (!snapshot) return { acted: false };
        const current = await this.call("screen.get", {}, signal, turn) as ScreenSnapshot;
        if (current.state_epoch !== snapshot.state_epoch || current.foreground_package !== snapshot.foreground_package ||
          current.virtual_generation !== snapshot.virtual_generation || !this.ready() || this.paused() || this.latestTurn !== turn)
          return { acted: false, skipped: "stale" };
        const effects: string[] = [];
        if (verdict.outcome.virtual_screen === "close" && virtualUsed && current.virtual_open && current.virtual_owner_turn === turn &&
          this.latestTurn === turn && this.ready() && !this.paused() && !signal.aborted) {
          const result = await this.call("virtual.close", { expected_generation: snapshot.virtual_generation, owner_turn: turn,
            decision_id: id }, signal, turn, `decision:${id}:close`) as { acted: boolean };
          if (result.acted) effects.push("close_virtual_screen");
        }
        return { acted: effects.length > 0, effects };
      } };
  }
  close(): void { this.armed.clear(); }
}
