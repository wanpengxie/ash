// A card an agent designed (A2UI, docs/GENUI.md) drawn in the conversation as DOM: the same literal plan the phone draws
// natively (`plan.components`, every binding already resolved by the hub). Inputs write into a working copy of the card's
// data kept here per card id, so it survives the timeline drawing its rows again; a password box keeps its text in memory
// only and sends it nowhere but the vault. A button's action is the owner's own message to the card's creator, the answer
// of a form, or (docs/CARD-RUNTIME.md) a press the hub runs for the card (`service:cards/act`: call / ask / tell), whose
// outcome the hub writes on the card itself and pushes as `card.patch`. A mini app (Html) runs in a sandboxed frame with no
// network and one way out: `ash.send`, and `ash.call` / `ash.ask` / `ash.tell`, which are presses of the card too.
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

/** The password map of a card (for tests and the submit). */
export const secretsOf = (cardId) => secrets.get(cardId) ?? new Map();
/** Forgets every card's local state (tests). */
export function resetCards() { for (const s of states.values()) clearTimeout(s.timer); states.clear(); secrets.clear(); }
/** The local state of a card (tests). */
export const cardState = (cardId) => states.get(cardId);

function editing(s) {
  const doc = s.root?.ownerDocument ?? globalThis.document;
  const active = doc?.activeElement;
  return Boolean(s.timer || s.inflight > 0 || (active && s.root?.contains?.(active) && active !== s.root));
}

/** The state of [card], following the hub's newer version unless the owner is editing the card right now. */
function stateFor(item) {
  const card = item.card;
  const server = Number.isFinite(card.updated_at) ? card.updated_at : 0;
  const data = plain(card.plan?.data) ? card.plan.data : {};
  let s = states.get(card.id);
  if (!s) {
    if (states.size >= MAX_STATES) for (const [id, old] of states) { if (!editing(old)) { clearTimeout(old.timer); states.delete(id); secrets.delete(id); } if (states.size < MAX_STATES) break; }
    s = { id: card.id, data: clone(data), seen: server, hold: null, plan: null, tabs: {}, version: 0, inflight: 0, timer: null,
      sent: false, cancelled: false, busy: false, error: "", answer: null, root: null, item, ctx: null, lastSend: 0, feedback: undefined,
      // The card runtime: presses on their way, their outcomes as answered here, 「已复制」, mini app calls in the last second.
      pressing: new Set(), outcomes: {}, copied: {}, runningSince: new Map(), calls: [], kept: false, keeping: false,
      // 「常驻」 as the owner just set it (until the hub's card says the same), and why setting it failed.
      pinned: undefined, pinning: false, pinError: "" };
    states.set(card.id, s);
  } else if (server > s.seen) {
    if (editing(s) || (s.hold !== null && server <= s.hold)) s.hold = Math.max(s.hold ?? 0, server);
    else { s.data = clone(data); s.seen = server; s.plan = null; s.hold = null; }
  }
  if (s.feedback !== undefined && card.feedback === s.feedback) s.feedback = undefined;
  if (s.pinned !== undefined && !s.pinning && (card.pinned === true) === s.pinned) s.pinned = undefined;
  if (card.state && card.state !== "open") { s.busy = false; if (card.state === "sent" || card.state === "cancelled") s.error = ""; }
  s.item = item;
  return s;
}

/**
 * The hub pushed [card] whole (`card.patch`: live data, a button's state, the lifecycle). Its state follows now; the row
 * itself is drawn again by the timeline, unless the owner's focus holds it (a button just pressed): then it is drawn here.
 * Not while an input has the focus: the timeline draws it when the owner leaves it.
 */
