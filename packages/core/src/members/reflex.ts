import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { Member } from "../world/member";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";
import { judgeStopKeyword } from "./reflex-keywords";
import type { JevReflexClient, JevReflexState } from "./reflex-jev";

const context: TrustedRouteContext = { member: "service:reflex", transport: "service", transportPrincipal: "service:reflex",
  local: true, remote: false, ownerProxy: false };

/** Watches newly accepted owner say requests; it never handles an inbound word. */
export class ReflexMember implements Member {
  readonly id = "service:reflex";
  readonly kind = "service" as const;
  readonly name = "Reflex";
  readonly online = true;
  private closed = false;
  private readonly stop: () => void;
  private readonly tasks = new Set<Promise<void>>();
  private failure: Error | null = null;

  constructor(private readonly router: WorldRouter, private readonly busyTurn: () => string | null,
    private readonly options: { jev?: Pick<JevReflexClient, "judge">; context?: (message: Message, turn: string) => JevReflexState;
      threshold?: number } = {}) {
    this.stop = router.subscribe((message) => this.observe(message));
  }
  words(): readonly WordSpec[] { return []; }
  handle(_message: Message, _context: RouteHandlerContext): ResponseBody {
    return { ok: false, error: { code: "not_found", message: "reflex has no inbound word" } };
  }
  get lastError(): Error | null { return this.failure; }

  private observe(message: Message): void {
    if (this.closed || message.kind !== "request" || message.from !== "person:owner" || message.to !== "agent:main" || message.word !== "say") return;
    // Capture the durable turn at message acceptance, not a later status label.
    const turn = this.busyTurn();
    const judgement = judgeStopKeyword(typeof message.body.text === "string" ? message.body.text : "");
    if (!turn && judgement.intent !== "pause") return;
    const task = this.judge(message, turn, judgement).catch((error) => { this.failure = error instanceof Error ? error : new Error(String(error)); });
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async judge(message: Message, turn: string | null, judgement: ReturnType<typeof judgeStopKeyword>): Promise<void> {
    let stage: "keyword" | "jev" = "keyword";
    let fallback: { fallback: "timeout" | "unavailable" | "invalid" | "error"; fallback_ms: number } | undefined;
    // While a turn runs, every message that is not already an explicit command goes to JEV: "够了", "闭嘴" or
    // "hold on" carry no stop keyword, yet they are the owner trying to stop the reply.
    if (turn && (judgement.intent === "unclear" || judgement.intent === "unrelated") && this.options.jev && this.options.context) {
      const asked = Date.now();
      try {
        const result = await this.options.jev.judge(this.options.context(message, turn));
        stage = "jev";
        judgement = { intent: result.intent === "stop" && result.confidence >= (this.options.threshold ?? 0.6) ? "stop" : "unrelated",
          confidence: result.confidence };
      } catch (error) {
        // The no-Key keyword rule remains the fallback on timeout or failure; the record says which, without any secret.
        const text = error instanceof Error ? `${error.name} ${error.message}` : "";
        fallback = { fallback: /abort|timeout/iu.test(text) ? "timeout" : /JEV answer/u.test(text) ? "invalid" : /JEV unavailable|fetch failed/u.test(text) ? "unavailable" : "error",
          fallback_ms: Math.max(0, Date.now() - asked) };
      }
    }
    let acted = false;
    if (judgement.intent === "pause" && !this.closed) {
      try {
        const sent = await this.router.send(context, { to: "service:admin", kind: "request", word: "pause",
          body: { by: message.id }, client_id: `reflex:pause:${message.id}`, wait: true });
        acted = sent.reply?.body.ok === true &&
          (sent.reply.body.result as { paused?: unknown } | undefined)?.paused === true;
      } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
    } else if (judgement.intent === "stop" && turn && !this.closed && this.busyTurn() === turn) {
      try {
        const sent = await this.router.send({ ...context, turn }, { to: "agent:main", kind: "request", word: "cancel_turn",
          body: { reason: "Owner asked to stop", by: message.id }, client_id: `reflex:cancel:${message.id}`, wait: true });
        const result = sent.reply?.body.result;
        acted = sent.reply?.body.ok === true && Boolean(result && typeof result === "object" && "cancelled" in result && result.cancelled === true);
      } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
    }
    if (this.closed) return;
    await this.router.send(context, { to: null, kind: "event", word: "reflex.judged",
      body: { message_id: message.id, stage, intent: judgement.intent, confidence: judgement.confidence, acted, ...fallback },
      client_id: `reflex:judged:${message.id}` });
  }

  /** Waits only for the local decision tasks; a cancelled DSH session may quiesce later. */
  async settled(): Promise<void> { await Promise.all([...this.tasks]); if (this.failure) throw this.failure; }
  async close(): Promise<void> { this.stop(); await Promise.all([...this.tasks]); this.closed = true; }
}
