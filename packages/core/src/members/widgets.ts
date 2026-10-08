import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID, wordContract } from "../../../sdk/src/words";
import { CardError, cardActions, levels, setPointer, validateCard, type WidgetRender } from "./widgets-card";
import type { Member } from "../world/member";
import type { RouteHandlerContext, TrustedRouteContext, WorldRouter } from "../world/router";

const service: TrustedRouteContext = { member: "service:widgets", transport: "service", transportPrincipal: "service:widgets",
  local: true, remote: false, ownerProxy: false };

const CARD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WIDGET_ID = /^[0-9]{1,12}$/;
const MAX_CARDS = 50;
const KEEP_EXPIRED_MS = 7 * 86_400_000;
const SIZES = new Set(["2x2", "4x2", "4x4"]);
/** How long widget.card.put waits for the phone to say whether it could draw the card. */
const DRAW_WAIT_MS = 4000;
/** How long widget.card.put / widget.card.preview wait for the phone's preview image (it draws the card first, then lays it out). */
const PREVIEW_WAIT_MS = 7000;
/** A preview PNG is about 50-150 KB; the phone caps it at 200 KB, the core refuses anything over this (base64 characters). */
const MAX_PREVIEW_B64 = 360_000;
const MAX_PREVIEW_SIDE = 1200;
const PNG_MAGIC = Buffer.from("89504e470d0a1a0a", "hex");

export type { WidgetComponent, WidgetRender } from "./widgets-card";
export { validateCard } from "./widgets-card";
/** The older name, kept for callers of the first card format. */
export const validateA2ui = validateCard;

export interface WidgetCard {
  id: string; title: string; size: "2x2" | "4x2" | "4x4"; owner: string; updated_at: number; expires_at: number | null;
  render: WidgetRender; actions: string[];
  /** The card as put (bindings unresolved), so a toggle on the phone can write back into its data. */
  source?: Record<string, unknown>;
  /** What the phone said about drawing this version of the card. */
  phone?: { updated_at: number; problem?: string };
}
/** A card as widget.list reports it. */
export interface WidgetCardInfo {
  id: string; title: string; size: string; owner: string; updated_at: number; expires_at: number | null; expired: boolean; actions: string[]; problem: string | null;
}
export interface PlacedWidget { id: string; type: "ash" | "card" }
/** What the owner answered on a card's feedback button (an action whose event context carries feedback: "…"). */
export interface CardFeedback { ts: number; feedback: string; action: string; card_updated_at: number; component?: string; item?: string }
const MAX_FEEDBACK_PER_CARD = 50;
const MAX_FEEDBACK_TEXT = 200;
/** What the phone keeps and draws; pushed in full on every change. */
export interface WidgetState {
  revision: number;
  cards: { id: string; title: string; size: string; owner: string; updated_at: number; expires_at: number | null; a2ui: WidgetRender }[];
  bindings: Record<string, string>;
  /** Cards whose preview image the phone should draw, each with a request number the phone echoes back (absent for none). */
  previews?: Record<string, number>;
}
/** How the phone drew a card, as an image: a PNG of the card as the widget shows it. */
export interface WidgetPreview {
  updated_at: number; at: number; ask: number;
  /** The image, or why there is none. */
  png?: string; width?: number; height?: number; theme?: "dark" | "light"; dp?: { width: number; height: number }; problem?: string;
}

/** What a preview adds to a result: the image (an image part for the agent's tool result), or why there is none. */
interface PreviewFields { preview?: Record<string, unknown>; preview_problem?: string; fresh?: boolean }

const bad = (message: string): never => { throw new CardError(message); };
class Forbidden extends Error {}
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

interface Stored { version: 1; cards: WidgetCard[]; bindings: Record<string, string>; placed: PlacedWidget[]; feedback: Record<string, CardFeedback[]> }