export function patchA2uiCard(card) {
  const s = plain(card) && typeof card.id === "string" ? states.get(card.id) : null;
  if (!s || !plain(card.plan)) return false;
  stateFor({ ...s.item, card });
  const root = s.root;
  const active = (root?.ownerDocument ?? globalThis.document)?.activeElement;
  const tag = String(active?.tagName ?? active?.tag ?? "").toLowerCase();
  if (root && active && active !== root && root.contains?.(active) && !["input", "textarea", "select"].includes(tag)) repaint(s);
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
// The mini app: one sandboxed frame per Html node, with the theme and `ash.send` put in front of its document.

export const MINI_APP_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
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

/**
 * `window.ash` in the mini app: `send(action, context)` (the owner's say), and `call(member, word, body)`, `ask(text)`,
 * `tell(text)`, each a press of the card that resolves to the hub's answer `{state, text, result?}` (never rejects).
 */
export const MINI_APP_BRIDGE = "(function(){var p=window.parent,n=0,w={};" +
  "function c(v){return v&&typeof v===\"object\"?JSON.parse(JSON.stringify(v)):{}}" +
  "function r(q){return new Promise(function(ok){var id=\"r\"+(++n);w[id]=ok;p.postMessage({ash:\"act\",id:id,request:q},\"*\")})}" +
  "window.addEventListener(\"message\",function(e){var d=e.data;if(e.source!==p||!d||d.ash!==\"answer\"||!w[d.id])return;var f=w[d.id];delete w[d.id];f(d.answer)});" +
  "window.ash=Object.freeze({send:function(action,context){p.postMessage({ash:\"send\",action:String(action),context:c(context)},\"*\")}," +
  "call:function(member,word,body){return r({call:{member:String(member),word:String(word),body:c(body)}})}," +
  "ask:function(text){return r({ask:{text:String(text)}})},tell:function(text){return r({tell:{text:String(text)}})}})})();";

/** The mini app's document: the CSP, the theme as CSS variables and the `ash.send` bridge, ahead of the agent's HTML. */
export function miniAppDocument(html, vars = themeVars(), accent = null) {
  const safe = (v) => String(v).replace(/[<>;{}]/g, "");
  const theme = { ...vars, ...(accent ? { "--ash-accent": accent } : {}) };
  const declarations = Object.entries(theme).filter(([k]) => k.startsWith("--")).map(([k, v]) => `${k}:${safe(v)}`).join(";");
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>:root{${declarations};color-scheme:${vars.scheme === "dark" ? "dark" : "light"}}html,body{margin:0;background:var(--ash-bg);color:var(--ash-text);font-family:system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}</style>` +
    `<script>${MINI_APP_BRIDGE}</script>`;
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

/**
 * A message from a mini app: only from a frame this page made, only `{ash: "send", action, context}` or
 * `{ash: "act", id, request}` (answered into the frame as `{ash: "answer", id, answer}`).
 */
export function frameMessage(event) {
  for (const entry of frames) {
    if (entry.frame.isConnected === false && entry.mounted) { frames.delete(entry); continue; }
    if (entry.frame.isConnected) entry.mounted = true;
    if (!event?.source || entry.frame.contentWindow !== event.source) continue;
    const data = event.data;
    if (plain(data) && data.ash === "act" && typeof data.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(data.id)) {
      const request = miniAppRequest(data.request);
      entry.act?.(data.id, request);
      return request !== null;
    }
    if (!plain(data) || data.ash !== "send" || typeof data.action !== "string" || !EVENT_NAME.test(data.action)) return false;
    const context = plain(data.context) ? data.context : {};
    let size = 0; try { size = JSON.stringify(context).length; } catch { return false; }
    if (size > 16 * 1024) return false;
    entry.send({ name: data.action, ...(Object.keys(context).length ? { context } : {}) });
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
// Drawing.

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
    paint(root, s);
  } catch {
    root.replaceChildren();
    root.className = "a-card card a2ui a2-plain";
    text(root, "div", item?.card?.text || "一张卡片", "card-body a2-plain-text");
  }
  return root;
}

/** Draws the card of state [s] into [root] again (after a local change), keeping the focused input focused with its caret. */
function repaint(s) {
  const root = s.root;
  if (!root) return;
  const doc = root.ownerDocument ?? globalThis.document;
  const active = doc?.activeElement;
  const key = active && root.contains?.(active) ? active.dataset?.a2Focus : undefined;
  const caret = key && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
  try { paint(root, s); } catch { return; }
  if (!key) return;
  const again = s.focusables?.get(key);
  if (!again) return;
  try { again.focus({ preventScroll: true }); if (caret) again.setSelectionRange?.(caret[0], caret[1]); } catch { /* not focusable any more */ }
}

function paint(root, s) {
  const item = s.item, card = item.card, ctx = s.ctx;
  const plan = parsePlan(s.plan) ?? parsePlan(card.plan);
  if (!plan) throw new Error("no plan");
  s.root = root;
  s.reactive = plan.reactive;
  s.focusables = new Map();
  root.replaceChildren();
  const accent = plan.theme ? cssColor(plan.theme.accent) : null;
  if (accent) root.style.setProperty("--you", accent);
  const closed = stateLine(card, s);
  const live = !closed && !!ctx;
  const form = plain(card.form);
  const byId = plan.byId;
  const passwords = () => { let map = secrets.get(card.id); if (!map) secrets.set(card.id, map = new Map()); return map; };

  const changed = () => {
    s.version++;
    if (s.error) { s.error = ""; root.querySelector?.(".a2-error")?.remove(); }
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { void draft(s); }, DRAFT_DELAY_MS);
    s.timer.unref?.();
  };
  const write = (path, value, redraw = false) => {
    if (typeof path !== "string") return;
    if (!writePointer(s.data, path, value)) return;
    changed();
    if (redraw) repaint(s);
  };
  const valueAt = (node, fallback) => { if (typeof node.bind !== "string") return fallback; const v = readPointer(s.data, node.bind); return v === undefined ? fallback : v; };
  const focusable = (el, node, part = "") => { const key = `${node.id}:${part}`; el.dataset.a2Focus = key; s.focusables.set(key, el); return el; };
  const act = (node) => (event) => { event?.preventDefault?.(); void perform(s, node.action, byId, node); };

  const draw = (parentEl, id, depth, parentKind) => {
    const node = byId.get(id);
    if (!node || depth > MAX_DEPTH || node.visible === false) return null;
    const el = drawNode(parentEl, node, depth);
    if (!el) return null;
    el.dataset.a2Id = node.id;
    applyStyle(el, node, parentKind);
    if (node.action && node.component !== "Button") {
      el.classList.add("a2-tap");
      el.setAttribute("role", "button");
      el.tabIndex = 0;
      const pressed = runtimeKind(node.action) && buttonView(card, s, node.id, node.action).busy;
      if ((!live && ("event" in node.action || runtimeKind(node.action))) || pressed) el.setAttribute("aria-disabled", "true");
      else el.addEventListener("click", act(node));
    }
    return el;
  };
  // The space between a container's children is its own `gap`; without one they sit edge to edge.
  const gap = (el, node) => { if (Number.isFinite(node.gap) && node.gap >= 0) el.style.gap = px(node.gap); };
  const kids = (el, node, depth) => { for (const kid of Array.isArray(node.children) ? node.children : []) { const child = draw(el, kid, depth + 1, node.component); if (child && node.component === "Stack") applyPlace(child, node); } };
  const applyPlace = (child, stack) => {
    const place = byId.get(child.dataset.a2Id)?.style?.place ?? stack.align ?? "topStart";
    const [block, inlinePlace] = PLACE[place] ?? PLACE.topStart;
    child.style.alignSelf = block; child.style.justifySelf = inlinePlace;
  };
  const field = (parentEl, node) => {
    const wrap = text(parentEl, "label", "", "a2-field");
    if (node.label) text(wrap, "span", node.label, "a2-label");
    return wrap;
  };

  function drawNode(parentEl, node, depth) {
    switch (node.component) {
    case "Text": {
      const el = text(parentEl, "div", "", `a2-text a2-${["h1", "h2", "h3", "h4", "h5", "caption"].includes(node.variant) ? node.variant : "body"}`);
      appendCardMarkdown(el, node.text ?? "");
      return el;
    }
    case "Image": {
      const url = String(node.url ?? "");
      if (url.startsWith("icon:")) { const el = text(parentEl, "span", "", "a2-icon"); drawIcon(el, url.slice(5), "i-l"); return el; }
      const img = document.createElement("img");
      img.className = `a2-img a2-img-${node.variant ?? "plain"}`;
      img.alt = node.a11y ?? "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      if (url === "avatar" || url.startsWith("avatar:")) img.src = avatarUrl(url === "avatar" ? "default" : url.slice(7));
      else if (/^https:\/\//i.test(url) || /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,/i.test(url)) img.src = url;
      else return null;
      const fit = { contain: "contain", cover: "cover", fill: "fill", none: "none", scaleDown: "scale-down" }[node.fit];
      if (fit) img.style.objectFit = fit;
      parentEl.append(img);
      return img;
    }
    case "Icon": {
      const el = text(parentEl, "span", "", "a2-icon");
      if (typeof node.svgPath === "string") {
        // A closed shape is filled; an outline (a path never closed with Z) is stroked like the line icons.
        const svg = svgNode("svg", { class: /[zZ]/.test(node.svgPath) ? "i i-s i-solid" : "i i-s", viewBox: "0 0 24 24", "aria-hidden": "true" }, el);
        svgNode("path", { d: node.svgPath }, svg);
      } else drawIcon(el, node.name);
      return el;
    }
    case "Row": case "Column": {
      const el = text(parentEl, "div", "", node.component === "Row" ? "a2-row" : "a2-col");
      if (JUSTIFY[node.justify]) el.style.justifyContent = node.justify === "stretch" ? "flex-start" : JUSTIFY[node.justify];
      if (ALIGN[node.align]) el.style.alignItems = ALIGN[node.align];
      if (node.justify === "stretch") el.classList.add("a2-stretch");
      gap(el, node);
      kids(el, node, depth);
      return el;
    }
    case "Stack": { const el = text(parentEl, "div", "", "a2-stack"); kids(el, node, depth); return el; }
    case "Grid": {
      const el = text(parentEl, "div", "", "a2-grid");
      el.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(12, node.columns ?? 2))}, minmax(0, 1fr))`;
      gap(el, node);
      kids(el, node, depth);
      return el;
    }
    case "List": {
      const horizontal = node.direction === "horizontal";
      const el = text(parentEl, "div", "", horizontal ? "a2-hlist" : node.columns > 1 ? "a2-grid" : "a2-col");
      if (!horizontal && node.columns > 1) el.style.gridTemplateColumns = `repeat(${node.columns}, minmax(0, 1fr))`;
      if (ALIGN[node.align]) el.style.alignItems = ALIGN[node.align];
      gap(el, node);
      kids(el, node, depth);
      return el;
    }
    case "Card": { const el = text(parentEl, "div", "", "a2-card"); if (node.child) draw(el, node.child, depth + 1, "Card"); return el; }
    case "Tabs": {
      const tabs = Array.isArray(node.tabs) ? node.tabs.filter((t) => plain(t) && typeof t.child === "string") : [];
      if (!tabs.length) return null;
      const el = text(parentEl, "div", "", "a2-tabs-box");
      const strip = text(el, "div", "", "a2-tabs");
      strip.setAttribute("role", "tablist");
      const chosen = Math.min(tabs.length - 1, Math.max(0, s.tabs[node.id] ?? node.selected ?? 0));
      tabs.forEach((tab, i) => {
        const b = button(strip, String(tab.title ?? ""), `a2-tab${i === chosen ? " on" : ""}`);
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(i === chosen));
        focusable(b, node, `tab${i}`);
        b.addEventListener("click", () => { if (s.tabs[node.id] === i) return; s.tabs[node.id] = i; repaint(s); });
      });
      const body = text(el, "div", "", "a2-col a2-tab-body");
      draw(body, tabs[chosen].child, depth + 1, "Column");
      return el;
    }
    case "Divider": return text(parentEl, "div", "", node.axis === "vertical" ? "a2-divider v" : "a2-divider");
    case "Spacer": {
      const el = text(parentEl, "div", "", "a2-spacer");
      if (Number.isFinite(node.size)) { el.style.flex = `0 0 ${px(node.size)}`; el.style.minWidth = el.style.minHeight = px(node.size); }
      else el.style.flex = "1 1 0";
      return el;
    }
    case "Button": {
      const variant = node.variant === "primary" ? "btn-primary" : node.variant === "borderless" ? "btn-ghost" : "btn-neutral";
      // A press the hub runs, or a copy, has a line under the button for its outcome (「已复制」, 「已完成 · 10:42」, why it failed).
      const lined = Boolean(runtimeKind(node.action) || plain(node.action?.copy));
      const view = lined ? buttonView(card, s, node.id, node.action) : { busy: false, line: null };
      const holder = lined ? text(parentEl, "div", "", "a2-act") : parentEl;
      const el = button(holder, "", `a-btn btn-sm a2-btn ${variant}`);
      if (view.busy) { text(el, "span", "处理中…", "a2-text"); el.setAttribute("aria-busy", "true"); }
      else if (node.child) draw(el, node.child, depth + 1, "Button");
      el.disabled = node.disabled === true || !live || s.busy || !node.action || view.busy;
      focusable(el, node);
      el.addEventListener("click", act(node));
      if (!lined) return el;
      if (node.style?.width === "fill" || Number.isFinite(node.style?.width)) holder.classList.add("a2-act-fill");
      if (view.line) text(holder, "div", view.line.text, `a2-act-line${view.line.state === "failed" ? " failed" : ""}`);
      return holder;
    }
    case "CheckBox": case "Switch": {
      const el = text(parentEl, "label", "", `a2-check${node.component === "Switch" ? " a2-switch-row" : ""}`);
      const input = document.createElement("input");
      input.type = "checkbox";
      if (node.component === "Switch") { input.className = "a2-switch"; input.setAttribute("role", "switch"); }
      input.checked = valueAt(node, node.checked === true) === true;
      input.disabled = !live || node.disabled === true;
      focusable(input, node);
      input.addEventListener("change", () => write(node.bind, input.checked === true));
      if (node.component === "Switch") { text(el, "span", node.label ?? "", "a2-check-label"); el.append(input); }
      else { el.append(input); text(el, "span", node.label ?? "", "a2-check-label"); }
      return el;
    }
    case "ChoicePicker": {
      const el = text(parentEl, "div", "", "a2-field a2-choice");
      if (node.label) text(el, "span", node.label, "a2-label");
      const options = Array.isArray(node.options) ? node.options.filter((o) => plain(o) && typeof o.value === "string") : [];
      const given = valueAt(node, null);
      const selected = new Set(Array.isArray(given) ? given.filter((v) => typeof v === "string") : options.filter((o) => o.checked).map((o) => o.value));
      const choose = (value, on) => {
        const next = node.multiple ? options.map((o) => o.value).filter((v) => v === value ? on : selected.has(v)) : on ? [value] : [];
        write(node.bind, next, true);
      };
      if (node.chips) {
        const row = text(el, "div", "", "opts a2-chips");
        options.forEach((o, i) => {
          const on = selected.has(o.value);
          const b = button(row, String(o.label ?? o.value), `opt${on ? " on" : ""}`, on ? "check" : "", "i-xs");
          b.setAttribute("aria-pressed", String(on));
          b.disabled = !live;
          focusable(b, node, `o${i}`);
          b.addEventListener("click", () => choose(o.value, node.multiple ? !on : true));
        });
      } else {
        const list = text(el, "div", "", "a2-col a2-choice-list");
        options.forEach((o, i) => {
          const row = text(list, "label", "", "a2-check");
          const input = document.createElement("input");
          input.type = node.multiple ? "checkbox" : "radio";
          input.name = `a2-${card.id}-${node.id}`;
          input.checked = selected.has(o.value);
          input.disabled = !live;
          focusable(input, node, `o${i}`);
          input.addEventListener("change", () => choose(o.value, input.checked === true));
          row.append(input);
          text(row, "span", String(o.label ?? o.value), "a2-check-label");
        });
      }
      return el;
    }
    case "ProgressBar": {
      const el = text(parentEl, "div", "", "a2-field a2-progress");
      if (node.label) text(el, "span", node.label, "a2-label");
      const track = text(el, "div", "", "a2-track");
      const max = Number.isFinite(node.max) && node.max > 0 ? node.max : 100;
      const value = Math.min(max, Math.max(0, Number(node.value) || 0));
      const fill = text(track, "div", "", "a2-fill");
      fill.style.width = `${Math.round(value / max * 1000) / 10}%`;
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", String(max));
      track.setAttribute("aria-valuenow", String(value));
      return el;
    }
    case "Badge": return text(parentEl, "span", node.text ?? "", "a2-badge");
    case "Clock": {
      const el = text(parentEl, "span", "", "a2-text a2-body a2-clock");
      ticking(el, () => { el.textContent = formatClock(new Date(), node.format || "HH:mm", node.timeZone); });
      return el;
    }
    case "Timer": {
      const el = text(parentEl, "span", "", "a2-text a2-body a2-timer");
      ticking(el, () => { el.textContent = formatSpan(Number.isFinite(node.since) ? Date.now() - node.since : (node.until ?? 0) - Date.now()); });
      return el;
    }
    case "Chart": {
      const h = Number.isFinite(node.style?.height) ? node.style.height : 80;
      const el = text(parentEl, "div", "", "a2-chart-box");
      el.style.height = px(h);
      let width = 0;
      const paintChart = (w) => { if (!w || w === width) return; width = w; el.replaceChildren(chartSvg(node, Math.round(w), h)); };
      paintChart(300);
      const measure = () => paintChart(el.clientWidth || 300);
      globalThis.requestAnimationFrame?.(measure);
      if (typeof globalThis.ResizeObserver === "function") new ResizeObserver(measure).observe(el);
      return el;
    }
    case "TextField": {
      const wrap = field(parentEl, node);
      const obscured = node.variant === "obscured";
      const long = node.variant === "longText";
      const input = document.createElement(long ? "textarea" : "input");
      input.className = "a2-input";
      if (!long) input.type = obscured ? "password" : "text";
      if (node.variant === "number") input.inputMode = "decimal";
      if (obscured) { input.autocomplete = "new-password"; input.spellcheck = false; }
      if (node.placeholder) input.placeholder = node.placeholder;
      const key = typeof node.bind === "string" ? node.bind : `#${node.id}`;
      input.value = obscured ? passwords().get(key) ?? "" : String(valueAt(node, node.text ?? "") ?? "");
      input.disabled = !live;
      focusable(input, node);
      // A password never enters the card's data: it is kept apart and goes to the vault on 「提交」.
      if (obscured) input.addEventListener("input", () => { passwords().set(key, input.value); if (s.error) { s.error = ""; root.querySelector?.(".a2-error")?.remove(); } });
      else input.addEventListener("input", () => write(node.bind, input.value));
      wrap.append(input);
      return wrap;
    }
    case "DateTimeInput": {
      const wrap = field(parentEl, node);
      const input = document.createElement("input");
      input.className = "a2-input";
      const date = node.enableDate !== false, time = node.enableTime === true;
      input.type = date && time ? "datetime-local" : date ? "date" : "time";
      const raw = String(valueAt(node, node.text ?? "") ?? "");
      input.value = date && time ? raw.slice(0, 16) : date ? raw.slice(0, 10) : /^\d{2}:\d{2}/.test(raw) ? raw.slice(0, 5) : /T(\d{2}:\d{2})/.exec(raw)?.[1] ?? "";
      input.disabled = !live;
      focusable(input, node);
      input.addEventListener("change", () => write(node.bind, input.value));
      wrap.append(input);
      return wrap;
    }
    case "Slider": {
      const wrap = field(parentEl, node);
      const min = Number.isFinite(node.min) ? node.min : 0, max = Number.isFinite(node.max) ? node.max : 100;
      const value = Number(valueAt(node, node.value ?? min));
      const row = text(wrap, "div", "", "a2-row a2-slider-row");
      const input = document.createElement("input");
      input.type = "range";
      input.className = "a2-slider";
      input.min = String(min); input.max = String(max);
      input.step = Number.isFinite(node.step) ? String(node.step) : "any";
      input.value = String(Number.isFinite(value) ? value : min);
      input.disabled = !live;
      focusable(input, node);
      row.append(input);
      const shown = text(row, "span", input.value, "a2-slider-value");
      input.addEventListener("input", () => { shown.textContent = input.value; write(node.bind, Number(input.value)); });
      return wrap;
    }
    case "Table": {
      const wrap = text(parentEl, "div", "", "a2-table-wrap");
      const table = text(wrap, "table", "", "a2-table");
      const header = Array.isArray(node.header) ? node.header : [];
      if (header.length) { const tr = text(text(table, "thead", ""), "tr", ""); for (const h of header) cellMarkdown(text(tr, "th", ""), h); }
      const body = text(table, "tbody", "");
      for (const row of Array.isArray(node.rows) ? node.rows : []) {
        const tr = text(body, "tr", "");
        for (const cell of Array.isArray(row) ? row : []) cellMarkdown(text(tr, "td", ""), cell);
      }
      return wrap;
    }
    case "Html": {
      const wrap = text(parentEl, "div", "", "a2-mini");
      const frame = document.createElement("iframe");
      frame.className = "a2-html";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("title", "小应用");
      frame.style.height = px(Number.isFinite(node.height) ? node.height : 320);
      const doc = miniAppDocument(node.html ?? "", themeVars(), accent);
      frame.srcdoc = doc;
      // The frame may only show its own document: a navigation away from it puts the document back.
      let loads = 0, expected = 1;
      frame.addEventListener("load", () => { loads++; if (loads > expected) { expected = loads + 1; frame.srcdoc = doc; } });
      wrap.append(frame);
      listen();
      const now = Date.now();
      for (const entry of frames) if (entry.frame.isConnected === false && now - entry.added > 2000) frames.delete(entry);
      const answerFrame = (id, answer) => { try { frame.contentWindow?.postMessage({ ash: "answer", id, answer }, "*"); } catch { /* the frame is gone */ } };
      frames.add({ frame, mounted: false, added: now, send: (event) => {
        // A mini app acts like a button, at most once a second.
        const now = Date.now();
        if (now - s.lastSend < 1000) return;
        s.lastSend = now;
        void perform(s, { event }, byId, node);
      }, act: (id, request) => {
        // ash.call / ash.ask / ash.tell: a press of this Html node with the frame's request, at most two a second.
        if (!request) { answerFrame(id, { state: "failed", text: "这个请求看不懂。" }); return; }
        const now = Date.now();
        s.calls = s.calls.filter((at) => now - at < 1000);
        if (s.calls.length >= 2) { answerFrame(id, { state: "failed", text: "太快了，稍后再试。" }); return; }
        s.calls.push(now);
        const c = s.ctx, current = s.item.card;
        if (typeof c?.act !== "function" || stateLine(current, s)) { answerFrame(id, { state: "failed", text: "这张卡已经结束了。" }); return; }
        void actOnce(c.act, actBody(current.id, node.id, s.data, request), actTimeoutMs(request)).then((answer) => answerFrame(id, answer));
      } });
      if (AGENT.test(card.owner ?? "") && !card.app && card.temporary_app !== true) {
        const save = button(wrap, "存成应用", "a-btn btn-sm btn-ghost a2-save");
        save.disabled = !live;
        save.addEventListener("click", () => {
          if (!live) return;
          void say(s, "把这个小应用存成应用", { name: "save_app", context: { component: node.id } });
        });
      }
      return wrap;
    }
    case "Skeleton": return text(parentEl, "div", "", "sk a2-skeleton");
    default: return null;
    }
  }

  const body = text(root, "div", "", "a2-col a2-body-root");
  if (!draw(body, plan.root, 0, "Column")) throw new Error("nothing drawn");
  if (s.error) text(root, "div", s.error, "card-note a2-error");
  if (closed) text(root, "div", closed, "a2-status");
  else if (s.busy) text(root, "div", form ? "正在提交…" : "正在发送…", "a2-status");
  footer(root, s, closed);
  if (!live) root.classList.add("a2-readonly");
  return root;
}

