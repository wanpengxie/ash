import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { Member } from "../world/member";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";
import { judgeStopKeyword } from "./reflex-keywords";

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

  constructor(private readonly router: WorldRouter, private readonly busyTurn: () => string | null) {
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
      body: { message_id: message.id, stage: "keyword", intent: judgement.intent, confidence: judgement.confidence, acted },
      client_id: `reflex:judged:${message.id}` });
  }

  /** Waits only for the local decision tasks; a cancelled DSH session may quiesce later. */
  async settled(): Promise<void> { await Promise.all([...this.tasks]); if (this.failure) throw this.failure; }
  async close(): Promise<void> { this.stop(); await Promise.all([...this.tasks]); this.closed = true; }
}
