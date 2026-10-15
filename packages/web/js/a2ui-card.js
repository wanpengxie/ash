// A card an agent designed (A2UI, docs/GENUI.md) drawn in the conversation as DOM: the same literal plan the phone draws
// natively (`plan.components`, every binding already resolved by the hub). Inputs write into a working copy of the card's
// data kept here per card id, so it survives the timeline drawing its rows again; a password box keeps its text in memory
// only and sends it nowhere but the vault. A button's action is the owner's own message to the card's creator, the answer
// of a form, or (docs/CARD-RUNTIME.md) a press the hub runs for the card (`service:cards/act`: call / ask / tell), whose
// outcome the hub writes on the card itself and pushes as `card.patch`; a pushed card is patched in place, component by
// component, never drawn anew under the owner's hands. A mini app (Html) runs in a sandboxed frame with no network and one
// way out: `ash.send`, and on a card of an app `ash.call` / `ash.ask` / `ash.tell`, which are presses of the card too.
import { addIcon, avatarUrl, button, text } from "./chat-ui.js";
import { ICON_SHAPES } from "./ash-icons.js";
import { markdownUrl } from "./markdown.js";
import { layout as chartLayout } from "../../../design/vitals/chart/chart.mjs";

const SVG = "http://www.w3.org/2000/svg";
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const AGENT = /^agent:[a-z][a-z0-9_-]{0,31}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
/** How long after the owner's last change the card's values go to the hub (`card.draft`). */
export const DRAFT_DELAY_MS = 400;
/** The most a card's data may hold (the hub keeps at most this much). */
const MAX_DATA_BYTES = 64 * 1024;
/** How deep a plan is drawn; a deeper (or circular) plan is cut there. */
const MAX_DEPTH = 40;

// ---------------------------------------------------------------------------------------------------------------------
// Pure parts: JSON pointers, the masked tail of a password, what a button sends.

const unescapeKey = (raw) => raw.replace(/~1/g, "/").replace(/~0/g, "~");

