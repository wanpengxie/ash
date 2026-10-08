import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { PULSE_EVENTS, wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { RouteHandlerContext, TrustedRouteContext, WorldRouter } from "../world/router";

const service: TrustedRouteContext = { member: "service:pulse", transport: "service", transportPrincipal: "service:pulse",
  local: true, remote: false, ownerProxy: false };

const WORDS = ["pulse.get", "pulse.set", "pulse.history", "pulse.note", "pulse.fire", "pulse.switch", "pulse.due"] as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Real timers are laid down this far ahead and renewed as time passes. */
const HORIZON_MS = 48 * HOUR;
const REFRESH_MS = 6 * HOUR;
/** A timer that fires much later than it was set for (the phone slept, ash was down) is not a reason to wake now. */
const STALE_MS = 2 * HOUR;
const MAX_HISTORY = 2000;
const DEFAULT_BUDGET = 14;
const DEFAULT_GAP_MIN = 60;
const DEFAULT_REVIEW_TIME = "21:00";
const GUIDANCE = "PULSE.md";
const HEARTBEAT = "HEARTBEAT.md";
const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const SET_FIELDS = new Set(["schedule", "events", "review_time", "guidance", "reason"]);

export type PulseEventName = typeof PULSE_EVENTS[number];
export type PulseDays = "daily" | "weekdays" | "weekends" | number[];
export interface PulseSlot { time: string | { at: number }; days?: PulseDays }
export interface PulseEventWatch { event: PulseEventName; min_gap_min: number }
export type PulseWhy = "schedule" | "event" | "review";
export type PulseEntry = { id: number; ts: number; kind: string } & Record<string, unknown>;

/** The starter: one wake every two hours in the daytime, and a few events worth hearing about. The agent changes both. */
const DEFAULT_SCHEDULE: PulseSlot[] = ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"].map((time) => ({ time, days: "daily" as const }));
const DEFAULT_EVENTS: PulseEventWatch[] = [
  { event: "geofence_enter", min_gap_min: DEFAULT_GAP_MIN }, { event: "geofence_exit", min_gap_min: DEFAULT_GAP_MIN },
  { event: "calendar_soon", min_gap_min: DEFAULT_GAP_MIN }];

interface PulseState {
  version: 1;
  enabled: boolean;
  /** The precondition as last evaluated: at least one "Ash 卡片" widget is on the home screen. */
  active: boolean;
  activated_at: number | null;
  schedule: PulseSlot[];
  events: PulseEventWatch[];
  review_time: string;
  seq: number;
  history: PulseEntry[];
  /** When each kind of event last woke the agent, and in which local hour any event last did. */
  event_wakes: Record<string, number>;
  event_hour: string | null;
}

export interface PulseOptions {
  router: WorldRouter;
  file: string;
  now?: () => number;
  /** The admin pause: nothing wakes the agent meanwhile. */
  isPaused?: () => boolean;
  /** The text a new PULSE.md and a new HEARTBEAT.md start from (the agent owns both afterwards). */
  templates?: { pulse?: string; heartbeat?: string };
  /** Wakes a day (default 14); the owner's usage cost is recorded by the cost service as for any turn. */
  budget?: number;
  /** Housekeeping interval for renewing timers (default 30 min); 0 turns it off. */
  tickMs?: number;
  log?: (message: string, error?: unknown) => void;
}

/** Where the "Ash 卡片" widgets on the home screen are known (service:widgets). */
export interface PlacedWidgets { placedCardWidgets(): string[]; onPlaced(listener: () => void): () => void }

const ok = (result: Record<string, unknown>): ResponseBody => ({ ok: true, result });
const refuse = (code: "bad_request" | "forbidden" | "failed" | "offline", message: string): ResponseBody => ({ ok: false, error: { code, message } });
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const clip = (value: string, max: number) => { const text = value.replace(/\s+/g, " ").trim(); return [...text].length > max ? `${[...text].slice(0, max).join("")}…` : text; };
const localDayStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const hourKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`; };

class Refused extends Error { constructor(readonly code: "bad_request" | "forbidden" | "failed" | "offline", message: string) { super(message); } }
const bad = (message: string): never => { throw new Refused("bad_request", message); };

/** pulse.json in ash's state directory, replaced atomically. */
class PulseFile {
  constructor(private readonly file: string) {}
  load(): PulseState {
    const fresh = (): PulseState => ({ version: 1, enabled: true, active: false, activated_at: null, schedule: structuredClone(DEFAULT_SCHEDULE),
      events: structuredClone(DEFAULT_EVENTS), review_time: DEFAULT_REVIEW_TIME, seq: 0, history: [], event_wakes: {}, event_hour: null });
    if (!existsSync(this.file)) return fresh();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PulseState>;
      const base = fresh();
      const history = Array.isArray(raw.history) ? raw.history.filter((item) => plain(item) && Number.isSafeInteger(item.id) && typeof item.ts === "number" && typeof item.kind === "string") : [];
      return { ...base, ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}), ...(typeof raw.active === "boolean" ? { active: raw.active } : {}),
        activated_at: typeof raw.activated_at === "number" ? raw.activated_at : null,
        schedule: Array.isArray(raw.schedule) ? raw.schedule : base.schedule, events: Array.isArray(raw.events) ? raw.events : base.events,
        review_time: typeof raw.review_time === "string" && CLOCK_TIME.test(raw.review_time) ? raw.review_time : base.review_time,
        seq: Math.max(Number(raw.seq) || 0, ...history.map((item) => item.id)), history, event_wakes: plain(raw.event_wakes) ? raw.event_wakes as Record<string, number> : {},
        event_hour: typeof raw.event_hour === "string" ? raw.event_hour : null };
    } catch { return fresh(); }
  }
  save(state: PulseState): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/**
 * service:pulse: Ash's own home-screen card as the window through which it speaks first. The service only wakes the main
 * agent (why, when, how many wakes are left), keeps its schedule, watch list, history and notes, and enforces the owner's
 * switch, the budget and the precondition: nothing exists while no "Ash 卡片" widget is placed. What to look at, whether to
 * speak and what to show is the agent's own, guided by PULSE.md, which the agent edits through service:self.
 */
export class PulseMember implements Member {
  readonly id = "service:pulse";
  readonly kind = "service" as const;
  readonly name = "Pulse";
  readonly online = true;
  private state: PulseState;
  private readonly store: PulseFile;
  private placed: PlacedWidgets | null = null;
  private stops: (() => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastReconcile = 0;
  private wakes = 0;
  private get budget(): number { return this.options.budget ?? DEFAULT_BUDGET; }
  private closed = false;

  constructor(private readonly options: PulseOptions) {
    this.store = new PulseFile(options.file);
    this.state = this.store.load();
    this.stops.push(options.router.subscribe((message) => this.observe(message)));
  }

  words(): readonly WordSpec[] { return WORDS.map((word) => wordContract("service:pulse", word)!); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private save(): void { this.store.save(this.state); }

  /** Learn where the widgets are; the precondition is evaluated now and whenever they change. */
  attach(widgets: PlacedWidgets): void {
    this.placed = widgets;
    this.stops.push(widgets.onPlaced(() => { void this.evaluate().catch((error) => this.options.log?.("pulse evaluation failed", error)); }));
  }
  /** Evaluate the precondition after startup, then keep the timers renewed. */
  start(): void {
    void this.evaluate().catch((error) => this.options.log?.("pulse start failed", error));
    const every = this.options.tickMs ?? 30 * 60_000;
    if (every > 0) { this.interval = setInterval(() => { void this.tick().catch(() => {}); }, every); this.interval.unref?.(); }
  }
  /** Renew the timers when they have not been laid down for a while (a day passing, a pause ending). */
  async tick(): Promise<void> {
    if (this.now() - this.lastReconcile >= REFRESH_MS) await this.serial(() => this.reconcile());
  }
  /** Resolves when everything queued so far (activation, timers) has finished. */
  async settled(): Promise<void> { let tail: Promise<unknown>; do { tail = this.queue; await tail.catch(() => {}); } while (tail !== this.queue); }
  close(): void { this.closed = true; for (const stop of this.stops.splice(0)) stop(); if (this.interval) clearInterval(this.interval); }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  // ---- precondition

  private placedNow(): boolean { return (this.placed?.placedCardWidgets().length ?? 0) > 0; }
  private running(): boolean { return this.state.active && this.state.enabled; }

  private evaluate(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      const placed = this.placedNow();
      if (placed && !this.state.active) {
        this.state.active = true; this.state.activated_at = this.now(); this.save();
        this.record("activated", { widgets: this.placed?.placedCardWidgets().length ?? 0 });
        if (this.state.enabled) {
          await this.seedFiles();
          await this.reconcile();
          // The first card is the agent's to decide.
          this.wake("schedule", { scheduledFor: this.now() });
        }
      } else if (!placed && this.state.active) {
        this.state.active = false; this.save();
        this.record("deactivated", {});
        await this.reconcile();
      } else if (this.state.active) await this.reconcile();
    });
  }

  // ---- history

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
  private reviewedSince(since: number): boolean {
    return this.state.history.some((item) => item.kind === "note" && item.note_kind === "review" && item.ts >= since);
  }

  // ---- schedule -> clock timers

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
  private reviewMoments(from: number, to: number): number[] {
    const [hour, minute] = this.state.review_time.split(":").map(Number) as [number, number];
    const first = new Date(from);
    return [0, 1, 2, 3].map((offset) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + offset, hour, minute, 0, 0).getTime())
      .filter((at) => at > from && at <= to);
  }

  private async ask(to: string, word: string, body: Record<string, unknown>): Promise<ResponseBody> {
    const sent = await this.options.router.send(service, { to, kind: "request", word, body, wait: true });
    return (sent.reply?.body as ResponseBody | undefined) ?? refuse("failed", "no answer was recorded");
  }

  /** Make the clock's pulse timers exactly the next 48 hours of the schedule (none unless the pulse is running). */
  private async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconcile = now;
    const want = new Map<string, { kind: "wake" | "floor"; at: number }>();
    if (this.running() && !this.closed) {
      for (const at of this.expand(now, now + HORIZON_MS)) want.set(`pulse:wake:${at}`, { kind: "wake", at });
      for (const at of this.reviewMoments(now, now + HORIZON_MS)) want.set(`pulse:floor:${at}`, { kind: "floor", at });
    }
    // One-moment entries that have passed are done.
    this.state.schedule = this.state.schedule.filter((slot) => typeof slot.time === "string" || slot.time.at > now);
    this.save();
    const listed = await this.ask("service:clock", "list", {});
    if (!listed.ok) { this.record("failure", { while: "timers", error: listed.error.message }); return; }
    const have = new Map<string, string>();
    for (const timer of (listed.result as { timers?: { id: string; label?: string }[] }).timers ?? []) if (timer.label?.startsWith("pulse:")) have.set(timer.label, timer.id);
    for (const [label, id] of have) if (!want.has(label)) await this.ask("service:clock", "cancel", { id });
    for (const [label, item] of want) {
      if (have.has(label)) continue;
      const set = await this.ask("service:clock", "set", { at: item.at, to: "service:pulse", word: "pulse.due", body: { kind: item.kind, at: item.at }, label });
      if (!set.ok && set.error.code !== "offline") this.record("failure", { while: "timers", error: set.error.message });
    }
  }

  // ---- waking the agent

  /**
   * Check the switch, the precondition, the pause and the budget, then wake the main agent with the reason only: no data.
   * A manual wake (pulse.fire) and the review floor are not held back by the budget.
   */
  private wake(why: PulseWhy, input: { scheduledFor: number; event?: string; manual?: boolean; floor?: boolean }): { fired: boolean; reason?: string } {
    const skip = (reason: string) => { this.record("skip", { why, reason, scheduled_for: input.scheduledFor, ...(input.event ? { event: input.event } : {}) }); return { fired: false, reason }; };
    if (!this.state.active) return { fired: false, reason: "no widget" };
    if (!this.state.enabled) return { fired: false, reason: "switched off" };
    if (this.options.isPaused?.()) return skip("paused");
    const used = this.todayCount();
    if (!input.manual && !input.floor && used >= this.budget) return skip("budget");
    const counted = !input.manual;
    const todayCount = used + (counted ? 1 : 0);
    const context: Record<string, unknown> = { why, scheduled_for: input.scheduledFor, today_count: todayCount, budget_left: Math.max(0, this.budget - todayCount),
      ...(input.event ? { event: input.event } : {}) };
    this.record("wake", { why, scheduled_for: input.scheduledFor, counted, ...(input.manual ? { manual: true } : {}), ...(input.event ? { event: input.event } : {}) });
    const n = ++this.wakes;
    void this.options.router.send(service, { to: "agent:main", kind: "request", word: "wake", body: { reason: "pulse", context }, wait: true,
      client_id: `pulse:wake:${this.now()}:${n}` })
      .then((sent) => { const body = sent.reply?.body as ResponseBody | undefined; if (body && !body.ok) this.record("failure", { while: "wake", why, error: body.error.message }); })
      .catch((error) => { this.record("failure", { while: "wake", why, error: error instanceof Error ? error.message : String(error) }); });
    return { fired: true };
  }

  private due(kind: "wake" | "floor", at: number): void {
    const now = this.now();
    if (!this.running()) return;
    if (kind === "wake") {
      if (now - at > STALE_MS) { this.record("skip", { why: "schedule", reason: "stale", scheduled_for: at }); return; }
      this.wake("schedule", { scheduledFor: at });
      return;
    }
    // The review floor: a day without a self-summary is not allowed to pass in silence.
    const baseline = Math.max(this.state.activated_at ?? 0, 0);
    if (this.reviewedSince(now - DAY) || now - baseline < DAY) return;
    // Several floors that were all overdue (ash was down overnight) are one reminder, not many.
    if (this.state.history.some((item) => item.kind === "wake" && item.why === "review" && item.ts > now - 12 * HOUR)) return;
    this.wake("review", { scheduledFor: at, floor: true });
  }

  // ---- events

  private observe(message: Message): void {
    if (this.closed) return;
    try {
      if (message.word === "widget.action" && message.kind === "event" && message.from === "service:widgets") this.feedback(message.body);
      const hit = this.eventOf(message);
      if (hit) this.event(hit.name, hit.what);
    } catch (error) { this.options.log?.("pulse could not read an event", error); }
  }
  private feedback(body: Record<string, unknown>): void {
    const context = plain(body.context) ? body.context : undefined;
    if (!context || typeof context.feedback !== "string" || String(body.owner).startsWith("app:")) return;
    this.record("feedback", { card: String(body.card), title: clip(String(body.title ?? ""), 40), feedback: clip(context.feedback, 200), action: String(body.action),
      ...(typeof body.component === "string" ? { component: body.component } : {}), ...(typeof body.item === "string" ? { item: body.item } : {}) });
  }
  private eventOf(message: Message): { name: PulseEventName; what: string } | null {
    const body = message.body;
    if (message.kind === "event" && message.from === "device:phone" && message.to === null) {
      if (message.word === "sense.geofence" && (body.transition === "enter" || body.transition === "exit"))
        return { name: body.transition === "enter" ? "geofence_enter" : "geofence_exit", what: `${body.transition === "enter" ? "arrived at" : "left"} ${clip(String(body.name), 40)}` };
      if (message.word === "sense.calendar" && body.kind === "upcoming")
        return { name: "calendar_soon", what: `calendar event soon: ${clip(String((body.event as { title?: unknown } | undefined)?.title ?? ""), 60)}` };
      if (message.word === "sense.source" && body.state === "stale") return { name: "source_stalled", what: `data source stalled: ${clip(String(body.source), 40)}` };
    }
    if (message.kind === "request" && message.from === "service:gate" && message.to === "person:owner" && message.word === "ask") return { name: "approval_waiting", what: "an approval is waiting for the owner" };
    if (message.kind === "event" && /^app:/.test(message.from) && !["app.activity", "app.card"].includes(message.word))
      return { name: "app_event", what: `${message.from} reported ${clip(message.word, 40)}` };
    return null;
  }
  private event(name: PulseEventName, what: string): void {
    const watch = this.state.events.find((item) => item.event === name);
    if (!watch || !this.running()) return;
    const now = this.now();
    const skip = (reason: string) => { this.record("skip", { why: "event", reason, event: what, event_name: name }); };
    if (now - (this.state.event_wakes[name] ?? 0) < watch.min_gap_min * 60_000) { skip("min_gap"); return; }
    // Events in the same hour are one wake: the agent reads the rest from its own sources.
    if (this.state.event_hour === hourKey(now)) { skip("coalesced"); return; }
    const sent = this.wake("event", { scheduledFor: now, event: what });
    if (sent.fired) { this.state.event_wakes[name] = now; this.state.event_hour = hourKey(now); this.save(); }
  }

  // ---- PULSE.md and HEARTBEAT.md

  private async seedFiles(): Promise<void> {
    for (const [path, text] of [[GUIDANCE, this.options.templates?.pulse], [HEARTBEAT, this.options.templates?.heartbeat]] as const) {
      if (!text) continue;
      try {
        const read = await this.ask("service:self", "read", { path });
        if (read.ok || read.error.code !== "not_found") continue;
        const wrote = await this.ask("service:self", "write", { path, content: text, why: "starting text for the pulse", expected_hash: null });
        if (!wrote.ok) this.record("failure", { while: "seed", path, error: wrote.error.message });
      } catch (error) { this.record("failure", { while: "seed", path, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  private async guidanceInfo(): Promise<Record<string, unknown>> {
    const read = await this.ask("service:self", "read", { path: GUIDANCE });
    const history = await this.ask("service:self", "history", { path: GUIDANCE });
    const versions = history.ok ? ((history.result as { versions?: { ts: number; hash: string }[] }).versions ?? []) : [];
    const changed = [...this.state.history].reverse().find((item) => item.kind === "change" && Array.isArray(item.changed) && (item.changed as string[]).includes("guidance"));
    return { path: GUIDANCE, exists: read.ok, ...(read.ok ? { hash: (read.result as { hash: string }).hash, version: versions.length + 1 } : {}),
      ...(changed ? { changed_at: changed.ts, changed_reason: changed.reason } : {}), earlier_versions: versions.slice(0, 5) };
  }

  // ---- words

  async handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody> {
    if (message.kind !== "request" || message.to !== this.id) return refuse("bad_request", "pulse takes requests only");
    try {
      switch (message.word) {
      case "pulse.get": return await this.get();
      case "pulse.set": return await this.serial(() => this.set(message.body));
      case "pulse.history": return this.page(message.body);
      case "pulse.note": return this.note(message.body);
      case "pulse.fire": return this.fire(message.body);
      case "pulse.switch": return await this.switchTo(message);
      case "pulse.due": return this.dueFromClock(message);
      }
      return refuse("bad_request", "unknown pulse word");
    } catch (error) {
      if (error instanceof Refused) return refuse(error.code, error.message);
      throw error;
    }
  }

  private async get(): Promise<ResponseBody> {
    const now = this.now();
    const used = this.todayCount();
    const active = this.placedNow() && this.state.enabled;
    const why = !this.placedNow() ? "no widget" : !this.state.enabled ? "switched off" : undefined;
    return ok({ active, ...(why ? { reason: why } : {}), enabled: this.state.enabled, schedule: structuredClone(this.state.schedule), events: structuredClone(this.state.events),
      review_time: this.state.review_time, budget: { per_day: this.budget, today_count: used, left: Math.max(0, this.budget - used) },
      next_wakes: active ? this.expand(now, now + HORIZON_MS).slice(0, 6) : [],
      history: this.state.history.slice(-10).reverse(),
      gaps: this.state.history.filter((item) => item.kind === "note" && item.note_kind === "gap").slice(-10).reverse(),
      guidance: await this.guidanceInfo() });
  }

  private page(body: Record<string, unknown>): ResponseBody {
    const limit = Math.min(Math.max(1, Math.trunc(Number(body.limit ?? 20)) || 20), 100);
    const before = typeof body.before === "number" ? body.before : Number.MAX_SAFE_INTEGER;
    const older = this.state.history.filter((item) => item.id < before).reverse();
    const entries = older.slice(0, limit);
    return ok({ entries, ...(older.length > limit ? { next_before: entries[entries.length - 1]!.id } : {}) });
  }

  private note(body: Record<string, unknown>): ResponseBody {
    const kind = body.kind === undefined ? "pulse" : body.kind;
    if (kind !== "pulse" && kind !== "review" && kind !== "gap") bad("kind must be pulse, review or gap");
    if (typeof body.did !== "string" || !body.did.trim()) bad("did is required");
    const used = Array.isArray(body.data_used) ? (body.data_used as unknown[]).filter((item): item is string => typeof item === "string").map((item) => clip(item, 80)).slice(0, 30) : [];
    const entry = this.record("note", { note_kind: kind, did: clip(String(body.did), 1000), why: clip(String(body.why ?? ""), 1000), ...(used.length ? { data_used: used } : {}) });
    return ok({ recorded: true, id: entry.id });
  }

  private fire(body: Record<string, unknown>): ResponseBody {
    const why = body.why === undefined ? "schedule" : body.why;
    if (why !== "schedule" && why !== "event" && why !== "review") bad("why must be schedule, event or review");
    if (!this.placedNow()) return ok({ fired: false, reason: "no widget" });
    if (!this.state.enabled) return ok({ fired: false, reason: "switched off" });
    return ok(this.wake(why as PulseWhy, { scheduledFor: this.now(), manual: true }));
  }

  private async switchTo(message: Message): Promise<ResponseBody> {
    // The router already refuses anyone but the local owner; the member does not trust that alone.
    if (message.from !== "person:owner") return refuse("forbidden", "only the owner switches the pulse");
    const enabled = message.body.enabled === true;
    if (typeof message.body.enabled !== "boolean") bad("enabled must be true or false");
    if (enabled !== this.state.enabled) {
      this.state.enabled = enabled; this.save();
      this.record("switch", { enabled, by: "owner" });
      await this.serial(async () => {
        if (this.state.active) { if (enabled) await this.seedFiles(); await this.reconcile(); }
      });
    }
    return ok({ enabled });
  }

  private dueFromClock(message: Message): ResponseBody {
    if (message.from !== "service:clock") return refuse("forbidden", "pulse timers are reported by the clock only");
    const kind = message.body.kind;
    if (kind !== "wake" && kind !== "floor") bad("unknown timer kind");
    this.due(kind as "wake" | "floor", Number(message.body.at));
    // Whatever just fired, the next days stay covered.
    void this.serial(() => this.reconcile()).catch(() => {});
    return ok({ accepted: true });
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
  private checkEvents(value: unknown): PulseEventWatch[] {
    if (!Array.isArray(value) || value.length > PULSE_EVENTS.length) bad("events must be a list of the allowed events");
    const seen = new Set<string>();
    return (value as unknown[]).map((item, index) => {
      if (!plain(item) || Object.keys(item).some((key) => key !== "event" && key !== "min_gap_min")) bad(`events[${index}] takes only event and min_gap_min`);
      const entry = item as Record<string, unknown>;
      if (!(PULSE_EVENTS as readonly unknown[]).includes(entry.event)) bad(`events[${index}].event must be one of ${PULSE_EVENTS.join(", ")}`);
      if (seen.has(entry.event as string)) bad(`events lists ${String(entry.event)} twice`);
      seen.add(entry.event as string);
      const gap = entry.min_gap_min === undefined ? DEFAULT_GAP_MIN : entry.min_gap_min;
      if (!Number.isInteger(gap) || (gap as number) < 1 || (gap as number) > 1440) bad(`events[${index}].min_gap_min must be 1 to 1440`);
      return { event: entry.event as PulseEventName, min_gap_min: gap as number };
    });
  }

  private async set(body: Record<string, unknown>): Promise<ResponseBody> {
    const unknown = Object.keys(body).filter((key) => !SET_FIELDS.has(key));
    if (unknown.length) bad(`unknown field ${unknown.join(", ")}; pulse.set takes ${[...SET_FIELDS].join(", ")}`);
    if (typeof body.reason !== "string" || !body.reason.trim()) bad("reason is required: say why you are changing this");
    const reason = clip(String(body.reason), 500);
    const schedule = body.schedule === undefined ? undefined : this.checkSchedule(body.schedule);
    const events = body.events === undefined ? undefined : this.checkEvents(body.events);
    if (body.review_time !== undefined && !(typeof body.review_time === "string" && CLOCK_TIME.test(body.review_time))) bad("review_time must be HH:MM");
    if (body.guidance !== undefined && (typeof body.guidance !== "string" || !body.guidance.trim() || body.guidance.length > 20_000)) bad("guidance must be the full text of PULSE.md, at most 20000 characters");
    if (schedule === undefined && events === undefined && body.review_time === undefined && body.guidance === undefined) bad("nothing to change: give schedule, events, review_time or guidance");
    const changed: string[] = [];
    let guidanceVersion: number | undefined;
    // The guidance goes first and through service:self (versions, rollback); if it cannot be written nothing else changes.
    if (typeof body.guidance === "string") {
      const read = await this.ask("service:self", "read", { path: GUIDANCE });
      if (!read.ok && read.error.code !== "not_found") return refuse("failed", `could not read ${GUIDANCE}: ${read.error.message}`);
      const wrote = await this.ask("service:self", "write", { path: GUIDANCE, content: body.guidance, why: clip(reason, 200), expected_hash: read.ok ? (read.result as { hash: string }).hash : null });
      if (!wrote.ok) return refuse("failed", `could not write ${GUIDANCE}: ${wrote.error.message}`);
      const history = await this.ask("service:self", "history", { path: GUIDANCE });
      guidanceVersion = (history.ok ? ((history.result as { versions?: unknown[] }).versions ?? []).length : 0) + 1;
      changed.push("guidance");
    }
    if (schedule) { this.state.schedule = schedule; changed.push("schedule"); }
    if (events) { this.state.events = events; changed.push("events"); }
    if (typeof body.review_time === "string") { this.state.review_time = body.review_time; changed.push("review_time"); }
    this.record("change", { changed, reason, ...(guidanceVersion !== undefined ? { guidance_version: guidanceVersion } : {}),
      ...(schedule ? { schedule } : {}), ...(events ? { events } : {}), ...(typeof body.review_time === "string" ? { review_time: body.review_time } : {}) });
    if (schedule || body.review_time !== undefined) await this.reconcile();
    const now = this.now();
    return ok({ changed, next_wakes: this.running() ? this.expand(now, now + HORIZON_MS).slice(0, 6) : [], ...(guidanceVersion !== undefined ? { guidance_version: guidanceVersion } : {}) });
  }
}
