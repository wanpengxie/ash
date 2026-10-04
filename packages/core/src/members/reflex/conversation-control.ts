import type { Message } from "../../../../sdk/src/api";
import { judgeStopKeyword } from "../reflex-keywords";
import type { JevReflexClient, JevReflexState } from "../reflex-jev";
import type { WorldRouter } from "../../world/router";
import { decisionContext, type DecisionJob, type DecisionRoute } from "../../world/decision/runtime";

export interface ConversationControlOptions {
  jev?: Pick<JevReflexClient, "judge"> & { available?(): boolean };
  context?: (message: Message, turn: string) => JevReflexState;
  threshold?: number;
}

export class ConversationControlRoute implements DecisionRoute {
  readonly id = "conversation.control";
  readonly version = 1;
  constructor(private readonly router: WorldRouter, private readonly busyTurn: () => string | null,
    private readonly options: ConversationControlOptions = {}) {}
  match(message: Message): DecisionJob | null {
    if (message.kind !== "request" || message.from !== "person:owner" || message.to !== "agent:main" || message.word !== "say") return null;
    const turn = this.busyTurn();
    const keyword = judgeStopKeyword(typeof message.body.text === "string" ? message.body.text : "");
    if (!turn && keyword.intent !== "pause") return null;
    const state = turn && this.options.context ? this.options.context(message, turn) : { latest_user_message: message.body.text };
    return { trigger: message, ...(turn ? { turn } : {}), state, evidence: [message.id],
      judge: async (signal) => {
        let judgement = keyword, stage = "keyword";
        let fallback: { fallback: string; fallback_ms: number } | undefined;
        if (turn && (judgement.intent === "unclear" || judgement.intent === "unrelated") && this.options.jev &&
          (this.options.jev.available?.() ?? true) && this.options.context) {
          const asked = Date.now();
          try {
            const result = await this.options.jev.judge(state as JevReflexState, signal);
            if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
              !["stop", "unrelated"].includes(result.intent)) throw new Error("JEV answer unavailable");
            stage = "jev";
            judgement = { intent: result.intent === "stop" && result.confidence >= (this.options.threshold ?? 0.6) ? "stop" : "unrelated",
              confidence: result.confidence };
          } catch (error) {
            if (signal.aborted) throw error;
            const text = error instanceof Error ? `${error.name} ${error.message}` : "";
            fallback = { fallback: /abort|timeout/iu.test(text) ? "timeout" : /JEV answer/u.test(text) ? "invalid" :
              /JEV unavailable|fetch failed/u.test(text) ? "unavailable" : "error", fallback_ms: Math.max(0, Date.now() - asked) };
          }
        }
        return { stage, confidence: judgement.confidence, ...(fallback ? { fallback: fallback.fallback } : {}),
          outcome: { intent: judgement.intent, ...(fallback ? { fallback_ms: fallback.fallback_ms } : {}) } };
      },
      current: () => keyword.intent === "pause" || !turn || this.busyTurn() === turn,
      apply: async (verdict) => {
        const intent = verdict.outcome.intent;
        if (intent === "pause") {
          const sent = await this.router.send(decisionContext, { to: "service:admin", kind: "request", word: "pause",
            body: { by: message.id }, client_id: `reflex:pause:${message.id}`, wait: true });
          return { acted: sent.reply?.body.ok === true && (sent.reply.body.result as { paused?: unknown })?.paused === true };
        }
        if (intent === "stop" && turn && this.busyTurn() === turn) {
          const sent = await this.router.send({ ...decisionContext, turn }, { to: "agent:main", kind: "request", word: "cancel_turn",
            body: { reason: "Owner asked to stop", by: message.id }, client_id: `reflex:cancel:${message.id}`, wait: true });
          return { acted: sent.reply?.body.ok === true && (sent.reply.body.result as { cancelled?: unknown })?.cancelled === true };
        }
        return { acted: false };
      },
      finished: async (verdict, result) => {
        await this.router.send(decisionContext, { to: null, kind: "event", word: "reflex.judged",
          body: { message_id: message.id, stage: verdict.stage, intent: verdict.outcome.intent, confidence: verdict.confidence,
            acted: result.acted, ...(verdict.fallback ? { fallback: verdict.fallback, fallback_ms: verdict.outcome.fallback_ms } : {}) },
          client_id: `reflex:judged:${message.id}` });
      },
    };
  }
}
