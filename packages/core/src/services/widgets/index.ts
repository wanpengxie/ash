/**
 * `service:widgets`: the cards on the owner's phone home screen (HUB-MODULES §3, SPEC-02 §4.1).
 *
 * Agents and apps put cards (A2UI, drawn natively by the hand); the owner places them with the 「Ash 卡片」 widget.
 *
 *   widget.list, widget.card.put / get / preview / validate / remove, widget.tap (owner)
 *   events in:  widget.placed, widget.bind (from the hands), widget.rendered (from the human edge: what the channel
 *               drew, with problems and preview pictures)
 *   events out: widget.state to person:owner whenever a card or a binding changes (the human edge pushes it to the
 *               channels that declared the `widget` surface); widget.action and widget.problem for the card's creator.
 *
 * `widget.list` returns the same whole state as `widget.state` carries, so a channel that just connected can fetch it.
 * The cards, bindings, placed widgets and the owner's feedback are tables in the ledger database. Preview pictures
 * are kept in memory only; the hand draws them again when asked.
 */
import {
  WordError, type Caller, type HandleContext, type Message, type WordResult,
} from "../../../../sdk/src/message";
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import type { Router } from "../../kernel/types";
import { CardError, cardActions, levels, setPointer, validateCard, type WidgetRender } from "./card";

export { validateCard } from "./card";
export const WIDGETS_ID = "service:widgets";
/** The event that carries the full widget state to the owner's channels. */
export const STATE_WORD = "widget.state";

const CARD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WIDGET_ID = /^[0-9]{1,12}$/;
const MAX_CARDS = 50;
const MAX_FEEDBACK_PER_CARD = 50;
const MAX_FEEDBACK_TEXT = 200;
const MAX_PREVIEW_B64 = 360_000;
const MAX_PREVIEW_SIDE = 1200;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");
const TOGGLES = new Set(["CheckBox", "Switch", "ChoicePicker"]);

export interface WidgetsOptions {
  ledger: Pick<Ledger, "db" | "tx">;
  router: Pick<Router, "send">;
  now?: () => number;
  /** How long `put` waits for the hand to say whether it drew the card (default 4 s) and for the preview picture (default 7 s). */
  drawWaitMs?: number;
  previewWaitMs?: number;
  log?: (message: string, error?: unknown) => void;
}

type Size = "2x2" | "4x2" | "4x4";
interface Card { id: string; title: string; size: Size; owner: string; updated_at: number; expires_at: number | null; render: WidgetRender; source: Record<string, any>; actions: string[]; phone_updated_at: number | null; phone_problem: string | null }
interface Preview { updated_at: number; at: number; ask: number; png?: string; width?: number; height?: number; theme?: string; dp?: { width: number; height: number }; problem?: string }
const plain = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const SELF: Caller = { member: WIDGETS_ID, via: "service", local: true };

export class WidgetsService implements Member {
  readonly id = WIDGETS_ID;
  readonly kind = "service" as const;
  readonly name = "Widgets";
  private readonly db;
  private revision = 0;
  private asks = 0;
  private readonly previews = new Map<string, Preview>();
  /** Cards whose preview the hand is asked to draw: the request number. */
  private readonly wanted = new Map<string, number>();
  private waiters = new Set<() => void>();

