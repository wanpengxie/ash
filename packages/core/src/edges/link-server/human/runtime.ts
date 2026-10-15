/**
 * `service:cards` (docs/CARD-RUNTIME.md): the cards in the conversation that hold resources, and their lifecycle.
 *
 *   registry   one row per card in `card_runtime` (beside `owner_cards`): its app (and whether the app exists only for it),
 *              lifecycle, pinned, last seen / used, expiry, the state of its buttons, when its live data last came
 *   lifecycle  active (on a screen, or used lately) -> idle (sources paused) -> dormant (snapshot; a temporary app sleeps)
 *              -> closed (card.close, ttl, form answered); seeing or pressing a card wakes it
 *   sources    a2ui.sources: data paths read every n seconds or fed by events, only while the card is active, always as
 *              the card's app; each change is pushed to the screens (`present {surface: chat, op: card.patch}`), not recorded
 *   act        a button: its call runs as `app:<id>` with `caller.card` (the gate may ask the owner, who is there), its
 *              ask / tell goes to an agent; one run per card and component; the outcome is written on the card
 */
import type { DatabaseSync } from "node:sqlite";
import { pointer, setPointer, type CardAction, type CardSource, type WidgetComponent } from "../../../../../sdk/src/card";
import { WordError, type Caller, type HandleContext, type Message, type Reply, type WordResult } from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Router } from "../../../kernel/types";
import type { CardRow, Cards } from "./cards";

export const CARDS_ID = "service:cards";
export type Life = "active" | "idle" | "dormant" | "closed";
export interface ActionState { state: "running" | "ok" | "failed"; text: string; at: number }

