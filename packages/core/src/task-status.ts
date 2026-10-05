import { randomUUID } from "node:crypto";
import type { Message } from "../../sdk/src/api";
import type { WorldRouter } from "./world/router";
import { ActivitySteps, activityAction, activityText } from "../../sdk/src/activity";

export interface TaskStatusFrame {
  session: string; revision: number; turn: string | null; started_at: number;
  state: string; text: string; steps: string[]; can_stop: boolean;
  tool?: string; step_started_at?: number;
  outcome?: string;
}
const states = new Set(["idle", "listening", "thinking", "working", "done", "waiting_you", "resting"]);
/** Native display projection only: selected step purpose, never raw arguments or recovered execution. */
export class TaskStatusBridge {
  private session = randomUUID();
  private revision = 0;
  private turn: string | null = null;
  private started = 0;
  private state = "idle";
  private text = "在线";
  private steps: string[] = [];
  private asks = new Set<string>();
  private activity = new ActivitySteps();
  private summary = "";
  private ended = false;
  private outcome = "";
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
        this.turn = m.body.turn; this.started = m.ts; this.ended = false; this.steps = []; this.asks.clear(); this.activity = new ActivitySteps(); this.summary = "";
        this.outcome = ""; this.state = "thinking"; this.text = "等待模型响应";
      } else if (m.word === "turn.end" && m.body.turn === this.turn) {
        this.ended = true; if (m.body.reason !== "completed") this.asks.clear(); this.state = "done";
        this.outcome = String(m.body.reason ?? "");
        this.text = m.body.reason === "completed" ? "已完成" : m.body.reason === "cancelled" ? "已停止" : "任务已结束";
      } else if (m.word === "activity.summary" && m.turn === this.turn && !this.ended) {
        if (m.body.current !== true || this.activity.current()) return;
        this.summary = activityText(m.body.text); this.text = this.summary || "等待模型响应";
      } else if (m.word === "status" && states.has(String(m.body.state))) {
        // Only committed turn.end ends a task. Transient idle/typing statuses must not erase it.
        if (this.turn && (this.ended || m.body.state === "idle" || m.body.state === "resting")) return;
        this.state = String(m.body.state);
        // Existing detail may include a query. Never transport that onto other apps.
        this.text = this.activity.current()?.label ?? (this.state === "thinking" || this.state === "listening"
          ? this.summary || "等待模型响应"
          : String(m.body.text ?? "").split(" · ")[0].replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 80));
        if (this.state === "idle" || this.state === "resting") { this.turn = null; this.started = 0; this.ended = false; this.steps = []; }
      } else return;
    } else if (this.turn && !this.ended && m.kind === "request" && m.to === "person:owner" && m.word === "ask") {
      // Gate holds the outer tool request while asking. That is waiting, not ongoing work.
      if (m.turn !== this.turn) return;
      this.asks.add(m.id);
    } else if (m.kind === "response" && m.reply_to && this.asks.delete(m.reply_to)) {
      if (this.ended && !this.asks.size) { this.state = "done"; this.text = "已结束，等待后续消息"; }
    } else if (this.turn && !this.ended && m.kind === "request" && m.from === "agent:main" && m.turn === this.turn) {
      if (!m.to || m.to === "person:owner") return;
      this.summary = "";
      this.activity.request(m.id, m.ts, activityAction(m.to, m.word, m.body));
      this.state = "working"; this.text = this.activity.current()?.label ?? "等待执行结果";
    } else if (m.kind === "response" && m.reply_to && !this.ended) {
      if (!this.activity.response(m.reply_to, m.ts, m.body)) return;
      this.text = this.activity.current()?.label ?? (this.summary || "等待模型响应");
      this.state = this.activity.current() ? "working" : "thinking";
    } else return;
    this.steps = this.activity.visible().slice(-5).map((s) => `${s.state === "ok" ? "✓ " : s.state === "failed" ? "失败 · " : ""}${s.label}`);
    this.enqueue();
  }
  private frame(): TaskStatusFrame {
    const action = this.ended ? undefined : this.activity.current();
    return { session: this.session, revision: ++this.revision, turn: this.turn, started_at: this.started,
      state: this.asks.size ? "waiting_you" : this.state, text: this.asks.size ? "等待你确认" : this.text,
      steps: [...this.steps], can_stop: !!this.turn && !this.ended, tool: action?.tool ?? "", step_started_at: action?.ts ?? this.started, outcome: this.outcome };
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
