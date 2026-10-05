import { randomUUID } from "node:crypto";
import type { Message } from "../../sdk/src/api";
import type { WorldRouter } from "./world/router";

export interface TaskStatusFrame {
  session: string; revision: number; turn: string | null; started_at: number;
  state: string; text: string; steps: string[]; can_stop: boolean;
}
const states = new Set(["idle", "listening", "thinking", "working", "done", "waiting_you", "resting"]);
/** Native display projection only. No model call, arguments, owner text or recovered execution. */
export class TaskStatusBridge {
  private session = randomUUID();
  private revision = 0;
  private turn: string | null = null;
  private started = 0;
  private state = "idle";
  private text = "在线";
  private steps: string[] = [];
  private asks = new Set<string>();
  private ended = false;
  private closed = false;
  private queued = false;
  private sending: Promise<void> | null = null;
  private stop: () => void;
  private timer: ReturnType<typeof setInterval>;
  constructor(router: Pick<WorldRouter, "subscribe">, private readonly deliver: (frame: TaskStatusFrame) => Promise<void>) {
    this.stop = router.subscribe((m) => this.observe(m));
    this.timer = setInterval(() => { if (this.turn && (!this.ended || this.asks.size)) this.enqueue(); }, 5_000);
    this.timer.unref();
    this.enqueue();
  }
  private observe(m: Message): void {
    if (this.closed) return;
    if (m.from === "agent:main" && m.kind === "event") {
      if (m.word === "turn.start" && typeof m.body.turn === "string") {
        this.turn = m.body.turn; this.started = m.ts; this.ended = false; this.steps = []; this.asks.clear();
        this.state = "thinking"; this.text = "在想";
      } else if (m.word === "turn.end" && m.body.turn === this.turn) {
        this.ended = true; if (m.body.reason !== "completed") this.asks.clear(); this.state = "done";
        this.text = m.body.reason === "completed" ? "已完成" : m.body.reason === "cancelled" ? "已停止" : "任务已结束";
      } else if (m.word === "status" && states.has(String(m.body.state))) {
        if (this.ended && m.body.state !== "idle" && m.body.state !== "resting" && m.body.state !== "waiting_you") return;
        this.state = String(m.body.state);
        // Existing detail may include a query. Never transport that onto other apps.
        this.text = String(m.body.text ?? "").split(" · ")[0].replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 80);
        if (this.state === "idle" || this.state === "resting") { this.turn = null; this.started = 0; this.ended = false; this.steps = []; }
        if (this.text && this.turn && this.steps.at(-1) !== this.text) this.steps = [...this.steps, this.text].slice(-5);
      } else return;
    } else if (this.turn && !this.ended && m.kind === "request" && m.to === "person:owner" && m.word === "ask") {
      // Gate holds the outer tool request while asking. That is waiting, not ongoing work.
      if (m.turn !== this.turn) return;
      this.asks.add(m.id);
    } else if (m.kind === "response" && m.reply_to && this.asks.delete(m.reply_to)) {
      if (this.ended && !this.asks.size) { this.state = "done"; this.text = "已结束，等待后续消息"; }
    } else return;
    this.enqueue();
  }
  private frame(): TaskStatusFrame {
    return { session: this.session, revision: ++this.revision, turn: this.turn, started_at: this.started,
      state: this.asks.size ? "waiting_you" : this.state, text: this.asks.size ? "等待你确认" : this.text,
      steps: [...this.steps], can_stop: !!this.turn && !this.ended };
  }
  private enqueue(): void {
    if (this.closed) return;
    this.queued = true;
    if (this.sending) return;
    this.sending = (async () => {
      while (this.queued && !this.closed) {
        this.queued = false;
        try { await this.deliver(this.frame()); } catch { /* display must never delay a task */ }
      }
    })().finally(() => { this.sending = null; if (this.queued && !this.closed) this.enqueue(); });
  }
  async settled(): Promise<void> { while (this.sending) await this.sending; }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.stop(); await this.settled();
    try { await this.deliver({ ...this.frame(), turn: null, started_at: 0, state: "idle", text: "在线", steps: [], can_stop: false }); } catch {}
  }
}
