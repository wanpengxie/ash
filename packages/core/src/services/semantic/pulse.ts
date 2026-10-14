/**
 * `service:pulse`: Ash's own home-screen card as the window through which it speaks first (SPEC-10 §3).
 *
 * The service only wakes the primary agent (`agent:<primary>/wake {lane: "back", reason: "pulse", context}`), keeps its
 * schedule, history and notes, and enforces the owner's switch, the day's budget and the precondition: nothing
 * exists while no "Ash 卡片" widget is placed. What to look at, whether to speak and what to show is the agent's own,
 * guided by PULSE.md in its home folder, which the agent edits itself (pulse.set has no guidance field).
 *
 * Changes from the version that ran on the phone: the default is one wake an hour from 08:00 to 22:00 with 16 a day;
 * there is no review wake and no review floor (the evening review is `daily.ts`); `pulse.note` has no `review` kind.
 *
 * The clock's timers: `pulse.due {kind: "wake"}` is a scheduled pulse. The same word also carries the semantic layer's
 * two other timers (`daily`, `reload`), which this member only passes on to `onDue`.
 *
 * Wakes for things that happen (a place entered, a ride, a calendar event) are the organ `app:sense-rules`'s to judge
 * (HUB-MODULES §7); the pulse listens to no sensor.
 */
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import { ask, CLOCK_TIME, dataOf, localDayStart, primaryAgent, reconcileTimers, seedBodyFile, wakeAgent, type Sender } from "./shared";

export const PULSE_ID = "service:pulse";
/** The members that lay down timers for `pulse.due` (the clock sends each as its setter): the pulse itself, and the semantic entity that also runs the daily review and the reload. */
const DUE_FROM: ReadonlySet<string> = new Set([PULSE_ID, "service:semantic"]);
const GUIDANCE = "PULSE.md";
const HOUR = 3_600_000;
/** Real timers are laid down this far ahead and renewed as time passes. */
const HORIZON_MS = 48 * HOUR;
const REFRESH_MS = 6 * HOUR;
/** A timer that fires much later than it was set for (the phone slept, ash was down) is not a reason to wake now. */
const STALE_MS = 2 * HOUR;
const MAX_HISTORY = 2000;
const DEFAULT_BUDGET = 16;

export type PulseDays = "daily" | "weekdays" | "weekends" | number[];
export interface PulseSlot { time: string | { at: number }; days?: PulseDays }
export type PulseWhy = "schedule";
export type PulseEntry = { id: number; ts: number; kind: string } & Record<string, unknown>;
export type DueKind = "wake" | "daily" | "reload";

/** The starter: one wake an hour in the daytime (08:00 to 22:00, 15 wakes). The agent changes it. */
export const DEFAULT_SCHEDULE: PulseSlot[] = Array.from({ length: 15 }, (_, i) => ({ time: `${String(8 + i).padStart(2, "0")}:00`, days: "daily" as const }));
interface PulseState {
  version: 1;
  enabled: boolean;
  /** The precondition as last evaluated: at least one "Ash 卡片" widget is on the home screen. */
  active: boolean;
  activated_at: number | null;
  schedule: PulseSlot[];
  seq: number;
  history: PulseEntry[];
}

export interface PulseOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  now?: () => number;
  /** Wakes a day (default 16). */
  budget?: number;
  /** The text a new PULSE.md starts from (the agent owns the file afterwards). */
  templates?: { pulse?: string };
  /** Housekeeping interval (default 30 min); 0 turns it off (tests call `tick`). */
  tickMs?: number;
  /** The clock reported a `daily` or `reload` timer. */
  onDue?: (kind: "daily" | "reload", at: number) => void | Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const clip = (value: string, max: number) => { const text = value.replace(/\s+/g, " ").trim(); return [...text].length > max ? `${[...text].slice(0, max).join("")}…` : text; };
const bad = (message: string): never => { throw new WordError("bad_request", message); };

const SQL = "CREATE TABLE IF NOT EXISTS pulse_state (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)";