/** The thumbs the owner gives an open or closed card: the last one given shows as chosen; its height is there from the start. */
const FEEDBACK = Object.freeze([["up", "👍", "thumbUp", "有用"], ["down", "👎", "thumbDown", "没用"]]);

/** Which thumb [card] shows as chosen: the one just tapped on this screen, else the last one the hub recorded. */
export const feedbackOf = (card, local) => local ?? (card?.feedback === "up" || card?.feedback === "down" ? card.feedback : undefined);

/**
 * The card's quiet bottom line, one height from the start: its live line (「常驻中」, 「HH:MM 更新」, 「已休眠 · …」) on the
 * left, then 「存成应用」 for a card whose app exists only for it, the 「常驻」 switch of an app's card, the thumbs of an
 * agent's card.
 */
function footer(root, s, closed) {
  const card = s.item.card;
  const thumbs = !plain(card.form) && AGENT.test(card.owner ?? "");
  const pin = !closed && pinnable(card);
  const pinned = s.pinned ?? card.pinned === true;
  const live = liveLine({ ...card, pinned });
  const keep = card.temporary_app === true && !s.kept && !closed;
  if (!thumbs && live === null && !keep && !pin) return;
  const bar = text(root, "div", "", "a2-feedback");
  if (s.pinError) text(bar, "span", s.pinError, "a2-live failed");
  else if (live !== null || pin) text(bar, "span", live ?? "", "a2-live");
  if (keep) {
    const b = button(bar, "存成应用", "a2-keep");
    b.disabled = typeof s.ctx?.keep !== "function" || s.keeping;
    b.addEventListener("click", () => { void keepApp(s); });
  }
  if (pin) {
    const b = button(bar, "", "a2-pin");
    text(b, "span", "", "a2-pin-track");
    text(b, "span", "常驻");
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", String(pinned));
    b.setAttribute("aria-label", pinned ? "常驻：开" : "常驻：关");
    b.disabled = typeof s.ctx?.pin !== "function" || s.pinning;
    b.addEventListener("click", () => { void togglePin(s); });
  }
  if (!thumbs) return;
  const chosen = feedbackOf(card, s.feedback);
  const can = typeof s.ctx?.say === "function";
  for (const [kind, glyph, shape, label] of FEEDBACK) {
    const b = button(bar, "", `a2-fb${chosen === kind ? " on" : ""}`);
    if (!drawShape(b, shape, "i-xs")) b.textContent = glyph;
    b.setAttribute("aria-label", label);
    b.setAttribute("aria-pressed", String(chosen === kind));
    b.disabled = !can;
    b.addEventListener("click", () => { void giveFeedback(s, kind, glyph); });
  }
}

