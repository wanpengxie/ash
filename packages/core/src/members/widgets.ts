import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { AGENT_ID, wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { RouteHandlerContext, TrustedRouteContext, WorldRouter } from "../world/router";

const service: TrustedRouteContext = { member: "service:widgets", transport: "service", transportPrincipal: "service:widgets",
  local: true, remote: false, ownerProxy: false };

export const WIDGET_ICONS = ["sun", "cloud", "rain", "snow", "wind", "moon", "heart", "steps", "weight", "sleep", "water", "fire",
  "calendar", "clock", "check", "alert", "star", "bell", "mail", "home", "car", "money", "chart"] as const;
const ICONS = new Set<string>(WIDGET_ICONS);
const CARD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WIDGET_ID = /^[0-9]{1,12}$/;
const COMPONENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ACTION = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_JSON = 8 * 1024;
const MAX_COMPONENTS = 40;
const MAX_LEVELS = 3;
const MAX_BUTTONS = 2;
const MAX_TEXT = 300;
const MAX_CARDS = 50;
const KEEP_EXPIRED_MS = 7 * 86_400_000;
const SIZES = new Set(["2x2", "4x2", "4x4"]);

/** One component as the phone draws it: literal values only, data bindings already resolved. */
export interface WidgetComponent {
  id: string; component: string; children?: string[]; align?: string; justify?: string; text?: string; variant?: string;
  url?: string; child?: string; action?: { event: { name: string } }; axis?: string; value?: number; label?: string;
}
export interface WidgetRender { root: string; components: WidgetComponent[] }
export interface WidgetCard {
  id: string; title: string; size: "2x2" | "4x2" | "4x4"; owner: string; updated_at: number; expires_at: number | null;
  render: WidgetRender; actions: string[];
}
export interface PlacedWidget { id: string; type: "ash" | "card" }
/** What the phone keeps and draws; pushed in full on every change. */
export interface WidgetState {
  revision: number;
  cards: { id: string; title: string; size: string; owner: string; updated_at: number; expires_at: number | null; a2ui: WidgetRender }[];
  bindings: Record<string, string>;
}

const FIELDS: Record<string, readonly string[]> = {
  Column: ["children", "align", "justify"],
  Row: ["children", "align", "justify"],
  Text: ["text", "variant"],
  Image: ["url", "fit", "variant"],
  Button: ["child", "action", "variant"],
  Divider: ["axis"],
  ProgressBar: ["value", "label"],
  Badge: ["text"],
};
const TEXT_VARIANTS = new Set(["h1", "h2", "h3", "h4", "h5", "body", "caption"]);

class CardError extends Error {}
const bad = (message: string): never => { throw new CardError(message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function pointer(data: unknown, path: string): unknown {
  if (path === "" || path === "/") return data;
  if (!path.startsWith("/")) return undefined;
  let at = data;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (plain(at) && Object.hasOwn(at, key)) at = at[key];
    else return undefined;
  }
  return at;
}

/**
 * Check a card's A2UI v0.9 component list against the subset the phone can draw and resolve its data bindings.
 * Throws a message an agent can act on; never accepts an unknown component, field, icon or deeper tree.
 */
export function validateA2ui(raw: unknown): WidgetRender {
  if (!plain(raw)) bad("a2ui must be an object {components:[...], root?, data?}");
  const a2ui = raw as Record<string, unknown>;
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(a2ui), "utf8"); } catch { bad("a2ui is not plain JSON"); }
  if (size > MAX_JSON) bad(`a2ui is ${size} bytes; at most ${MAX_JSON} bytes are allowed`);
  for (const key of Object.keys(a2ui)) if (!["components", "root", "data"].includes(key)) bad(`a2ui has unsupported field "${key}" (allowed: components, root, data)`);
  const data = a2ui.data ?? {};
  if (!plain(data)) bad("a2ui.data must be an object");
  const list = a2ui.components;
  if (!Array.isArray(list) || list.length === 0) bad("a2ui.components must be a non-empty array of components");
  const components = list as unknown[];
  if (components.length > MAX_COMPONENTS) bad(`a2ui has ${components.length} components; at most ${MAX_COMPONENTS} are allowed`);
  const root = a2ui.root ?? "root";
  if (typeof root !== "string" || !COMPONENT_ID.test(root)) bad("a2ui.root must be a component id");
  const byId = new Map<string, Record<string, unknown>>();
  for (const [index, item] of components.entries()) {
    if (!plain(item)) bad(`components[${index}] must be an object`);
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !COMPONENT_ID.test(c.id)) bad(`components[${index}] needs an id (letters, digits, _ . -; at most 64)`);
    const cid = c.id as string;
    if (byId.has(cid)) bad(`component id "${cid}" is used twice`);
    if (typeof c.component !== "string") bad(`component "${cid}" needs a component type`);
    const allowed = FIELDS[c.component as string];
    if (!allowed) bad(`component "${cid}" has unsupported type "${String(c.component)}"; allowed: ${Object.keys(FIELDS).join(", ")}`);
    for (const key of Object.keys(c)) if (key !== "id" && key !== "component" && key !== "weight" && !allowed.includes(key))
      bad(`${c.component} "${cid}" has unsupported field "${key}" (allowed: ${allowed.join(", ")})`);
    byId.set(cid, c);
  }
  if (!byId.has(root as string)) bad(`root component "${String(root)}" is missing`);
  const text = (value: unknown, where: string, max = MAX_TEXT): string => {
    let resolved = value;
    if (plain(value)) {
      if (Object.keys(value).length !== 1 || typeof value.path !== "string") bad(`${where} must be a string or {path}`);
      resolved = pointer(data, value.path as string);
      if (resolved === undefined) bad(`${where} reads ${String(value.path)}, which is not in data`);
    }
    if (typeof resolved === "number" && Number.isFinite(resolved)) resolved = String(resolved);
    if (typeof resolved !== "string") bad(`${where} must be text`);
    const out = (resolved as string).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => ch === "\n" ? "\n" : " ");
    if (out.length > max) bad(`${where} is ${out.length} characters; at most ${max} are allowed`);
    return out;
  };
  const out: WidgetComponent[] = [];
  const seen = new Set<string>();
  let buttons = 0;
  const labels = new Set<string>();
  for (const c of byId.values()) if (c.component === "Button") {
    if (typeof c.child !== "string" || byId.get(c.child)?.component !== "Text") bad(`Button "${String(c.id)}" needs child: the id of a Text used as its label`);
    labels.add(c.child as string);
  }
  const visit = (cid: string, levels: number, path: string[]): void => {
    if (path.includes(cid)) bad(`component "${cid}" contains itself`);
    if (seen.has(cid)) bad(`component "${cid}" is used in more than one place`);
    const c = byId.get(cid);
    if (!c) bad(`component "${path[path.length - 1]}" refers to missing component "${cid}"`);
    seen.add(cid);
    const node = c as Record<string, unknown>;
    const kind = node.component as string;
    const result: WidgetComponent = { id: cid, component: kind };
    if (kind === "Column" || kind === "Row") {
      if (levels + 1 > MAX_LEVELS) bad(`Column/Row "${cid}" is nested ${levels + 1} levels deep; at most ${MAX_LEVELS} are allowed`);
      if (!Array.isArray(node.children) || node.children.some((child) => typeof child !== "string")) bad(`${kind} "${cid}" needs children: an array of component ids`);
      const children = node.children as string[];
      if (node.align !== undefined && !["start", "center", "end", "stretch"].includes(String(node.align))) bad(`${kind} "${cid}" align must be start, center, end or stretch`);
      if (node.justify !== undefined && !["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"].includes(String(node.justify))) bad(`${kind} "${cid}" has unsupported justify`);
      out.push({ ...result, children: [...children], ...(node.align ? { align: String(node.align) } : {}), ...(node.justify ? { justify: String(node.justify) } : {}) });
      for (const child of children) {
        if (labels.has(child)) bad(`Text "${child}" is a button label and cannot also be a child of ${kind} "${cid}"`);
        visit(child, levels + 1, [...path, cid]);
      }
      return;
    }
    if (kind === "Text") {
      const variant = node.variant === undefined ? "body" : String(node.variant);
      if (!TEXT_VARIANTS.has(variant)) bad(`Text "${cid}" variant must be one of h1 (big number), h2, h3 (title), body, caption (secondary)`);
      out.push({ ...result, text: text(node.text, `Text "${cid}" text`), variant });
    } else if (kind === "Image") {
      const url = text(node.url, `Image "${cid}" url`, 80);
      if (url !== "avatar" && !(url.startsWith("icon:") && ICONS.has(url.slice(5))))
        bad(`Image "${cid}" url must be "avatar" or "icon:<name>" with name one of ${WIDGET_ICONS.join(", ")}; web images are not drawn`);
      out.push({ ...result, url });
    } else if (kind === "Button") {
      if (++buttons > MAX_BUTTONS) bad(`a card may have at most ${MAX_BUTTONS} buttons`);
      const action = node.action as Record<string, unknown> | undefined;
      const event = plain(action) ? action.event : undefined;
      const name = plain(event) ? event.name : undefined;
      if (!plain(action) || Object.keys(action).length !== 1 || !plain(event) || typeof name !== "string" || !ACTION.test(name))
        bad(`Button "${cid}" needs action: {event: {name: "<action name>"}} (letters, digits, _ . : -; at most 64)`);
      const label = byId.get(node.child as string)!;
      seen.add(node.child as string);
      out.push({ ...result, child: node.child as string, action: { event: { name: name as string } } });
      out.push({ id: node.child as string, component: "Text", text: text(label.text, `Text "${String(label.id)}" text`, 20), variant: "body" });
    } else if (kind === "Divider") {
      if (node.axis !== undefined && node.axis !== "horizontal") bad(`Divider "${cid}" axis must be horizontal`);
      out.push(result);
    } else if (kind === "ProgressBar") {
      let value = node.value;
      if (plain(value)) value = Number(text(value, `ProgressBar "${cid}" value`));
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) bad(`ProgressBar "${cid}" value must be a number from 0 to 100`);
      out.push({ ...result, value: Math.round(value as number), ...(node.label !== undefined ? { label: text(node.label, `ProgressBar "${cid}" label`, 40) } : {}) });
    } else if (kind === "Badge") {
      out.push({ ...result, text: text(node.text, `Badge "${cid}" text`, 8) });
    }
  };
  visit(root as string, 0, []);
  const unused = [...byId.keys()].filter((key) => !seen.has(key));
  if (unused.length) bad(`components not reachable from root: ${unused.slice(0, 5).join(", ")}`);
  return { root: root as string, components: out };
}