/** The JSON pointer of a top-level field name (a form field's bind path): `/` + the name with `~` -> `~0`, `/` -> `~1`. */
export const fieldPath = (name) => `/${String(name).replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** The value at JSON pointer [path] in [data]; undefined when it is not there. */
export function readPointer(data, path) {
  if (path === "" || path === "/") return data;
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  let at = data;
  for (const raw of path.slice(1).split("/")) {
    const key = unescapeKey(raw);
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (plain(at) && Object.hasOwn(at, key)) at = at[key];
    else return undefined;
  }
  return at;
}

/** Writes [value] at JSON pointer [path], creating objects on the way; arrays only by an existing index. False when it cannot. */
export function writePointer(data, path, value) {
  if (!plain(data) || typeof path !== "string" || !path.startsWith("/") || path === "/") return false;
  const keys = path.slice(1).split("/").map(unescapeKey);
  let at = data;
  for (const [i, key] of keys.entries()) {
    const last = i === keys.length - 1;
    if (Array.isArray(at)) {
      if (!/^\d+$/.test(key) || Number(key) >= at.length) return false;
      if (last) { at[Number(key)] = value; return true; }
      at = at[Number(key)];
    } else if (plain(at)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) return false;
      if (last) { at[key] = value; return true; }
      if (!plain(at[key]) && !Array.isArray(at[key])) at[key] = {};
      at = at[key];
    } else return false;
  }
  return false;
}

/** What the agent learns of a password: `****` and its last four characters when it has eight or more, else `****`. */
export function masked(text) {
  const chars = [...String(text ?? "")];
  return chars.length >= 8 ? `****${chars.slice(-4).join("")}` : "****";
}

/**
 * The answer of a form the owner sends: the working copy without the password fields as `values`, and for each password
 * field the vault name it was saved under with its masked tail. [secretTexts] maps a field's bind path to what was typed.
 */
export function formAnswerBody(form, data, secretTexts = new Map()) {
  const secret = plain(form?.secret) ? form.secret : {};
  const values = {};
  for (const [key, value] of Object.entries(plain(data) ? data : {})) if (!Object.hasOwn(secret, key)) values[key] = clone(value);
  const out = {};
  for (const [field, ref] of Object.entries(secret)) out[field] = { ref, masked: masked(secretTexts.get(fieldPath(field)) ?? "") };
  return { ok: true, result: { data: { values, secret: out } } };
}

/** The answer of a form the owner cancels. */
export const formCancelBody = () => ({ ok: false, error: { code: "cancelled", message: "主人取消了" } });

/** The owner's `say` for an action on a card: the label as the text, and which card, which action, its context and the values. */
export function sayBody(cardId, label, event, data) {
  const context = plain(event?.context) && Object.keys(event.context).length ? clone(event.context) : undefined;
  return { text: String(label || event?.name || "").trim() || String(event?.name ?? ""),
    card: { id: cardId, action: event.name, ...(context ? { context } : {}), data: clone(plain(data) ? data : {}) } };
}

/** A card item's plan made ready to draw: the components by id and the root; null when there is nothing to draw. */
export function parsePlan(plan) {
  if (!plain(plan) || !Array.isArray(plan.components)) return null;
  const byId = new Map();
  for (const node of plan.components) if (plain(node) && typeof node.id === "string" && typeof node.component === "string" && !byId.has(node.id)) byId.set(node.id, node);
  const root = typeof plan.root === "string" ? plan.root : "root";
  if (!byId.has(root)) return null;
  return { root, byId, data: plain(plan.data) ? plan.data : {}, reactive: plan.reactive === true, theme: plain(plan.theme) ? plan.theme : null };
}

/** The visible label of a button: the first Text below it, else the action's name. */
export function buttonLabel(byId, node) {
  const seen = new Set();
  const find = (id, depth = 0) => {
    const c = byId.get(id);
    if (!c || seen.has(id) || depth > MAX_DEPTH) return "";
    seen.add(id);
    if (c.component === "Text" && typeof c.text === "string") return plainText(c.text);
    for (const kid of kidsOf(c)) { const found = find(kid, depth + 1); if (found) return found; }
    return "";
  };
  return (node.child && find(node.child)) || node.action?.event?.name || "";
}

const kidsOf = (c) => [...(Array.isArray(c.children) ? c.children : []), ...(typeof c.child === "string" ? [c.child] : []), ...(Array.isArray(c.tabs) ? c.tabs.map((t) => t?.child) : [])].filter((k) => typeof k === "string");
/** Markdown marks taken off, for a label. */
const plainText = (value) => String(value).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~#>]/g, "").replace(/\s+/g, " ").trim();

const STATE_TEXT = Object.freeze({ sent: "已提交", cancelled: "已取消", expired: "已过期", closed: "已结束" });

/** The line under a card that no longer takes input; empty while it is open. */
export function stateLine(card, local = {}, now = Date.now()) {
  if (local.sent) return STATE_TEXT.sent;
  if (local.cancelled) return STATE_TEXT.cancelled;
  if (card.state && card.state !== "open") return STATE_TEXT[card.state] ?? STATE_TEXT.closed;
  if (card.life === "closed") return STATE_TEXT.closed;
  if (Number.isFinite(card.form?.expires_at) && card.form.expires_at > 0 && card.form.expires_at <= now) return STATE_TEXT.expired;
  return "";
}

// ---------------------------------------------------------------------------------------------------------------------
// The card runtime (docs/CARD-RUNTIME.md): presses the hub runs, what a button shows, the card's live line, what is seen.

/** A press the hub runs for the card (`service:cards/act`): "call", "ask" or "tell"; null for any other action. */
export function runtimeKind(action) {
  if (!plain(action)) return null;
  return ["call", "ask", "tell"].find((kind) => plain(action[kind])) ?? null;
}

/** What a press sends to `service:cards/act`: which card, which component, the values on the card now, and a mini app's request. */
export function actBody(cardId, component, data, request = null) {
  return { card: String(cardId), component: String(component), data: clone(plain(data) ? data : {}), ...(plain(request) ? { request: clone(request) } : {}) };
}

/** How long a press waits for the hub's answer: the action's `timeout_s` (the hub's own default otherwise) and 5 s more. */
export function actTimeoutMs(action) {
  const kind = runtimeKind(action);
  const given = kind && kind !== "tell" ? action[kind].timeout_s : undefined;
  const seconds = Number.isFinite(given) && given > 0 ? given : kind === "ask" ? 120 : 30;
  return (seconds + 5) * 1000;
}

const ACT_FAILED = "没做成，可以再按一次。";
const ACT_LATE = "没有及时回应，可以再按一次。";

/** The outcome line of a press the hub did not answer: why, in the owner's words. */
export function actProblem(error) {
  const code = error?.code;
  if (code === "conflict") return "这张卡已经结束了，按钮不再起作用。";
  if (code === "offline" || code === "unavailable") return "没连上，可以再按一次。";
  if (code === "timeout" || code === "result_unknown") return ACT_LATE;
  if (code === "forbidden") return "这张卡的应用没有被批准做这件事。";
  return ACT_FAILED;
}

const answerOf = (data) => plain(data) && ["ok", "failed", "running"].includes(data.state)
  ? { state: data.state, text: typeof data.text === "string" ? data.text : "", ...(data.result !== undefined ? { result: data.result } : {}) }
  : { state: "failed", text: ACT_FAILED };

/** One press: [act] (the page's `service:cards/act`) with [body], answered within [ms]; never throws. */
export async function actOnce(act, body, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ state: "failed", text: ACT_LATE }), ms); });
  try {
    return await Promise.race([Promise.resolve().then(() => act(body)).then(answerOf, (error) => ({ state: "failed", text: actProblem(error) })), late]);
  } finally { clearTimeout(timer); }
}

/** How long 「已复制」 stays under a button. */
export const COPIED_MS = 2000;

/**
 * What a button with a hub action (or a copy) shows now: `busy` (「处理中…」, disabled: a press of this screen is on its way,
 * or the hub says it runs; a run the hub never finished stops counting after the action's wait) and the line under it:
 * the outcome this screen was answered, unless the hub wrote a newer one on the card.
 */
export function buttonView(card, local, component, action, now = Date.now()) {
  const copied = local?.copied?.[component];
  if (copied && copied.until > now) return { busy: false, line: { state: copied.state, text: copied.text } };
  const hub = plain(card?.actions?.[component]) ? card.actions[component] : null;
  let running = false;
  if (hub?.state === "running") {
    const since = local?.runningSince;
    const key = `${component}\0${hub.at}`;
    if (since && !since.has(key)) { if (since.size > 50) since.clear(); since.set(key, now); }
    running = now - (since?.get(key) ?? now) < actTimeoutMs(action);
  }
  if (local?.pressing?.has(component) || running) return { busy: true, line: null };
  const mine = local?.outcomes?.[component];
  const hubDone = hub && hub.state !== "running" ? hub : null;
  const shown = mine && !(hubDone && Number(hubDone.at) > mine.after) ? mine : hubDone;
  return { busy: false, line: shown?.text ? { state: shown.state === "failed" ? "failed" : "ok", text: String(shown.text) } : null };
}

const clockOf = (ms) => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/**
 * The quiet line at the bottom of a card that holds resources (it has an app; its live data may come): 「常驻中」 while the
 * owner keeps it running, 「HH:MM 更新」 once data came, 「已休眠 · HH:MM 的数据」 while it sleeps, "" until then (the line
 * keeps its place); null for any other card.
 */
export function liveLine(card) {
  const backed = (typeof card?.app === "string" && card.app !== "") || card?.temporary_app === true;
  if (!backed || !(Number.isFinite(card.fed_at) || typeof card.life === "string")) return null;
  if (card.life === "closed" || (card.state && card.state !== "open")) return null;
  const fed = Number.isFinite(card.fed_at) && card.fed_at > 0 ? card.fed_at : null;
  if (card.life === "dormant") {
    const at = fed ?? (Number.isFinite(card.updated_at) && card.updated_at > 0 ? card.updated_at : null);
    return at ? `已休眠 · ${clockOf(at)} 的数据` : "已休眠";
  }
  if (card.pinned === true && card.life === "active") return "常驻中";
  return fed ? `${clockOf(fed)} 更新` : "";
}

/** Whether the owner may keep [card] running (「常驻」): a card of an app that is not closed. */
export const pinnable = (card) => typeof card?.app === "string" && card.app !== "" && card.life !== "closed" && (!card.state || card.state === "open");

/** The ids of the cards an agent designed that are on screen in [log] now (at most 50). */
export function cardIdsOnScreen(log) {
  const view = log?.getBoundingClientRect?.();
  if (!view) return [];
  const ids = [];
  for (const el of log.querySelectorAll?.(".a2ui[data-card-id]") ?? []) {
    const id = el.dataset?.cardId;
    const box = el.getBoundingClientRect?.();
    if (!id || !box || ids.includes(id) || box.height <= 0 || box.bottom <= view.top || box.top >= view.bottom) continue;
    ids.push(id);
    if (ids.length >= 50) break;
  }
  return ids;
}

/**
 * Tells the hub which cards are on screen (`service:cards/seen`): [delay] ms after the last poke (the list stopped
 * scrolling, the chat came into view) and every [every] ms while the chat is visible; never while it is hidden, never an
 * empty list. Failures are ignored: the next report says it again.
 */
export class SeenReporter {
  constructor({ ids, send, visible = () => true, delay = 400, every = 60_000 }) {
    Object.assign(this, { ids, send, visible, delay, every, timer: null, interval: null });
  }
  poke() {
    if (!this.visible()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.report(), this.delay);
    this.timer.unref?.();
  }
  report() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.visible()) return;
    let ids;
    try { ids = this.ids(); } catch { return; }
    if (!Array.isArray(ids) || !ids.length) return;
    Promise.resolve().then(() => this.send(ids.slice(0, 50))).catch(() => {});
  }
  start() {
    clearInterval(this.interval);
    this.interval = setInterval(() => this.report(), this.every);
    this.interval.unref?.();
  }
  dispose() { clearTimeout(this.timer); clearInterval(this.interval); this.timer = this.interval = null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-card state: the working copy, the tab shown, what is being sent. Passwords live apart and never in data.

const states = new Map();
/** card id -> Map(bind path -> typed password). In memory only; sent to `service:vault/set` and nowhere else. */
const secrets = new Map();
const MAX_STATES = 300;
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** The password map of a card (for tests and the submit). */
export const secretsOf = (cardId) => secrets.get(cardId) ?? new Map();
/** Forgets every card's local state (tests). */
export function resetCards() {
  for (const s of states.values()) { clearTimeout(s.timer); for (const view of s.ui?.views.values() ?? []) view.dispose?.(); }
  states.clear(); secrets.clear(); later.cards.clear();
}
/** The local state of a card (tests). */
export const cardState = (cardId) => states.get(cardId);

function editing(s) {
  const root = s.ui?.root;
  const doc = root?.ownerDocument ?? globalThis.document;
  const active = doc?.activeElement;
  return Boolean(s.timer || s.inflight > 0 || (active && root?.contains?.(active) && active !== root));
}

/** Whether a part of the card is selected on the page (a range over it, not a caret). */
function selected(el) {
  try {
    const selection = (el.ownerDocument ?? globalThis.document)?.getSelection?.();
    return Boolean(selection?.rangeCount && !selection.isCollapsed && selection.containsNode?.(el, true));
  } catch { return false; }
}

/** Whether the owner is editing an input of [view]: it has the focus, an IME is composing in it, a slider is dragged, or it holds a selection. */
function inputEditing(view) {
  if (view.composing || view.dragging) return true;
  for (const input of view.inputs ?? []) {
    const doc = input.ownerDocument ?? globalThis.document;
    if (doc?.activeElement === input || selected(input)) return true;
  }
  return false;
}

/**
 * The state of [card]. A newer version from the hub becomes the working copy, field by field: a field the owner changed
 * and the hub has not taken yet keeps the owner's value (it goes with the next draft); a field being edited keeps what is
 * typed and the hub's value waits beside it (per card + component) until the editing ends.
 */
function stateFor(item) {
  const card = item.card;
  const server = Number.isFinite(card.updated_at) ? card.updated_at : 0;
  const data = plain(card.plan?.data) ? card.plan.data : {};
  let s = states.get(card.id);
  if (!s) {
    if (states.size >= MAX_STATES) for (const [id, old] of states) { if (!editing(old)) { clearTimeout(old.timer); states.delete(id); secrets.delete(id); } if (states.size < MAX_STATES) break; }
    s = { id: card.id, data: clone(data), seen: server, stale: false, plan: null, tabs: {}, version: 0, inflight: 0, timer: null,
      // Bind path -> the local version that changed it (not yet taken by the hub); component id -> the hub's value held while it is edited.
      touched: new Map(), held: new Map(),
      sent: false, cancelled: false, busy: false, error: "", answer: null, ui: null, item, ctx: null, lastSend: 0, feedback: undefined,
      // The card runtime: presses on their way, their outcomes as answered here, 「已复制」, mini app calls in the last second.
      pressing: new Set(), outcomes: {}, copied: {}, runningSince: new Map(), calls: [], kept: false, keeping: false,
      // 「常驻」 as the owner just set it (until the hub's card says the same), and why setting it failed.
      pinned: undefined, pinning: false, pinError: "" };
    states.set(card.id, s);
  } else if (server > s.seen) {
    const next = clone(data);
    const keep = new Map([...s.touched.keys()].map((path) => [path, null]));
    for (const view of s.ui?.views.values() ?? []) if (typeof view.node?.bind === "string" && view.inputs?.length && inputEditing(view)) keep.set(view.node.bind, view.id);
    for (const [path, component] of keep) {
      const local = readPointer(s.data, path), theirs = readPointer(data, path);
      if (same(local, theirs)) { s.touched.delete(path); continue; }
      if (local !== undefined) writePointer(next, path, clone(local));
      if (component !== null && !s.touched.has(path)) s.held.set(component, { path, value: clone(theirs), local: clone(local) });
      s.stale = true;
    }
    s.data = next; s.seen = server; s.plan = null;
  }
  if (s.feedback !== undefined && card.feedback === s.feedback) s.feedback = undefined;
  if (s.pinned !== undefined && !s.pinning && (card.pinned === true) === s.pinned) s.pinned = undefined;
  if (card.state && card.state !== "open") { s.busy = false; if (card.state === "sent" || card.state === "cancelled") s.error = ""; }
  s.item = item;
  return s;
}

/** The hub has the owner's values up to [version] (a draft answered, a press or a say that carried them). */
function taken(s, version) { for (const [path, at] of s.touched) if (at <= version) s.touched.delete(path); }

/**
 * The hub pushed [card] whole (`card.patch`: live data, a button's state, the lifecycle). Its state follows now and the
 * card on screen is patched in place, component by component: an input the owner is editing keeps its text, caret and
 * composition. The timeline then finds nothing left to change.
 */
export function patchA2uiCard(card) {
  const s = plain(card) && typeof card.id === "string" ? states.get(card.id) : null;
  if (!s || !plain(card.plan)) return false;
  stateFor({ ...s.item, card });
  redraw(s);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Colours and styles.

const THEME_COLORS = Object.freeze({
  text: "var(--text)", textSecondary: "var(--text-2)", accent: "var(--you)", onAccent: "var(--on-you)", background: "var(--bg)",
  surface: "var(--surface)", surfaceVariant: "var(--surface-2)", line: "var(--line)", transparent: "transparent",
  translucentDark: "rgba(0,0,0,.35)", translucentLight: "rgba(255,255,255,.7)", white: "#FFFFFF", black: "#000000",
  red: "var(--err-fill)", orange: "#F2704E", yellow: "var(--warn-fill)", green: "var(--ok-fill)", teal: "var(--her-fill)",
  blue: "var(--helper-blue)", purple: "var(--helper-purple)", pink: "var(--helper-rose)", gray: "var(--text-3)",
});
const dark = () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;

/** A card colour (a theme name, "#RRGGBBAA" or {light, dark}) as CSS; null when it is none of those. */
export function cssColor(value) {
  if (plain(value)) return cssColor(dark() ? value.dark : value.light);
  if (typeof value !== "string") return null;
  if (Object.hasOwn(THEME_COLORS, value)) return THEME_COLORS[value];
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value) ? value : null;
}

const px = (n) => `${n}px`;
const box = (v) => Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) ? v.map(px).join(" ") : null;
const JUSTIFY = { start: "flex-start", center: "center", end: "flex-end", spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly", stretch: "stretch" };
const ALIGN = { start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" };
const PLACE = { topStart: ["start", "start"], top: ["start", "center"], topEnd: ["start", "end"], start: ["center", "start"], center: ["center", "center"],
  end: ["center", "end"], bottomStart: ["end", "start"], bottom: ["end", "center"], bottomEnd: ["end", "end"] };

function applyStyle(el, node, parent) {
  const s = plain(node.style) ? node.style : {};
  const st = el.style;
  const bg = cssColor(s.background); if (bg) st.background = bg;
  const fg = cssColor(s.color); if (fg) st.color = fg;
  if (Number.isFinite(s.cornerRadius)) { st.borderRadius = px(s.cornerRadius); st.overflow = "hidden"; }
  const pad = box(s.padding); if (pad) st.padding = pad;
  const margin = box(s.margin); if (margin) st.margin = margin;
  for (const side of ["width", "height"]) {
    const v = s[side];
    if (Number.isFinite(v)) { st[side] = px(v); st.flexShrink = "0"; }
    else if (v === "fill") {
      // Along the parent's axis it takes the room left; across it, the whole width or height.
      if ((side === "width" && parent === "Row") || (side === "height" && parent === "Column")) { st.flex = "1 1 0"; st.minWidth = "0"; }
      else { st.alignSelf = "stretch"; if (side === "width") st.width = "100%"; }
    }
    else if (v === "wrap") st[side] = "fit-content";
  }
  if (Number.isFinite(s.fontSize)) { st.fontSize = px(s.fontSize); if (!Number.isFinite(s.lineHeight)) st.lineHeight = "1.4"; }
  if (Number.isFinite(s.fontWeight)) st.fontWeight = String(s.fontWeight);
  if (s.italic === true) st.fontStyle = "italic";
  const deco = [s.underline === true && "underline", s.strikethrough === true && "line-through"].filter(Boolean).join(" ");
  if (deco) st.textDecoration = deco;
  if (typeof s.textAlign === "string") st.textAlign = s.textAlign;
  if (Number.isInteger(s.maxLines)) {
    if (s.maxLines === 1) { st.whiteSpace = "nowrap"; st.overflow = "hidden"; st.textOverflow = s.ellipsize === "none" ? "clip" : "ellipsis"; }
    else { st.display = "-webkit-box"; st.webkitBoxOrient = "vertical"; st.webkitLineClamp = String(s.maxLines); st.overflow = "hidden"; }
  }
  if (Number.isFinite(s.lineHeight)) st.lineHeight = px(s.lineHeight);
  if (Number.isFinite(s.letterSpacing)) st.letterSpacing = `${s.letterSpacing}em`;
  if (Number.isFinite(s.opacity)) st.opacity = String(s.opacity);
  if (Number.isFinite(node.weight) && node.weight > 0 && (parent === "Row" || parent === "Column")) { st.flex = `${node.weight} ${node.weight} 0`; st.minWidth = "0"; }
  if (node.a11y) el.setAttribute("aria-label", String(node.a11y));
}

// ---------------------------------------------------------------------------------------------------------------------
// Text: the simple Markdown of a card (**b** *i* `code` ~~s~~ [link](url), # headings, - lists).

const INLINE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\s][^*\n]*?\*|_[^_\s][^_\n]*?_)/;

function inline(parent, source, depth = 0) {
  let rest = String(source);
  while (rest) {
    const m = depth > 4 ? null : INLINE.exec(rest);
    if (!m) { parent.append(document.createTextNode(rest)); return; }
    if (m.index) parent.append(document.createTextNode(rest.slice(0, m.index)));
    const token = m[0];
    if (token.startsWith("**") || token.startsWith("__")) inline(text(parent, "b", ""), token.slice(2, -2), depth + 1);
    else if (token.startsWith("~~")) inline(text(parent, "s", ""), token.slice(2, -2), depth + 1);
    else if (token.startsWith("`")) text(parent, "code", token.slice(1, -1));
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const href = link && markdownUrl(link[2]);
      if (href) { const a = text(parent, "a", ""); inline(a, link[1], depth + 1); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      else parent.append(document.createTextNode(link ? link[1] : token));
    } else inline(text(parent, "i", ""), token.slice(1, -1), depth + 1);
    rest = rest.slice(m.index + token.length);
  }
}