/** How long the line saying 「常驻」 was not set stays. */
const PIN_ERROR_MS = 3000;

/** 「常驻」: the owner keeps the card running off screen, or lets it sleep again (`service:cards/pin`); shown at once, put back if refused. */
async function togglePin(s) {
  const ctx = s.ctx, card = s.item.card;
  if (s.pinning || typeof ctx?.pin !== "function") return;
  const before = s.pinned ?? card.pinned === true;
  s.pinned = !before; s.pinning = true; s.pinError = "";
  repaint(s);
  try { await ctx.pin(card.id, s.pinned); }
  catch {
    s.pinned = before;
    s.pinError = before ? "没关掉常驻，请再试一次" : "没设成常驻，请再试一次";
    const timer = setTimeout(() => { s.pinError = ""; repaint(s); }, PIN_ERROR_MS);
    timer.unref?.();
  } finally { s.pinning = false; repaint(s); }
}

/** 「存成应用」: the card's temporary app stays (`service:cards/keep`); the button goes once the hub took it. */
async function keepApp(s) {
  const ctx = s.ctx, card = s.item.card;
  if (s.keeping || s.kept || typeof ctx?.keep !== "function") return;
  s.keeping = true;
  repaint(s);
  try { await ctx.keep(card.id); s.kept = true; }
  catch { ctx.problem?.("没存成应用，请再试一次。"); }
  finally { s.keeping = false; repaint(s); }
}