interface Stored { version: 1; cards: WidgetCard[]; bindings: Record<string, string>; placed: PlacedWidget[] }

/** widgets.json in ash's state directory, replaced atomically. */
class WidgetFile {
  constructor(private readonly file: string) {}
  load(): Stored {
    const empty: Stored = { version: 1, cards: [], bindings: {}, placed: [] };
    if (!existsSync(this.file)) return empty;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Stored>;
      const cards = Array.isArray(raw.cards) ? raw.cards.filter((card) => card && CARD_ID.test(card.id) && card.render && Array.isArray(card.render.components)) : [];
      const bindings = plain(raw.bindings) ? Object.fromEntries(Object.entries(raw.bindings).filter(([key, value]) => WIDGET_ID.test(key) && typeof value === "string")) as Record<string, string> : {};
      const placed = Array.isArray(raw.placed) ? raw.placed.filter((item) => item && WIDGET_ID.test(item.id) && (item.type === "ash" || item.type === "card")) : [];
      return { version: 1, cards, bindings, placed };
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
  /** Hands the full state to the phone; the phone answers with the widgets placed on its home screen. */
  push?: (state: WidgetState) => Promise<{ widgets?: unknown } | void>;
  now?: () => number;
}

/**
 * service:widgets: cards for the phone's home screen. Agents and apps put cards (a small A2UI subset), the owner places
 * them with the "Ash 卡片" widget; a button tap goes back to the card's creator as widget.action.
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

  constructor(private readonly options: WidgetsOptions) {
    this.store = new WidgetFile(options.file);
    this.state = this.store.load();
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  words(): readonly WordSpec[] {
    return ["widget.list", "widget.card.put", "widget.card.remove", "widget.bind", "widget.tap", "widget.placed"].map((word) => wordContract("service:widgets", word)!);
  }

  /** Push once at startup so the phone draws what was saved. */
  start(): void { this.enqueue(); }

