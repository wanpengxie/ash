import { randomUUID } from "node:crypto";
import type { Message } from "../../sdk/src/api";
import type { WorldRouter } from "./world/router";
import { ActivitySteps, activityAction, activityText } from "../../sdk/src/activity";

export interface TaskCard {
  id: string; pending_id: string; to: string; turn: string; kind: string; title: string; detail: string;
  original: string; options: { id: string; label: string }[]; expires_at: number;
  allow_custom: boolean; state: string;
}
export interface TaskStatusFrame {
  session: string; revision: number; turn: string | null; started_at: number;
  state: string; text: string; steps: string[]; can_stop: boolean;
  tool?: string; step_started_at?: number;
  outcome?: string;
  /** How a normally ended turn left things for the owner, once judged (task.outcome route); empty until then. */
  verdict?: string;
  reply?: string; cards?: TaskCard[];
}
const states = new Set(["idle", "listening", "thinking", "working", "done", "waiting_you", "resting"]);
/** Native display projection: activity labels, owner-facing replies and exact approval cards. Never executes. */
export class TaskStatusBridge {
  private session = randomUUID();
  private revision = 0;
  private turn: string | null = null;
  private started = 0;
  private state = "idle";
  private text = "在线";
  private steps: string[] = [];
  private asks = new Map<string, TaskCard>();
  private replies: string[] = [];
  private replyInterrupted = false;
  private activity = new ActivitySteps();
  private summary = "";
  private ended = false;
  private outcome = "";
  private verdict = "";
  private closed = false;
  private queued = false;
  private sending: Promise<void> | null = null;
  private stop: () => void;
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly router: Pick<WorldRouter, "subscribe"> & Partial<Pick<WorldRouter, "ledger">>, private readonly deliver: (frame: TaskStatusFrame) => Promise<void>) {
    for (const item of router.ledger?.activeHumanPending() ?? []) {
      if (item.agent !== "agent:main") continue;
      const ask = router.ledger?.byId(item.ask_id);
      if (ask) { this.turn = item.turn; this.started = ask.ts; this.ended = true; this.state = "done"; this.addAsk(ask); }
    }
    this.stop = router.subscribe((m) => this.observe(m));
    this.timer = setInterval(() => { if (this.turn && (!this.ended || this.asks.size)) this.enqueue(); }, 5_000);
    this.timer.unref();
    this.enqueue();
  }
  private addAsk(m: Message): void {
    const human = this.router.ledger?.humanPending(m.id);
    const source = m.body.source as Record<string, unknown> | undefined;
    this.asks.set(m.id, { id: m.id, pending_id: human?.pending_id ?? m.id, to: m.from, turn: m.turn ?? this.turn!,
      kind: String(m.body.human_kind ?? "approval"), title: String(m.body.title ?? "需要你确认"), detail: String(m.body.detail ?? ""),
      original: typeof source?.body_full === "string" ? source.body_full : human?.action ? JSON.stringify(human.action.body, null, 2) : String(m.body.detail ?? ""),
      options: Array.isArray(m.body.options) ? m.body.options as TaskCard["options"] : [], expires_at: Number(m.body.expires_at ?? 0),
      allow_custom: m.body.allow_custom === true, state: human?.state ?? "waiting" });
  }
  private observe(m: Message): void {
    if (this.closed) return;
    if (m.from === "agent:main" && m.kind === "event") {
      if (m.word === "turn.start" && typeof m.body.turn === "string") {
        this.turn = m.body.turn; this.started = m.ts; this.ended = false; this.steps = []; this.activity = new ActivitySteps(); this.summary = "";
        for (const [id, card] of this.asks) if (card.state !== "waiting" && !(card.kind === "approval" && card.state === "answered")) this.asks.delete(id);
        this.replies = []; this.replyInterrupted = false;
        this.outcome = ""; this.verdict = ""; this.state = "thinking"; this.text = "等待模型响应";
      } else if (m.word === "turn.end" && m.body.turn === this.turn) {
        this.ended = true; this.state = "done";
        this.outcome = String(m.body.reason ?? "");
        this.text = m.body.reason === "completed" ? "本轮回复" : m.body.reason === "cancelled" ? "已停止" : "本轮已结束";
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
    } else if (m.from === "service:reflex" && m.kind === "event" && m.word === "decision.applied" && m.body.route === "task.outcome") {
      // A late verdict for an earlier turn says nothing about the current one.
      if (!this.turn || m.turn !== this.turn || !this.ended || m.body.acted !== true) return;
      this.verdict = String((m.body.outcome as { kind?: unknown } | undefined)?.kind ?? "");
    } else if (this.turn && m.kind === "request" && m.to === "person:owner" && m.word === "ask") {
      // Gate holds the outer tool request while asking. That is waiting, not ongoing work.
      if (m.turn !== this.turn) return;
      this.addAsk(m);
    } else if (m.from === "service:gate" && m.kind === "event" && m.word === "human.pending") {
      // Durable pending records can outlive the turn that created them.
    } else if (m.kind === "response" && m.reply_to && this.asks.has(m.reply_to)) {
      const card = this.asks.get(m.reply_to)!;
      const result = m.body.result as { choice?: string } | undefined;
      card.state = m.body.ok ? result?.choice === "deny" ? "denied" : "answered" : "withdrawn";
    } else if (this.turn && !this.ended && m.from === "agent:main" && m.to === "person:owner" && m.kind === "request" && m.word === "say" && m.turn === this.turn) {
      if (this.replyInterrupted) this.replies = [];
      this.replyInterrupted = false;
      if (typeof m.body.text === "string") this.replies.push(m.body.text);
    } else if (this.turn && !this.ended && m.kind === "request" && m.from === "agent:main" && m.turn === this.turn) {
      if (!m.to || m.to === "person:owner") return;
      // Several speech tool calls can form one final reply; they are not intervening task work.
      if (m.to === "service:dsh-tool" && /(?:^|__)(?:human_say|ash_say)$/.test(m.word)) return;
      this.replyInterrupted = this.replies.length > 0;
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
    for (const card of this.asks.values()) {
      const human = this.router.ledger?.humanPending(card.id);
      if (human) { card.state = human.state; card.pending_id = human.pending_id; }
      if (card.state === "waiting" && card.expires_at > 0 && card.expires_at <= Date.now()) card.state = "expired";
    }
    const cards = [...this.asks.values()].map((card) => structuredClone(card));
    const waiting = cards.some((c) => c.state === "waiting");
    const action = this.ended ? undefined : this.activity.current();
    return { session: this.session, revision: ++this.revision, turn: this.turn, started_at: this.started,
      state: waiting ? "waiting_you" : this.state, text: waiting ? "等待你回应" : this.text,
      reply: this.replies.join("\n\n"), cards,
      steps: [...this.steps], can_stop: !!this.turn && !this.ended, tool: action?.tool ?? "", step_started_at: action?.ts ?? this.started, outcome: this.outcome,
      ...(this.ended && this.verdict ? { verdict: this.verdict } : {}) };
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