/** The owner's thumb as a say to the card's agent; a second tap on the one already chosen does nothing. */
async function giveFeedback(s, kind, glyph) {
  const ctx = s.ctx, card = s.item.card;
  const before = feedbackOf(card, s.feedback);
  if (before === kind || s.feedbackSending || typeof ctx?.say !== "function" || !AGENT.test(card.owner ?? "")) return;
  const body = sayBody(card.id, glyph, { name: "feedback", context: { feedback: kind } }, s.data);
  s.feedback = kind; s.feedbackSending = true; repaint(s);
  try { await ctx.say(card.owner, body.text, body.card); }
  catch (error) { s.feedback = before; repaint(s); ctx.problem?.(`没发出去：${error?.message || "请再点一次"}`); }
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
    if (version === s.version && s.reactive && plain(answer?.plan) && parsePlan(answer.plan)) { s.plan = answer.plan; repaint(s); }
  } catch { /* the values stay on this screen; the action that follows carries them */ }
  finally { s.inflight--; }
  // A newer version came while the owner was typing: read the card again now that the hub has the owner's values.
  if (version === s.version && !s.timer && s.inflight === 0 && s.hold !== null) ctx.refresh?.(s.item.id);
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
  repaint(s);
  const answer = await actOnce(ctx.act, actBody(card.id, node.id, s.data), actTimeoutMs(action));
  s.pressing.delete(node.id);
  // What the hub wrote on the card by now is not newer than this answer; anything it writes later is.
  if (answer.state !== "running") s.outcomes[node.id] = { state: answer.state, text: answer.text, after: Number(s.item.card.actions?.[node.id]?.at) || 0 };
  repaint(s);
}