/** Appends [source] as the card's simple Markdown: headings, bullet lists and paragraphs of inline marks. */
export function appendCardMarkdown(parent, source) {
  let list = null, para = null;
  for (const line of String(source ?? "").split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (heading) { list = para = null; inline(text(parent, "div", "", `a2-md-h a2-md-h${heading[1].length}`), heading[2]); }
    else if (bullet) { para = null; list ??= text(parent, "ul", "", "a2-md-ul"); inline(text(list, "li", ""), bullet[1]); }
    else if (!line.trim()) { list = para = null; }
    else {
      list = null;
      if (para) para.append(document.createElement("br")); else para = text(parent, "div", "", "a2-md-p");
      inline(para, line);
    }
  }
  return parent;
}

/** A table cell's text as the card's inline Markdown (**b**, `code`, links), its lines kept. */
export function cellMarkdown(cell, source) {
  String(source ?? "").split("\n").forEach((line, i) => { if (i) cell.append(document.createElement("br")); inline(cell, line); });
  return cell;
}

// ---------------------------------------------------------------------------------------------------------------------
// Icons and charts.

/**
 * Line icons the cards use beyond Ash's own set (js/ash-icons.js), drawn the same way: a 24 grid, stroke 1.8, round caps and
 * joins (`.i`); a shape with `fill` is solid. The same path data as the phone's vector drawables (res/drawable/ash_ic_*.xml:
 * sun, cloud, rain, snow, wind, person, account, star, star_half, star_off, volume_*, weight, water, car, thumb_up, thumb_down),
 * so both look alike: change them together.
 */