/** widgets.json in ash's state directory, replaced atomically. */
class WidgetFile {
  constructor(private readonly file: string) {}
  load(): Stored {
    const empty: Stored = { version: 1, cards: [], bindings: {}, placed: [], feedback: {} };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
      const cards = Array.isArray(raw.cards) ? raw.cards.filter((card) => card && CARD_ID.test(card.id) && card.render && Array.isArray(card.render.components)) : [];
      const bindings = plain(raw.bindings) ? Object.fromEntries(Object.entries(raw.bindings).filter(([key, value]) => WIDGET_ID.test(key) && typeof value === "string")) as Record<string, string> : {};
      const placed = Array.isArray(raw.placed) ? raw.placed.filter((item) => item && WIDGET_ID.test(item.id) && (item.type === "ash" || item.type === "card")) : [];
      const ids = new Set(cards.map((card) => card.id));
      const feedback = plain(raw.feedback) ? Object.fromEntries(Object.entries(raw.feedback).filter(([key, list]) => ids.has(key) && Array.isArray(list))
        .map(([key, list]) => [key, (list as CardFeedback[]).filter((item) => plain(item) && typeof item.feedback === "string" && typeof item.ts === "number").slice(-MAX_FEEDBACK_PER_CARD)])) : {};
      return { version: 1, cards, bindings, placed, feedback };
    } catch { return empty; }
  }
  save(state: Stored): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

export interface WidgetsOptions {
  router: WorldRouter;
  file: string;
  /**
   * Hands the full state to the phone; the phone answers with the widgets placed on its home screen and, for each card
   * it tried to draw, whether it could ({card, updated_at, problem?}).
   */
  push?: (state: WidgetState) => Promise<{ widgets?: unknown; rendered?: unknown; previews?: unknown } | void>;
  now?: () => number;
  /** How long a result waits for the phone's preview image (default 7 s). */
  previewWaitMs?: number;
}

const TOGGLES = new Set(["CheckBox", "Switch", "ChoicePicker"]);

/**
 * service:widgets: cards for the phone's home screen. Agents and apps put cards (A2UI, drawn natively), the owner
 * places them with the "Ash 卡片" widget; a tap or toggle goes back to the card's creator as widget.action, and what the
 * phone could not draw goes back to it as widget.problem.
 */
export class WidgetsMember implements Member {
  readonly id = "service:widgets";
  readonly kind = "service" as const;
  readonly name = "Widgets";
  readonly online = true;
  private state: Stored;
  private readonly store: WidgetFile;
  private revision = 0;
  private queued = false;
  private sending: Promise<void> | null = null;
  private closed = false;
  /** The latest preview image per card (kept in memory only; the phone draws it again when asked). */
  private readonly previews = new Map<string, WidgetPreview>();
  /** Cards the phone is asked to draw a preview for: the request number that was last asked. */
  private readonly wanted = new Map<string, number>();
  private asks = 0;
  private get previewWait(): number { return this.options.previewWaitMs ?? PREVIEW_WAIT_MS; }
  /** True once the phone has said it can draw previews (older apps never do, so nothing waits for them). */
  private previewCapable = false;
  private previewWaiters = new Set<() => void>();
  private appTap: ((app: string, card: string, detail: Record<string, unknown>) => Promise<void>) | null = null;
  private placedListeners = new Set<() => void>();