/** `{copy: {text}}`: onto this device's clipboard, nothing sent; 「已复制」 under the button for a moment. */
async function copy(s, node, value) {
  const write = typeof s.ctx?.copy === "function" ? s.ctx.copy : (words) => globalThis.navigator.clipboard.writeText(words);
  let ok = true;
  try { await write(String(value ?? "")); } catch { ok = false; }
  if (ok) haptic();
  if (!node?.id) return;
  s.copied[node.id] = { until: Date.now() + COPIED_MS, state: ok ? "ok" : "failed", text: ok ? "已复制" : "没复制成功" };
  repaint(s);
  const timer = setTimeout(() => repaint(s), COPIED_MS + 20);
  timer.unref?.();
}

async function say(s, label, event) {
  const ctx = s.ctx, card = s.item.card;
  if (!AGENT.test(card.owner ?? "") || typeof ctx?.say !== "function") return;
  clearTimeout(s.timer); s.timer = null;
  const body = sayBody(card.id, label, event, s.data);
  try { await ctx.say(card.owner, body.text, body.card); }
  catch (error) { ctx.problem?.(`没发出去：${error?.message || "请再点一次"}`); }
}

function fail(s, message) { s.busy = false; s.error = message; repaint(s); }

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
  s.busy = true; s.error = ""; repaint(s);
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
  repaint(s);
  ctx.refresh?.(s.item.id);
}

async function cancelForm(s) {
  const ctx = s.ctx;
  if (typeof ctx.answerForm !== "function") return;
  clearTimeout(s.timer); s.timer = null;
  s.busy = true; s.error = ""; repaint(s);
  let result;
  try { result = await answer(s, formCancelBody()); } catch { result = { ok: false, error: { code: "offline" } }; }
  if (!result?.ok) { fail(s, answerProblem(result?.error)); return; }
  secrets.delete(s.item.card.id);
  s.busy = false; s.cancelled = true;
  repaint(s);
  ctx.refresh?.(s.item.id);
}
