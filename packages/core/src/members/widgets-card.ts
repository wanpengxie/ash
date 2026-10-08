/**
 * The home-screen card format: A2UI v0.9 (basic catalog) plus a few Ash extensions, checked against what an Android
 * home-screen widget (RemoteViews) can actually draw. Nothing here is a taste limit: a card is refused only for what
 * the phone physically cannot do, with the component, the property and the reason.
 *
 * The output is the same component list with every data binding, function call and template resolved to literal
 * values: the phone draws it without further decisions, and re-checks the same nesting budget (WidgetPlan.kt).
 */

export class CardError extends Error {}
const bad = (message: string): never => { throw new CardError(message); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const list = (items: readonly string[]): string => items.join(", ");

/** Android limits, not Ash's: see WidgetPlan.kt for the same numbers on the phone. */
export const CARD_LIMITS = {
  /** RemoteViews refuses more than 10 nested RemoteViews below the top one (MAX_NESTED_VIEWS). */
  levels: 10,
  /** Per-size layouts wrap the card in one more RemoteViews. */
  levelsWithSizes: 9,
  /** A scrolling list's items are separate RemoteViews, each with the full budget. */
  itemLevels: 11,
  /** RemoteViews(Map<SizeF, RemoteViews>) takes at most 16 sizes. */
  sizes: 16,
  /** Scrolling lists per layout: each needs a prebuilt view id, as Android sets list contents by id from the widget's top level. */
  lists: 16,
  /** One widget update crosses the binder in a single ~1 MB transaction; bitmaps travel separately. */
  components: 1500,
  json: 512 * 1024,
  text: 20_000,
} as const;

export const CARD_COMPONENTS = ["Text", "Image", "Icon", "Row", "Column", "List", "Card", "Tabs", "Divider", "Button", "CheckBox",
  "ChoicePicker", "Switch", "Stack", "Grid", "Spacer", "ProgressBar", "Badge", "Clock", "Timer"] as const;

/** What a widget cannot hold, and what to use instead. */
const IMPOSSIBLE: Record<string, string> = {
  Video: "Android home-screen widgets cannot play video (RemoteViews has no video view); use an Image with an action that opens an app surface",
  AudioPlayer: "Android home-screen widgets cannot play audio; use a Button whose action asks you (event) or opens an app surface",
  TextField: "Android home-screen widgets cannot take typed input (RemoteViews has no text box); use a Button that opens an app surface or asks Ash",
  DateTimeInput: "Android home-screen widgets cannot show a date or time picker; use a Button that opens an app surface",
  Slider: "Android home-screen widgets cannot hold a slider (SeekBar is not allowed in RemoteViews); use a ProgressBar to show a value and Buttons to change it",
  Modal: "a home-screen widget cannot open a pop-up over the home screen; use an action that opens an app surface (openApp) instead",
  WebView: "Android home-screen widgets cannot run web pages; build the card from components, or open an app surface",
  Html: "Android home-screen widgets cannot run web pages; build the card from components, or open an app surface",
  Script: "home-screen widgets run no code; the card is drawn from components only",
  Canvas: "home-screen widgets cannot draw at run time; send an Image instead",
  Svg: "SVG cannot be drawn in a widget; use Icon {name:{svgPath}} for a single path, or a PNG/JPEG/WebP Image",
  Animation: "home-screen widgets cannot animate; send the frame you want shown",
  Lottie: "home-screen widgets cannot animate; send the frame you want shown",
  Map: "a live map cannot be drawn in a widget; send a map Image and an action that opens it",
  Chart: "there is no chart view in widgets; send the chart as an Image, or build bars from ProgressBar/Row",
};

/** Built-in icons: A2UI v0.9 icon names and Ash's older names. The phone maps each one to a glyph. */
export const CARD_ICONS = [
  "accountCircle", "add", "arrowBack", "arrowForward", "attachFile", "calendarToday", "call", "camera", "check", "close", "delete",
  "download", "edit", "event", "error", "fastForward", "favorite", "favoriteOff", "folder", "help", "home", "info", "locationOn", "lock",
  "lockOpen", "mail", "menu", "moreVert", "moreHoriz", "notificationsOff", "notifications", "pause", "payment", "person", "phone", "photo",
  "play", "print", "refresh", "rewind", "search", "send", "settings", "share", "shoppingCart", "skipNext", "skipPrevious", "star", "starHalf",
  "starOff", "stop", "upload", "visibility", "visibilityOff", "volumeDown", "volumeMute", "volumeOff", "volumeUp", "warning",
  "sun", "cloud", "rain", "snow", "wind", "moon", "heart", "steps", "weight", "sleep", "water", "fire", "calendar", "clock", "alert",
  "bell", "car", "money", "chart"] as const;
const ICONS = new Set<string>(CARD_ICONS);
export const CARD_AVATARS = ["default", "focused", "listening", "resting", "success", "thinking"] as const;

/** Theme colours; each has a light and a dark value on the phone and follows the system's dark mode. */
export const CARD_COLORS = ["text", "textSecondary", "accent", "onAccent", "background", "surface", "surfaceVariant", "line", "transparent",
  "translucentDark", "translucentLight", "white", "black", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"] as const;
const COLORS = new Set<string>(CARD_COLORS);

const COMMON = ["id", "component", "weight", "accessibility", "style", "action", "visible", "checks"];
const FIELDS: Record<string, readonly string[]> = {
  Text: ["text", "variant"],
  Image: ["url", "description", "fit", "variant"],
  Icon: ["name"],
  Row: ["children", "justify", "align"],
  Column: ["children", "justify", "align"],
  List: ["children", "direction", "align", "columns"],
  Card: ["child"],
  Tabs: ["tabs", "selected"],
  Divider: ["axis"],
  Button: ["child", "variant"],
  CheckBox: ["label", "value"],
  Switch: ["label", "value"],
  ChoicePicker: ["label", "variant", "options", "value", "displayStyle", "filterable"],
  Stack: ["children", "align"],
  Grid: ["children", "columns"],
  Spacer: ["size"],
  ProgressBar: ["value", "max", "label"],
  Badge: ["text"],
  Clock: ["format", "timeZone"],
  Timer: ["since", "until"],
};
const CONTAINERS = new Set(["Row", "Column", "List", "Stack", "Grid"]);

export const CARD_STYLE_KEYS = ["background", "color", "cornerRadius", "padding", "margin", "width", "height", "fontSize", "fontWeight",
  "italic", "underline", "strikethrough", "textAlign", "maxLines", "ellipsize", "lineHeight", "letterSpacing", "opacity", "place"] as const;
const STYLE_KEYS = new Set<string>(CARD_STYLE_KEYS);
/** Style a widget cannot apply at run time, with the reason. */
const STYLE_IMPOSSIBLE: Record<string, string> = {
  border: "RemoteViews cannot set a stroke at run time; put the element inside a Card or Stack whose background is the border colour, with padding equal to the border width",
  borderColor: "RemoteViews cannot set a stroke at run time; nest the element in a container with that background and a small padding",
  borderWidth: "RemoteViews cannot set a stroke at run time; nest the element in a container with that background and a small padding",
  shadow: "home-screen widgets draw no shadows",
  boxShadow: "home-screen widgets draw no shadows",
  elevation: "home-screen widgets draw no shadows",
  gradient: "RemoteViews cannot build a gradient at run time; send it as an Image",
  backgroundImage: "use a Stack with an Image first and the content after it",
  fontFamily: "RemoteViews can only switch to monospace text, which Markdown `code` gives",
  animation: "home-screen widgets cannot animate",
  transition: "home-screen widgets cannot animate",
  transform: "home-screen widgets cannot transform elements",
  rotate: "home-screen widgets cannot rotate elements",
};
const PLACES = ["topStart", "top", "topEnd", "start", "center", "end", "bottomStart", "bottom", "bottomEnd"];

/** One normalized colour: "#RRGGBBAA", a theme colour name, or a light/dark pair of those. */
export type CardColor = string | { light: string; dark: string };
export interface CardStyle {
  background?: CardColor; color?: CardColor; cornerRadius?: number; padding?: number[]; margin?: number[];
  width?: number | "fill" | "wrap"; height?: number | "fill" | "wrap"; fontSize?: number; fontWeight?: number; italic?: boolean;
  underline?: boolean; strikethrough?: boolean; textAlign?: string; maxLines?: number; ellipsize?: string; lineHeight?: number;
  letterSpacing?: number; opacity?: number; place?: string;
}
export type CardAction =
  | { event: { name: string; context?: Record<string, unknown> } }
  | { openApp: { app: string; surface?: string } }
  | { openAsh: Record<string, never> }
  | { openUrl: { url: string } };

/** One component as the phone draws it: literal values only. Instances of a template carry the item they show. */
export interface WidgetComponent {
  id: string; component: string;
  weight?: number; style?: CardStyle; action?: CardAction; visible?: boolean; disabled?: boolean; a11y?: string;
  /** The list item (its key) this component belongs to, and that item's data path. */
  item?: string; itemPath?: string;
  /** Where a CheckBox/Switch/ChoicePicker writes the owner's choice back in the card's data (two-way binding). */
  bind?: string;
  children?: string[]; justify?: string; align?: string; direction?: string; columns?: number;
  text?: string; variant?: string; url?: string; fit?: string; name?: string; svgPath?: string; child?: string;
  tabs?: { title: string; child: string }[]; selected?: number; axis?: string; checked?: boolean; label?: string;
  options?: { label: string; value: string; checked: boolean }[]; multiple?: boolean; chips?: boolean;
  value?: number; max?: number; size?: number; format?: string; timeZone?: string; since?: number; until?: number;
}
export interface CardSize { width: number; height: number; root: string }
export interface WidgetRender { root: string; components: WidgetComponent[]; sizes?: CardSize[]; theme?: { accent?: CardColor } }

// ---------------------------------------------------------------------------------------------------------------------
// Data binding and the A2UI value functions.

function unescapePointer(raw: string): string { return raw.replace(/~1/g, "/").replace(/~0/g, "~"); }

export function pointer(data: unknown, path: string): unknown {
  if (path === "" || path === "/") return data;
  if (!path.startsWith("/")) return undefined;
  let at = data;
  for (const raw of path.slice(1).split("/")) {
    const key = unescapePointer(raw);
    if (Array.isArray(at) && /^\d+$/.test(key)) at = at[Number(key)];
    else if (plain(at) && Object.hasOwn(at, key)) at = at[key];
    else return undefined;
  }
  return at;
}

/** Write one value at a JSON pointer, creating objects on the way; arrays only by existing index. */
export function setPointer(data: Record<string, unknown>, path: string, value: unknown): boolean {
  if (!path.startsWith("/") || path === "/") return false;
  const keys = path.slice(1).split("/").map(unescapePointer);
  let at: unknown = data;
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

const absolute = (path: string, scope: string): string => path.startsWith("/") ? path : `${scope}/${path}`.replace(/\/+$/, "") || "/";

function pad(n: number, width = 2): string { return String(n).padStart(width, "0"); }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Unicode TR35 date pattern (the subset A2UI documents), in the phone's local time. */
export function formatDate(date: Date, format: string): string {
  let out = "";
  for (let i = 0; i < format.length;) {
    const ch = format[i];
    if (ch === "'") {
      const end = format.indexOf("'", i + 1);
      out += end < 0 ? format.slice(i + 1) : format.slice(i + 1, end) || "'";
      i = end < 0 ? format.length : end + 1;
      continue;
    }
    let n = 1;
    while (format[i + n] === ch) n++;
    i += n;
    const h = date.getHours();
    switch (ch) {
    case "y": out += n === 2 ? pad(date.getFullYear() % 100) : String(date.getFullYear()); break;
    case "M": out += n >= 4 ? MONTHS[date.getMonth()] : n === 3 ? MONTHS[date.getMonth()].slice(0, 3) : n === 2 ? pad(date.getMonth() + 1) : String(date.getMonth() + 1); break;
    case "d": out += n === 2 ? pad(date.getDate()) : String(date.getDate()); break;
    case "E": out += n >= 4 ? DAYS[date.getDay()] : DAYS[date.getDay()].slice(0, 3); break;
    case "H": out += n === 2 ? pad(h) : String(h); break;
    case "h": { const h12 = h % 12 || 12; out += n === 2 ? pad(h12) : String(h12); break; }
    case "m": out += pad(date.getMinutes()); break;
    case "s": out += pad(date.getSeconds()); break;
    case "a": out += h < 12 ? "AM" : "PM"; break;
    default: out += ch.repeat(n);
    }
  }
  return out;
}

class Resolver {
  constructor(private readonly data: unknown) {}

  /** Any A2UI dynamic value: a literal, {path} or {call, args}. */
  value(value: unknown, where: string, scope: string): unknown {
    if (plain(value)) {
      if (typeof value.path === "string" && Object.keys(value).length === 1) {
        const resolved = pointer(this.data, absolute(value.path, scope));
        if (resolved === undefined) bad(`${where} reads ${absolute(value.path, scope)}, which is not in data`);
        return resolved;
      }
      if (typeof value.call === "string") return this.call(value, where, scope);
    }
    return value;
  }

  text(value: unknown, where: string, scope: string): string {
    let resolved = this.value(value, where, scope);
    if (typeof resolved === "number" && Number.isFinite(resolved)) resolved = String(resolved);
    if (typeof resolved === "boolean") resolved = String(resolved);
    if (typeof resolved !== "string") bad(`${where} must be text, {path} or a function call {call, args}`);
    const out = (resolved as string).replace(/\r\n?/g, "\n").replace(/[\p{Cc}]/gu, (ch) => ch === "\n" || ch === "\t" ? ch : " ");
    if (out.length > CARD_LIMITS.text) bad(`${where} is ${out.length} characters; one text can hold at most ${CARD_LIMITS.text}`);
    return out;
  }

  number(value: unknown, where: string, scope: string): number {
    let resolved = this.value(value, where, scope);
    if (typeof resolved === "string" && resolved.trim() !== "" && Number.isFinite(Number(resolved))) resolved = Number(resolved);
    if (typeof resolved !== "number" || !Number.isFinite(resolved)) bad(`${where} must be a number`);
    return resolved as number;
  }

  bool(value: unknown, where: string, scope: string): boolean {
    const resolved = this.value(value, where, scope);
    if (typeof resolved !== "boolean") bad(`${where} must be true or false`);
    return resolved as boolean;
  }

  private call(fn: Record<string, unknown>, where: string, scope: string): unknown {
    const name = fn.call as string;
    const args = fn.args === undefined ? {} : fn.args;
    if (!plain(args)) bad(`${where}: ${name} args must be an object`);
    const a = args as Record<string, unknown>;
    const at = `${where} (${name})`;
    const opt = (key: string) => a[key] === undefined ? undefined : this.value(a[key], `${at} ${key}`, scope);
    switch (name) {
    case "formatString": return this.interpolate(this.text(a.value, `${at} value`, scope), at, scope);
    case "formatNumber": case "formatCurrency": {
      const n = this.number(a.value, `${at} value`, scope);
      const decimals = a.decimals === undefined ? undefined : Math.max(0, Math.min(20, Math.round(this.number(a.decimals, `${at} decimals`, scope))));
      const grouping = a.grouping === undefined ? true : this.bool(a.grouping, `${at} grouping`, scope);
      const options: Intl.NumberFormatOptions = { useGrouping: grouping,
        ...(decimals !== undefined ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : {}) };
      if (name === "formatCurrency") {
        const currency = this.text(a.currency, `${at} currency`, scope);
        try { return new Intl.NumberFormat("zh-CN", { ...options, style: "currency", currency }).format(n); }
        catch { return bad(`${at} currency "${currency}" is not an ISO 4217 code`); }
      }
      return new Intl.NumberFormat("zh-CN", options).format(n);
    }
    case "formatDate": {
      const raw = this.value(a.value, `${at} value`, scope);
      const date = typeof raw === "number" ? new Date(raw) : typeof raw === "string" ? new Date(raw) : null;
      if (!date || Number.isNaN(date.getTime())) bad(`${at} value must be a time (milliseconds or an ISO 8601 string)`);
      return formatDate(date as Date, this.text(a.format, `${at} format`, scope));
    }
    case "pluralize": {
      const n = this.number(a.value, `${at} value`, scope);
      if (a.other === undefined) bad(`${at} needs other`);
      const category = n === 0 && a.zero !== undefined ? "zero" : new Intl.PluralRules("en").select(n);
      const chosen = a[category] !== undefined ? a[category] : a.other;
      return this.text(chosen, `${at} ${category}`, scope);
    }
    case "and": case "or": {
      if (!Array.isArray(a.values) || a.values.length < 2) bad(`${at} needs values: at least two booleans`);
      const values = (a.values as unknown[]).map((v, i) => this.bool(v, `${at} values[${i}]`, scope));
      return name === "and" ? values.every(Boolean) : values.some(Boolean);
    }
    case "not": return !this.bool(a.value, `${at} value`, scope);
    case "required": { const v = opt("value"); return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0); }
    case "regex": {
      const v = String(opt("value") ?? "");
      try { return new RegExp(this.text(a.pattern, `${at} pattern`, scope)).test(v); } catch { return bad(`${at} pattern is not a valid regular expression`); }
    }
    case "length": {
      const v = opt("value"); const len = typeof v === "string" || Array.isArray(v) ? v.length : 0;
      const min = a.min === undefined ? -Infinity : this.number(a.min, `${at} min`, scope);
      const max = a.max === undefined ? Infinity : this.number(a.max, `${at} max`, scope);
      return len >= min && len <= max;
    }
    case "numeric": {
      const v = Number(opt("value"));
      const min = a.min === undefined ? -Infinity : this.number(a.min, `${at} min`, scope);
      const max = a.max === undefined ? Infinity : this.number(a.max, `${at} max`, scope);
      return Number.isFinite(v) && v >= min && v <= max;
    }
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(opt("value") ?? ""));
    case "now": return new Date().toISOString();
    case "openUrl": return bad(`${where}: openUrl is an action, not a value`);
    }
    return bad(`${where} calls unknown function "${name}"; the card can use formatString, formatNumber, formatCurrency, formatDate, pluralize, and, or, not, required, regex, length, numeric, email, now (and openUrl as an action)`);
  }

  /** formatString: ${/path}, ${relative/path} and ${fn(arg:value, ...)}; \${ is a literal. */
  interpolate(template: string, where: string, scope: string): string {
    let out = "";
    let i = 0;
    while (i < template.length) {
      if (template.startsWith("\\${", i)) { out += "${"; i += 3; continue; }
      if (template.startsWith("${", i)) {
        const [value, next] = this.expression(template, i + 2, where, scope);
        if (template[next] !== "}") bad(`${where}: unclosed \${ in formatString`);
        out += value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
        i = next + 1;
        continue;
      }
      out += template[i++];
    }
    return out;
  }

  /** One expression inside ${...}: a function call or a path. Returns the value and the index after it. */
  private expression(s: string, start: number, where: string, scope: string): [unknown, number] {
    let i = start;
    while (s[i] === " ") i++;
    const name = /^[A-Za-z_][A-Za-z0-9_]*\(/.exec(s.slice(i));
    if (name) {
      i += name[0].length;
      const args: Record<string, unknown> = {};
      for (;;) {
        while (s[i] === " " || s[i] === ",") i++;
        if (s[i] === ")") { i++; break; }
        const key = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        if (!key) bad(`${where}: function arguments in formatString must be named (name:value)`);
        i += key![0].length;
        while (s[i] === " ") i++;
        if (s[i] !== ":") bad(`${where}: expected ':' after argument ${key![0]}`);
        i++;
        while (s[i] === " ") i++;
        let value: unknown;
        if (s.startsWith("${", i)) {
          const [v, next] = this.expression(s, i + 2, where, scope);
          if (s[next] !== "}") bad(`${where}: unclosed \${ in formatString`);
          value = v; i = next + 1;
        } else if (s[i] === "'" || s[i] === "\"") {
          const quote = s[i]; const end = s.indexOf(quote, i + 1);
          if (end < 0) bad(`${where}: unclosed string in formatString`);
          value = s.slice(i + 1, end); i = end + 1;
        } else {
          const raw = /^[^,)\s]+/.exec(s.slice(i))?.[0] ?? "";
          i += raw.length;
          value = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) && raw !== "" ? Number(raw) : raw;
        }
        args[key![0]] = value;
      }
      while (s[i] === " ") i++;
      return [this.call({ call: name[0].slice(0, -1), args }, where, scope), i];
    }
    const path = /^[^}]*/.exec(s.slice(i))![0].trim();
    const resolved = pointer(this.data, absolute(path, scope));
    if (resolved === undefined) bad(`${where} reads ${absolute(path, scope)}, which is not in data`);
    return [resolved, i + /^[^}]*/.exec(s.slice(i))![0].length];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Style, colours, actions.