  constructor(private readonly options: WidgetsOptions) {
    this.store = new WidgetFile(options.file);
    this.state = this.store.load();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  words(): readonly WordSpec[] {
    return ["widget.list", "widget.card.put", "widget.card.get", "widget.card.preview", "widget.card.validate", "widget.card.remove", "widget.bind", "widget.tap", "widget.placed"]
      .map((word) => wordContract("service:widgets", word)!);
  }

  /** Push once at startup so the phone draws what was saved. */
  start(): void { this.enqueue(); }

  private info(card: WidgetCard): WidgetCardInfo {
    const problem = card.phone && card.phone.updated_at === card.updated_at ? card.phone.problem ?? null : null;
    return { id: card.id, title: card.title, size: card.size, owner: card.owner, updated_at: card.updated_at, expires_at: card.expires_at,
      expired: card.expires_at !== null && card.expires_at <= this.now(), actions: [...card.actions], problem };
  }

  snapshot(): WidgetState {
    const previews = Object.fromEntries([...this.wanted].filter(([card]) => this.state.cards.some((c) => c.id === card)));
    return { revision: ++this.revision, bindings: { ...this.state.bindings }, ...(Object.keys(previews).length ? { previews } : {}),
      cards: this.state.cards.map((card) => ({ id: card.id, title: card.title, size: card.size, owner: card.owner, updated_at: card.updated_at,
        expires_at: card.expires_at, a2ui: structuredClone(card.render) })) };
  }

  private commit(): void {
    this.store.save(this.state);
    this.enqueue();
  }

  private mayChange(card: WidgetCard, from: string): boolean { return card.owner === from || from === "person:owner"; }

  async handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody> {
    try { return await this.dispatch(message); }
    catch (error) {
      if (error instanceof CardError) return { ok: false, error: { code: "bad_request", message: error.message } };
      if (error instanceof Forbidden) return { ok: false, error: { code: "forbidden", message: error.message } };
      throw error;
    }
  }

  private async dispatch(message: Message): Promise<ResponseBody> {
    const body = message.body;
    switch (message.word) {
    case "widget.list": {
      const placed = new Map(this.state.placed.map((item) => [item.id, item.type]));
      for (const key of Object.keys(this.state.bindings)) if (!placed.has(key)) placed.set(key, "card");
      return { ok: true, result: { cards: this.state.cards.map((card) => this.info(card)),
        widgets: [...placed].map(([widget, type]) => ({ id: widget, type, card: type === "card" ? this.state.bindings[widget] ?? null : null })) } };
    }
    case "widget.card.validate": {
      try {
        const render = validateCard(body.a2ui);
        const roots = [render.root, ...(render.sizes ?? []).map((size) => size.root)];
        const byId = new Map(render.components.map((c) => [c.id, c]));
        return { ok: true, result: { valid: true, components: render.components.length, levels: Math.max(...roots.map((root) => levels(byId, root))),
          actions: cardActions(render) } };
      } catch (error) {
        if (error instanceof CardError) return { ok: true, result: { valid: false, problem: error.message } };
        throw error;
      }
    }
    case "widget.card.put": {
      const card = this.put(message.from, body, { preview: true });
      const phone = await this.drawn(card);
      const { fresh: _fresh, ...preview } = phone.phone === "unknown" ? {} as PreviewFields : await this.previewOf(card, this.previewWait);
      return { ok: true, result: { card: this.info(card), bound_widgets: Object.entries(this.state.bindings).filter(([, value]) => value === card.id).map(([key]) => key),
        ...phone, ...preview } };
    }
    case "widget.card.get": {
      const card = this.state.cards.find((item) => item.id === body.id);
      if (!card) return { ok: false, error: { code: "not_found", message: `no card "${String(body.id)}"; widget.list shows the cards` } };
      return { ok: true, result: { card: this.info(card), a2ui: structuredClone(card.source ?? card.render), feedback: (this.state.feedback[card.id] ?? []).map((item) => ({ ...item })),
        ...(await this.latestPreview(card)) } };
    }
    case "widget.card.preview": {
      const card = this.state.cards.find((item) => item.id === body.id);
      if (!card) return { ok: false, error: { code: "not_found", message: `no card "${String(body.id)}"; widget.list shows the cards` } };
      return { ok: true, result: { card: this.info(card), ...(await this.freshPreview(card)) } };
    }
    case "widget.card.remove": {
      const cardId = String(body.id);
      const existing = this.state.cards.find((card) => card.id === cardId);
      if (!existing) return { ok: true, result: { removed: false } };
      if (!this.mayChange(existing, message.from)) return { ok: false, error: { code: "forbidden", message: `card "${cardId}" belongs to ${existing.owner}; only it or the owner may remove it` } };
      this.state.cards = this.state.cards.filter((card) => card.id !== cardId);
      this.state.bindings = Object.fromEntries(Object.entries(this.state.bindings).filter(([, value]) => value !== cardId));
      delete this.state.feedback[cardId];
      this.previews.delete(cardId); this.wanted.delete(cardId);
      this.commit();
      return { ok: true, result: { removed: true } };
    }
    case "widget.bind": {
      const widget = String(body.widget); const cardId = String(body.card);
      if (!WIDGET_ID.test(widget)) bad("widget must be a widget id from widget.list");
      if (!this.state.cards.some((card) => card.id === cardId)) return { ok: false, error: { code: "not_found", message: `no card "${cardId}"; widget.list shows the cards` } };
      const placed = this.state.placed.find((item) => item.id === widget);
      // The owner binds while placing the widget, possibly before the phone has reported it; others need a known card widget.
      if (message.from !== "person:owner" && placed?.type !== "card") return { ok: false, error: { code: "not_found", message: `no "Ash 卡片" widget ${widget} on the home screen; widget.list shows them` } };
      if (!placed) this.state.placed = [...this.state.placed, { id: widget, type: "card" }];
      this.state.bindings = { ...this.state.bindings, [widget]: cardId };
      this.commit();
      if (!placed) this.placedChanged();
      return { ok: true, result: { widget, card: cardId } };
    }
    case "widget.placed": {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "only the owner's phone reports placed widgets" } };
      if (body.widgets !== undefined) this.placed(body.widgets);
      if (body.rendered !== undefined) await this.rendered(body.rendered);
      return { ok: true, result: { accepted: true } };
    }
    case "widget.tap": {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "only the owner taps a widget" } };
      return await this.tap(body);
    }
    }
    return { ok: false, error: { code: "not_found", message: "widget word unavailable" } };
  }

  /** Create or replace a card for [from]; throws a CardError (or Forbidden) saying why not. Unchanged cards are left alone. */
  private put(from: string, body: Record<string, unknown>, options: { keepUnchanged?: boolean; preview?: boolean } = {}): WidgetCard {
    const cardId = String(body.id);
    if (!CARD_ID.test(cardId)) bad("id must be lowercase letters, digits, . _ - (at most 64)");
    const title = String(body.title ?? "").trim();
    if (!title || title.length > 40) bad("title must be 1 to 40 characters");
    if (!SIZES.has(String(body.size))) bad("size must be 2x2, 4x2 or 4x4");
    const render = validateCard(body.a2ui);
    const existing = this.state.cards.find((card) => card.id === cardId);
    if (existing && !this.mayChange(existing, from)) throw new Forbidden(`card "${cardId}" belongs to ${existing.owner}; only it or the owner may change it`);
    if (!existing && this.state.cards.length >= MAX_CARDS) this.purge();
    if (!existing && this.state.cards.length >= MAX_CARDS) bad(`there are already ${MAX_CARDS} cards; remove one first`);
    const ttl = body.ttl_min;
    // An app's card is redrawn often with the same content: nothing to send then.
    if (existing && options.keepUnchanged && ttl === undefined && existing.expires_at === null && existing.title === title && existing.size === body.size &&
      JSON.stringify(existing.source) === JSON.stringify(body.a2ui)) return existing;
    // A replaced card is a new version even within the same millisecond, so the phone's answer matches this one.
    const now = Math.max(this.now(), (existing?.updated_at ?? 0) + 1);
    const card: WidgetCard = { id: cardId, title, size: body.size as WidgetCard["size"], owner: existing?.owner ?? from, updated_at: now,
      expires_at: typeof ttl === "number" ? now + ttl * 60_000 : null, render, actions: cardActions(render),
      source: structuredClone(body.a2ui as Record<string, unknown>) };
    this.state.cards = existing ? this.state.cards.map((item) => item.id === cardId ? card : item) : [...this.state.cards, card];
    this.previews.delete(cardId);
    if (options.preview) this.wanted.set(cardId, ++this.asks);
    this.commit();
    return card;
  }

  /**
   * An app's own card (owner app:<id>), drawn from the app's data by ash's app runtime: created or replaced, never
   * waiting for the phone. A problem (an invalid card, an id another member already uses) comes back as text.
   */
  putAppCard(app: string, card: { id: string; title: string; size: string }, a2ui: unknown): { ok: true; changed: boolean } | { ok: false; problem: string } {
    try {
      const before = this.state.cards.find((item) => item.id === card.id)?.updated_at;
      const put = this.put(`app:${app}`, { id: card.id, title: card.title, size: card.size, a2ui }, { keepUnchanged: true });
      return { ok: true, changed: put.updated_at !== before };
    } catch (error) {
      if (error instanceof CardError || error instanceof Forbidden) return { ok: false, problem: error.message };
      throw error;
    }
  }

  /** Remove app <app>'s cards except [keep] (cards it no longer declares, or all when it is gone). */
  removeAppCards(app: string, keep: readonly string[] = []): void {
    const owner = `app:${app}`;
    const gone = new Set(this.state.cards.filter((card) => card.owner === owner && !keep.includes(card.id)).map((card) => card.id));
    if (!gone.size) return;
    for (const id of gone) { this.previews.delete(id); this.wanted.delete(id); }
    this.state.cards = this.state.cards.filter((card) => !gone.has(card.id));
    this.state.bindings = Object.fromEntries(Object.entries(this.state.bindings).filter(([, value]) => !gone.has(value)));
    this.commit();
  }

  /** One card as widget.list shows it, or null. */
  cardInfo(id: string): WidgetCardInfo | null {
    const card = this.state.cards.find((item) => item.id === id);
    return card ? this.info(card) : null;
  }

  /** Where a tap on an app's card goes: the app itself (its declared action tool), set by ash's app runtime. */
  setAppTap(handler: ((app: string, card: string, detail: Record<string, unknown>) => Promise<void>) | null): void { this.appTap = handler; }

  /** Wait briefly for the phone's answer to this version of the card: drawn, or why not. */
  private async drawn(card: WidgetCard): Promise<{ phone: "drawn" | "problem" | "unknown"; problem?: string }> {
    if (!this.options.push) return { phone: "unknown" };
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.settled(), new Promise<void>((resolve) => { timer = setTimeout(resolve, DRAW_WAIT_MS); timer.unref?.(); })]);
    clearTimeout(timer);
    const current = this.state.cards.find((item) => item.id === card.id);
    const phone = current?.phone;
    if (!phone || phone.updated_at !== card.updated_at) return { phone: "unknown" };
    return phone.problem ? { phone: "problem", problem: phone.problem } : { phone: "drawn" };
  }

  /** Wake whoever waits for a preview to arrive. */
  private previewArrived(): void { const waiters = [...this.previewWaiters]; this.previewWaiters.clear(); for (const wake of waiters) wake(); }

  /** Wait until [ready] holds (re-checked whenever a preview arrives) or [ms] pass. */
  private async waitPreview(ready: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!ready() && Date.now() < end) {
      await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); this.previewWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, Math.max(1, end - Date.now()));
        timer.unref?.();
        this.previewWaiters.add(wake);
      });
    }
  }

  /** The preview of this version of [card] as result fields: an image part, or why there is none. {} when the phone cannot draw previews. */
  private async previewOf(card: WidgetCard, waitMs: number, minAsk = 0): Promise<PreviewFields> {
    if (!this.options.push) return {};
    await this.settled();
    const have = () => { const rec = this.previews.get(card.id); return !!rec && rec.updated_at === card.updated_at && rec.ask >= minAsk; };
    if (!this.previewCapable) { this.wanted.delete(card.id); return {}; }
    await this.waitPreview(have, waitMs);
    const rec = this.previews.get(card.id);
    if (!rec || rec.updated_at !== card.updated_at) return { preview_problem: "the phone did not finish drawing the preview in time; widget.card.preview tries again" };
    const fresh = rec.ask >= minAsk;
    if (!rec.png) return { preview_problem: rec.problem ?? "the phone could not draw a preview", fresh };
    return { preview: { type: "image", data: rec.png, mimeType: "image/png", width: rec.width, height: rec.height, theme: rec.theme, size: card.size,
      ...(rec.dp ? { layout_dp: rec.dp } : {}), drawn_at: rec.at }, fresh };
  }

  /** widget.card.preview: ask the phone to draw the card again (the owner may have changed theme, an app card may have refreshed), else the last one. */
  private async freshPreview(card: WidgetCard): Promise<Record<string, unknown>> {
    if (!this.options.push) return { preview_problem: "no phone is connected to draw a preview", fresh: false };
    const ask = ++this.asks;
    this.wanted.set(card.id, ask);
    this.enqueue();
    const got = await this.previewOf(card, this.previewWait, ask);
    if (!this.previewCapable) return { preview_problem: "this phone app cannot draw card previews yet; update the Ash app", fresh: false };
    // Without a fresh answer, the last picture of this version (if any) is returned and marked as such.
    return { ...got, fresh: got.fresh ?? false, ...(got.fresh === false && got.preview ? { note: "the phone did not answer in time; this is the last preview it drew" } : {}) };
  }

  /** The preview of the card's current version: the one the phone already drew, else the phone is asked (same image as widget.card.preview). */
  private async latestPreview(card: WidgetCard): Promise<Record<string, unknown>> {
    const have = this.previews.get(card.id);
    const { fresh: _fresh, ...rest } = have && have.updated_at === card.updated_at && have.png ? await this.previewOf(card, 0) : await this.freshPreview(card);
    return rest;
  }

  /** "Ash 卡片" widgets on the home screen, including ones only known by the card they show. */
  placedCardWidgets(): string[] {
    const ids = new Set(this.state.placed.filter((item) => item.type === "card").map((item) => item.id));
    for (const key of Object.keys(this.state.bindings)) if (!this.state.placed.some((item) => item.id === key)) ids.add(key);
    return [...ids];
  }

  /** Called whenever the set of placed widgets changes (the phone's report, or the owner placing a widget with a card). */
  onPlaced(listener: () => void): () => void {
    this.placedListeners.add(listener);
    return () => { this.placedListeners.delete(listener); };
  }
  private placedChanged(): void { for (const listener of [...this.placedListeners]) { try { listener(); } catch { /* a listener cannot undo the report */ } } }

  /** A tap, a toggle or a choice on a placed card, from the owner's phone. */
  private async tap(body: Record<string, unknown>): Promise<ResponseBody> {
    const card = this.state.cards.find((item) => item.id === body.card);
    if (!card) return { ok: false, error: { code: "not_found", message: "card no longer exists" } };
    const componentId = typeof body.component === "string" ? body.component : undefined;
    // Phones before the full card format sent only the event name.
    const component = componentId !== undefined ? card.render.components.find((c) => c.id === componentId)
      : card.render.components.find((c) => c.action && "event" in c.action && c.action.event.name === body.action);
    if (!component) return { ok: false, error: { code: "not_found", message: "this card has no such element any more" } };
    const event = component.action && "event" in component.action ? component.action.event : undefined;
    const toggle = TOGGLES.has(component.component);
    if (!event && !toggle) return { ok: false, error: { code: "bad_request", message: "this element sends nothing back" } };
    const checked = typeof body.checked === "boolean" ? body.checked : undefined;
    const value = Array.isArray(body.value) && body.value.every((v) => typeof v === "string") ? body.value as string[] : undefined;
    if (toggle && component.component === "ChoicePicker" && !value) bad("a choice needs value: the selected option values");
    if (toggle && component.component !== "ChoicePicker" && checked === undefined) bad("a toggle needs checked: true or false");
    if (value && component.options) {
      const known = new Set(component.options.map((o) => o.value));
      if (value.some((v) => !known.has(v))) bad("value has an option this choice does not offer");
    }
    // Two-way binding: the owner's choice is written into the card's data, so the card keeps showing it.
    if (toggle && component.bind && card.source) {
      const source = structuredClone(card.source);
      if (!plain(source.data)) source.data = {};
      if (setPointer(source.data as Record<string, unknown>, component.bind, component.component === "ChoicePicker" ? value : checked)) {
        try {
          const render = validateCard(source);
          card.source = source; card.render = render; card.actions = cardActions(render);
          card.updated_at = Math.max(this.now(), card.updated_at + 1);
          this.previews.delete(card.id);
          this.commit();
        } catch { /* the card stays as it was; the event still goes to its creator */ }
      }
    }
    const name = event?.name ?? "change";
    const defId = component.id.replace(/[#@].*$/, "");
    const feedback = event?.context && typeof (event.context as Record<string, unknown>).feedback === "string" && !/^app:/.test(card.owner)
      ? String((event.context as Record<string, unknown>).feedback).replace(/\s+/g, " ").trim().slice(0, MAX_FEEDBACK_TEXT) : "";
    const detail = { card: card.id, action: name, owner: card.owner, title: card.title, component: defId,
      ...(component.item !== undefined ? { item: component.item } : {}), ...(checked !== undefined && component.component !== "ChoicePicker" ? { checked } : {}),
      ...(value ? { value } : {}), ...(event?.context ? { context: event.context } : {}) };
    await this.options.router.send(service, { to: null, kind: "event", word: "widget.action", body: detail });
    // A feedback button is the owner's answer to the card, not an instruction: it is kept with the card (and heard by the
    // pulse history through the widget.action event above) and wakes nobody.
    if (feedback) {
      const list = [...(this.state.feedback[card.id] ?? []), { ts: this.now(), feedback, action: name, card_updated_at: card.updated_at, component: defId,
        ...(component.item !== undefined ? { item: String(component.item) } : {}) }];
      this.state.feedback[card.id] = list.slice(-MAX_FEEDBACK_PER_CARD);
      this.store.save(this.state);
      return { ok: true, result: { accepted: true } };
    }
    // An app's card: the tap goes to the app itself, which changes its data and draws the card again.
    if (/^app:/.test(card.owner) && this.appTap) {
      try { await this.appTap(card.owner.slice(4), card.id, detail); } catch { /* the app runtime reports its own failures */ }
      return { ok: true, result: { accepted: true } };
    }
    // The creator decides what a tap means: an agent hears it as a message in its own turn.
    if (event && AGENT_ID.test(card.owner)) {
      const what = [component.item !== undefined ? `item ${component.item}` : "", checked !== undefined ? `now ${checked ? "checked" : "unchecked"}` : "",
        value ? `selected ${JSON.stringify(value)}` : "", event.context ? `context ${JSON.stringify(event.context)}` : ""].filter(Boolean).join("; ");
      try {
        await this.options.router.send(service, { to: card.owner, kind: "request", word: "say",
          body: { text: `[widget.action] The owner tapped "${name}" on your home-screen card "${card.title}" (id ${card.id}${what ? `; ${what}` : ""}). Decide what it means; anything risky still goes through approval.` } });
      } catch { /* the event is on the ledger either way */ }
    }
    return { ok: true, result: { accepted: true } };
  }

  /** One preview from the phone's report, checked: a real PNG of a sane size, or null. */
  private previewOfReport(raw: Record<string, unknown>): Omit<WidgetPreview, "updated_at" | "at" | "ask"> | null {
    if (typeof raw.png !== "string" || raw.png.length > MAX_PREVIEW_B64) return null;
    const data = Buffer.from(raw.png.replace(/\s+/g, ""), "base64");
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_MAGIC)) return null;
    const side = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PREVIEW_SIDE;
    if (!side(raw.width) || !side(raw.height) || (raw.theme !== "dark" && raw.theme !== "light")) return null;
    const dp = plain(raw.dp) && typeof raw.dp.width === "number" && typeof raw.dp.height === "number" ? { width: Math.round(raw.dp.width), height: Math.round(raw.dp.height) } : undefined;
    return { png: data.toString("base64"), width: raw.width as number, height: raw.height as number, theme: raw.theme, ...(dp ? { dp } : {}) };
  }

  /** The phone's word on drawing each card: kept per card version, and a new problem goes to the card's creator. */
  private async rendered(raw: unknown): Promise<void> {
    if (!Array.isArray(raw)) return;
    let changed = false;
    let previewed = 0;
    const tell: { card: WidgetCard; problem: string }[] = [];
    for (const item of raw.slice(0, 200)) {
      if (!plain(item) || typeof item.card !== "string" || typeof item.updated_at !== "number") continue;
      const card = this.state.cards.find((c) => c.id === item.card);
      if (!card || card.updated_at !== item.updated_at) continue;
      if ((item.preview !== undefined || item.preview_problem !== undefined) && previewed++ < 4) this.keepPreview(card, item);
      const problem = typeof item.problem === "string" && item.problem ? item.problem.slice(0, 1000) : undefined;
      if (card.phone?.updated_at === card.updated_at && card.phone.problem === problem) continue;
      card.phone = { updated_at: card.updated_at, ...(problem ? { problem } : {}) };
      changed = true;
      if (problem) tell.push({ card, problem });
    }
    if (changed) this.store.save(this.state);
    for (const { card, problem } of tell) {
      await this.options.router.send(service, { to: null, kind: "event", word: "widget.problem", body: { card: card.id, owner: card.owner, title: card.title, problem } });
      if (AGENT_ID.test(card.owner)) {
        try {
          await this.options.router.send(service, { to: card.owner, kind: "request", word: "say",
            body: { text: `[widget.problem] The phone could not fully draw your home-screen card "${card.title}" (id ${card.id}): ${problem}. Fix the card with widget.card.put (widget.card.validate checks it first).` } });
        } catch { /* on the ledger either way */ }
      }
    }
  }

  /** Keep the preview (or the honest reason for none) the phone sent for this version of [card]; an answer to an older request is ignored. */
  private keepPreview(card: WidgetCard, item: Record<string, unknown>): void {
    const ask = typeof item.preview_ask === "number" && Number.isSafeInteger(item.preview_ask) ? item.preview_ask : 0;
    const old = this.previews.get(card.id);
    if (old && old.updated_at === card.updated_at && old.ask > ask) return;
    const image = plain(item.preview) ? this.previewOfReport(item.preview) : null;
    const problem = image ? undefined : typeof item.preview_problem === "string" && item.preview_problem ? item.preview_problem.slice(0, 500)
      : "the phone sent a preview that is not a valid image";
    this.previews.set(card.id, { updated_at: card.updated_at, at: this.now(), ask, ...(image ?? { problem }) });
    const wanted = this.wanted.get(card.id);
    if (wanted !== undefined && wanted <= ask) this.wanted.delete(card.id);
    this.previewArrived();
  }

  private placed(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const next = raw.filter((item): item is PlacedWidget => plain(item) && typeof item.id === "string" && WIDGET_ID.test(item.id) && (item.type === "ash" || item.type === "card"))
      .map((item) => ({ id: item.id, type: item.type }));
    const ids = new Set(next.map((item) => item.id));
    const bindings = Object.fromEntries(Object.entries(this.state.bindings).filter(([key]) => ids.has(key)));
    const changed = JSON.stringify(next) !== JSON.stringify(this.state.placed) || Object.keys(bindings).length !== Object.keys(this.state.bindings).length;
    if (!changed) return;
    this.state.placed = next; this.state.bindings = bindings;
    this.store.save(this.state);
    this.placedChanged();
  }

  /** Long-expired cards that no widget shows go first when space runs out. */
  private purge(): void {
    const now = this.now();
    const bound = new Set(Object.values(this.state.bindings));
    this.state.cards = this.state.cards.filter((card) => bound.has(card.id) || card.expires_at === null || card.expires_at + KEEP_EXPIRED_MS > now);
  }

  private enqueue(): void {
    const push = this.options.push;
    if (!push || this.closed) return;
    this.queued = true;
    if (this.sending) return;
    this.sending = (async () => {
      while (this.queued && !this.closed) {
        this.queued = false;
        try {
          const answer = await push(this.snapshot());
          if (answer && Array.isArray(answer.widgets)) this.placed(answer.widgets);
          if (answer && answer.previews === true) this.previewCapable = true;
          if (answer && answer.rendered !== undefined) await this.rendered(answer.rendered);
        } catch { /* the phone may be starting; the next change or startup pushes again */ }
      }
    })().finally(() => { this.sending = null; if (this.queued && !this.closed) this.enqueue(); });
  }

  async settled(): Promise<void> { while (this.sending) await this.sending; }
  close(): void { this.closed = true; }
}