export const CARD_ICON_SHAPES = Object.freeze({
  sun: [["path", { d: "M8,12a4,4 0 1,0 8,0a4,4 0 1,0 -8,0" }], ["path", { d: "M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" }]],
  cloud: [["path", { d: "M7.5 18.5h9.5a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7.1 9.1 4.75 4.75 0 0 0 7.5 18.5z" }]],
  rain: [["path", { d: "M7.5 14.5h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.8 6.3 4.1 4.1 0 0 0 7.5 14.5z" }], ["path", { d: "M8.5 17.5l-1 2.5M12.5 17.5l-1 2.5M16.5 17.5l-1 2.5" }]],
  snow: [["path", { d: "M7.5 14.5h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.8 6.3 4.1 4.1 0 0 0 7.5 14.5z" }], ["path", { d: "M8 18v.01M12 18v.01M16 18v.01M10 21v.01M14 21v.01" }]],
  wind: [["path", { d: "M3.5 9h10a2.5 2.5 0 1 0-2.5-2.5M3.5 13h14a2.5 2.5 0 1 1-2.5 2.5M3.5 17h7" }]],
  person: [["path", { d: "M8.5,8a3.5,3.5 0 1,0 7,0a3.5,3.5 0 1,0 -7,0" }], ["path", { d: "M5 20a7 7 0 0 1 14 0" }]],
  accountCircle: [["path", { d: "M3.5,12a8.5,8.5 0 1,0 17,0a8.5,8.5 0 1,0 -17,0" }], ["path", { d: "M9.5,10a2.5,2.5 0 1,0 5,0a2.5,2.5 0 1,0 -5,0" }], ["path", { d: "M6.8 18.6a6 6 0 0 1 10.4 0" }]],
  star: [["path", { d: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.75 1-5.8L3.5 9.7l5.9-.9z" }]],
  starHalf: [["path", { d: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.75 1-5.8L3.5 9.7l5.9-.9z" }], ["path", { d: "M12 3.5L9.4 8.8 3.5 9.7l4.25 4.1-1 5.8L12 16.9z", fill: "currentColor", stroke: "none" }]],
  starOff: [["path", { d: "M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.75 1-5.8L3.5 9.7l5.9-.9z" }], ["path", { d: "M3.5 3.5l17 17" }]],
  volumeUp: [["path", { d: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z" }], ["path", { d: "M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" }]],
  volumeDown: [["path", { d: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z" }], ["path", { d: "M15.5 9a4 4 0 0 1 0 6" }]],
  volumeMute: [["path", { d: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z" }]],
  volumeOff: [["path", { d: "M4 9.5h3.5L12 5.5v13l-4.5-4H4z" }], ["path", { d: "M15.5 9.5l5 5M20.5 9.5l-5 5" }]],
  weight: [["path", { d: "M5.5 9.5h13l1.5 10.5h-16z" }], ["path", { d: "M9 9.5V7a3 3 0 0 1 6 0v2.5" }]],
  water: [["path", { d: "M12 3.5s-6 6.6-6 10.5a6 6 0 0 0 12 0c0-3.9-6-10.5-6-10.5z" }]],
  car: [["path", { d: "M3.5 16.5v-3.5l1.9-5a2 2 0 0 1 1.9-1.3h9.4a2 2 0 0 1 1.9 1.3l1.9 5v3.5z" }], ["path", { d: "M3.5 13h17" }], ["path", { d: "M6 16.5v2h2.5v-2M15.5 16.5v2H18v-2" }], ["path", { d: "M7 14.8v.01M17 14.8v.01" }]],
  thumbUp: [["path", { d: "M7.5 10.5v9h-3v-9z" }], ["path", { d: "M7.5 10.5l3.5-6.5a2 2 0 0 1 2 2.2l-.5 3.3h5a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H7.5" }]],
  thumbDown: [["path", { d: "M7.5 13.5v-9h-3v9z" }], ["path", { d: "M7.5 13.5l3.5 6.5a2 2 0 0 0 2-2.2l-.5-3.3h5a2 2 0 0 0 2-2.4l-1.2-6a2 2 0 0 0-2-1.6H7.5" }]],

});

/**
 * Every card icon name (sdk card.ts CARD_ICONS) as the nearest line icon: one of Ash's own (js/ash-icons.js) or of the
 * cards' (CARD_ICON_SHAPES); null draws a neutral outline (a small circle). The one table on the web; the phone keeps its own.
 */
export const CARD_ICON_GLYPHS = Object.freeze({
  accountCircle: "accountCircle", add: "plus", arrowBack: "back", arrowForward: "chev", attachFile: "file", calendarToday: "clock", call: "phone",
  camera: "camera", check: "check", close: "x", delete: "trash", download: "down", edit: "pen", event: "clock", error: "alert",
  fastForward: "chev", favorite: "heart", favoriteOff: "heart", folder: "folder", help: "ask", home: "grid", info: "alert", locationOn: "pin",
  lock: "lock", lockOpen: "lock", mail: "msg", menu: "list", moreVert: "more", moreHoriz: "more", notificationsOff: "bell",
  notifications: "bell", pause: "pause", payment: "wallet", person: "person", phone: "phone", photo: "image", play: "chev", print: "file",
  refresh: "refresh", rewind: "back", search: "eye", send: "up", settings: "slider", share: "link", shoppingCart: "box", skipNext: "chev",
  skipPrevious: "back", star: "star", starHalf: "starHalf", starOff: "starOff", stop: "x", upload: "up", visibility: "eye", visibilityOff: "eye",
  volumeDown: "volumeDown", volumeMute: "volumeMute", volumeOff: "volumeOff", volumeUp: "volumeUp", warning: "alert", sun: "sun", cloud: "cloud",
  rain: "rain", snow: "snow", wind: "wind", moon: "moon", heart: "heart", steps: "pulse", weight: "weight", sleep: "moon", water: "water", fire: "bolt",
  calendar: "clock", clock: "clock", alert: "alert", bell: "bell", car: "car", money: "coin", chart: "pulse",
});

/** A line icon by its shape name (the cards' own first, then Ash's); null when there is none or no SVG to draw with. */
function drawShape(parent, glyph, className) {
  if (typeof document.createElementNS !== "function") return null;
  const shapes = Object.hasOwn(CARD_ICON_SHAPES, glyph) ? CARD_ICON_SHAPES[glyph] : null;
  if (!shapes) return Object.hasOwn(ICON_SHAPES, glyph) ? addIcon(parent, glyph, className) : null;
  const svg = svgNode("svg", { class: className ? `i ${className}` : "i", viewBox: "0 0 24 24", "aria-hidden": "true" }, parent);
  for (const [tag, attrs] of shapes) svgNode(tag, attrs, svg);
  return svg;
}

/** A card icon as a single-colour line icon in the node's colour (never an emoji); the neutral outline when it has no match. */
function drawIcon(parent, name, className = "i-s") {
  const glyph = Object.hasOwn(CARD_ICON_GLYPHS, name) ? CARD_ICON_GLYPHS[name] : null;
  const drawn = glyph && drawShape(parent, glyph, className);
  if (drawn) return drawn;
  const svg = svgNode("svg", { class: `i ${className} a2-icon-none`, viewBox: "0 0 24 24", "aria-hidden": "true" }, parent);
  svgNode("circle", { cx: 12, cy: 12, r: 5 }, svg);
  return svg;
}

function svgNode(tag, attrs, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

/** The SVG of a Chart at [w] x [h] (CSS px): the same geometry as the phone's (design/vitals/chart). */
export function chartSvg(node, w, h) {
  const svg = svgNode("svg", { class: "a2-chart", width: "100%", height: h, viewBox: `0 0 ${w} ${h}`, "aria-hidden": "true" });
  const color = (c) => cssColor(c) ?? "var(--text-3)";
  const path = (points) => `M${points.map((p) => p.join(",")).join("L")}`;
  for (const p of chartLayout({ series: node.series ?? [], gap: node.gap }, w, h)) {
    if (p.kind === "bar") svgNode("rect", { x: p.x, y: p.y, width: Math.max(0, p.w), height: p.h, rx: p.r, fill: color(p.color) }, svg);
    else if (p.kind === "area" && p.points.length) svgNode("path", { d: `${path(p.points)}L${p.points.at(-1)[0]},${h}L${p.points[0][0]},${h}Z`, fill: color(p.color), opacity: p.alpha }, svg);
    else if (p.kind === "line" && p.points.length) svgNode("path", { d: path(p.points), fill: "none", stroke: color(p.color), "stroke-width": p.width, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    else if (p.kind === "limit") svgNode("line", { x1: p.x1, x2: p.x2, y1: p.y, y2: p.y, stroke: color(p.color), "stroke-width": p.width, "stroke-dasharray": p.dash.join(" ") }, svg);
    else if (p.kind === "dot") svgNode("circle", { cx: p.x, cy: p.y, r: p.r, fill: color(p.color) }, svg);
  }
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------------
// Clock and timer.

const pad2 = (n) => String(n).padStart(2, "0");

/** The TR35 subset the cards use (yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h mm ss a), in [timeZone] when given. */
export function formatClock(date, format = "HH:mm", timeZone) {
  let parts;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", weekday: "long", hour: "numeric", minute: "numeric", second: "numeric" });
    parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  } catch { return ""; }
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const y = Number(parts.year), M = Number(parts.month), d = Number(parts.day), H = Number(parts.hour) % 24, m = Number(parts.minute), sec = Number(parts.second);
  let out = "";
  for (let i = 0; i < format.length;) {
    const ch = format[i];
    if (ch === "'") { const end = format.indexOf("'", i + 1); out += end < 0 ? format.slice(i + 1) : format.slice(i + 1, end) || "'"; i = end < 0 ? format.length : end + 1; continue; }
    let n = 1; while (format[i + n] === ch) n++; i += n;
    switch (ch) {
    case "y": out += n === 2 ? pad2(y % 100) : String(y); break;
    case "M": out += n >= 4 ? MONTHS[M - 1] : n === 3 ? MONTHS[M - 1].slice(0, 3) : n === 2 ? pad2(M) : String(M); break;
    case "d": out += n >= 2 ? pad2(d) : String(d); break;
    case "E": out += n >= 4 ? parts.weekday : parts.weekday.slice(0, 3); break;
    case "H": out += n >= 2 ? pad2(H) : String(H); break;
    case "h": { const h12 = H % 12 || 12; out += n >= 2 ? pad2(h12) : String(h12); break; }
    case "m": out += n >= 2 ? pad2(m) : String(m); break;
    case "s": out += n >= 2 ? pad2(sec) : String(sec); break;
    case "a": out += H < 12 ? "AM" : "PM"; break;
    default: out += ch.repeat(n);
    }
  }
  return out;
}

/** A span of time as m:ss or h:mm:ss. */
export function formatSpan(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Calls [paint] now and every second while [el] is on the page. */
function ticking(el, paint) {
  paint();
  let seen = false, ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    if (el.isConnected) seen = true;
    // Gone from the page, or never put on it (a stand-in DOM has no isConnected).
    else if (seen || ticks > 5 || el.isConnected === undefined) { clearInterval(timer); return; }
    paint();
  }, 1000);
  timer.unref?.();
}

// ---------------------------------------------------------------------------------------------------------------------
// The mini app: one sandboxed frame per Html node (scripts only, an opaque origin, its own document as srcdoc with a strict
// CSP), and one way to speak: JSON-RPC posted to this page with the token of its load. Who speaks (the card, the component,
// the app) is what this page bound when it made the frame, never what a message says.

export const MINI_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
/** The most one message of a mini app may hold (bytes of its JSON). */
export const MINI_APP_MAX_BYTES = 64 * 1024;
/** What a mini app may ask for: `ash/send` always; `ash/call`, `ash/ask`, `ash/tell` only on a card of an app. */
export const MINI_APP_METHODS = Object.freeze(["ash/send", "ash/call", "ash/ask", "ash/tell"]);
const RPC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const frames = new Set();
let listening = false;

function themeVars() {
  const css = globalThis.getComputedStyle?.(globalThis.document?.documentElement);
  const read = (name, fallback) => css?.getPropertyValue(name)?.trim() || fallback;
  const night = dark();
  return {
    "--ash-bg": read("--bg", night ? "#1B1715" : "#FFF8F1"), "--ash-surface": read("--surface", night ? "#25201D" : "#FFFFFF"),
    "--ash-text": read("--text", night ? "#EADFD8" : "#3B302B"), "--ash-text2": read("--text-2", night ? "#B7A79E" : "#7C6B62"),
    "--ash-accent": read("--you", night ? "#FF8A66" : "#CC4B2E"), "--ash-line": read("--line", night ? "#342D29" : "#F0E2D7"), scheme: night ? "dark" : "light",
  };
}

/** A new load's token: which load of which frame a message comes from (a message of an older load is dropped). */
function newToken() {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `window.ash` in the mini app, speaking JSON-RPC 2.0 to this page with its load's [token]: `send(action, context)` (the
 * owner's say), and on a card of an app ([full]) also `call(member, word, body)`, `ask(text)`, `tell(text)`, each a press of
 * the card that resolves to the hub's answer `{state, text, result?}` (never rejects).
 */
export function miniAppBridge(token, full = false) {
  return `(function(){var p=window.parent,g=${JSON.stringify(String(token))},n=0,w={};` +
    "function c(v){return v&&typeof v===\"object\"&&!Array.isArray(v)?JSON.parse(JSON.stringify(v)):{}}" +
    "function o(m){p.postMessage({g:g,m:JSON.stringify(m)},\"*\")}" +
    "function r(k,q){return new Promise(function(ok){var id=\"r\"+(++n);w[id]=ok;o({jsonrpc:\"2.0\",id:id,method:\"ash/\"+k,params:q})})}" +
    "window.addEventListener(\"message\",function(e){var d=e.data,m;if(e.source!==p||!d||d.g!==g||typeof d.m!==\"string\")return;" +
    "try{m=JSON.parse(d.m)}catch(x){return}if(!m||m.jsonrpc!==\"2.0\"||!Object.prototype.hasOwnProperty.call(w,m.id))return;var f=w[m.id];delete w[m.id];f(m.result)});" +
    "var a={send:function(action,context){o({jsonrpc:\"2.0\",method:\"ash/send\",params:{action:String(action),context:c(context)}})}};" +
    (full ? "a.call=function(member,word,body){return r(\"call\",{member:String(member),word:String(word),body:c(body)})};" +
      "a.ask=function(text){return r(\"ask\",{text:String(text)})};a.tell=function(text){return r(\"tell\",{text:String(text)})};" : "") +
    "window.ash=Object.freeze(a)})();";
}

/**
 * The mini app's document: the CSP, the theme as CSS variables and the bridge of this load ([token]; [full]: a card of an
 * app), ahead of the agent's HTML.
 */
export function miniAppDocument(html, vars = themeVars(), accent = null, { token = "", full = false } = {}) {
  const safe = (v) => String(v).replace(/[<>;{}]/g, "");
  const theme = { ...vars, ...(accent ? { "--ash-accent": accent } : {}) };
  const declarations = Object.entries(theme).filter(([k]) => k.startsWith("--")).map(([k, v]) => `${k}:${safe(v)}`).join(";");
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{${declarations};color-scheme:${vars.scheme === "dark" ? "dark" : "light"}}html,body{margin:0;background:var(--ash-bg);color:var(--ash-text);font-family:system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}</style>` +
    `<script>${miniAppBridge(token, full)}</script>`;
  const source = String(html ?? "");
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source);
  return doctype ? `${doctype[0]}${head}${source.slice(doctype[0].length)}` : `<!doctype html>${head}${source}`;
}

/** A mini app's `call` / `ask` / `tell` request made safe to send; null when it is none of them. */
export function miniAppRequest(request) {
  if (!plain(request)) return null;
  const call = request.call;
  if (plain(call) && typeof call.member === "string" && call.member && call.member.length <= 128 && typeof call.word === "string" && call.word && call.word.length <= 128) {
    const body = plain(call.body) ? call.body : {};
    let size = 0; try { size = JSON.stringify(body).length; } catch { return null; }
    return size > 16 * 1024 ? null : { call: { member: call.member, word: call.word, body: clone(body) } };
  }
  for (const kind of ["ask", "tell"]) {
    const value = request[kind];
    if (plain(value) && typeof value.text === "string" && value.text.trim() && value.text.length <= 4000) return { [kind]: { text: value.text } };
  }
  return null;
}

const only = (value, keys) => plain(value) && Object.keys(value).every((key) => keys.includes(key));

/** The params of [method] checked against its schema (no other keys): the event of a send, the request of a press; null when they do not match. */
function miniAppParams(method, params) {
  if (method === "ash/send") {
    if (!only(params, ["action", "context"]) || typeof params.action !== "string" || !EVENT_NAME.test(params.action)) return null;
    if (params.context !== undefined && !plain(params.context)) return null;
    const context = params.context ?? {};
    let size = 0; try { size = JSON.stringify(context).length; } catch { return null; }
    return size > 16 * 1024 ? null : { name: params.action, ...(Object.keys(context).length ? { context: clone(context) } : {}) };
  }
  if (method === "ash/call") {
    if (!only(params, ["member", "word", "body"]) || (params.body !== undefined && !plain(params.body))) return null;
    return miniAppRequest({ call: params });
  }
  const kind = method.slice(4);
  return only(params, ["text"]) ? miniAppRequest({ [kind]: params }) : null;
}

/**
 * One message posted by a mini app, checked against the frame's current load: `{g, m}` with [token] as `g` (an older load's
 * token is a stranger) and `m` the JSON text, at most 64 KB, of `{jsonrpc: "2.0", id, method, params}` with a known method
 * whose params match their schema; `call` / `ask` / `tell` only when [full] (a card of an app). The result is
 * `{method, id, params}`, or `{refused, id}` (`id` only when the message could be read far enough to answer it).
 */
export function miniAppRpc(data, { token, full = false }) {
  if (!token || !only(data, ["g", "m"]) || data.g !== token || typeof data.m !== "string") return { refused: "stranger" };
  if (data.m.length > MINI_APP_MAX_BYTES || new TextEncoder().encode(data.m).byteLength > MINI_APP_MAX_BYTES) return { refused: "size" };
  let message;
  try { message = JSON.parse(data.m); } catch { return { refused: "schema" }; }
  if (!only(message, ["jsonrpc", "id", "method", "params"]) || message.jsonrpc !== "2.0") return { refused: "schema" };
  const id = (typeof message.id === "string" && RPC_ID.test(message.id)) || Number.isSafeInteger(message.id) ? message.id : undefined;
  if (message.id !== undefined && id === undefined) return { refused: "schema" };
  if (!MINI_APP_METHODS.includes(message.method)) return { refused: "schema", id };
  if (message.method !== "ash/send" && id === undefined) return { refused: "schema" };
  if (message.method !== "ash/send" && !full) return { refused: "forbidden", id };
  const params = miniAppParams(message.method, message.params);
  return params ? { method: message.method, id, params } : { refused: "schema", id };
}

/**
 * A message from a mini app: only from the window of a frame this page made (a nested frame or another window is no one),
 * only with its current load's token, and only as `miniAppRpc` reads it. A press is answered into the same load.
 */
export function frameMessage(event) {
  for (const entry of frames) {
    if (entry.frame.isConnected === false && entry.mounted) { frames.delete(entry); continue; }
    if (entry.frame.isConnected) entry.mounted = true;
    if (!event?.source || entry.frame.contentWindow !== event.source) continue;
    const rpc = miniAppRpc(event.data, entry);
    if (rpc.refused) {
      if (rpc.id !== undefined) entry.answer(rpc.id, { state: "failed", text: rpc.refused === "forbidden" ? "这张卡不能这样做。" : "这个请求看不懂。" }, entry.token);
      return false;
    }
    if (rpc.method === "ash/send") entry.send(rpc.params);
    else entry.act(rpc.id, rpc.params);
    return true;
  }
  return false;
}

function listen() {
  if (listening || typeof globalThis.addEventListener !== "function") return;
  listening = true;
  globalThis.addEventListener("message", frameMessage);
}

// ---------------------------------------------------------------------------------------------------------------------
// Opening what a card points at.

/** `openUrl` / `openApp` / `openAsh`, as a home-screen card's tap does them on the phone. */
export function openAction(action) {
  if (action?.openUrl && typeof action.openUrl.url === "string") {
    let url; try { url = new URL(action.openUrl.url); } catch { return false; }
    if (!["https:", "http:", "mailto:", "tel:", "sms:", "geo:"].includes(url.protocol)) return false;
    globalThis.open?.(url.href, "_blank", "noopener,noreferrer");
    return true;
  }
  if (action?.openApp && typeof action.openApp.app === "string") {
    globalThis.dispatchEvent?.(new CustomEvent("ash:open", { cancelable: true, detail: { page: "home", section: "app", arg: action.openApp.app } }));
    return true;
  }
  if (action?.openAsh) { globalThis.dispatchEvent?.(new CustomEvent("ash:open", { cancelable: true, detail: { page: "home" } })); return true; }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drawing. A card is drawn once into its root and then patched there: every component keeps its element by the plan's
// stable id, and a new plan (live data, a button's state, the lifecycle) changes only what it changes. A component whose
// structure changed (another kind of element) is drawn anew alone; its unchanged children move over as they are.

const make = (tag, className = "", value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
};
const setText = (el, value) => { const next = String(value ?? ""); if (el.textContent !== next) el.textContent = next; };
const setClass = (el, className) => { if (el.className !== className) el.className = className; };
const setAttr = (el, name, value) => {
  if (value === null || value === undefined) { if (el.getAttribute?.(name) != null) el.removeAttribute?.(name); }
  else if (el.getAttribute?.(name) !== String(value)) el.setAttribute(name, String(value));
};
const setProp = (el, name, value) => { if (el[name] !== value) el[name] = value; };

/** Makes [parent]'s children exactly [els], in order, moving only what is out of place. */
function arrange(parent, els) {
  const keep = new Set(els);
  for (const child of [...(parent.childNodes ?? parent.children ?? [])]) if (!keep.has(child)) child.remove();
  let at = parent.firstChild ?? null;
  for (const el of els) {
    if (el === at) { at = at.nextSibling ?? null; continue; }
    parent.insertBefore(el, at);
  }
}

/**
 * Draws the conversation card [item] (`card.type === "a2ui"`). [ctx] holds what the card does to the hub:
 * `draft(cardId, data)`, `vaultSet({ref, value, label, kind})`, `answerForm({to, reply_to, body, client_id})`,
 * `say(to, text, card)`, `refresh(messageId)`, `open(action)`, `problem(text)`. Without it the card is read-only.
 */
export function renderA2uiCard(parent, item, ctx = null) {
  const root = text(parent, "div", "", "a-card card a2ui");
  root.dataset.cardId = String(item?.card?.id ?? "");
  try {
    if (!parsePlan(item?.card?.plan)) throw new Error("no plan");
    const s = stateFor(item);
    s.ctx = ctx;
    for (const view of s.ui?.views.values() ?? []) view.dispose?.();
    s.ui = { root, body: text(root, "div", "", "a2-col a2-body-root"), views: new Map(), footer: {}, error: null, status: null };
    draw(s);
  } catch {
    const s = states.get(item?.card?.id);
    if (s?.ui?.root === root) s.ui = null;
    root.replaceChildren();
    root.className = "a-card card a2ui a2-plain";
    text(root, "div", item?.card?.text || "一张卡片", "card-body a2-plain-text");
  }
  return root;
}

/**
 * Patches the card drawn in [root] with [item] in place, component by component; false when it cannot (another card, or
 * not drawn here), and the row must be drawn anew.
 */
export function updateA2uiCard(root, item, ctx = null) {
  const card = item?.card;
  const s = plain(card) && typeof card.id === "string" ? states.get(card.id) : null;
  if (!s || !root || s.ui?.root !== root || !parsePlan(card.plan)) return false;
  stateFor(item);
  s.ctx = ctx;
  try { draw(s); return true; } catch { return false; }
}

/** The card of state [s] patched after a local change or a pushed card. */
function redraw(s) { if (s.ui) try { draw(s); } catch { /* the next full draw shows its plain text */ } }

/** Cards with a change held back (a selected text, an input being edited): patched again once the owner lets go. */
function later(s) {
  later.cards.add(s);
  const doc = s.ui?.root?.ownerDocument ?? globalThis.document;
  if (later.listening || typeof doc?.addEventListener !== "function") return;
  later.listening = true;
  let queued = false;
  const again = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; const cards = [...later.cards]; later.cards.clear(); for (const card of cards) redraw(card); }, 0);
  };
  for (const type of ["selectionchange", "focusout", "compositionend", "pointerup"]) doc.addEventListener(type, () => { if (later.cards.size) again(); }, true);
}
later.cards = new Set();
later.listening = false;

function draw(s) {
  const ui = s.ui, card = s.item.card;
  const plan = parsePlan(s.plan) ?? parsePlan(card.plan);
  if (!plan) throw new Error("no plan");
  release(s);
  s.byId = plan.byId;
  s.reactive = plan.reactive;
  s.accent = plan.theme ? cssColor(plan.theme.accent) : null;
  if (s.accent) { if ((ui.root.style.getPropertyValue?.("--you") ?? ui.root.style["--you"]) !== s.accent) ui.root.style.setProperty("--you", s.accent); }
  else ui.root.style.removeProperty?.("--you");
  const closed = stateLine(card, s);
  const pass = { s, card, closed, live: !closed && !!s.ctx, seen: new Set(), deferred: false };
  pass.draw = (parentView, id, depth, kind) => drawId(pass, parentView, id, depth, kind);
  const top = pass.draw(null, plan.root, 0, "Column");
  if (!top) throw new Error("nothing drawn");
  arrange(ui.body, [top.el]);
  for (const [id, view] of ui.views) if (!pass.seen.has(id)) { view.dispose?.(); ui.views.delete(id); }
  chrome(s, closed, pass.live);
  if (pass.deferred || s.held.size) later(s);
}

/** The lines under the body: the error, how the card ended or what is being sent, the footer; read-only when it takes no input. */
function chrome(s, closed, live) {
  const ui = s.ui, card = s.item.card;
  const line = (el, value, className) => {
    if (!value) return null;
    el ??= make("div", className);
    setText(el, value);
    return el;
  };
  ui.error = line(ui.error, s.error, "card-note a2-error");
  ui.status = line(ui.status, closed || (s.busy ? (plain(card.form) ? "正在提交…" : "正在发送…") : ""), "a2-status");
  arrange(ui.root, [ui.body, ui.error, ui.status, footer(s, closed)].filter(Boolean));
  if (live) ui.root.classList.remove("a2-readonly"); else ui.root.classList.add("a2-readonly");
}

/** Draws (or patches) component [id] for [parentView] (null for the root), drawn in a parent of kind [kind]. */
function drawId(pass, parentView, id, depth, kind) {
  const s = pass.s;
  const node = s.byId.get(id);
  const spec = node && Object.hasOwn(COMPONENTS, node.component) ? COMPONENTS[node.component] : null;
  // A component is drawn once per card: a second mention of an id (or a circle) draws nothing.
  if (!spec || depth > MAX_DEPTH || pass.seen.has(id)) return null;
  // A node that cannot be drawn as it is (a picture without a usable url, tabs without tabs) is left out.
  const shape = spec.shape ? spec.shape(node, pass) : node.component;
  if (shape === null) return null;
  pass.seen.add(id);
  let view = s.ui.views.get(id);
  if (view && view.shape !== shape) { view.dispose?.(); view = null; }
  if (!view) {
    view = { id, shape, node, d: {}, sig: null, tapping: false };
    spec.make(view, node, pass);
    view.el.dataset.a2Id = id;
    s.ui.views.set(id, view);
  }
  view.node = node;
  view.parentKind = kind;
  view.tapping = node.component !== "Button" && plain(node.action);
  spec.update(view, node, pass, depth);
  dress(view, parentView, spec);
  tap(view, pass);
  return view;
}

/** Sets [view]'s element class to [className] (and `a2-tap` while it is a tap target). */
const base = (view, className) => setClass(view.el, view.tapping ? `${className} a2-tap` : className);

/** The node's own style (and its component's layout) on its element, again only when one of them changed. */
function dress(view, parentView, spec) {
  const node = view.node, el = view.el;
  const stack = parentView?.node.component === "Stack";
  const place = stack ? (node.style?.place ?? parentView.node.align ?? "topStart") : null;
  const sig = JSON.stringify([node.style ?? null, node.weight ?? null, node.visible === false, node.a11y ?? null, node.justify ?? null, node.align ?? null,
    node.gap ?? null, node.columns ?? null, node.direction ?? null, node.size ?? null, node.fit ?? null, node.variant ?? null, view.parentKind, place]);
  if (sig === view.sig) return;
  view.sig = sig;
  el.style.cssText = "";
  spec.own?.(view, node);
  applyStyle(el, node, view.parentKind);
  if (!node.a11y) setAttr(el, "aria-label", null);
  if (place) { const [block, inlinePlace] = PLACE[place] ?? PLACE.topStart; el.style.alignSelf = block; el.style.justifySelf = inlinePlace; }
  if (node.visible === false) el.style.setProperty("display", "none", "important");
}

/** Anything with an action but a Button is a tap target: one listener, which reads the node of the moment. */
function tap(view, pass) {
  const node = view.node, el = view.el, s = pass.s;
  if (view.tapping) {
    if (!view.listening) {
      view.listening = true;
      el.addEventListener("click", (event) => {
        if (el.getAttribute("aria-disabled") === "true" || !plain(view.node.action)) return;
        event?.preventDefault?.();
        void perform(s, view.node.action, s.byId, view.node);
      });
    }
    setAttr(el, "role", "button");
    setProp(el, "tabIndex", 0);
    const pressed = runtimeKind(node.action) && buttonView(pass.card, s, node.id, node.action).busy;
    setAttr(el, "aria-disabled", (!pass.live && ("event" in node.action || runtimeKind(node.action))) || pressed ? "true" : null);
  } else if (view.listening) {
    setAttr(el, "role", null);
    setAttr(el, "aria-disabled", null);
    setProp(el, "tabIndex", -1);
  }
}

/** The children [ids] of [view] drawn into [into] (its element by default), in order. */
function kids(view, ids, pass, depth, into = view.el, kind = view.node.component) {
  const els = [];
  for (const id of ids) { const child = pass.draw(view, id, depth + 1, kind); if (child) els.push(child.el); }
  arrange(into, els);
}
const childIds = (node) => Array.isArray(node.children) ? node.children.filter((id) => typeof id === "string") : [];

/** A changed working copy: drafted after a pause; [path] (a bind path) now holds the owner's value. */
function changed(s, path) {
  s.version++;
  if (typeof path === "string") s.touched.set(path, s.version);
  if (s.error) { s.error = ""; redraw(s); }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { void draft(s); }, DRAFT_DELAY_MS);
  s.timer.unref?.();
}
function write(s, path, value, again = false) {
  if (typeof path !== "string" || !writePointer(s.data, path, value)) return;
  changed(s, path);
  if (again) redraw(s);
}
const valueAt = (s, node, fallback) => { if (typeof node.bind !== "string") return fallback; const v = readPointer(s.data, node.bind); return v === undefined ? fallback : v; };

/** An input of [view]: who edits it (focus, IME composition, a dragged slider) and what follows when the editing ends. */
function watch(view, s, input, { drag = false } = {}) {
  (view.inputs ??= []).push(input);
  input.addEventListener("compositionstart", () => { view.composing = true; });
  input.addEventListener("compositionend", () => { view.composing = false; settle(s); });
  input.addEventListener("blur", () => { view.dragging = false; settle(s); });
  if (drag) {
    input.addEventListener("pointerdown", () => { view.dragging = true; });
    for (const type of ["pointerup", "pointercancel", "change"]) input.addEventListener(type, () => { view.dragging = false; settle(s); });
  }
}

/** The owner may have stopped editing an input of the card: what was held for it is drawn now (see `release`). */
function settle(s) {
  const timer = setTimeout(() => redraw(s), 0);
  timer.unref?.();
}

/**
 * The hub's values held beside inputs the owner no longer edits come in, unless the owner changed the field meanwhile: the
 * owner's value wins then, and goes with the next draft.
 */
function release(s) {
  for (const [id, held] of s.held) {
    const view = s.ui.views.get(id);
    if (view && inputEditing(view)) continue;
    s.held.delete(id);
    if (same(readPointer(s.data, held.path), held.local) && !s.touched.has(held.path)) writePointer(s.data, held.path, clone(held.value));
  }
}

/** Whether an input's shown value may be set now: never while the owner edits it. */
const free = (view) => !inputEditing(view);

const IMAGE_FIT = { contain: "contain", cover: "cover", fill: "fill", none: "none", scaleDown: "scale-down" };
/** Image variants whose box the stylesheet sizes in both directions (ash-ui.css .a2-img-*). */
const IMAGE_BOX = { icon: [true, true], avatar: [true, true], smallFeature: [true, true], mediumFeature: [true, true], header: [true, true], largeFeature: [true, false] };
const imageSrc = (url) => url === "avatar" || url.startsWith("avatar:") ? avatarUrl(url === "avatar" ? "default" : url.slice(7))
  : /^https:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,/i.test(url) ? url : null;
const imageKind = (url) => url.startsWith("icon:") ? "icon" : imageSrc(url) ? "img" : null;
const tabsOf = (node) => Array.isArray(node.tabs) ? node.tabs.filter((t) => plain(t) && typeof t.child === "string") : [];
const optionsOf = (node) => Array.isArray(node.options) ? node.options.filter((o) => plain(o) && typeof o.value === "string") : [];
const lined = (node) => Boolean(runtimeKind(node.action) || plain(node.action?.copy));
const dateType = (node) => { const date = node.enableDate !== false, time = node.enableTime === true; return date && time ? "datetime-local" : date ? "date" : "time"; };
const saveable = (card) => AGENT.test(card.owner ?? "") && !card.app && card.temporary_app !== true;
const appOf = (card) => typeof card.app === "string" && card.app !== "" ? card.app : null;

/** A field's label above its control, present only while the node has one. */
function label(view, wrap, node, control, className = "a2-label") {
  if (node.label) { view.labelEl ??= make("span", className); setText(view.labelEl, node.label); }
  arrange(wrap, [node.label ? view.labelEl : null, control].filter(Boolean));
}

/** A frame's Html loaded again (a new load, a new token): only when its html changed, or it went somewhere else. */
function loadFrame(view, s) {
  const card = s.item.card, entry = view.entry;
  // Who the frame speaks for is bound here, for this load.
  Object.assign(entry, { token: newToken(), card: card.id, component: view.id, app: appOf(card) });
  entry.full = entry.app !== null;
  view.expected = view.loads + 1;
  view.frame.srcdoc = miniAppDocument(view.d.html ?? "", themeVars(), s.accent, { token: entry.token, full: entry.full });
}

const COMPONENTS = {
  Text: {
    make(view) { view.el = make("div"); },
    update(view, node, pass) {
      base(view, `a2-text a2-${["h1", "h2", "h3", "h4", "h5", "caption"].includes(node.variant) ? node.variant : "body"}`);
      if (view.d.text === (node.text ?? "")) return;
      // Text the owner is selecting stays as it is until the selection ends.
      if (view.d.text !== undefined && selected(view.el)) { pass.deferred = true; return; }
      view.d.text = node.text ?? "";
      view.el.replaceChildren();
      appendCardMarkdown(view.el, view.d.text);
    },
  },
  Image: {
    shape: (node) => { const kind = imageKind(String(node.url ?? "")); return kind ? `Image:${kind}` : null; },
    make(view, node) {
      if (view.shape === "Image:icon") { view.el = make("span"); return; }
      const img = make("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      view.el = img;
    },
    update(view, node) {
      const url = String(node.url ?? "");
      if (view.shape === "Image:icon") {
        base(view, "a2-icon");
        if (view.d.url !== url) { view.d.url = url; view.el.replaceChildren(); drawIcon(view.el, url.slice(5), "i-l"); }
        return;
      }
      base(view, `a2-img a2-img-${node.variant ?? "plain"}`);
      setProp(view.el, "alt", String(node.a11y ?? ""));
      const src = imageSrc(url);
      // The box keeps its size; only the picture changes.
      if (view.d.src !== src) { view.d.src = src; view.el.src = src; }
    },
    // The box has its size before the picture comes: the node's width / height, its variant's, or 16:9 of the width.
    own(view, node) {
      if (view.shape === "Image:icon") return;
      const st = view.el.style, style = plain(node.style) ? node.style : {};
      const fit = IMAGE_FIT[node.fit];
      if (fit) st.objectFit = fit;
      const [wide, high] = IMAGE_BOX[node.variant] ?? [false, false];
      const width = Number.isFinite(style.width) || style.width === "fill" || wide, height = Number.isFinite(style.height) || high;
      if (!height) { st.aspectRatio = "16 / 9"; if (!width) st.width = "100%"; }
    },
  },
  Icon: {
    make(view) { view.el = make("span"); },
    update(view, node) {
      base(view, "a2-icon");
      const key = typeof node.svgPath === "string" ? `path:${node.svgPath}` : `name:${node.name}`;
      if (view.d.key === key) return;
      view.d.key = key;
      view.el.replaceChildren();
      if (typeof node.svgPath === "string") {
        // A closed shape is filled; an outline (a path never closed with Z) is stroked like the line icons.
        const svg = svgNode("svg", { class: /[zZ]/.test(node.svgPath) ? "i i-s i-solid" : "i i-s", viewBox: "0 0 24 24", "aria-hidden": "true" }, view.el);
        svgNode("path", { d: node.svgPath }, svg);
      } else drawIcon(view.el, node.name);
    },
  },
  Row: {
    make(view) { view.el = make("div"); },
    update(view, node, pass, depth) { base(view, `${node.component === "Row" ? "a2-row" : "a2-col"}${node.justify === "stretch" ? " a2-stretch" : ""}`); kids(view, childIds(node), pass, depth); },
    own(view, node) {
      const st = view.el.style;
      if (JUSTIFY[node.justify]) st.justifyContent = node.justify === "stretch" ? "flex-start" : JUSTIFY[node.justify];
      if (ALIGN[node.align]) st.alignItems = ALIGN[node.align];
      if (Number.isFinite(node.gap) && node.gap >= 0) st.gap = px(node.gap);
    },
  },
  Stack: {
    make(view) { view.el = make("div"); },
    update(view, node, pass, depth) { base(view, "a2-stack"); kids(view, childIds(node), pass, depth); },
  },
  Grid: {
    make(view) { view.el = make("div"); },
    update(view, node, pass, depth) { base(view, "a2-grid"); kids(view, childIds(node), pass, depth); },
    own(view, node) {
      view.el.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(12, node.columns ?? 2))}, minmax(0, 1fr))`;
      if (Number.isFinite(node.gap) && node.gap >= 0) view.el.style.gap = px(node.gap);
    },
  },
  List: {
    make(view) { view.el = make("div"); },
    update(view, node, pass, depth) {
      base(view, node.direction === "horizontal" ? "a2-hlist" : node.columns > 1 ? "a2-grid" : "a2-col");
      kids(view, childIds(node), pass, depth);
    },
    own(view, node) {
      const st = view.el.style;
      if (node.direction !== "horizontal" && node.columns > 1) st.gridTemplateColumns = `repeat(${node.columns}, minmax(0, 1fr))`;
      if (ALIGN[node.align]) st.alignItems = ALIGN[node.align];
      if (Number.isFinite(node.gap) && node.gap >= 0) st.gap = px(node.gap);
    },
  },
  Card: {
    make(view) { view.el = make("div"); },
    update(view, node, pass, depth) { base(view, "a2-card"); kids(view, typeof node.child === "string" ? [node.child] : [], pass, depth); },
  },
  Tabs: {
    shape: (node) => tabsOf(node).length ? "Tabs" : null,
    make(view) {
      view.el = make("div");
      view.strip = make("div", "a2-tabs");
      view.strip.setAttribute("role", "tablist");
      view.body = make("div", "a2-col a2-tab-body");
      view.el.append(view.strip, view.body);
      view.tabs = [];
    },
    update(view, node, pass, depth) {
      const s = pass.s, tabs = tabsOf(node);
      base(view, "a2-tabs-box");
      const titles = JSON.stringify(tabs.map((tab) => String(tab.title ?? "")));
      if (view.d.titles !== titles) {
        view.d.titles = titles;
        view.tabs = tabs.map((tab, i) => {
          const b = make("button", "a2-tab", String(tab.title ?? ""));
          b.type = "button";
          b.setAttribute("role", "tab");
          b.addEventListener("click", () => { if (s.tabs[view.id] === i) return; s.tabs[view.id] = i; redraw(s); });
          return b;
        });
        arrange(view.strip, view.tabs);
      }
      const chosen = Math.min(tabs.length - 1, Math.max(0, s.tabs[node.id] ?? node.selected ?? 0));
      view.tabs.forEach((b, i) => { setClass(b, `a2-tab${i === chosen ? " on" : ""}`); setAttr(b, "aria-selected", String(i === chosen)); });
      kids(view, [tabs[chosen].child], pass, depth, view.body, "Column");
    },
  },
  Divider: {
    make(view) { view.el = make("div"); },
    update(view, node) { base(view, node.axis === "vertical" ? "a2-divider v" : "a2-divider"); },
  },
  Spacer: {
    make(view) { view.el = make("div"); },
    update(view) { base(view, "a2-spacer"); },
    own(view, node) {
      const st = view.el.style;
      if (Number.isFinite(node.size)) { st.flex = `0 0 ${px(node.size)}`; st.minWidth = st.minHeight = px(node.size); }
      else st.flex = "1 1 0";
    },
  },
  Button: {
    // A press the hub runs, or a copy, has a line under the button for its outcome (「已复制」, 「已完成 · 10:42」, why it failed).
    shape: (node) => `Button:${lined(node)}`,
    make(view, node, pass) {
      const s = pass.s;
      view.button = make("button");
      view.button.type = "button";
      view.button.addEventListener("click", (event) => { event?.preventDefault?.(); void perform(s, view.node.action, s.byId, view.node); });
      view.busy = make("span", "a2-text", "处理中…");
      if (view.shape === "Button:true") { view.el = make("div"); view.el.append(view.button); } else view.el = view.button;
    },
    update(view, node, pass, depth) {
      const s = pass.s, b = view.button, line = view.shape === "Button:true";
      const variant = node.variant === "primary" ? "btn-primary" : node.variant === "borderless" ? "btn-ghost" : "btn-neutral";
      const state = line ? buttonView(pass.card, s, node.id, node.action) : { busy: false, line: null };
      setClass(b, `a-btn btn-sm a2-btn ${variant}`);
      // The label stays drawn (and kept) while 「处理中…」 stands in its place.
      const child = typeof node.child === "string" ? pass.draw(view, node.child, depth + 1, "Button") : null;
      arrange(b, state.busy ? [view.busy] : child ? [child.el] : []);
      setAttr(b, "aria-busy", state.busy ? "true" : null);
      setProp(b, "disabled", node.disabled === true || !pass.live || s.busy || !node.action || state.busy);
      if (!line) return;
      base(view, `a2-act${node.style?.width === "fill" || Number.isFinite(node.style?.width) ? " a2-act-fill" : ""}`);
      if (state.line) {
        view.line ??= make("div");
        setClass(view.line, `a2-act-line${state.line.state === "failed" ? " failed" : ""}`);
        setText(view.line, state.line.text);
      }
      arrange(view.el, state.line ? [b, view.line] : [b]);
    },
  },
  CheckBox: {
    make(view, node, pass) {
      const s = pass.s, sw = node.component === "Switch";
      view.el = make("label");
      view.input = make("input");
      view.input.type = "checkbox";
      if (sw) { view.input.className = "a2-switch"; view.input.setAttribute("role", "switch"); }
      view.input.addEventListener("change", () => write(s, view.node.bind, view.input.checked === true));
      watch(view, s, view.input);
      view.text = make("span", "a2-check-label");
      if (sw) view.el.append(view.text, view.input); else view.el.append(view.input, view.text);
    },
    update(view, node, pass) {
      base(view, `a2-check${node.component === "Switch" ? " a2-switch-row" : ""}`);
      setText(view.text, node.label ?? "");
      if (free(view)) setProp(view.input, "checked", valueAt(pass.s, node, node.checked === true) === true);
      setProp(view.input, "disabled", !pass.live || node.disabled === true);
    },
  },
  ChoicePicker: {
    shape: (node) => `ChoicePicker:${!!node.chips}:${!!node.multiple}:${JSON.stringify(optionsOf(node).map((o) => o.value))}`,
    make(view, node, pass) {
      const s = pass.s;
      view.el = make("div");
      view.list = make("div", node.chips ? "opts a2-chips" : "a2-col a2-choice-list");
      const choose = (value, on) => {
        const now = view.node, options = optionsOf(now), chosen = view.chosen ?? new Set();
        const next = now.multiple ? options.map((o) => o.value).filter((v) => v === value ? on : chosen.has(v)) : on ? [value] : [];
        write(s, now.bind, next, true);
      };
      view.options = optionsOf(node).map((o, i) => {
        if (node.chips) {
          const b = make("button");
          b.type = "button";
          b.addEventListener("click", () => choose(o.value, view.node.multiple ? !view.chosen?.has(o.value) : true));
          view.list.append(b);
          return { button: b };
        }
        const row = make("label", "a2-check");
        const input = make("input");
        input.type = node.multiple ? "checkbox" : "radio";
        input.addEventListener("change", () => choose(o.value, input.checked === true));
        watch(view, s, input);
        const words = make("span", "a2-check-label");
        row.append(input, words);
        view.list.append(row);
        return { input, words };
      });
    },
    update(view, node, pass) {
      const s = pass.s, card = pass.card, options = optionsOf(node);
      base(view, "a2-field a2-choice");
      label(view, view.el, node, view.list);
      const given = valueAt(s, node, null);
      view.chosen = new Set(Array.isArray(given) ? given.filter((v) => typeof v === "string") : options.filter((o) => o.checked).map((o) => o.value));
      const editing = !free(view);
      options.forEach((o, i) => {
        const on = view.chosen.has(o.value), words = String(o.label ?? o.value), part = view.options[i], drawn = view.d[i];
        if (part.button) {
          setClass(part.button, `opt${on ? " on" : ""}`);
          setAttr(part.button, "aria-pressed", String(on));
          setProp(part.button, "disabled", !pass.live);
          if (drawn?.on !== on || drawn?.words !== words) {
            part.button.replaceChildren();
            if (on) { addIcon(part.button, "check", "i-xs"); text(part.button, "span", words); } else part.button.textContent = words;
          }
        } else {
          setProp(part.input, "name", `a2-${card.id}-${node.id}`);
          if (!editing) setProp(part.input, "checked", on);
          setProp(part.input, "disabled", !pass.live);
          setText(part.words, words);
        }
        view.d[i] = { on, words };
      });
    },
  },
  ProgressBar: {
    make(view) {
      view.el = make("div");
      view.track = make("div", "a2-track");
      view.fill = make("div", "a2-fill");
      view.track.append(view.fill);
      view.track.setAttribute("role", "progressbar");
      view.track.setAttribute("aria-valuemin", "0");
    },
    update(view, node) {
      base(view, "a2-field a2-progress");
      label(view, view.el, node, view.track);
      const max = Number.isFinite(node.max) && node.max > 0 ? node.max : 100;
      const value = Math.min(max, Math.max(0, Number(node.value) || 0));
      const width = `${Math.round(value / max * 1000) / 10}%`;
      if (view.fill.style.width !== width) view.fill.style.width = width;
      setAttr(view.track, "aria-valuemax", String(max));
      setAttr(view.track, "aria-valuenow", String(value));
    },
  },
  Badge: {
    make(view) { view.el = make("span"); },
    update(view, node) { base(view, "a2-badge"); setText(view.el, node.text ?? ""); },
  },
  Clock: {
    make(view) { view.el = make("span"); ticking(view.el, () => setText(view.el, formatClock(new Date(), view.node.format || "HH:mm", view.node.timeZone))); },
    update(view, node) {
      base(view, "a2-text a2-body a2-clock");
      const key = `${node.format}\0${node.timeZone}`;
      if (view.d.key !== undefined && view.d.key !== key) setText(view.el, formatClock(new Date(), node.format || "HH:mm", node.timeZone));
      view.d.key = key;
    },
  },
  Timer: {
    make(view) { view.el = make("span"); ticking(view.el, () => setText(view.el, timerText(view.node))); },
    update(view, node) {
      base(view, "a2-text a2-body a2-timer");
      const key = `${node.since}\0${node.until}`;
      if (view.d.key !== undefined && view.d.key !== key) setText(view.el, timerText(node));
      view.d.key = key;
    },
  },
  Chart: {
    make(view) {
      view.el = make("div");
      view.width = 0;
      const measure = () => chartPaint(view, view.el.clientWidth || 300);
      globalThis.requestAnimationFrame?.(measure);
      if (typeof globalThis.ResizeObserver === "function") { const observer = new ResizeObserver(measure); observer.observe(view.el); view.dispose = () => observer.disconnect(); }
    },
    update(view, node) {
      base(view, "a2-chart-box");
      const key = JSON.stringify([node.series ?? [], node.gap ?? null, chartHeight(node)]);
      if (view.d.key === key) return;
      view.d.key = key;
      view.width = 0;
      chartPaint(view, view.el.clientWidth || 300);
    },
    own(view, node) { view.el.style.height = px(chartHeight(node)); },
  },
  TextField: {
    shape: (node) => `TextField:${node.variant === "longText" ? "long" : node.variant === "obscured" ? "secret" : "text"}`,
    make(view, node, pass) {
      const s = pass.s, obscured = view.shape === "TextField:secret", long = view.shape === "TextField:long";
      view.el = make("label");
      const input = view.input = make(long ? "textarea" : "input", "a2-input");
      if (!long) input.type = obscured ? "password" : "text";
      if (obscured) { input.autocomplete = "new-password"; input.spellcheck = false; }
      // A password never enters the card's data: it is kept apart and goes to the vault on 「提交」.
      if (obscured) input.addEventListener("input", () => { passwordsOf(s).set(secretKey(view.node), input.value); if (s.error) { s.error = ""; redraw(s); } });
      else input.addEventListener("input", () => write(s, view.node.bind, input.value));
      watch(view, s, input);
    },
    update(view, node, pass) {
      const s = pass.s, input = view.input;
      base(view, "a2-field");
      label(view, view.el, node, input);
      if (node.variant === "number" || input.inputMode) setProp(input, "inputMode", node.variant === "number" ? "decimal" : "");
      setProp(input, "placeholder", String(node.placeholder ?? ""));
      const value = view.shape === "TextField:secret" ? passwordsOf(s).get(secretKey(node)) ?? "" : String(valueAt(s, node, node.text ?? "") ?? "");
      // Never set while the owner types in it (focus, IME composition, a selection): it would take the caret and the composing text.
      if (free(view)) setProp(input, "value", value);
      setProp(input, "disabled", !pass.live);
    },
  },
  DateTimeInput: {
    shape: (node) => `DateTimeInput:${dateType(node)}`,
    make(view, node, pass) {
      const s = pass.s;
      view.el = make("label");
      view.input = make("input", "a2-input");
      view.input.type = dateType(node);
      view.input.addEventListener("change", () => write(s, view.node.bind, view.input.value));
      watch(view, s, view.input);
    },
    update(view, node, pass) {
      base(view, "a2-field");
      label(view, view.el, node, view.input);
      const raw = String(valueAt(pass.s, node, node.text ?? "") ?? ""), type = view.input.type;
      const value = type === "datetime-local" ? raw.slice(0, 16) : type === "date" ? raw.slice(0, 10) : /^\d{2}:\d{2}/.test(raw) ? raw.slice(0, 5) : /T(\d{2}:\d{2})/.exec(raw)?.[1] ?? "";
      if (free(view)) setProp(view.input, "value", value);
      setProp(view.input, "disabled", !pass.live);
    },
  },
  Slider: {
    make(view, node, pass) {
      const s = pass.s;
      view.el = make("label");
      view.row = make("div", "a2-row a2-slider-row");
      view.input = make("input", "a2-slider");
      view.input.type = "range";
      view.shown = make("span", "a2-slider-value");
      view.row.append(view.input, view.shown);
      view.input.addEventListener("input", () => { setText(view.shown, view.input.value); write(s, view.node.bind, Number(view.input.value)); });
      watch(view, s, view.input, { drag: true });
    },
    update(view, node, pass) {
      base(view, "a2-field");
      label(view, view.el, node, view.row);
      const min = Number.isFinite(node.min) ? node.min : 0, max = Number.isFinite(node.max) ? node.max : 100;
      setProp(view.input, "min", String(min));
      setProp(view.input, "max", String(max));
      setProp(view.input, "step", Number.isFinite(node.step) ? String(node.step) : "any");
      if (free(view)) {
        const value = Number(valueAt(pass.s, node, node.value ?? min));
        setProp(view.input, "value", String(Number.isFinite(value) ? value : min));
        setText(view.shown, view.input.value);
      }
      setProp(view.input, "disabled", !pass.live);
    },
  },
  Table: {
    make(view) { view.el = make("div"); view.table = make("table", "a2-table"); view.el.append(view.table); },
    update(view, node, pass) {
      base(view, "a2-table-wrap");
      const key = JSON.stringify([node.header ?? null, node.rows ?? null]);
      if (view.d.key === key) return;
      if (view.d.key !== undefined && selected(view.el)) { pass.deferred = true; return; }
      view.d.key = key;
      view.table.replaceChildren();
      const header = Array.isArray(node.header) ? node.header : [];
      if (header.length) { const tr = text(text(view.table, "thead", ""), "tr", ""); for (const h of header) cellMarkdown(text(tr, "th", ""), h); }
      const body = text(view.table, "tbody", "");
      for (const row of Array.isArray(node.rows) ? node.rows : []) {
        const tr = text(body, "tr", "");
        for (const cell of Array.isArray(row) ? row : []) cellMarkdown(text(tr, "td", ""), cell);
      }
    },
  },
  Html: {
    shape: (node, pass) => `Html:${saveable(pass.card)}`,
    make(view, node, pass) {
      const s = pass.s;
      view.el = make("div");
      const frame = view.frame = make("iframe", "a2-html");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("title", "小应用");
      view.loads = 0;
      view.expected = 1;
      // The frame may only show its own document: a navigation away from it loads the document again (a new token).
      frame.addEventListener("load", () => { view.loads++; if (view.loads > view.expected) loadFrame(view, s); });
      view.el.append(frame);
      const entry = view.entry = { frame, mounted: false, added: Date.now(), token: "", card: null, component: null, app: null, full: false };
      entry.answer = (id, answer, token) => {
        // Into the load that asked, never into a later one.
        if (!token || token !== entry.token) return;
        try { frame.contentWindow?.postMessage({ g: token, m: JSON.stringify({ jsonrpc: "2.0", id, result: answer }) }, "*"); } catch { /* the frame is gone */ }
      };
      entry.send = (event) => {
        // A mini app acts like a button, at most once a second.
        const now = Date.now();
        if (now - s.lastSend < 1000) return;
        s.lastSend = now;
        void perform(s, { event }, s.byId, view.node);
      };
      entry.act = (id, request) => {
        // ash.call / ash.ask / ash.tell: a press of this Html node (as bound to this load) with the frame's request, at most two a second.
        const token = entry.token, now = Date.now();
        s.calls = s.calls.filter((at) => now - at < 1000);
        if (s.calls.length >= 2) { entry.answer(id, { state: "failed", text: "太快了，稍后再试。" }, token); return; }
        s.calls.push(now);
        const c = s.ctx, current = s.item.card;
        if (typeof c?.act !== "function" || stateLine(current, s) || current.id !== entry.card) { entry.answer(id, { state: "failed", text: "这张卡已经结束了。" }, token); return; }
        void actOnce(c.act, actBody(entry.card, entry.component, s.data, request), actTimeoutMs(request)).then((answer) => entry.answer(id, answer, token));
      };
      listen();
      for (const old of frames) if (old.frame.isConnected === false && entry.added - old.added > 2000) frames.delete(old);
      frames.add(entry);
      view.dispose = () => { frames.delete(entry); entry.token = ""; };
      if (view.shape === "Html:true") {
        view.save = make("button", "a-btn btn-sm btn-ghost a2-save", "存成应用");
        view.save.type = "button";
        view.save.addEventListener("click", () => {
          if (view.save.disabled) return;
          void say(s, "把这个小应用存成应用", { name: "save_app", context: { component: view.id } });
        });
        view.el.append(view.save);
      }
    },
    update(view, node, pass) {
      base(view, "a2-mini");
      const height = px(Number.isFinite(node.height) ? node.height : 320);
      if (view.frame.style.height !== height) view.frame.style.height = height;
      // Loaded again only when its html changed: data patches never reload it.
      if (view.d.html !== String(node.html ?? "")) { view.d.html = String(node.html ?? ""); loadFrame(view, pass.s); }
      if (view.save) setProp(view.save, "disabled", !pass.live);
    },
  },
  Skeleton: {
    make(view) { view.el = make("div"); },
    update(view) { base(view, "sk a2-skeleton"); },
  },
};
COMPONENTS.Column = COMPONENTS.Row;
COMPONENTS.Switch = COMPONENTS.CheckBox;

const chartHeight = (node) => Number.isFinite(node.style?.height) ? node.style.height : 80;
function chartPaint(view, w) {
  if (!w || w === view.width) return;
  view.width = w;
  view.el.replaceChildren(chartSvg(view.node, Math.round(w), chartHeight(view.node)));
}
const timerText = (node) => formatSpan(Number.isFinite(node.since) ? Date.now() - node.since : (node.until ?? 0) - Date.now());
const passwordsOf = (s) => { let map = secrets.get(s.id); if (!map) secrets.set(s.id, map = new Map()); return map; };
const secretKey = (node) => typeof node.bind === "string" ? node.bind : `#${node.id}`;

/** The thumbs the owner gives an open or closed card: the last one given shows as chosen; its height is there from the start. */
const FEEDBACK = Object.freeze([["up", "👍", "thumbUp", "有用"], ["down", "👎", "thumbDown", "没用"]]);

/** Which thumb [card] shows as chosen: the one just tapped on this screen, else the last one the hub recorded. */
export const feedbackOf = (card, local) => local ?? (card?.feedback === "up" || card?.feedback === "down" ? card.feedback : undefined);

/**
 * The card's quiet bottom line, one height from the start: its live line (「常驻中」, 「HH:MM 更新」, 「已休眠 · …」) on the
 * left, then 「存成应用」 for a card whose app exists only for it, the 「常驻」 switch of an app's card, the thumbs of an
 * agent's card. Patched in place like the components; null when the card has none of them.
 */
function footer(s, closed) {
  const card = s.item.card, f = s.ui.footer;
  const thumbs = !plain(card.form) && AGENT.test(card.owner ?? "");
  const pin = !closed && pinnable(card);
  const pinned = s.pinned ?? card.pinned === true;
  const live = liveLine({ ...card, pinned });
  const keep = card.temporary_app === true && !s.kept && !closed;
  if (!thumbs && live === null && !keep && !pin) return null;
  f.bar ??= make("div", "a2-feedback");
  const parts = [];
  if (s.pinError || live !== null || pin) {
    f.live ??= make("span");
    setClass(f.live, s.pinError ? "a2-live failed" : "a2-live");
    setText(f.live, s.pinError || live || "");
    parts.push(f.live);
  }
  if (keep) {
    if (!f.keep) { f.keep = make("button", "a2-keep", "存成应用"); f.keep.type = "button"; f.keep.addEventListener("click", () => { void keepApp(s); }); }
    setProp(f.keep, "disabled", typeof s.ctx?.keep !== "function" || s.keeping);
    parts.push(f.keep);
  }
  if (pin) {
    if (!f.pin) {
      f.pin = make("button", "a2-pin");
      f.pin.type = "button";
      text(f.pin, "span", "", "a2-pin-track");
      text(f.pin, "span", "常驻");
      f.pin.setAttribute("role", "switch");
      f.pin.addEventListener("click", () => { void togglePin(s); });
    }
    setAttr(f.pin, "aria-checked", String(pinned));
    setAttr(f.pin, "aria-label", pinned ? "常驻：开" : "常驻：关");
    setProp(f.pin, "disabled", typeof s.ctx?.pin !== "function" || s.pinning);
    parts.push(f.pin);
  }
  if (thumbs) {
    f.thumbs ??= FEEDBACK.map(([kind, glyph, shape, words]) => {
      const b = make("button", "a2-fb");
      b.type = "button";
      if (!drawShape(b, shape, "i-xs")) b.textContent = glyph;
      b.setAttribute("aria-label", words);
      b.addEventListener("click", () => { void giveFeedback(s, kind, glyph); });
      return b;
    });
    const chosen = feedbackOf(card, s.feedback);
    FEEDBACK.forEach(([kind], i) => {
      const b = f.thumbs[i];
      setClass(b, `a2-fb${chosen === kind ? " on" : ""}`);
      setAttr(b, "aria-pressed", String(chosen === kind));
      setProp(b, "disabled", typeof s.ctx?.say !== "function");
    });
    parts.push(...f.thumbs);
  }
  arrange(f.bar, parts);
  return f.bar;
}

/** How long the line saying 「常驻」 was not set stays. */
const PIN_ERROR_MS = 3000;

/** 「常驻」: the owner keeps the card running off screen, or lets it sleep again (`service:cards/pin`); shown at once, put back if refused. */
async function togglePin(s) {
  const ctx = s.ctx, card = s.item.card;
  if (s.pinning || typeof ctx?.pin !== "function") return;
  const before = s.pinned ?? card.pinned === true;
  s.pinned = !before; s.pinning = true; s.pinError = "";
  redraw(s);
  try { await ctx.pin(card.id, s.pinned); }
  catch {
    s.pinned = before;
    s.pinError = before ? "没关掉常驻，请再试一次" : "没设成常驻，请再试一次";
    const timer = setTimeout(() => { s.pinError = ""; redraw(s); }, PIN_ERROR_MS);
    timer.unref?.();
  } finally { s.pinning = false; redraw(s); }
}

/** 「存成应用」: the card's temporary app stays (`service:cards/keep`); the button goes once the hub took it. */
async function keepApp(s) {
  const ctx = s.ctx, card = s.item.card;
  if (s.keeping || s.kept || typeof ctx?.keep !== "function") return;
  s.keeping = true;
  redraw(s);
  try { await ctx.keep(card.id); s.kept = true; }
  catch { ctx.problem?.("没存成应用，请再试一次。"); }
  finally { s.keeping = false; redraw(s); }
}

/** The owner's thumb as a say to the card's agent; a second tap on the one already chosen does nothing. */
async function giveFeedback(s, kind, glyph) {
  const ctx = s.ctx, card = s.item.card;
  const before = feedbackOf(card, s.feedback);
  if (before === kind || s.feedbackSending || typeof ctx?.say !== "function" || !AGENT.test(card.owner ?? "")) return;
  const body = sayBody(card.id, glyph, { name: "feedback", context: { feedback: kind } }, s.data);
  s.feedback = kind; s.feedbackSending = true; redraw(s);
  try { await ctx.say(card.owner, body.text, body.card); }
  catch (error) { s.feedback = before; redraw(s); ctx.problem?.(`没发出去：${error?.message || "请再点一次"}`); }
  finally { s.feedbackSending = false; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Acting.

/** The owner's values go to the hub; a reactive card is drawn again from the answer. */
async function draft(s) {
  s.timer = null;
  const ctx = s.ctx, card = s.item.card;
  if (typeof ctx?.draft !== "function" || stateLine(card, s)) return;
  let body;
  try { body = JSON.stringify(s.data); } catch { return; }
  if (new TextEncoder().encode(body).byteLength > MAX_DATA_BYTES) return;
  const version = s.version;
  s.inflight++;
  try {
    const answer = await ctx.draft(card.id, JSON.parse(body));
    taken(s, version);
    if (version === s.version && s.reactive && plain(answer?.plan) && parsePlan(answer.plan)) { s.plan = answer.plan; redraw(s); }
  } catch { /* the values stay on this screen; the action that follows carries them */ }
  finally { s.inflight--; }
  // A newer version came while the owner was typing: read the card again now that the hub has the owner's values.
  if (version === s.version && !s.timer && s.inflight === 0 && s.stale) { s.stale = false; ctx.refresh?.(s.item.id); }
}

/** What a tap on [node] (a Button, or anything with an action) does. */
async function perform(s, action, byId, node) {
  if (!plain(action)) return;
  const ctx = s.ctx, card = s.item.card;
  if (runtimeKind(action)) { await press(s, node, action); return; }
  if (plain(action.copy)) { await copy(s, node, action.copy.text); return; }
  if (!("event" in action)) { (ctx?.open ?? openAction)(action); return; }
  const event = action.event;
  if (!plain(event) || typeof event.name !== "string" || !ctx || stateLine(card, s) || s.busy) return;
  if (plain(card.form)) {
    if (event.name === "submit") await submitForm(s);
    else if (event.name === "cancel") await cancelForm(s);
    return;
  }
  await say(s, node?.component === "Button" ? buttonLabel(byId, node) : event.name, event);
}

/** A short tick under the finger where the device has one. */
function haptic() { try { globalThis.navigator?.vibrate?.(8); } catch { /* no vibration here */ } }

/**
 * A press the hub runs (`service:cards/act` with the values on the card): 「处理中…」 and disabled at once, then the outcome
 * under the button; retryable after the answer or the wait. A press while one runs does nothing.
 */
async function press(s, node, action) {
  const ctx = s.ctx, card = s.item.card;
  if (!node?.id || typeof ctx?.act !== "function" || stateLine(card, s) || s.busy) return;
  if (buttonView(card, s, node.id, action).busy) return;
  // The values go with the press: no separate draft after it.
  clearTimeout(s.timer); s.timer = null;
  s.pressing.add(node.id);
  delete s.outcomes[node.id];
  haptic();
  redraw(s);
  const version = s.version;
  const answer = await actOnce(ctx.act, actBody(card.id, node.id, s.data), actTimeoutMs(action));
  s.pressing.delete(node.id);
  if (answer.state !== "failed") taken(s, version);
  // What the hub wrote on the card by now is not newer than this answer; anything it writes later is.
  if (answer.state !== "running") s.outcomes[node.id] = { state: answer.state, text: answer.text, after: Number(s.item.card.actions?.[node.id]?.at) || 0 };
  redraw(s);
}

/** `{copy: {text}}`: onto this device's clipboard, nothing sent; 「已复制」 under the button for a moment. */
async function copy(s, node, value) {
  const write = typeof s.ctx?.copy === "function" ? s.ctx.copy : (words) => globalThis.navigator.clipboard.writeText(words);
  let ok = true;
  try { await write(String(value ?? "")); } catch { ok = false; }
  if (ok) haptic();
  if (!node?.id) return;
  s.copied[node.id] = { until: Date.now() + COPIED_MS, state: ok ? "ok" : "failed", text: ok ? "已复制" : "没复制成功" };
  redraw(s);
  const timer = setTimeout(() => redraw(s), COPIED_MS + 20);
  timer.unref?.();
}

async function say(s, label, event) {
  const ctx = s.ctx, card = s.item.card;
  if (!AGENT.test(card.owner ?? "") || typeof ctx?.say !== "function") return;
  clearTimeout(s.timer); s.timer = null;
  const body = sayBody(card.id, label, event, s.data), version = s.version;
  try { await ctx.say(card.owner, body.text, body.card); taken(s, version); }
  catch (error) { ctx.problem?.(`没发出去：${error?.message || "请再点一次"}`); }
}

function fail(s, message) { s.busy = false; s.error = message; redraw(s); }

const UNKNOWN = ["offline", "unavailable", "timeout", "result_unknown", "internal"];

async function answer(s, body) {
  const ctx = s.ctx, item = s.item;
  const key = JSON.stringify(body);
  if (s.answer?.key !== key) s.answer = { key, clientId: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` };
  return ctx.answerForm({ to: item.card.owner, reply_to: item.id, body, client_id: s.answer.clientId });
}

const answerProblem = (error) => UNKNOWN.includes(error?.code) ? "没连上，提交有没有送到还不知道，请再点一次。" :
  error?.code === "conflict" ? "这张表已经结束了。" :
  /not filled in: (.+)/.exec(error?.message ?? "")?.[1] ? `还没填：${/not filled in: (.+)/.exec(error.message)[1]}` : "没提交成功，请检查后再试。";

async function submitForm(s) {
  const ctx = s.ctx, card = s.item.card, form = card.form;
  if (typeof ctx.answerForm !== "function") return;
  clearTimeout(s.timer); s.timer = null;
  const typed = secretsOf(card.id);
  const titles = plain(form.titles) ? form.titles : {};
  const secret = Object.entries(plain(form.secret) ? form.secret : {});
  for (const [field] of secret) if (!(typed.get(fieldPath(field)) ?? "")) { fail(s, `请先填写${titles[field] || field}`); return; }
  s.busy = true; s.error = ""; redraw(s);
  if (secret.length) {
    if (typeof ctx.vaultSet !== "function") { fail(s, "这里存不了密码，请到手机上填写。"); return; }
    try {
      await Promise.all(secret.map(([field, ref]) => ctx.vaultSet({ ref, value: typed.get(fieldPath(field)), label: titles[field] || field, kind: "password" })));
    } catch { fail(s, "密码没存进保险箱，请再试一次。"); return; }
  }
  let result;
  try { result = await answer(s, formAnswerBody(form, s.data, typed)); } catch (error) { result = { ok: false, error: { code: "offline", message: String(error?.message ?? "") } }; }
  if (!result?.ok) { fail(s, answerProblem(result?.error)); return; }
  secrets.delete(card.id);
  s.busy = false; s.sent = true; s.error = "";
  redraw(s);
  ctx.refresh?.(s.item.id);
}

async function cancelForm(s) {
  const ctx = s.ctx;
  if (typeof ctx.answerForm !== "function") return;
  clearTimeout(s.timer); s.timer = null;
  s.busy = true; s.error = ""; redraw(s);
  let result;
  try { result = await answer(s, formCancelBody()); } catch { result = { ok: false, error: { code: "offline" } }; }
  if (!result?.ok) { fail(s, answerProblem(result?.error)); return; }
  secrets.delete(s.item.card.id);
  s.busy = false; s.cancelled = true;
  redraw(s);
  ctx.refresh?.(s.item.id);
}