function color(value: unknown, where: string): CardColor {
  if (plain(value) && Object.keys(value).every((k) => k === "light" || k === "dark") && value.light !== undefined && value.dark !== undefined)
    return { light: color(value.light, `${where}.light`) as string, dark: color(value.dark, `${where}.dark`) as string };
  if (typeof value !== "string") return bad(`${where} must be "#RRGGBB", "#RRGGBBAA", a theme colour (${list(CARD_COLORS)}) or {light, dark}`);
  if (COLORS.has(value)) return value;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!hex) return bad(`${where} "${value}" is not a colour: use "#RRGGBB", "#RRGGBBAA" (alpha last, as in CSS), a theme colour (${list(CARD_COLORS)}) or {light, dark}`);
  let h = hex[1].toUpperCase();
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) h += "FF";
  return `#${h}`;
}

function dimension(value: unknown, where: string, max = 2000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) bad(`${where} must be a number of dp from 0 to ${max}`);
  return Math.round((value as number) * 10) / 10;
}

function box(value: unknown, where: string): number[] {
  if (typeof value === "number") { const d = dimension(value, where, 500); return [d, d, d, d]; }
  if (Array.isArray(value) && [1, 2, 4].includes(value.length)) {
    const n = value.map((v, i) => dimension(v, `${where}[${i}]`, 500));
    return n.length === 1 ? [n[0], n[0], n[0], n[0]] : n.length === 2 ? [n[0], n[1], n[0], n[1]] : n;
  }
  if (plain(value)) {
    const side = (k: string, ...alt: string[]) => { for (const key of [k, ...alt]) if (value[key] !== undefined) return dimension(value[key], `${where}.${key}`, 500); return 0; };
    for (const key of Object.keys(value)) if (!["top", "right", "bottom", "left", "start", "end"].includes(key)) bad(`${where} has unknown side "${key}" (top, end/right, bottom, start/left)`);
    return [side("top"), side("end", "right"), side("bottom"), side("start", "left")];
  }
  return bad(`${where} must be a number of dp, [vertical, horizontal], [top, end, bottom, start] or {top, end, bottom, start}`);
}