interface Run {
  id: string; app: string | null; temporary: boolean; life: Life; pinned: boolean; last_seen: number; last_used: number;
  expires_at: number | null; actions: Record<string, ActionState>; fed_at: number | null; kept: boolean;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS card_runtime (
  id TEXT PRIMARY KEY, app TEXT, temporary INTEGER NOT NULL DEFAULT 0, life TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, actions TEXT NOT NULL DEFAULT '{}',
  fed_at INTEGER, kept INTEGER NOT NULL DEFAULT 0)`;

/** The defaults of the hub settings `cards.*`. */
export const CARD_LIMITS_DEFAULT = { idle_minutes: 2, dormant_minutes: 30, max_active: 8, max_sources: 16, max_temporary_apps: 5 };
const TICK_MS = 10_000;
/** A card reported on screen counts as seen for this long (the screens report again at least once a minute). */
const SEEN_MS = 75_000;
const EVENT_GAP_MS = 2_000;
const CALL_TIMEOUT_S = 30;
const ASK_TIMEOUT_S = 120;
const SELF: Caller = { member: CARDS_ID, via: "service", local: true };

export interface CardRuntimeDeps {
  db: DatabaseSync;
  cards: Cards;
  router: Pick<Router, "send" | "subscribe">;
  /** The whole card, as the screens draw it, to every screen that shows the conversation. */
  push(card: Record<string, unknown>): void;
  /** Is a screen of the owner showing Ash now? None: every card goes idle in time. */
  viewing(): boolean;
  settings(): Record<string, unknown>;
  now(): number;
  log(message: string, error?: unknown): void;
  /** No timers (tests drive `tick`). */
  manual?: boolean;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clock = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** A failed call in the owner's words: why, and what to do next. */
function failure(code: string, message: string): string {
  switch (code) {
    case "forbidden": return "这张卡的应用没有被批准做这件事，安装时没给这一项权限。";
    case "denied": return "你没有同意，所以没有做。";
    case "timeout": return "没有及时回应，可以再按一次。";
    case "offline": return "要用的那一方现在不在线，稍后再按。";
    case "cancelled": return "取消了。";
    case "waiting": return "没有等到你的确认，已取消；要做就再按一次。";
    default: return `没做成：${message.slice(0, 120)}`;
  }
}

export class CardRuntime {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastEvent = new Map<string, number>();
  private readonly running = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly d: CardRuntimeDeps) {
    d.db.exec(SCHEMA);
    this.unsubscribe = d.router.subscribe({}, (m) => { if (m.kind === "event") this.onEvent(m); });
    if (!d.manual) { this.tickTimer = setInterval(() => this.tick(), TICK_MS); this.tickTimer.unref?.(); }
  }

  close(): void {
    this.unsubscribe();
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
  }

  // ---- the registry ----------------------------------------------------------------------------------------------

  private decode(r: Record<string, unknown> | undefined): Run | null {
    if (!r) return null;
    return { id: String(r.id), app: r.app ? String(r.app) : null, temporary: r.temporary === 1, life: String(r.life) as Life, pinned: r.pinned === 1,
      last_seen: Number(r.last_seen), last_used: Number(r.last_used), expires_at: r.expires_at === null ? null : Number(r.expires_at),
      actions: JSON.parse(String(r.actions)), fed_at: r.fed_at === null ? null : Number(r.fed_at), kept: r.kept === 1 };
  }
  run(id: string): Run | null { return this.decode(this.d.db.prepare("SELECT * FROM card_runtime WHERE id=?").get(id) as Record<string, unknown> | undefined); }
  private all(): Run[] { return (this.d.db.prepare("SELECT * FROM card_runtime WHERE life!='closed'").all() as Record<string, unknown>[]).map((r) => this.decode(r)!); }
  private save(r: Run): void {
    this.d.db.prepare("INSERT OR REPLACE INTO card_runtime(id,app,temporary,life,pinned,last_seen,last_used,expires_at,actions,fed_at,kept) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, r.app, r.temporary ? 1 : 0, r.life, r.pinned ? 1 : 0, r.last_seen, r.last_used, r.expires_at, JSON.stringify(r.actions), r.fed_at, r.kept ? 1 : 0);
  }
  private limits() {
    const s = this.d.settings();
    const n = (key: keyof typeof CARD_LIMITS_DEFAULT) => { const v = s[`cards.${key}`]; return typeof v === "number" && v >= 0 ? v : CARD_LIMITS_DEFAULT[key]; };
    return { idle_minutes: n("idle_minutes"), dormant_minutes: n("dormant_minutes"), max_active: n("max_active"), max_sources: n("max_sources"), max_temporary_apps: n("max_temporary_apps") };
  }

  /** A card was shown: it is registered, active (it is on the screen now). */
  register(row: CardRow, o: { app?: string; temporary?: boolean; ttl_min?: number }): void {
    const now = this.d.now();
    this.save({ id: row.id, app: o.app ?? null, temporary: !!o.app && o.temporary === true, life: "active", pinned: false, last_seen: now, last_used: now,
      expires_at: o.ttl_min ? now + o.ttl_min * 60_000 : null, actions: {}, fed_at: null, kept: false });
    this.reconcile();
  }

  /** What the screens draw of a card besides its plan: whose app, its lifecycle and the state of its buttons. */
  extra(id: string): Record<string, unknown> {
    const r = this.run(id);
    if (!r) return {};
    return { life: r.life, ...(r.app ? { app: r.app } : {}), ...(r.temporary && !r.kept ? { temporary_app: true } : {}), ...(r.pinned ? { pinned: true } : {}),
      ...(Object.keys(r.actions).length ? { actions: r.actions } : {}), ...(r.fed_at ? { fed_at: r.fed_at } : {}) };
  }

  /** Whether [from] may change card [row] besides its creator: its app. */
  isApp(row: CardRow, from: string): boolean { const r = this.run(row.id); return !!r?.app && from === `app:${r.app}`; }

  /** The card changed (card.update by its creator or its app): every screen draws it again now. */
  changed(id: string): void { this.push(id); }

  private push(id: string): void {
    const row = this.d.cards.get(id);
    if (row) this.d.push({ ...this.d.cards.item(row), ...this.extra(id) });
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  /** The screens report the cards on them now. */
  seen(ids: string[]): string[] {
    const now = this.d.now();
    const woken: string[] = [];
    for (const id of ids) {
      const r = this.run(id);
      if (!r || r.life === "closed") continue;
      r.last_seen = now;
      const was = r.life;
      r.life = "active";
      this.save(r);
      if (was !== "active") { woken.push(id); void this.wakeApp(r); }
    }
    this.reconcile();
    for (const id of woken) this.push(id);
    return ids.filter((id) => this.run(id)?.life === "active");
  }

  /** Every few seconds: who is active, idle, dormant or past its time; sources follow; limits hold. */
  tick(): void { try { this.reconcile(); } catch (error) { this.d.log("cards tick", error); } }

  private reconcile(): void {
    const now = this.d.now();
    const l = this.limits();
    const viewing = this.d.viewing();
    const changed: string[] = [];
    const runs = this.all();
    for (const r of runs) {
      if (r.expires_at !== null && r.expires_at <= now) { this.closeRun(r, false); changed.push(r.id); continue; }
      const onScreen = viewing && now - r.last_seen < SEEN_MS;
      const quiet = now - Math.max(r.last_seen, r.last_used);
      const want: Life = r.pinned || onScreen || quiet < l.idle_minutes * 60_000 ? "active" : quiet < (l.idle_minutes + l.dormant_minutes) * 60_000 ? "idle" : "dormant";
      if (want !== r.life) { r.life = want; this.save(r); changed.push(r.id); }
    }
    // Limits: the least recently used go to sleep first.
    const recent = (r: Run) => Math.max(r.last_seen, r.last_used);
    const active = this.all().filter((r) => r.life === "active" && !r.pinned).sort((a, b) => recent(a) - recent(b));
    while (active.length + this.all().filter((r) => r.life === "active" && r.pinned).length > l.max_active && active.length) {
      const r = active.shift()!; r.life = "dormant"; this.save(r); changed.push(r.id);
    }
    let sources = 0;
    for (const r of this.all().filter((x) => x.life === "active").sort((a, b) => recent(b) - recent(a))) {
      const n = Object.keys(this.sourcesOf(r)).length;
      if (sources + n > l.max_sources && !r.pinned) { r.life = "idle"; this.save(r); changed.push(r.id); continue; }
      sources += n;
    }
    const temporary = [...new Set(this.all().filter((r) => r.temporary && !r.kept && r.life === "active" && r.app).map((r) => r.app!))];
    if (temporary.length > l.max_temporary_apps) {
      const byApp = temporary.map((app) => ({ app, last: Math.max(...this.all().filter((r) => r.app === app).map(recent)) })).sort((a, b) => a.last - b.last);
      for (const { app } of byApp.slice(0, temporary.length - l.max_temporary_apps)) for (const r of this.all().filter((x) => x.app === app && !x.pinned)) { r.life = "dormant"; this.save(r); changed.push(r.id); }
    }
    // Sources run for the active cards only; a temporary app whose cards all sleep sleeps too.
    for (const r of this.all()) this.schedule(r);
    for (const id of [...this.timers.keys()]) { const card = id.slice(0, id.indexOf("\0")); const r = this.run(card); if (!r || r.life !== "active") { clearInterval(this.timers.get(id)); this.timers.delete(id); } }
    for (const app of new Set(this.all().filter((r) => r.temporary && !r.kept && r.app).map((r) => r.app!))) {
      if (this.all().filter((r) => r.app === app).every((r) => r.life === "dormant")) void this.call("service:apps", "apps.sleep", { id: app });
    }
    for (const id of new Set(changed)) this.push(id);
  }

  private async wakeApp(r: Run): Promise<void> {
    if (r.app) await this.call("service:apps", "apps.wake", { id: r.app });
    this.schedule(r);
  }

  private closeRun(r: Run, push = true): void {
    r.life = "closed";
    r.actions = Object.fromEntries(Object.entries(r.actions).filter(([, a]) => a.state !== "running"));
    this.save(r);
    for (const id of [...this.timers.keys()]) if (id.startsWith(`${r.id}\0`)) { clearInterval(this.timers.get(id)); this.timers.delete(id); }
    const row = this.d.cards.get(r.id);
    if (row && row.state === "open") this.d.cards.setState(r.id, "closed");
    // A temporary app goes when its cards are all closed (unless the owner kept it).
    if (r.app && r.temporary && !r.kept) {
      const left = this.d.db.prepare("SELECT count(*) AS n FROM card_runtime WHERE app=? AND life!='closed'").get(r.app) as { n: number };
      const kept = this.d.db.prepare("SELECT count(*) AS n FROM card_runtime WHERE app=? AND kept=1").get(r.app) as { n: number };
      if (Number(left.n) === 0 && Number(kept.n) === 0) void this.call("service:apps", "apps.remove", { id: r.app, keep_data: false });
    }
    if (push) this.push(r.id);
  }

  /** person:owner/card.close and service:cards/close. */
  closeCard(id: string): boolean {
    const r = this.run(id);
    if (!r) { const row = this.d.cards.get(id); if (row?.state === "open") { this.d.cards.setState(id, "closed"); return true; } return false; }
    if (r.life === "closed") return false;
    this.closeRun(r);
    return true;
  }

  // ---- sources ---------------------------------------------------------------------------------------------------

  private sourcesOf(r: Run): Record<string, CardSource> {
    if (!r.app) return {};
    return this.d.cards.get(r.id)?.plan.sources ?? {};
  }

  /** Polled sources of an active card get a timer; the others none. */
  private schedule(r: Run): void {
    const sources = r.life === "active" ? this.sourcesOf(r) : {};
    for (const [path, src] of Object.entries(sources)) {
      if (!("word" in src)) continue;
      const key = `${r.id}\0${path}`;
      if (this.timers.has(key)) continue;
      const read = () => void this.read(r.id, path, src);
      read();
      const timer = setInterval(read, src.every_s * 1000);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }

  private async read(card: string, path: string, src: Extract<CardSource, { word: string }>): Promise<void> {
    const r = this.run(card);
    if (!r?.app || r.life !== "active") return;
    const reply = await this.d.router.send({ to: src.member, kind: "request", word: src.word, body: src.body ?? {} }, { member: `app:${r.app}`, via: "app", local: true });
    if (!reply.ok) { this.d.log(`card ${card} source ${path}: ${reply.error.code}`); return; }
    this.feed(card, path, src, reply.result?.data);
  }

  private onEvent(m: Message): void {
    for (const r of this.all()) {
      if (r.life !== "active" || !r.app) continue;
      for (const [path, src] of Object.entries(this.sourcesOf(r))) {
        if (!("event" in src)) continue;
        const [member, word] = [src.event.slice(0, src.event.indexOf("/")), src.event.slice(src.event.indexOf("/") + 1)];
        if (word !== m.word || !(member === m.from || (member.endsWith(":*") && m.from.startsWith(member.slice(0, -1))))) continue;
        const key = `${r.id}\0${path}`;
        const now = this.d.now();
        if (now - (this.lastEvent.get(key) ?? 0) < EVENT_GAP_MS) continue;
        this.lastEvent.set(key, now);
        this.feed(r.id, path, src, m.body);
      }
    }
  }

  /** A value came for [path]: picked, kept as a list when asked, the card drawn again and pushed (not recorded). */
  private feed(card: string, path: string, src: CardSource, value: unknown): void {
    const row = this.d.cards.get(card);
    const r = this.run(card);
    if (!row || !r || r.life === "closed") return;
    let v = src.pick ? pointer(value, src.pick) : value;
    if (v === undefined) return;
    if (src.keep) {
      const list = pointer(row.data, path);
      v = [...(Array.isArray(list) ? list : []), v].slice(-src.keep);
    }
    try { this.d.cards.update(row, { data: { [path]: v } }); } catch (error) { this.d.log(`card ${card} source ${path} not applied`, error); return; }
    r.fed_at = this.d.now();
    this.save(r);
    this.push(card);
  }

  // ---- buttons ---------------------------------------------------------------------------------------------------

  private async call(to: string, word: string, body: Record<string, unknown>): Promise<Reply> {
    try { return await this.d.router.send({ to, kind: "request", word, body }, SELF); } catch (error) { this.d.log(`${to}/${word}`, error); return { ok: false, error: { code: "internal", message: "failed" } }; }
  }

  private setAction(id: string, component: string, a: ActionState | null): void {
    const r = this.run(id);
    if (!r) return;
    if (a) r.actions[component] = a; else delete r.actions[component];
    this.save(r);
    this.push(id);
  }

  /** service:cards/act: press [component] of [card] with the values on the screen now. */
  async act(body: { card: string; component: string; data?: Record<string, unknown>; request?: Record<string, unknown> }): Promise<WordResult> {
    let row = this.d.cards.get(body.card);
    if (!row) throw new WordError("not_found", `no card ${body.card}`);
    let r = this.run(row.id);
    if (row.state !== "open" || r?.life === "closed") throw new WordError("conflict", "this card is closed: its buttons no longer do anything");
    if (body.data) { try { row = this.d.cards.draft(row, body.data); } catch (error) { throw error instanceof WordError ? error : new WordError("bad_request", "the card's values cannot be read"); } }
    const node = row.plan.components.find((c) => c.id === body.component);
    if (!node) throw new WordError("not_found", `the card has no component ${body.component}`);
    const action = node.component === "Html" && body.request ? requestAction(body.request) : node.action;
    if (!action) throw new WordError("bad_request", `${body.component} has no action`);
    const key = `${row.id}\0${body.component}`;
    if (this.running.has(key)) return { data: { state: "running", text: "处理中" } };
    if (r) { r.last_used = this.d.now(); const was = r.life; r.life = "active"; this.save(r); if (was === "dormant") await this.wakeApp(r); }
    this.running.add(key);
    this.setAction(row.id, body.component, { state: "running", text: "处理中…", at: this.d.now() });
    try {
      const out = await this.run_(row, r, action, node);
      this.setAction(row.id, body.component, { state: out.ok ? "ok" : "failed", text: out.text, at: this.d.now() });
      return { data: { state: out.ok ? "ok" : "failed", text: out.text, ...(out.result !== undefined ? { result: out.result } : {}) } };
    } finally { this.running.delete(key); }
  }

  private async run_(row: CardRow, r: Run | null, action: CardAction, node: WidgetComponent): Promise<{ ok: boolean; text: string; result?: unknown }> {
    const within = <T>(p: Promise<T>, s: number): Promise<T | "timeout"> => new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), s * 1000); t.unref?.();
      p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve("timeout"); });
    });
    const write = (path: string | undefined, value: unknown) => {
      if (!path) return;
      const now = this.d.cards.get(row.id);
      if (now) { try { this.d.cards.update(now, { data: { [path]: value } }); } catch (error) { this.d.log(`card ${row.id} result not written`, error); } }
    };
    if ("call" in action) {
      if (!r?.app) return { ok: false, text: "这张卡没有后端应用，按钮调不了中枢的能力。" };
      const c = action.call;
      const caller: Caller = { member: `app:${r.app}`, via: "app", local: true, card: row.id };
      const reply = await within(this.d.router.send({ to: c.member, kind: "request", word: c.word, body: c.body }, caller), c.timeout_s ?? CALL_TIMEOUT_S);
      if (reply === "timeout") return { ok: false, text: failure("timeout", "") };
      if (!reply.ok) return { ok: false, text: failure(reply.error.code, reply.error.message) };
      const data = reply.result?.data as { status?: unknown; pending_id?: unknown } | undefined;
      if (data?.status === "waiting_owner") {
        if (typeof data.pending_id === "string") void this.call("service:gate", "pending.withdraw", { id: data.pending_id });
        return { ok: false, text: failure("waiting", "") };
      }
      write(c.result, reply.result?.data ?? null);
      return { ok: true, text: `已完成 · ${clock(this.d.now())}`, result: reply.result?.data };
    }
    if ("ask" in action || "tell" in action) {
      const a = "ask" in action ? action.ask : action.tell;
      const agent = a.agent ?? (row.owner.startsWith("agent:") ? row.owner : null);
      if (!agent) return { ok: false, text: "不知道该问哪个帮手。" };
      const text = `[card ${row.id}, ${"ask" in action ? "ask" : "tell"} from ${node.id}] ${a.text}\n${JSON.stringify({ data: this.d.cards.get(row.id)?.data ?? {} })}`;
      if ("tell" in action) {
        const reply = await this.call(agent, "tell", { text });
        return reply.ok ? { ok: true, text: "已转告" } : { ok: false, text: failure(reply.error.code, reply.error.message) };
      }
      const reply = await within(this.call(agent, "ask", { text }), action.ask.timeout_s ?? ASK_TIMEOUT_S);
      if (reply === "timeout") return { ok: false, text: failure("timeout", "") };
      if (!reply.ok) return { ok: false, text: failure(reply.error.code, reply.error.message) };
      const answer = (reply.result?.data as { answer?: unknown } | undefined)?.answer;
      write(action.ask.result, typeof answer === "string" ? answer : "");
      return { ok: true, text: "已回答", result: answer };
    }
    return { ok: false, text: "这个按钮在手机上处理。" };
  }

  // ---- the member --------------------------------------------------------------------------------------------------

  private info(r: Run): Record<string, unknown> {
    const row = this.d.cards.get(r.id);
    return { id: r.id, message: row?.message ?? "", owner: row?.owner ?? "", ...(r.app ? { app: r.app } : {}), temporary_app: r.temporary && !r.kept, life: r.life,
      pinned: r.pinned, text: row?.text ?? "", sources: Object.keys(this.sourcesOf(r)), last_seen: r.last_seen, last_used: r.last_used,
      ...(r.expires_at !== null ? { expires_at: r.expires_at } : {}), updated_at: row?.updated_at ?? 0 };
  }
  private need(id: unknown): Run {
    const r = typeof id === "string" ? this.run(id) : null;
    if (!r) throw new WordError("not_found", `no card ${String(id)} in the registry`);
    return r;
  }

  readonly member: Member = {
    id: CARDS_ID, kind: "service", name: "Cards",
    words: (): WordContract[] => wordsOf(CARDS_ID),
    handle: async (msg: Message, _ctx: HandleContext): Promise<WordResult> => {
      const body = (msg.body ?? {}) as Record<string, any>;
      switch (msg.word) {
        case "list": {
          const life = body.life as Life | undefined;
          const rows = (this.d.db.prepare(`SELECT * FROM card_runtime WHERE ${life ? "life=?" : "life!='closed'"} ORDER BY max(last_seen,last_used) DESC LIMIT 200`).all(...(life ? [life] : [])) as Record<string, unknown>[]).map((x) => this.decode(x)!);
          return { data: { cards: rows.map((r) => this.info(r)), limits: this.limits() } };
        }
        case "describe": { const r = this.need(body.id); return { data: { card: this.info(r), actions: r.actions } }; }
        case "sleep": {
          const r = this.need(body.id);
          if (r.life !== "closed") { r.life = "dormant"; r.pinned = false; r.last_seen = 0; r.last_used = 0; this.save(r); this.reconcile(); this.push(r.id); }
          return { data: { life: this.run(r.id)!.life } };
        }
        case "wake": {
          const r = this.need(body.id);
          if (r.life !== "closed") { r.life = "active"; r.last_used = this.d.now(); this.save(r); await this.wakeApp(r); this.reconcile(); this.push(r.id); }
          return { data: { life: this.run(r.id)!.life } };
        }
        case "close": return { data: { closed: this.closeCard(String(body.id)) } };
        case "pin": { const r = this.need(body.id); r.pinned = body.pinned === true; r.last_used = this.d.now(); this.save(r); this.reconcile(); this.push(r.id); return { data: { pinned: r.pinned } }; }
        case "keep": { const r = this.need(body.id); r.kept = true; this.save(r); this.push(r.id); return { data: { kept: true, ...(r.app ? { app: r.app } : {}) } }; }
        case "act": return this.act(body as Parameters<CardRuntime["act"]>[0]);
        case "seen": return { data: { active: this.seen(Array.isArray(body.cards) ? body.cards.filter((x: unknown): x is string => typeof x === "string") : []) } };
        default: throw new WordError("not_found", `${CARDS_ID} has no word ${msg.word}`);
      }
    },
  };
}

/** What a mini app may ask of its card: a call, an ask or a tell, checked like a button's. */
function requestAction(request: Record<string, unknown>): CardAction | undefined {
  if (plain(request.call) && typeof request.call.member === "string" && typeof request.call.word === "string")
    return { call: { member: request.call.member, word: request.call.word, body: plain(request.call.body) ? request.call.body : {} } };
  if (plain(request.ask) && typeof request.ask.text === "string") return { ask: { text: request.ask.text } };
  if (plain(request.tell) && typeof request.tell.text === "string") return { tell: { text: request.tell.text } };
  return undefined;
}