  private info(card: WidgetCard) {
    return { id: card.id, title: card.title, size: card.size, owner: card.owner, updated_at: card.updated_at, expires_at: card.expires_at,
      expired: card.expires_at !== null && card.expires_at <= this.now(), actions: [...card.actions] };
  }

  snapshot(): WidgetState {
    return { revision: ++this.revision, bindings: { ...this.state.bindings },
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
    case "widget.card.put": {
      const cardId = String(body.id);
      if (!CARD_ID.test(cardId)) bad("id must be lowercase letters, digits, . _ - (at most 64)");
      const title = String(body.title ?? "").trim();
      if (!title || title.length > 40) bad("title must be 1 to 40 characters");
      if (!SIZES.has(String(body.size))) bad("size must be 2x2, 4x2 or 4x4");
      const render = validateA2ui(body.a2ui);
      const existing = this.state.cards.find((card) => card.id === cardId);
      if (existing && !this.mayChange(existing, message.from)) return { ok: false, error: { code: "forbidden", message: `card "${cardId}" belongs to ${existing.owner}; only it or the owner may change it` } };
      if (!existing && this.state.cards.length >= MAX_CARDS) this.purge();
      if (!existing && this.state.cards.length >= MAX_CARDS) bad(`there are already ${MAX_CARDS} cards; remove one first`);
      const now = this.now();
      const ttl = body.ttl_min;
      const card: WidgetCard = { id: cardId, title, size: body.size as WidgetCard["size"], owner: existing?.owner ?? message.from, updated_at: now,
        expires_at: typeof ttl === "number" ? now + ttl * 60_000 : null, render,
        actions: render.components.flatMap((c) => c.action ? [c.action.event.name] : []) };
      this.state.cards = existing ? this.state.cards.map((item) => item.id === cardId ? card : item) : [...this.state.cards, card];
      this.commit();
      return { ok: true, result: { card: this.info(card), bound_widgets: Object.entries(this.state.bindings).filter(([, value]) => value === cardId).map(([key]) => key) } };
    }
    case "widget.card.remove": {
      const cardId = String(body.id);
      const existing = this.state.cards.find((card) => card.id === cardId);
      if (!existing) return { ok: true, result: { removed: false } };
      if (!this.mayChange(existing, message.from)) return { ok: false, error: { code: "forbidden", message: `card "${cardId}" belongs to ${existing.owner}; only it or the owner may remove it` } };
      this.state.cards = this.state.cards.filter((card) => card.id !== cardId);
      this.state.bindings = Object.fromEntries(Object.entries(this.state.bindings).filter(([, value]) => value !== cardId));
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
      return { ok: true, result: { widget, card: cardId } };
    }
    case "widget.placed": {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "only the owner's phone reports placed widgets" } };
      this.placed(body.widgets);
      return { ok: true, result: { accepted: true } };
    }
    case "widget.tap": {
      if (message.from !== "person:owner") return { ok: false, error: { code: "forbidden", message: "only the owner taps a widget" } };
      const card = this.state.cards.find((item) => item.id === body.card);
      if (!card) return { ok: false, error: { code: "not_found", message: "card no longer exists" } };
      const action = String(body.action);
      if (!card.actions.includes(action)) return { ok: false, error: { code: "bad_request", message: "this card has no such button" } };
      await this.options.router.send(service, { to: null, kind: "event", word: "widget.action", body: { card: card.id, action, owner: card.owner, title: card.title } });
      // The creator decides what a tap means: an agent hears it as a message in its own turn.
      if (AGENT_ID.test(card.owner)) {
        try {
          await this.options.router.send(service, { to: card.owner, kind: "request", word: "say",
            body: { text: `[widget.action] The owner tapped the button "${action}" on your home-screen card "${card.title}" (id ${card.id}). Decide what it means; anything risky still goes through approval.` } });
        } catch { /* the event is on the ledger either way */ }
      }
      return { ok: true, result: { accepted: true } };
    }
    }
    return { ok: false, error: { code: "not_found", message: "widget word unavailable" } };
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
        } catch { /* the phone may be starting; the next change or startup pushes again */ }
      }
    })().finally(() => { this.sending = null; if (this.queued && !this.closed) this.enqueue(); });
  }

  async settled(): Promise<void> { while (this.sending) await this.sending; }
  close(): void { this.closed = true; }
}