function style(raw: unknown, where: string, r: Resolver, scope: string): CardStyle | undefined {
  if (raw === undefined) return undefined;
  if (!plain(raw)) bad(`${where} style must be an object`);
  const s = raw as Record<string, unknown>;
  const out: CardStyle = {};
  for (const key of Object.keys(s)) {
    if (STYLE_IMPOSSIBLE[key]) bad(`${where} style.${key} is not possible: ${STYLE_IMPOSSIBLE[key]}`);
    if (!STYLE_KEYS.has(key)) bad(`${where} has unknown style "${key}"; style supports ${list(CARD_STYLE_KEYS)}`);
    const v = r.value(s[key], `${where} style.${key}`, scope);
    const at = `${where} style.${key}`;
    switch (key) {
    case "background": case "color": out[key] = color(v, at); break;
    case "cornerRadius": out.cornerRadius = dimension(v, at, 500); break;
    case "padding": case "margin": out[key] = box(v, at); break;
    case "width": case "height":
      out[key] = v === "fill" || v === "wrap" ? v : dimension(v, at); break;
    case "fontSize": out.fontSize = dimension(v, at, 200); if (out.fontSize < 1) bad(`${at} must be at least 1`); break;
    case "fontWeight": {
      const w = v === "normal" ? 400 : v === "medium" ? 500 : v === "bold" ? 700 : v;
      if (typeof w !== "number" || w < 100 || w > 900) bad(`${at} must be normal, medium, bold or 100-900`);
      out.fontWeight = Math.round((w as number) / 100) * 100; break;
    }
    case "italic": case "underline": case "strikethrough":
      if (typeof v !== "boolean") bad(`${at} must be true or false`);
      out[key] = v as boolean; break;
    case "textAlign":
      if (!["start", "center", "end", "left", "right", "justify"].includes(String(v))) bad(`${at} must be start, center, end or justify`);
      out.textAlign = v === "left" ? "start" : v === "right" ? "end" : String(v); break;
    case "maxLines":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 1000) bad(`${at} must be a whole number from 1`);
      out.maxLines = v as number; break;
    case "ellipsize":
      if (!["end", "start", "middle", "none"].includes(String(v))) bad(`${at} must be end, start, middle or none`);
      out.ellipsize = String(v); break;
    case "lineHeight": out.lineHeight = dimension(v, at, 400); break;
    case "letterSpacing":
      if (typeof v !== "number" || v < -1 || v > 2) bad(`${at} must be a number of em from -1 to 2`);
      out.letterSpacing = v as number; break;
    case "opacity":
      if (typeof v !== "number" || v < 0 || v > 1) bad(`${at} must be from 0 to 1`);
      out.opacity = v as number; break;
    case "place":
      if (!PLACES.includes(String(v))) bad(`${at} must be one of ${list(PLACES)}`);
      out.place = String(v); break;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const APP_ID = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*$/;
const SURFACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const URL_SCHEMES = ["https:", "http:", "mailto:", "tel:", "sms:", "geo:"];

function openTarget(url: string, where: string): CardAction {
  if (url === "ash:" || url === "ash://" || url === "ash://home") return { openAsh: {} };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return bad(`${where} url "${url}" is not a URL`); }
  if (parsed.protocol === "ui:" || parsed.protocol === "ash-app:") {
    // ui://<app>/<surface> (an app's resource) or ash-app://open?app=<app>&surface=<surface>.
    const app = parsed.protocol === "ui:" ? parsed.hostname : parsed.searchParams.get("app") ?? "";
    const surface = parsed.protocol === "ui:" ? decodeURIComponent(parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "") : parsed.searchParams.get("surface") ?? "";
    if (!APP_ID.test(app)) bad(`${where} url "${url}" names no app id`);
    if (surface && !SURFACE_ID.test(surface)) bad(`${where} url "${url}" has an invalid surface id`);
    return { openApp: { app, ...(surface ? { surface } : {}) } };
  }
  if (!URL_SCHEMES.includes(parsed.protocol)) bad(`${where} url scheme ${parsed.protocol} is not opened from a card (allowed: ${list(URL_SCHEMES)}, ui://<app>/<surface>, ash-app://, ash:)`);
  if (url.length > 2048) bad(`${where} url is longer than 2048 characters`);
  return { openUrl: { url: parsed.toString() } };
}

function action(raw: unknown, where: string, r: Resolver, scope: string): CardAction {
  const shapes = "{event:{name, context?}}, {functionCall:{call:'openUrl', args:{url}}}, {openApp:{app, surface?}} or {openAsh:{}}";
  if (!plain(raw) || Object.keys(raw).length !== 1) return bad(`${where} action must be one of ${shapes}`);
  if (plain(raw.event)) {
    const e = raw.event;
    for (const key of Object.keys(e)) if (key !== "name" && key !== "context") bad(`${where} action.event has unknown field "${key}" (name, context)`);
    if (typeof e.name !== "string" || !EVENT_NAME.test(e.name)) bad(`${where} action.event.name must be letters, digits, _ . : - (at most 64)`);
    let context: Record<string, unknown> | undefined;
    if (e.context !== undefined) {
      if (!plain(e.context)) bad(`${where} action.event.context must be an object`);
      context = {};
      for (const [key, value] of Object.entries(e.context as Record<string, unknown>)) context[key] = r.value(value, `${where} action.event.context.${key}`, scope);
    }
    return { event: { name: e.name as string, ...(context ? { context } : {}) } };
  }
  if (plain(raw.functionCall)) {
    const f = raw.functionCall;
    if (f.call !== "openUrl") bad(`${where} action.functionCall "${String(f.call)}": the only action function is openUrl`);
    const url = r.text(plain(f.args) ? f.args.url : undefined, `${where} openUrl url`, scope);
    return openTarget(url, where);
  }
  if (plain(raw.openApp)) {
    const app = r.text(raw.openApp.app, `${where} openApp.app`, scope);
    if (!APP_ID.test(app)) bad(`${where} openApp.app "${app}" is not an app id (as in apps.list)`);
    const surface = raw.openApp.surface === undefined ? undefined : r.text(raw.openApp.surface, `${where} openApp.surface`, scope);
    if (surface !== undefined && !SURFACE_ID.test(surface)) bad(`${where} openApp.surface "${surface}" is not a surface id (as in the app's surfaces)`);
    return { openApp: { app, ...(surface ? { surface } : {}) } };
  }
  if (plain(raw.openAsh)) return { openAsh: {} };
  return bad(`${where} action must be one of ${shapes}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Images.

const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,([A-Za-z0-9+/=\s]+)$/i;

/** The pixel size in an image's header; null when the bytes are not a PNG, JPEG, GIF, WebP or BMP. */
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 10 && bytes.toString("ascii", 0, 3) === "GIF") return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)) };
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") { const b = bytes.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    if (chunk === "VP8X") return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** A source the phone can draw: Ash's face, a built-in icon, an https image, or an embedded image. */
function imageUrl(url: string, where: string): string {
  if (url === "avatar") return url;
  if (url.startsWith("avatar:")) {
    if (!(CARD_AVATARS as readonly string[]).includes(url.slice(7))) bad(`${where} "${url}": Ash's faces are ${list(CARD_AVATARS)}`);
    return url;
  }
  if (url.startsWith("icon:")) {
    if (!ICONS.has(url.slice(5))) bad(`${where} "${url}": there is no built-in icon "${url.slice(5)}"; icons are ${list(CARD_ICONS)}`);
    return url;
  }
  if (url.startsWith("data:")) {
    const m = DATA_IMAGE.exec(url);
    if (!m) {
      if (/^data:image\/svg/i.test(url)) bad(`${where}: SVG cannot be drawn in a widget (Android decodes only bitmaps); send PNG, JPEG, WebP, GIF or BMP`);
      bad(`${where}: a data URL must be data:image/<png|jpeg|webp|gif|bmp>;base64,...`);
    }
    const bytes = Buffer.from(m![2].replace(/\s+/g, ""), "base64");
    const size = imageSize(bytes);
    if (!size || size.width < 1 || size.height < 1) bad(`${where}: the embedded image is not a readable ${m![1]} file`);
    // Android decodes a downsampled copy, so any size draws; past this the header is surely corrupt.
    if (size!.width > 65_535 || size!.height > 65_535) bad(`${where}: the embedded image claims ${size!.width}x${size!.height} pixels, which no phone decodes`);
    return url.replace(/\s+/g, "");
  }
  if (/^http:\/\//i.test(url)) bad(`${where}: plain http images are not fetched; use https`);
  if (!/^https:\/\//i.test(url)) bad(`${where} "${url.slice(0, 80)}" must be "avatar", "avatar:<face>", "icon:<name>", an https:// URL or a data:image/... URL`);
  try { new URL(url); } catch { bad(`${where} "${url.slice(0, 80)}" is not a valid URL`); }
  if (url.length > 4096) bad(`${where}: the URL is longer than 4096 characters`);
  if (/\.svgz?(\?|#|$)/i.test(url)) bad(`${where}: SVG cannot be drawn in a widget (Android decodes only bitmaps); use a PNG, JPEG or WebP URL`);
  return url;
}

// ---------------------------------------------------------------------------------------------------------------------
// The card.

/**
 * How many nested RemoteViews a component needs: one for itself, plus one for a weighted child of a Row/Column (every
 * child when it justifies "stretch") or a Stack child placed anywhere but the top start (each sits in a slot), and a Grid's rows and cells. A List counts once: its items are
 * separate RemoteViews with their own budget. WidgetPlan.levels on the phone counts the same way.
 */
export function levels(byId: Map<string, WidgetComponent>, id: string): number {
  const c = byId.get(id)!;
  const of = (child: string) => levels(byId, child);
  switch (c.component) {
  case "Row": case "Column":
    return 1 + Math.max(0, ...(c.children ?? []).map((k) => of(k) + ((byId.get(k)!.weight ?? 0) > 0 || c.justify === "stretch" ? 1 : 0)));
  case "Stack":
    return 1 + Math.max(0, ...(c.children ?? []).map((k) => of(k) + ((byId.get(k)!.style?.place ?? c.align ?? "topStart") !== "topStart" ? 1 : 0)));
  case "Grid": return 3 + Math.max(0, ...(c.children ?? []).map(of));
  case "Card": case "Button": return 1 + (c.child ? of(c.child) : 0);
  case "Tabs": return 1 + Math.max(2, ...(c.tabs ?? []).map((t) => of(t.child)));
  case "ChoicePicker": return 2;
  default: return 1;
  }
}

/** The deepest branch, for the error message. */
function deepest(byId: Map<string, WidgetComponent>, id: string): string[] {
  const c = byId.get(id)!;
  const kids = c.component === "List" ? [] : [...(c.children ?? []), ...(c.child ? [c.child] : []), ...(c.tabs ?? []).map((t) => t.child)];
  let best: string[] = [];
  for (const k of kids) { const path = deepest(byId, k); if (path.length > best.length) best = path; }
  return [id, ...best];
}

/**
 * Check a card's A2UI and resolve it into literal components. Throws a CardError naming the component, the property
 * and why; never accepts something the phone would draw differently or not at all.
 */
export function validateCard(raw: unknown, options: { checkLevels?: boolean } = {}): WidgetRender {
  if (!plain(raw)) bad("a2ui must be an object {components:[...], root?, data?, sizes?, theme?}");
  const a2ui = raw as Record<string, unknown>;
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(a2ui), "utf8"); } catch { bad("a2ui is not plain JSON"); }
  if (bytes > CARD_LIMITS.json) bad(`a2ui is ${bytes} bytes; one card can be at most ${CARD_LIMITS.json} bytes (it is sent to the phone in one piece) — link large images by https instead of embedding them`);
  for (const key of Object.keys(a2ui)) if (!["components", "root", "data", "sizes", "theme", "catalogId", "surfaceId"].includes(key))
    bad(`a2ui has unknown field "${key}" (components, root, data, sizes, theme)`);
  const data = a2ui.data ?? {};
  if (!plain(data)) bad("a2ui.data must be an object");
  const r = new Resolver(data);
  if (!Array.isArray(a2ui.components) || a2ui.components.length === 0) bad("a2ui.components must be a non-empty array of components");
  const defs = new Map<string, Record<string, unknown>>();
  for (const [index, item] of (a2ui.components as unknown[]).entries()) {
    if (!plain(item)) bad(`components[${index}] must be an object`);
    const c = item as Record<string, unknown>;
    if (typeof c.id !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(c.id)) bad(`components[${index}] needs an id (letters, digits, _ . -; at most 64)`);
    const cid = c.id as string;
    if (defs.has(cid)) bad(`component id "${cid}" is used twice`);
    if (typeof c.component !== "string") bad(`component "${cid}" needs a component type`);
    const kind = c.component as string;
    if (IMPOSSIBLE[kind]) bad(`${kind} "${cid}" cannot be drawn: ${IMPOSSIBLE[kind]}`);
    const allowed = FIELDS[kind];
    if (!allowed) bad(`component "${cid}" has unknown type "${kind}"; widgets draw ${list(CARD_COMPONENTS)}`);
    for (const key of Object.keys(c)) if (!COMMON.includes(key) && !allowed.includes(key)) {
      if (STYLE_KEYS.has(key) || STYLE_IMPOSSIBLE[key]) bad(`${kind} "${cid}" has "${key}" at the top level; put it in style: {${key}: ...}`);
      bad(`${kind} "${cid}" has unknown field "${key}" (${kind} takes ${list([...allowed, "weight", "style", "action", "visible", "accessibility"])})`);
    }
    defs.set(cid, c);
  }

  const out: WidgetComponent[] = [];
  const byId = new Map<string, WidgetComponent>();
  const reached = new Set<string>();
  /** Mark a definition and everything it names as part of the card, without drawing it. */
  const designed = (id: string, seen = new Set<string>()): void => {
    const def = defs.get(id);
    if (!def || seen.has(id)) return;
    seen.add(id); reached.add(id);
    const kids = def.children;
    if (Array.isArray(kids)) for (const kid of kids) { if (typeof kid === "string") designed(kid, seen); }
    else if (plain(kids) && typeof kids.componentId === "string") designed(kids.componentId, seen);
    if (typeof def.child === "string") designed(def.child, seen);
    if (Array.isArray(def.tabs)) for (const tab of def.tabs) if (plain(tab) && typeof tab.child === "string") designed(tab.child, seen);
  };
  const MAX = CARD_LIMITS.components;

  /** Instantiate definition [defId] as [outId] in data [scope]; [item] is the list item it belongs to. */
  const visit = (defId: string, outId: string, scope: string, item: { key: string; path: string } | undefined, path: string[]): string => {
    if (path.includes(defId)) bad(`component "${defId}" contains itself (${[...path, defId].join(" > ")})`);
    const def = defs.get(defId);
    if (!def) bad(`component "${path[path.length - 1]}" refers to missing component "${defId}"`);
    if (byId.has(outId)) bad(`component "${defId}" is used in more than one place; give each place its own component`);
    if (out.length >= MAX) bad(`the card expands to more than ${MAX} components; one widget update must fit Android's ~1 MB limit — show fewer items or split the card`);
    reached.add(defId);
    const c = def as Record<string, unknown>;
    const kind = c.component as string;
    const where = `${kind} "${defId}"`;
    const node: WidgetComponent = { id: outId, component: kind };
    byId.set(outId, node);
    out.push(node);
    const suffix = outId.slice(defId.length);
    const childPath = [...path, defId];
    const childId = (id: string) => `${id}${suffix}`;
    const one = (id: unknown, field: string): string => {
      if (typeof id !== "string") bad(`${where} ${field} must be a component id`);
      return visit(id as string, childId(id as string), scope, item, childPath);
    };
    const children = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        if (value.some((v) => typeof v !== "string")) bad(`${where} children must be component ids`);
        return (value as string[]).map((id) => visit(id, childId(id), scope, item, childPath));
      }
      if (plain(value) && typeof value.componentId === "string" && typeof value.path === "string") {
        const at = absolute(value.path, scope);
        const items = pointer(data, at);
        if (!Array.isArray(items)) bad(`${where} children template reads ${at}, which is not an array in data`);
        // A template with no items now is still part of the card (it draws once there are items).
        if (!(items as unknown[]).length) designed(value.componentId as string);
        return (items as unknown[]).map((entry, i) => {
          const key = plain(entry) && (typeof entry.id === "string" || typeof entry.id === "number") ? String(entry.id)
            : plain(entry) && (typeof entry.key === "string" || typeof entry.key === "number") ? String(entry.key) : String(i);
          const tid = value.componentId as string;
          return visit(tid, `${tid}${suffix}@${i}`, `${at}/${i}`, { key, path: `${at}/${i}` }, childPath);
        });
      }
      return bad(`${where} children must be an array of component ids or a template {componentId, path}`);
    };
    if (item) { node.item = item.key; node.itemPath = item.path; }
    if (c.weight !== undefined) {
      const w = r.number(c.weight, `${where} weight`, scope);
      if (w < 0 || w > 1000) bad(`${where} weight must be from 0 to 1000`);
      if (w > 0) node.weight = w;
    }
    const s = style(c.style, where, r, scope);
    if (s) node.style = s;
    if (c.visible !== undefined) { const v = r.bool(c.visible, `${where} visible`, scope); if (!v) node.visible = false; }
    if (plain(c.accessibility)) {
      const label = c.accessibility.label === undefined ? undefined : r.text(c.accessibility.label, `${where} accessibility.label`, scope);
      const description = c.accessibility.description === undefined ? undefined : r.text(c.accessibility.description, `${where} accessibility.description`, scope);
      const a11y = [label, description].filter(Boolean).join("，");
      if (a11y) node.a11y = a11y;
    } else if (c.accessibility !== undefined) bad(`${where} accessibility must be {label?, description?}`);
    if (c.action !== undefined) node.action = action(c.action, where, r, scope);
    if (c.checks !== undefined) {
      if (!Array.isArray(c.checks)) bad(`${where} checks must be an array of {condition, message}`);
      for (const [i, check] of (c.checks as unknown[]).entries()) {
        if (!plain(check)) bad(`${where} checks[${i}] must be {condition, message}`);
        if (!r.bool((check as Record<string, unknown>).condition, `${where} checks[${i}].condition`, scope)) node.disabled = true;
      }
    }
    const bound = (value: unknown): string | undefined => plain(value) && typeof value.path === "string" && Object.keys(value).length === 1 ? absolute(value.path, scope) : undefined;
    const enumOf = (field: string, values: string[], fallback?: string): string | undefined => {
      if (c[field] === undefined) return fallback;
      const v = String(r.value(c[field], `${where} ${field}`, scope));
      if (!values.includes(v)) bad(`${where} ${field} must be one of ${list(values)}`);
      return v;
    };

    switch (kind) {
    case "Text":
      node.text = r.text(c.text, `${where} text`, scope);
      node.variant = enumOf("variant", ["h1", "h2", "h3", "h4", "h5", "body", "caption"], "body");
      break;
    case "Image": {
      node.url = imageUrl(r.text(c.url, `${where} url`, scope), `${where} url`);
      const fit = enumOf("fit", ["contain", "cover", "fill", "none", "scaleDown"]); if (fit) node.fit = fit;
      const variant = enumOf("variant", ["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]); if (variant) node.variant = variant;
      if (c.description !== undefined) node.a11y = r.text(c.description, `${where} description`, scope);
      break;
    }
    case "Icon": {
      if (plain(c.name) && typeof c.name.svgPath === "string") {
        const d = c.name.svgPath as string;
        if (!/^[\sMmLlHhVvCcSsQqTtAaZz0-9.,eE+-]+$/.test(d) || d.length > 20_000) bad(`${where} name.svgPath must be SVG path data (M, L, H, V, C, S, Q, T, A, Z and numbers)`);
        node.svgPath = d.replace(/\s+/g, " ").trim();
      } else {
        const name = r.text(c.name, `${where} name`, scope);
        if (!ICONS.has(name)) bad(`${where} name "${name}" is not a built-in icon; use one of ${list(CARD_ICONS)}, or {svgPath:"..."}`);
        node.name = name;
      }
      break;
    }
    case "Row": case "Column": case "Stack": {
      node.children = children(c.children);
      if (kind === "Stack") { const a = enumOf("align", PLACES); if (a) node.align = a; break; }
      const j = enumOf("justify", ["start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"]); if (j) node.justify = j;
      const a = enumOf("align", ["start", "center", "end", "stretch"]); if (a) node.align = a;
      break;
    }
    case "List": {
      const direction = enumOf("direction", ["vertical", "horizontal"], "vertical");
      if (direction === "horizontal") bad(`${where} direction horizontal: Android widgets can only scroll lists vertically; use a Row (no scrolling) or a vertical List`);
      node.children = children(c.children);
      const a = enumOf("align", ["start", "center", "end", "stretch"]); if (a) node.align = a;
      if (c.columns !== undefined) {
        const n = r.number(c.columns, `${where} columns`, scope);
        if (!Number.isInteger(n) || n < 1 || n > 12) bad(`${where} columns must be a whole number from 1 to 12`);
        if (n > 1) node.columns = n;
      }
      break;
    }
    case "Grid": {
      node.children = children(c.children);
      const n = r.number(c.columns ?? 2, `${where} columns`, scope);
      if (!Number.isInteger(n) || n < 1 || n > 12) bad(`${where} columns must be a whole number from 1 to 12`);
      node.columns = n;
      break;
    }
    case "Card": node.child = one(c.child, "child"); break;
    case "Button":
      if (c.action === undefined) bad(`${where} needs an action`);
      node.child = one(c.child, "child");
      node.variant = enumOf("variant", ["default", "primary", "borderless"], "default");
      break;
    case "Tabs": {
      if (!Array.isArray(c.tabs) || c.tabs.length === 0) bad(`${where} tabs must be a non-empty array of {title, child}`);
      node.tabs = (c.tabs as unknown[]).map((tab, i) => {
        if (!plain(tab)) bad(`${where} tabs[${i}] must be {title, child}`);
        const t = tab as Record<string, unknown>;
        return { title: r.text(t.title, `${where} tabs[${i}].title`, scope), child: one(t.child, `tabs[${i}].child`) };
      });
      const sel = c.selected === undefined ? 0 : r.number(c.selected, `${where} selected`, scope);
      if (!Number.isInteger(sel) || sel < 0 || sel >= node.tabs.length) bad(`${where} selected must be a tab index from 0 to ${node.tabs.length - 1}`);
      node.selected = sel;
      break;
    }
    case "Divider": node.axis = enumOf("axis", ["horizontal", "vertical"], "horizontal"); break;
    case "CheckBox": case "Switch": {
      if (c.label !== undefined) node.label = r.text(c.label, `${where} label`, scope);
      node.checked = c.value === undefined ? false : r.bool(c.value, `${where} value`, scope);
      const b = bound(c.value); if (b) node.bind = b;
      break;
    }
    case "ChoicePicker": {
      if (c.filterable === true) bad(`${where} filterable needs a text box, which widgets cannot hold; leave it out`);
      if (c.label !== undefined) node.label = r.text(c.label, `${where} label`, scope);
      node.multiple = enumOf("variant", ["multipleSelection", "mutuallyExclusive"], "mutuallyExclusive") === "multipleSelection";
      node.chips = enumOf("displayStyle", ["checkbox", "chips"], "checkbox") === "chips";
      const raw = c.value === undefined ? [] : r.value(c.value, `${where} value`, scope);
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) bad(`${where} value must be an array of option values`);
      const selected = new Set(raw as string[]);
      if (!Array.isArray(c.options) || c.options.length === 0) bad(`${where} options must be a non-empty array of {label, value}`);
      node.options = (c.options as unknown[]).map((o, i) => {
        if (!plain(o) || typeof o.value !== "string") bad(`${where} options[${i}] must be {label, value}`);
        const opt = o as Record<string, unknown>;
        return { label: r.text(opt.label, `${where} options[${i}].label`, scope), value: opt.value as string, checked: selected.has(opt.value as string) };
      });
      const b = bound(c.value); if (b) node.bind = b;
      break;
    }
    case "Spacer": if (c.size !== undefined) node.size = dimension(r.value(c.size, `${where} size`, scope), `${where} size`); break;
    case "ProgressBar": {
      node.max = c.max === undefined ? 100 : r.number(c.max, `${where} max`, scope);
      if (node.max <= 0) bad(`${where} max must be above 0`);
      const v = r.number(c.value, `${where} value`, scope);
      if (v < 0 || v > node.max) bad(`${where} value must be from 0 to ${node.max}`);
      node.value = v;
      if (c.label !== undefined) node.label = r.text(c.label, `${where} label`, scope);
      break;
    }
    case "Badge": node.text = r.text(c.text, `${where} text`, scope); break;
    case "Clock":
      if (c.format !== undefined) node.format = r.text(c.format, `${where} format`, scope);
      if (c.timeZone !== undefined) {
        const tz = r.text(c.timeZone, `${where} timeZone`, scope);
        try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { bad(`${where} timeZone "${tz}" is not an IANA time zone`); }
        node.timeZone = tz;
      }
      break;
    case "Timer": {
      if ((c.since === undefined) === (c.until === undefined)) bad(`${where} needs since (counts up from a time) or until (counts down to a time), in epoch milliseconds`);
      const key = c.since !== undefined ? "since" : "until";
      const t = r.number(c[key], `${where} ${key}`, scope);
      if (t < 0) bad(`${where} ${key} must be epoch milliseconds`);
      node[key] = Math.round(t);
      break;
    }
    }
    return outId;
  };

  const rootId = a2ui.root ?? "root";
  if (typeof rootId !== "string" || !defs.has(rootId)) bad(`root component "${String(rootId)}" is missing (a2ui.root names it; default "root")`);
  visit(rootId as string, rootId as string, "", undefined, []);
  let sizes: CardSize[] | undefined;
  if (a2ui.sizes !== undefined) {
    if (!Array.isArray(a2ui.sizes) || a2ui.sizes.length === 0) bad("a2ui.sizes must be a non-empty array of {width, height, root}");
    const count = (a2ui.sizes as unknown[]).length;
    if (count > CARD_LIMITS.sizes) bad(`a2ui.sizes has ${count} layouts; Android takes at most ${CARD_LIMITS.sizes}`);
    // Each layout is drawn on its own, so layouts may share components: every extra layout gets its own copies.
    const drawn = new Map<string, string>([[rootId as string, rootId as string]]);
    sizes = (a2ui.sizes as unknown[]).map((s, i) => {
      if (!plain(s) || typeof s.root !== "string") bad(`a2ui.sizes[${i}] must be {width, height, root}`);
      const size = s as Record<string, unknown>;
      const root = size.root as string;
      if (!defs.has(root)) bad(`a2ui.sizes[${i}].root "${root}" is not a component`);
      if (!drawn.has(root)) drawn.set(root, visit(root, `${root}#${i}`, "", undefined, []));
      return { width: dimension(size.width, `a2ui.sizes[${i}].width`), height: dimension(size.height, `a2ui.sizes[${i}].height`), root: drawn.get(root)! };
    });
  }
  const unused = [...defs.keys()].filter((key) => !reached.has(key));
  if (unused.length) bad(`components not reachable from root: ${unused.slice(0, 5).join(", ")}`);
  let theme: WidgetRender["theme"];
  if (a2ui.theme !== undefined) {
    if (!plain(a2ui.theme)) bad("a2ui.theme must be an object {primaryColor?}");
    const t = a2ui.theme as Record<string, unknown>;
    for (const key of Object.keys(t)) if (!["primaryColor", "agentDisplayName", "iconUrl"].includes(key)) bad(`a2ui.theme has unknown field "${key}" (primaryColor)`);
    if (t.primaryColor !== undefined) theme = { accent: color(t.primaryColor, "a2ui.theme.primaryColor") };
  }

  // What Android can nest, counted the way the phone builds it.
  const roots = [rootId as string, ...(sizes ?? []).map((s) => s.root).filter((x) => x !== rootId)];
  const budget = sizes ? CARD_LIMITS.levelsWithSizes : CARD_LIMITS.levels;
  for (const root of options.checkLevels === false ? [] : roots) {
    const n = levels(byId, root);
    if (n > budget) {
      const branch = deepest(byId, root);
      bad(`the card nests ${n} levels deep (${branch.join(" > ")}); Android widgets allow at most ${budget}${sizes ? " with per-size layouts" : ""} ` +
        "(weighted children of a Row/Column, placed children of a Stack and Grid cells count one more) — flatten it, e.g. put Texts side by side in one Row instead of nesting Columns");
    }
  }
  const countLists = (id: string): number => {
    const c = byId.get(id)!;
    return (c.component === "List" ? 1 : 0) + [...(c.children ?? []), ...(c.child ? [c.child] : []), ...(c.tabs ?? []).map((t) => t.child)].reduce((n, k) => n + countLists(k), 0);
  };
  for (const root of roots) {
    const n = countLists(root);
    if (n > CARD_LIMITS.lists) bad(`the card has ${n} Lists in one layout; Android widgets take at most ${CARD_LIMITS.lists} scrolling lists (each needs its own prebuilt view) — merge them`);
  }
  const inList = (id: string, list: string): void => {
    const c = byId.get(id)!;
    if (c.component === "List") bad(`List "${id}" is inside an item of List "${list}"; Android widgets cannot scroll a list inside a list`);
    for (const k of [...(c.children ?? []), ...(c.child ? [c.child] : []), ...(c.tabs ?? []).map((t) => t.child)]) inList(k, list);
  };
  for (const c of out) if (c.component === "List") for (const item of c.children ?? []) {
    inList(item, c.id);
    if (options.checkLevels === false) continue;
    const n = levels(byId, item);
    if (n > CARD_LIMITS.itemLevels) bad(`an item of List "${c.id}" nests ${n} levels deep (${deepest(byId, item).join(" > ")}); Android allows at most ${CARD_LIMITS.itemLevels} in a list item`);
  }
  return { root: rootId as string, components: out, ...(sizes ? { sizes } : {}), ...(theme ? { theme } : {}) };
}

/** Event names, open targets and toggles on a card, as widget.list reports them. */
export function cardActions(render: WidgetRender): string[] {
  const names = new Set<string>();
  for (const c of render.components) {
    if (c.action && "event" in c.action) names.add(c.action.event.name);
  }
  return [...names];
}