  constructor(private readonly options: WidgetsOptions) {
    this.db = options.ledger.db();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS widget_cards (id TEXT PRIMARY KEY, title TEXT NOT NULL, size TEXT NOT NULL, owner TEXT NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER, render TEXT NOT NULL, source TEXT NOT NULL, actions TEXT NOT NULL, phone_updated_at INTEGER, phone_problem TEXT);
      CREATE TABLE IF NOT EXISTS widget_placed (id TEXT PRIMARY KEY, type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS widget_bindings (widget TEXT PRIMARY KEY, card TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS widget_feedback (card TEXT NOT NULL, ts INTEGER NOT NULL, feedback TEXT NOT NULL, action TEXT NOT NULL, card_updated_at INTEGER NOT NULL, component TEXT, item TEXT);`);
  }

  words(): WordContract[] { return wordsOf(WIDGETS_ID); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private log(message: string, error?: unknown): void { (this.options.log ?? ((m, e) => console.error(`[widgets] ${m}${e ? `: ${(e as Error).message}` : ""}`)))(message, error); }

  /** Once at start: hand the saved cards to the channels. */
  start(): void { this.notify(); }

  // ---- storage ----
  private cardOf(row: Record<string, any>): Card {
    return { id: row.id, title: row.title, size: row.size, owner: row.owner, updated_at: row.updated_at, expires_at: row.expires_at, render: JSON.parse(row.render),
      source: JSON.parse(row.source), actions: JSON.parse(row.actions), phone_updated_at: row.phone_updated_at, phone_problem: row.phone_problem };
  }
  private cards(): Card[] { return (this.db.prepare("SELECT * FROM widget_cards ORDER BY rowid").all() as Record<string, any>[]).map((r) => this.cardOf(r)); }
  private card(id: unknown): Card | null {
    const row = this.db.prepare("SELECT * FROM widget_cards WHERE id=?").get(id as string) as Record<string, any> | undefined;
    return row ? this.cardOf(row) : null;
  }
  private bindings(): Record<string, string> {
    return Object.fromEntries((this.db.prepare("SELECT widget, card FROM widget_bindings").all() as { widget: string; card: string }[]).map((r) => [r.widget, r.card]));
  }
  private placedList(): { id: string; type: "ash" | "card" }[] { return this.db.prepare("SELECT id, type FROM widget_placed ORDER BY rowid").all() as { id: string; type: "ash" | "card" }[]; }
  private save(card: Card): void {
    this.db.prepare(`INSERT INTO widget_cards(id,title,size,owner,updated_at,expires_at,render,source,actions,phone_updated_at,phone_problem) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,size=excluded.size,owner=excluded.owner,updated_at=excluded.updated_at,expires_at=excluded.expires_at,
      render=excluded.render,source=excluded.source,actions=excluded.actions,phone_updated_at=excluded.phone_updated_at,phone_problem=excluded.phone_problem`)
      .run(card.id, card.title, card.size, card.owner, card.updated_at, card.expires_at, JSON.stringify(card.render), JSON.stringify(card.source), JSON.stringify(card.actions), card.phone_updated_at, card.phone_problem);
  }
  private drop(id: string): void {
    this.db.prepare("DELETE FROM widget_cards WHERE id=?").run(id);
    this.db.prepare("DELETE FROM widget_bindings WHERE card=?").run(id);
    this.db.prepare("DELETE FROM widget_feedback WHERE card=?").run(id);
    this.previews.delete(id); this.wanted.delete(id);
  }

  private info(card: Card) {
    const problem = card.phone_updated_at === card.updated_at ? card.phone_problem : null;
    return { id: card.id, title: card.title, size: card.size, owner: card.owner, updated_at: card.updated_at, expires_at: card.expires_at,
      expired: card.expires_at !== null && card.expires_at <= this.now(), actions: [...card.actions], problem };
  }

  // ---- telling the owner's channels ----
  /**
   * The whole state, the same object for `widget.state` and `widget.list`: the cards (as listed, plus the drawable form
   * `a2ui`), the placed widgets with the card each shows, the bindings, and the previews the hand is asked for.
   */
  state() {
    const bindings = this.bindings();
    const placed = new Map(this.placedList().map((p) => [p.id, p.type]));
    for (const key of Object.keys(bindings)) if (!placed.has(key)) placed.set(key, "card");
    const previews = Object.fromEntries([...this.wanted]);
    return { revision: this.revision, bindings, ...(Object.keys(previews).length ? { previews } : {}),
      cards: this.cards().map((c) => ({ ...this.info(c), a2ui: c.render })),
      widgets: [...placed].map(([id, type]) => ({ id, type, card: type === "card" ? bindings[id] ?? null : null })) };
  }
  private notify(): void {
    this.revision++;
    this.options.router.send({ to: OWNER_ID, kind: "event", word: STATE_WORD, body: this.state() }, SELF)
      .then((reply) => { if (!reply.ok) this.log(`${STATE_WORD}: ${reply.error.code}: ${reply.error.message}`); }, (error) => this.log(`${STATE_WORD} failed`, error));
  }
  private emit(to: string | null, word: string, body: unknown): void {
    this.options.router.send({ to, kind: "event", word, body }, SELF).then((r) => { if (!r.ok) this.log(`${word}: ${r.error.code}: ${r.error.message}`); }, (e) => this.log(`${word} failed`, e));
  }
  private tellAgent(agent: string, text: string): void {
    if (!isAgentId(agent)) return;
    this.options.router.send({ to: agent, kind: "request", word: "tell", body: { text } }, SELF).then((r) => { if (!r.ok) this.log(`tell ${agent}: ${r.error.code}`); }, (e) => this.log(`tell ${agent} failed`, e));
  }

  // ---- waiting for the hand's report ----
  private wake(): void { const all = [...this.waiters]; this.waiters.clear(); for (const w of all) w(); }
  private async until(ready: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!ready() && Date.now() < end) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.max(1, end - Date.now()));
        this.waiters.add(done);
      });
    }
  }

  // ---- words ----
  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, any>;
    if (msg.kind === "event") {
      if (msg.word === "widget.placed") this.placed(body.widgets);
      else if (msg.word === "widget.bind") this.bind(body.widget, body.card);
      else if (msg.word === "widget.rendered") { if (body.widgets !== undefined) this.placed(body.widgets); this.rendered(body.rendered); }
      return;
    }
    try {
      switch (msg.word) {
        case "widget.list": return { data: this.state() };
        case "widget.card.validate": return { data: this.validate(body.a2ui) };
        case "widget.card.put": return await this.put(msg.from, body);
        case "widget.card.get": return await this.get(body.id);
        case "widget.card.preview": return await this.previewWord(body.id);
        case "widget.card.remove": return { data: this.remove(msg.from, body.id) };
        case "widget.tap": return { data: this.tap(body) };
        default: throw new WordError("not_found", `service:widgets has no word ${msg.word}`);
      }
    } catch (error) {
      if (error instanceof CardError) throw new WordError("bad_request", error.message);
      throw error;
    }
  }

  private validate(a2ui: unknown) {
    try {
      const render = validateCard(a2ui);
      const byId = new Map(render.components.map((c) => [c.id, c]));
      const roots = [render.root, ...(render.sizes ?? []).map((s) => s.root)];
      return { valid: true, components: render.components.length, levels: Math.max(...roots.map((r) => levels(byId, r))), actions: cardActions(render) };
    } catch (error) {
      if (error instanceof CardError) return { valid: false, problem: error.message };
      throw error;
    }
  }

  private mayChange(card: Card, from: string): boolean { return card.owner === from || from === OWNER_ID || isAgentId(from); }

  private async put(from: string, body: Record<string, any>): Promise<WordResult> {
    const id = String(body.id);
    if (!CARD_ID.test(id)) throw new CardError("id must be lowercase letters, digits, . _ - (at most 64)");
    const title = String(body.title ?? "").trim();
    if (!title || title.length > 40) throw new CardError("title must be 1 to 40 characters");
    const render = validateCard(body.a2ui);
    const existing = this.card(id);
    if (existing && !this.mayChange(existing, from)) throw new WordError("forbidden", `card "${id}" belongs to ${existing.owner}; only it or the owner may change it`);
    if (!existing && this.cards().length >= MAX_CARDS) throw new CardError(`there are already ${MAX_CARDS} cards; remove one first`);
    // A replaced card is a new version even within the same millisecond, so the hand's answer matches this one.
    const now = Math.max(this.now(), (existing?.updated_at ?? 0) + 1);
    const card: Card = { id, title, size: body.size, owner: existing?.owner ?? from, updated_at: now, expires_at: typeof body.ttl_min === "number" ? now + body.ttl_min * 60_000 : null,
      render, source: structuredClone(body.a2ui), actions: cardActions(render), phone_updated_at: null, phone_problem: null };
    this.save(card);
    this.previews.delete(id);
    this.wanted.set(id, ++this.asks);
    this.notify();

    const answered = () => this.card(id)?.phone_updated_at === card.updated_at;
    await this.until(answered, this.options.drawWaitMs ?? 4000);
    const now2 = this.card(id);
    const phone = now2?.phone_updated_at === card.updated_at ? (now2.phone_problem ? { phone: "problem", problem: now2.phone_problem } : { phone: "drawn" }) : { phone: "unknown" };
    const preview = phone.phone === "unknown" ? {} : await this.previewOf(card, this.options.previewWaitMs ?? 7000);
    const { fresh: _fresh, ...shown } = preview;
    return this.withImage({ card: this.info(card), bound_widgets: Object.entries(this.bindings()).filter(([, c]) => c === id).map(([w]) => w), ...phone, ...shown });
  }

  private async get(id: unknown): Promise<WordResult> {
    const card = this.card(id);
    if (!card) throw new WordError("not_found", `no card "${String(id)}"; widget.list shows the cards`);
    const feedback = (this.db.prepare("SELECT ts, feedback, action, card_updated_at, component, item FROM widget_feedback WHERE card=? ORDER BY ts").all(card.id) as Record<string, any>[])
      .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)));
    const have = this.previews.get(card.id);
    const { fresh: _fresh, ...rest } = have && have.updated_at === card.updated_at && have.png ? await this.previewOf(card, 0) : await this.freshPreview(card);
    return this.withImage({ card: this.info(card), a2ui: card.source, feedback, ...rest });
  }

  private async previewWord(id: unknown): Promise<WordResult> {
    const card = this.card(id);
    if (!card) throw new WordError("not_found", `no card "${String(id)}"; widget.list shows the cards`);
    return this.withImage({ card: this.info(card), ...(await this.freshPreview(card)) });
  }

  /** The data as is, plus the picture as an image part for a model to look at. */
  private withImage(data: Record<string, any>): WordResult {
    const p = data.preview as { data: string; mimeType: string } | undefined;
    return p ? { data, content: [{ type: "text", text: JSON.stringify({ ...data, preview: undefined }) }, { type: "image", mime: p.mimeType, b64: p.data }] } : { data };
  }

  private remove(from: string, id: unknown) {
    const card = this.card(id);
    if (!card) return { removed: false };
    if (!this.mayChange(card, from)) throw new WordError("forbidden", `card "${card.id}" belongs to ${card.owner}; only it or the owner may remove it`);
    this.drop(card.id);
    this.notify();
    return { removed: true };
  }

  // ---- previews ----
  private async previewOf(card: Card, waitMs: number, minAsk = 0): Promise<Record<string, any>> {
    const have = () => { const r = this.previews.get(card.id); return !!r && r.updated_at === card.updated_at && r.ask >= minAsk; };
    await this.until(have, waitMs);
    const rec = this.previews.get(card.id);
    if (!rec || rec.updated_at !== card.updated_at) return { preview_problem: "the phone did not finish drawing the preview in time; widget.card.preview tries again" };
    const fresh = rec.ask >= minAsk;
    if (!rec.png) return { preview_problem: rec.problem ?? "the phone could not draw a preview", fresh };
    return { preview: { type: "image", data: rec.png, mimeType: "image/png", width: rec.width, height: rec.height, theme: rec.theme, size: card.size,
      ...(rec.dp ? { layout_dp: rec.dp } : {}), drawn_at: rec.at }, fresh };
  }

  private async freshPreview(card: Card): Promise<Record<string, any>> {
    const ask = ++this.asks;
    this.wanted.set(card.id, ask);
    this.notify();
    const got = await this.previewOf(card, this.options.previewWaitMs ?? 7000, ask);
    return { ...got, fresh: got.fresh ?? false, ...(got.fresh === false && got.preview ? { note: "the phone did not answer in time; this is the last preview it drew" } : {}) };
  }

  // ---- the owner taps ----
  private tap(body: Record<string, any>) {
    const card = this.card(body.card);
    if (!card) throw new WordError("not_found", "card no longer exists");
    const component = typeof body.component === "string" ? card.render.components.find((c) => c.id === body.component)
      : card.render.components.find((c) => c.action && "event" in c.action && c.action.event.name === body.action);
    if (!component) throw new WordError("not_found", "this card has no such element any more");
    const event = component.action && "event" in component.action ? component.action.event : undefined;
    const toggle = TOGGLES.has(component.component);
    if (!event && !toggle) throw new WordError("bad_request", "this element sends nothing back");
    const checked = typeof body.checked === "boolean" ? body.checked : undefined;
    const value = Array.isArray(body.value) && body.value.every((v: unknown) => typeof v === "string") ? body.value as string[] : undefined;
    if (toggle && component.component === "ChoicePicker" && !value) throw new WordError("bad_request", "a choice needs value: the selected option values");
    if (toggle && component.component !== "ChoicePicker" && checked === undefined) throw new WordError("bad_request", "a toggle needs checked: true or false");
    if (value && component.options && value.some((v) => !component.options!.some((o) => o.value === v))) throw new WordError("bad_request", "value has an option this choice does not offer");
    // Two-way binding: the owner's choice is written into the card's data, so the card keeps showing it.
    if (toggle && component.bind) {
      const source = structuredClone(card.source);
      if (!plain(source.data)) source.data = {};
      if (setPointer(source.data, component.bind, component.component === "ChoicePicker" ? value : checked)) {
        try {
          const render = validateCard(source);
          Object.assign(card, { source, render, actions: cardActions(render), updated_at: Math.max(this.now(), card.updated_at + 1) });
          this.save(card);
          this.previews.delete(card.id);
          this.notify();
        } catch { /* the card stays as it was; the event still goes to its creator */ }
      }
    }
    const name = event?.name ?? "change";
    const defId = component.id.replace(/[#@].*$/, "");
    const feedback = event?.context && typeof event.context.feedback === "string" && !card.owner.startsWith("app:")
      ? String(event.context.feedback).replace(/\s+/g, " ").trim().slice(0, MAX_FEEDBACK_TEXT) : "";
    const detail = { card: card.id, action: name, owner: card.owner, title: card.title, component: defId,
      ...(component.item !== undefined ? { item: component.item } : {}), ...(checked !== undefined && component.component !== "ChoicePicker" ? { checked } : {}),
      ...(value ? { value } : {}), ...(event?.context ? { context: event.context } : {}) };
    this.emit(null, "widget.action", detail);
    // A feedback button is the owner's answer to the card, not an instruction: kept with the card, wakes nobody.
    if (feedback) {
      this.options.ledger.tx(() => {
        this.db.prepare("INSERT INTO widget_feedback(card,ts,feedback,action,card_updated_at,component,item) VALUES(?,?,?,?,?,?,?)")
          .run(card.id, this.now(), feedback, name, card.updated_at, defId, component.item === undefined ? null : String(component.item));
        this.db.prepare("DELETE FROM widget_feedback WHERE card=? AND rowid NOT IN (SELECT rowid FROM widget_feedback WHERE card=? ORDER BY rowid DESC LIMIT ?)").run(card.id, card.id, MAX_FEEDBACK_PER_CARD);
      });
      return { accepted: true };
    }
    // An app hears the tap through the event (it listens); the creator agent hears it as a message in its own turn.
    if (event && isAgentId(card.owner)) {
      const what = [component.item !== undefined ? `item ${component.item}` : "", checked !== undefined ? `now ${checked ? "checked" : "unchecked"}` : "",
        value ? `selected ${JSON.stringify(value)}` : "", event.context ? `context ${JSON.stringify(event.context)}` : ""].filter(Boolean).join("; ");
      this.tellAgent(card.owner, `[widget.action] The owner tapped "${name}" on your home-screen card "${card.title}" (id ${card.id}${what ? `; ${what}` : ""}). Decide what it means; anything risky still goes through approval.`);
    }
    return { accepted: true };
  }

  // ---- reports from the hands and the human edge ----
  private placed(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const next = raw.filter((i): i is { id: string; type: "ash" | "card" } => plain(i) && typeof i.id === "string" && WIDGET_ID.test(i.id) && (i.type === "ash" || i.type === "card"));
    const same = JSON.stringify(next.map((i) => ({ id: i.id, type: i.type }))) === JSON.stringify(this.placedList());
    const ids = new Set(next.map((i) => i.id));
    const gone = Object.keys(this.bindings()).filter((w) => !ids.has(w));
    if (same && !gone.length) return;
    this.options.ledger.tx(() => {
      this.db.prepare("DELETE FROM widget_placed").run();
      for (const i of next) this.db.prepare("INSERT OR REPLACE INTO widget_placed(id,type) VALUES(?,?)").run(i.id, i.type);
      for (const w of gone) this.db.prepare("DELETE FROM widget_bindings WHERE widget=?").run(w);
    });
    this.notify();
  }

  private bind(widget: unknown, cardId: unknown): void {
    if (typeof widget !== "string" || !WIDGET_ID.test(widget) || !this.card(cardId)) return;
    this.options.ledger.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO widget_placed(id,type) VALUES(?,'card')").run(widget);
      this.db.prepare("INSERT OR REPLACE INTO widget_bindings(widget,card) VALUES(?,?)").run(widget, cardId as string);
    });
    this.notify();
  }

  private rendered(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    let previewed = 0;
    for (const item of raw.slice(0, 200)) {
      if (!plain(item) || typeof item.card !== "string" || typeof item.updated_at !== "number") continue;
      const card = this.card(item.card);
      if (!card || card.updated_at !== item.updated_at) continue;
      if ((item.preview !== undefined || item.preview_problem !== undefined) && previewed++ < 4) this.keepPreview(card, item);
      const problem = typeof item.problem === "string" && item.problem ? item.problem.slice(0, 1000) : null;
      if (card.phone_updated_at === card.updated_at && card.phone_problem === problem) continue;
      this.db.prepare("UPDATE widget_cards SET phone_updated_at=?, phone_problem=? WHERE id=?").run(card.updated_at, problem, card.id);
      if (problem) {
        this.emit(null, "widget.problem", { card: card.id, owner: card.owner, title: card.title, problem });
        this.tellAgent(card.owner, `[widget.problem] The phone could not fully draw your home-screen card "${card.title}" (id ${card.id}): ${problem}. Fix the card with widget.card.put (widget.card.validate checks it first).`);
      }
    }
    this.wake();
  }

  /** Keep the preview (or the honest reason for none) for this version of the card; an answer to an older request is ignored. */
  private keepPreview(card: Card, item: Record<string, any>): void {
    const ask = Number.isSafeInteger(item.preview_ask) ? item.preview_ask as number : 0;
    const old = this.previews.get(card.id);
    if (old && old.updated_at === card.updated_at && old.ask > ask) return;
    const image = plain(item.preview) ? this.checkedPreview(item.preview) : null;
    const problem = image ? undefined : typeof item.preview_problem === "string" && item.preview_problem ? item.preview_problem.slice(0, 500) : "the phone sent a preview that is not a valid image";
    this.previews.set(card.id, { updated_at: card.updated_at, at: this.now(), ask, ...(image ?? { problem }) });
    const wanted = this.wanted.get(card.id);
    if (wanted !== undefined && wanted <= ask) this.wanted.delete(card.id);
  }

  private checkedPreview(raw: Record<string, any>): Pick<Preview, "png" | "width" | "height" | "theme" | "dp"> | null {
    if (typeof raw.png !== "string" || raw.png.length > MAX_PREVIEW_B64) return null;
    const data = Buffer.from(raw.png.replace(/\s+/g, ""), "base64");
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_MAGIC)) return null;
    const side = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_PREVIEW_SIDE;
    if (!side(raw.width) || !side(raw.height) || (raw.theme !== "dark" && raw.theme !== "light")) return null;
    const dp = plain(raw.dp) && typeof raw.dp.width === "number" && typeof raw.dp.height === "number" ? { width: Math.round(raw.dp.width), height: Math.round(raw.dp.height) } : undefined;
    return { png: data.toString("base64"), width: raw.width, height: raw.height, theme: raw.theme, ...(dp ? { dp } : {}) };
  }
}

export function createWidgetsService(options: WidgetsOptions): WidgetsService { return new WidgetsService(options); }