export class PulseService implements Member {
  readonly id = PULSE_ID;
  readonly kind = "service" as const;
  readonly name = "Pulse";
  /** The events this member hears: the widget state (the precondition and the owner's feedback). */
  readonly listens = ["widget.placed", "widget.action"];
  private readonly db;
  private readonly now: () => number;
  private state: PulseState;
  /** The "Ash 卡片" widgets known to be on the home screen. */
  private placed = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastReconcile = 0;
  private guidanceSeeded = false;
  private closed = false;
  private get budget(): number { return this.options.budget ?? DEFAULT_BUDGET; }

  constructor(private readonly options: PulseOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.db.exec(SQL);
    this.state = this.load();
  }

  words(): WordContract[] { return wordsOf(PULSE_ID); }

  // ---- storage ----

  private load(): PulseState {
    const fresh = (): PulseState => ({ version: 1, enabled: true, active: false, activated_at: null, schedule: structuredClone(DEFAULT_SCHEDULE),
      seq: 0, history: [] });
    const row = this.db.prepare("SELECT json FROM pulse_state WHERE id=1").get() as { json: string } | undefined;
    if (!row) return fresh();
    try {
      const raw = JSON.parse(row.json) as Partial<PulseState>;
      const base = fresh();
      const history = Array.isArray(raw.history) ? raw.history.filter((item) => plain(item) && Number.isSafeInteger(item.id) && typeof item.ts === "number" && typeof item.kind === "string") : [];
      return { ...base, ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}), ...(typeof raw.active === "boolean" ? { active: raw.active } : {}),
        activated_at: typeof raw.activated_at === "number" ? raw.activated_at : null,
        schedule: Array.isArray(raw.schedule) ? raw.schedule : base.schedule,
        seq: Math.max(Number(raw.seq) || 0, ...history.map((item) => item.id)), history };
    } catch { return fresh(); }
  }
  private save(): void {
    this.db.prepare("INSERT INTO pulse_state (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(JSON.stringify(this.state));
  }

  // ---- lifecycle ----

  /** Learn which widgets are placed, evaluate the precondition, then keep the timers renewed. */
  async start(): Promise<void> {
    this.closed = false;
    const listed = dataOf<{ widgets?: { type?: string }[] }>(await ask(this.options.router, PULSE_ID, "service:widgets", "widget.list"));
    if (listed?.widgets) this.placed = listed.widgets.filter((w) => w.type === "card").length;
    await this.evaluate();
    const every = this.options.tickMs ?? 30 * 60_000;
    if (every > 0) { this.interval = setInterval(() => { void this.tick().catch(() => {}); }, every); this.interval.unref?.(); }
  }
  /** Renew the timers when they have not been laid down for a while (a day passing, a pause ending); seed PULSE.md if the body was away. */
  async tick(): Promise<void> {
    if (this.running() && !this.guidanceSeeded) await this.seedGuidance();
    if (this.now() - this.lastReconcile >= REFRESH_MS) await this.serial(() => this.reconcile());
  }
  /** Resolves when everything queued so far (activation, timers) has finished. */
  async settled(): Promise<void> { let tail: Promise<unknown>; do { tail = this.queue; await tail.catch(() => {}); } while (tail !== this.queue); }
  stop(): void { this.closed = true; if (this.interval) clearInterval(this.interval); this.interval = null; }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  // ---- precondition ----

  private running(): boolean { return this.state.active && this.state.enabled; }

  private evaluate(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const placed = this.placed > 0;
      if (placed && !this.state.active) {
        this.state.active = true; this.state.activated_at = this.now(); this.save();
        this.record("activated", { widgets: this.placed });
        if (this.state.enabled) {
          await this.seedGuidance();
          await this.reconcile();
          // The first card is the agent's to decide.
          await this.wake("schedule", { scheduledFor: this.now() });
        }
      } else if (!placed && this.state.active) {
        this.state.active = false; this.save();
        this.record("deactivated", {});
        await this.reconcile();
      } else if (this.state.active) await this.reconcile();
    });
  }

  // ---- history ----

  private record(kind: string, data: Record<string, unknown>): PulseEntry {
    const entry: PulseEntry = { id: ++this.state.seq, ts: this.now(), kind, ...data };
    this.state.history.push(entry);
    if (this.state.history.length > MAX_HISTORY) this.state.history.splice(0, this.state.history.length - MAX_HISTORY);
    this.save();
    return entry;
  }
  private todayCount(): number {
    const start = localDayStart(this.now());
    return this.state.history.filter((item) => item.kind === "wake" && item.counted === true && item.ts >= start).length;
  }

  // ---- schedule -> clock timers ----

  private matches(days: PulseDays | undefined, weekday: number): boolean {
    if (days === undefined || days === "daily") return true;
    if (days === "weekdays") return weekday >= 1 && weekday <= 5;
    if (days === "weekends") return weekday === 0 || weekday === 6;
    return days.includes(weekday);
  }
  /** Every scheduled moment in (from, to], ascending. */
  expand(from: number, to: number): number[] {
    const out = new Set<number>();
    const first = new Date(from);
    for (let offset = 0; offset <= 3; offset++) {
      for (const slot of this.state.schedule) {
        if (typeof slot.time === "object") { if (offset === 0 && slot.time.at > from && slot.time.at <= to) out.add(slot.time.at); continue; }
        const [hour, minute] = slot.time.split(":").map(Number) as [number, number];
        const day = new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset, hour, minute, 0, 0);
        if (this.matches(slot.days, day.getDay()) && day.getTime() > from && day.getTime() <= to) out.add(day.getTime());
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Make the clock's pulse timers exactly the next 48 hours of the schedule (none unless the pulse is running). */
  private async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconcile = now;
    const want = new Map<string, { at: number; body: unknown }>();
    if (this.running() && !this.closed) for (const at of this.expand(now, now + HORIZON_MS)) want.set(`pulse:wake:${at}`, { at, body: { kind: "wake", at } });
    // One-moment entries that have passed are done.
    this.state.schedule = this.state.schedule.filter((slot) => typeof slot.time === "string" || slot.time.at > now);
    this.save();
    const problem = await reconcileTimers(this.options.router, PULSE_ID, "pulse:", PULSE_ID, "pulse.due", want);
    if (problem) this.record("failure", { while: "timers", error: problem });
  }

  // ---- waking the agent ----

  private async paused(): Promise<boolean> {
    return dataOf<{ paused?: boolean }>(await ask(this.options.router, PULSE_ID, "service:admin", "status"))?.paused === true;
  }

  /**
   * Check the switch, the precondition, the pause and the budget, then wake the primary agent with the reason and the counts only:
   * no data. A manual wake (pulse.fire) is not held back by the budget.
   */
  private async wake(why: PulseWhy, input: { scheduledFor: number; manual?: boolean }): Promise<{ fired: boolean; reason?: string }> {
    const skip = (reason: string) => { this.record("skip", { why, reason, scheduled_for: input.scheduledFor }); return { fired: false, reason }; };
    if (!this.state.active) return { fired: false, reason: "no widget" };
    if (!this.state.enabled) return { fired: false, reason: "switched off" };
    if (await this.paused()) return skip("paused");
    const agent = await primaryAgent(this.options.router, PULSE_ID);
    if (!agent) return skip("no primary agent");
    // The checks that decide and the record that counts are one step, so two wakes at once cannot both take the last place.
    if (!this.running()) return { fired: false, reason: "switched off" };
    const used = this.todayCount();
    if (!input.manual && used >= this.budget) return skip("budget");
    const counted = !input.manual;
    const todayCount = used + (counted ? 1 : 0);
    const context: Record<string, unknown> = { why, scheduled_for: input.scheduledFor, today_count: todayCount, budget_left: Math.max(0, this.budget - todayCount) };
    this.record("wake", { why, scheduled_for: input.scheduledFor, counted, ...(input.manual ? { manual: true } : {}) });
    const sent = await wakeAgent(this.options.router, PULSE_ID, agent, "pulse", context);
    if (!sent.ok) this.record("failure", { while: "wake", why, error: sent.error.message });
    return { fired: true };
  }

  private async due(kind: DueKind, at: number): Promise<void> {
    if (kind !== "wake") { await this.options.onDue?.(kind, at); return; }
    const now = this.now();
    if (!this.running()) return;
    if (now - at > STALE_MS) { this.record("skip", { why: "schedule", reason: "stale", scheduled_for: at }); return; }
    await this.wake("schedule", { scheduledFor: at });
  }

  // ---- events ----

  private async observe(msg: Message): Promise<void> {
    if (this.closed) return;
    const body = (msg.body ?? {}) as Record<string, any>;
    try {
      if (msg.word === "widget.placed") {
        this.placed = Array.isArray(body.widgets) ? body.widgets.filter((w: { type?: string }) => w?.type === "card").length : 0;
        await this.evaluate();
      } else if (msg.word === "widget.action" && msg.from === "service:widgets") this.feedback(body);
    } catch (error) { this.options.log?.("pulse could not read an event", error); }
  }

  private feedback(body: Record<string, any>): void {
    const context = plain(body.context) ? body.context : undefined;
    if (!context || typeof context.feedback !== "string" || String(body.owner).startsWith("app:")) return;
    this.record("feedback", { card: String(body.card), title: clip(String(body.title ?? ""), 40), feedback: clip(context.feedback, 200), action: String(body.action),
      ...(typeof body.component === "string" ? { component: body.component } : {}), ...(typeof body.item === "string" ? { item: body.item } : {}) });
  }

  // ---- PULSE.md ----

  private async seedGuidance(): Promise<void> {
    const text = this.options.templates?.pulse;
    if (!text) { this.guidanceSeeded = true; return; }
    this.guidanceSeeded = await seedBodyFile(this.options.router, PULSE_ID, GUIDANCE, text);
    if (!this.guidanceSeeded) this.record("failure", { while: "seed", path: GUIDANCE, error: "the body did not take the file" });
  }

  // ---- words ----

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    if (msg.kind === "event") { await this.observe(msg); return; }
    const body = (msg.body ?? {}) as Record<string, unknown>;
    switch (msg.word) {
      case "pulse.get": return { data: this.get() };
      case "pulse.set": return { data: await this.serial(() => this.set(body)) };
      case "pulse.history": return { data: this.page(body) };
      case "pulse.note": return { data: this.note(body) };
      case "pulse.fire": return { data: await this.fire() };
      case "pulse.switch": return { data: await this.switchTo(msg, ctx, body) };
      case "pulse.due": return { data: await this.dueFromClock(msg, body) };
      default: throw new WordError("not_found", `service:pulse has no word ${msg.word}`);
    }
  }

  private get() {
    const now = this.now();
    const used = this.todayCount();
    const active = this.placed > 0 && this.state.enabled;
    const why = this.placed === 0 ? "no widget" : !this.state.enabled ? "switched off" : undefined;
    return { active, ...(why ? { reason: why } : {}), enabled: this.state.enabled, schedule: structuredClone(this.state.schedule),
      budget: { per_day: this.budget, today_count: used, left: Math.max(0, this.budget - used) },
      next_wakes: active ? this.expand(now, now + HORIZON_MS).slice(0, 6) : [],
      history: this.state.history.slice(-10).reverse(),
      gaps: this.state.history.filter((item) => item.kind === "note" && item.note_kind === "gap").slice(-10).reverse() };
  }

  private page(body: Record<string, unknown>) {
    const limit = Math.min(Math.max(1, Math.trunc(Number(body.limit ?? 20)) || 20), 100);
    const before = typeof body.before === "number" ? body.before : Number.MAX_SAFE_INTEGER;
    const older = this.state.history.filter((item) => item.id < before).reverse();
    const entries = older.slice(0, limit);
    return { entries, ...(older.length > limit ? { next_before: entries[entries.length - 1]!.id } : {}) };
  }

  private note(body: Record<string, unknown>) {
    const kind = body.kind === undefined ? "pulse" : body.kind;
    if (kind !== "pulse" && kind !== "gap") bad("kind must be pulse or gap");
    if (typeof body.did !== "string" || !body.did.trim()) bad("did is required");
    const used = Array.isArray(body.data_used) ? (body.data_used as unknown[]).filter((item): item is string => typeof item === "string").map((item) => clip(item, 80)).slice(0, 30) : [];
    const entry = this.record("note", { note_kind: kind, did: clip(String(body.did), 1000), why: clip(String(body.why ?? ""), 1000), ...(used.length ? { data_used: used } : {}) });
    return { recorded: true, id: entry.id };
  }

  private async fire() {
    if (this.placed === 0) return { fired: false, reason: "no widget" };
    if (!this.state.enabled) return { fired: false, reason: "switched off" };
    return this.wake("schedule", { scheduledFor: this.now(), manual: true });
  }

  private async switchTo(msg: Message, ctx: HandleContext, body: Record<string, unknown>) {
    if (typeof body.enabled !== "boolean") bad("enabled must be true or false");
    const enabled = body.enabled === true;
    if (enabled !== this.state.enabled) {
      this.state.enabled = enabled; this.save();
      this.record("switch", { enabled, by: msg.from === "person:owner" ? "owner" : msg.from });
      await this.serial(async () => {
        if (this.state.active) { if (enabled) await this.seedGuidance(); await this.reconcile(); }
      });
    }
    return { enabled };
  }

  private async dueFromClock(msg: Message, body: Record<string, unknown>) {
    // The clock sends a timer as the one who set it, and the semantic layer set all of these (pulse, daily review, reload).
    if (!DUE_FROM.has(msg.from)) throw new WordError("forbidden", "pulse timers are reported by the semantic layer's own timers only");
    const kind = body.kind;
    if (kind !== "wake" && kind !== "daily" && kind !== "reload") bad("unknown timer kind");
    await this.due(kind as DueKind, Number(body.at));
    // Whatever just fired, the next days stay covered.
    if (kind === "wake") void this.serial(() => this.reconcile()).catch(() => {});
    return { accepted: true };
  }

  private checkSchedule(value: unknown): PulseSlot[] {
    if (!Array.isArray(value) || value.length > 48) bad("schedule must be a list of at most 48 entries");
    const now = this.now();
    return (value as unknown[]).map((item, index) => {
      if (!plain(item) || Object.keys(item).some((key) => key !== "time" && key !== "days")) bad(`schedule[${index}] takes only time and days`);
      const slot = item as Record<string, unknown>;
      const time = slot.time;
      if (typeof time === "string") {
        if (!CLOCK_TIME.test(time)) bad(`schedule[${index}].time must be HH:MM`);
      } else if (plain(time) && Object.keys(time).length === 1 && Number.isSafeInteger(time.at)) {
        if ((time.at as number) <= now) bad(`schedule[${index}].time.at is in the past`);
      } else bad(`schedule[${index}].time must be "HH:MM" or {at: epoch ms}`);
      const days = slot.days;
      if (days !== undefined && !(days === "daily" || days === "weekdays" || days === "weekends" ||
        (Array.isArray(days) && days.length > 0 && days.length <= 7 && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)))) bad(`schedule[${index}].days must be daily, weekdays, weekends or a list of 0-6`);
      return { time: typeof time === "string" ? time : { at: (time as { at: number }).at }, ...(days === undefined ? {} : { days: days as PulseDays }) };
    });
  }

  private async set(body: Record<string, unknown>) {
    const unknown = Object.keys(body).filter((key) => key !== "schedule" && key !== "reason");
    if (unknown.length) bad(`unknown field ${unknown.join(", ")}; pulse.set takes schedule and reason (PULSE.md is yours to edit in your home folder)`);
    if (typeof body.reason !== "string" || !body.reason.trim()) bad("reason is required: say why you are changing this");
    const reason = clip(String(body.reason), 500);
    const schedule = body.schedule === undefined ? undefined : this.checkSchedule(body.schedule);
    if (schedule === undefined) bad("nothing to change: give schedule");
    this.state.schedule = schedule!;
    this.record("change", { changed: ["schedule"], reason, schedule });
    await this.reconcile();
    const now = this.now();
    return { changed: ["schedule"], next_wakes: this.running() ? this.expand(now, now + HORIZON_MS).slice(0, 6) : [] };
  }
}

