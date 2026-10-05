import { randomUUID } from "node:crypto";
import type { Message } from "../../sdk/src/api";
import type { WorldRouter } from "./world/router";

export interface TaskStatusFrame {
  session: string; revision: number; turn: string | null; started_at: number;
  state: string; text: string; steps: string[]; can_stop: boolean;
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
  private actions = new Map<string, { label: string; purpose: boolean }>();
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
        this.turn = m.body.turn; this.started = m.ts; this.ended = false; this.steps = []; this.asks.clear(); this.actions.clear();
        this.state = "thinking"; this.text = "正在理解你的请求";
      } else if (m.word === "turn.end" && m.body.turn === this.turn) {
        this.ended = true; if (m.body.reason !== "completed") this.asks.clear(); this.state = "done";
        this.text = m.body.reason === "completed" ? "已完成" : m.body.reason === "cancelled" ? "已停止" : "任务已结束";
      } else if (m.word === "status" && states.has(String(m.body.state))) {
        // Only committed turn.end ends a task. Transient idle/typing statuses must not erase it.
        if (this.turn && (this.ended || m.body.state === "idle" || m.body.state === "resting")) return;
        this.state = String(m.body.state);
        // Existing detail may include a query. Never transport that onto other apps.
        this.text = this.actionText() ?? (this.state === "thinking" || this.state === "listening"
          ? this.steps.length ? "正在分析返回结果" : "正在理解你的请求"
          : String(m.body.text ?? "").split(" · ")[0].replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 80));
        if (this.state === "idle" || this.state === "resting") { this.turn = null; this.started = 0; this.ended = false; this.steps = []; }
        if (this.text && this.turn && this.steps.at(-1) !== this.text) this.steps = [...this.steps, this.text].slice(-5);
      } else return;
    } else if (this.turn && !this.ended && m.kind === "request" && m.to === "person:owner" && m.word === "ask") {
      // Gate holds the outer tool request while asking. That is waiting, not ongoing work.
      if (m.turn !== this.turn) return;
      this.asks.add(m.id);
    } else if (m.kind === "response" && m.reply_to && this.asks.delete(m.reply_to)) {
      if (this.ended && !this.asks.size) { this.state = "done"; this.text = "已结束，等待后续消息"; }
    } else if (this.turn && !this.ended && m.kind === "request" && m.from === "agent:main" && m.turn === this.turn) {
      const label = taskActionLabel(m);
      if (!label) return;
      this.actions.set(m.id, label); this.state = "working"; this.text = this.actionText()!;
      if (this.steps.at(-1) !== this.text) this.steps = [...this.steps, this.text].slice(-5);
    } else if (m.kind === "response" && m.reply_to && this.actions.delete(m.reply_to) && !this.ended) {
      this.text = this.actionText() ?? "正在分析返回结果";
      this.state = this.actions.size ? "working" : "thinking";
    } else return;
    this.enqueue();
  }
  private frame(): TaskStatusFrame {
    return { session: this.session, revision: ++this.revision, turn: this.turn, started_at: this.started,
      state: this.asks.size ? "waiting_you" : this.state, text: this.asks.size ? "等待你确认" : this.text,
      steps: [...this.steps], can_stop: !!this.turn && !this.ended };
  }
  private actionText(): string | undefined {
    const actions = [...this.actions.values()].reverse();
    return (actions.find((a) => a.purpose) ?? actions[0])?.label;
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

/** Show human-written purpose or a precise operation, never a raw command, URL query or input body. */
function taskActionLabel(m: Message): { label: string; purpose: boolean } | null {
  let body = m.body;
  let word = m.word;
  if (m.to === "service:dsh-tool") {
    try { body = typeof body.arguments === "string" ? JSON.parse(body.arguments) : {}; } catch { return null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    if (word === "bash" && typeof body.description === "string" && body.description.trim())
      return { label: body.description.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 60), purpose: true };
    if (word === "mcp__ash__capability_call") word = String(body.word ?? "");
  }
  if (typeof body.purpose === "string" && body.purpose.trim())
    return { label: body.purpose.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 60), purpose: true };
  const labels: Record<string, string> = {
    "screen.read": "正在读取当前页面", "screen.see": "正在查看屏幕内容", "screen.screenshot": "正在保存屏幕截图",
    "screen.tap": "正在点击页面控件", "screen.type": "正在填写内容", "screen.scroll": "正在滚动查找内容",
    "screen.swipe": "正在滑动页面", "screen.global_action": "正在切换页面",
    "apps.open": "正在打开应用", "browser.open": "正在打开网页", "browser.read": "正在读取网页内容",
    "browser.click": "正在点击网页控件", "browser.type": "正在填写网页内容", "browser.run": "正在操作网页",
    "vscreen.create": "正在准备后台屏幕", "vscreen.launch": "正在后台打开应用", "vscreen.see": "正在查看后台页面",
    "vscreen.tap": "正在操作后台页面", "vscreen.type": "正在填写后台页面", "vscreen.close": "正在关闭后台屏幕",
    "bash": "正在执行命令（未提供用途）", "shell.run": "正在执行命令（未提供用途）",
    "web_search": "正在检索资料", "web_fetch": "正在读取网页内容",
  };
  return labels[word] ? { label: labels[word], purpose: false } : null;
}
