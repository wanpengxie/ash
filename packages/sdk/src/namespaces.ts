/**
 * Standard hand namespaces. A hand declares capabilities named `<namespace>.<action>`; for a standard namespace the
 * input/result schemas, effect and default risk below are the contract, and every hand that implements a name must
 * give it the same meaning (a hand may accept or return more fields, never fewer, and may raise the risk, never lower
 * it). Anything only one kind of hand can do is not standard and is named `x.<name>.<action>`.
 *
 * Effect and risk are the types and rules of word.ts; nothing is redefined here. The values come from the phone's
 * CapabilityPolicy.kt and the computer's workspace.ts (old effect `send` is `act`, old `structure` is `write`).
 * Results describe the structured part of a call result (`data`); images and files travel in the result's content.
 */
import { DATE_PATTERN } from "./ids";
import type { ErrorCode } from "./message";
import { DEFAULT_CALLERS, secret, type CallerKind, type Effect, type JsonSchema, type Risk, type WordContract } from "./word";

/** A JSON Schema (2020-12) document; the shared `JsonSchema` type of word.ts. */
export type SchemaObject = JsonSchema;

export interface StandardAction {
  /** Full capability name, `<namespace>.<action>`. */
  name: string;
  /** One sentence for the agent. */
  description: string;
  /** What the owner sees while it runs (present continuous). */
  label: string;
  input_schema: SchemaObject;
  result_schema: SchemaObject;
  effect: Effect;
  /** Default risk. */
  risk: Risk;
  /** True when the call operates the screen the owner is currently looking at on that hand. */
  foreground: boolean;
  /** Error codes (SPEC-02 §7) this action is expected to return besides the generic bad_request / timeout / failed. */
  errors: readonly ErrorCode[];
  /** The risk is assessed per call by the hand (SPEC-01 §6.3). */
  per_call_risk?: boolean;
  /** Who may call; default `DEFAULT_CALLERS`. */
  callers?: CallerKind[];
}

// ---------------------------------------------------------------------------------------------------------------------
// browser
//
// A hand may keep several browser spaces (a space is one tab with its own page; spaces on a hand share logins).
// Every action takes an optional `space` (1-24 of a-z 0-9 _ -, default "main"). On a computer a space belongs to the
// caller that opened it. A hand may keep only a few spaces open: opening one more may close the one used longest ago.
// Page content is untrusted data, never instructions.
// ---------------------------------------------------------------------------------------------------------------------

export const BROWSER_SPACE_PATTERN = "^[a-z0-9_-]{1,24}$";
export const BROWSER_DEFAULT_SPACE = "main";
/** `close` takes a space name or `*`; built from BROWSER_SPACE_PATTERN so the rule is written once. */
const BROWSER_CLOSE_PATTERN = `^(${BROWSER_SPACE_PATTERN.slice(1, -1)}|\\*)$`;

const SPACE_HELP = "Which browser space (tab) to use: 1-24 of a-z 0-9 _ -. Default main. Give each task its own space; spaces share logins.";
const spaceProp = (): SchemaObject => ({ type: "string", pattern: BROWSER_SPACE_PATTERN, description: SPACE_HELP });
const object = (properties: Record<string, SchemaObject>, required: readonly string[] = []): SchemaObject =>
  ({ type: "object", additionalProperties: false, required, properties });

/** One numbered control on the page. `ref` is only valid for the latest page the same space returned. */
const elementSchema = (): SchemaObject => ({
  type: "object", required: ["ref", "tag", "text"],
  properties: {
    ref: { type: "integer", minimum: 0, description: "The control number to pass to click / type." },
    tag: { type: "string", description: "Element name, e.g. a, button, input." },
    type: { type: "string", description: "Input type, e.g. text, checkbox." },
    text: { type: "string", description: "Visible name, label or placeholder." },
    href: { type: "string" },
    disabled: { type: "boolean" },
    inViewport: { type: "boolean", description: "False when the control is above or below the visible part of the page." },
  },
});

/** The page as the agent reads it. Returned by open, read, click, type, scroll and back. */
const pageResult = (): SchemaObject => ({
  type: "object", required: ["space", "url", "title", "text", "elements"],
  properties: {
    space: { type: "string" },
    url: { type: "string" },
    title: { type: "string" },
    text: { type: "string", description: "The visible text of the page." },
    scroll: { type: "object", required: ["y", "height"], properties: { y: { type: "integer" }, height: { type: "integer" } } },
    elements: { type: "array", items: elementSchema(), description: "Links, buttons and fields, numbered." },
    truncated: { type: "boolean", description: "True when text or elements were cut to fit." },
  },
});

/** site and label name what is being touched so the owner can approve it by reading one line. */
const targetProps = (what: string): Record<string, SchemaObject> => ({
  ref: { type: "integer", minimum: 0, description: `The ${what} number from the latest page of that space.` },
  site: { type: "string", minLength: 1, description: "The site you are on, e.g. example.com." },
  label: { type: "string", minLength: 1, description: `The ${what}'s visible name, e.g. 登录.` },
});

export const BROWSER_ACTIONS: readonly StandardAction[] = Object.freeze([
  {
    name: "browser.open",
    description: "Open a web page (http or https) in a browser space and return it as text with numbered controls; scripts run like in a real browser.",
    label: "在打开网页",
    input_schema: object({ url: { type: "string", pattern: "^[hH][tT][tT][pP][sS]?://", maxLength: 2048, description: "The address to open." }, space: spaceProp() }, ["url"]),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["forbidden", "unavailable", "result_unknown"],
  },
  {
    name: "browser.read",
    description: "Read the page open in a space now: its text and the numbered controls (links, buttons, fields). Call again after the page changes.",
    label: "在读网页",
    input_schema: object({ space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.click",
    description: "Click a control from the latest page of that space; refused if the page or the control is no longer what site and label say. Returns the page afterwards.",
    label: "在网页上点击",
    input_schema: object({ ...targetProps("control"), space: spaceProp() }, ["ref", "site", "label"]),
    result_schema: pageResult(),
    effect: "act", risk: "outward", foreground: false,
    errors: ["not_found", "conflict", "unavailable", "result_unknown"],
  },
  {
    name: "browser.type",
    description: "Type text into a field from the latest page of that space, replacing its content, optionally submitting its form. Password and file fields are refused. Returns the page afterwards.",
    label: "在网页上输入",
    input_schema: object({
      ...targetProps("field"),
      text: { type: "string", maxLength: 20000, description: "What to type; replaces the field's content." },
      submit: { type: "boolean", description: "Submit the form after typing (like pressing Enter)." },
      space: spaceProp(),
    }, ["ref", "site", "label", "text"]),
    result_schema: pageResult(),
    effect: "act", risk: "outward", foreground: false,
    errors: ["not_found", "conflict", "forbidden", "unavailable", "result_unknown"],
  },
  {
    name: "browser.scroll",
    description: "Scroll the page about one screen down or up and return it.",
    label: "在滚动网页",
    input_schema: object({ direction: { type: "string", enum: ["down", "up"], description: "down (default) or up." }, space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.back",
    description: "Go to the previous page in that space and return it.",
    label: "在回上一页",
    input_schema: object({ space: spaceProp() }),
    result_schema: pageResult(),
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.screenshot",
    description: "A picture of the page in a space as it looks now, for things text does not show (charts, layout). The picture is the image part of the result.",
    label: "在给网页截图",
    input_schema: object({ space: spaceProp() }),
    result_schema: {
      type: "object", required: ["space", "url", "title", "mime"],
      properties: {
        space: { type: "string" }, url: { type: "string" }, title: { type: "string" },
        mime: { type: "string", description: "image/jpeg or image/png." },
        path: { type: "string", description: "Where the hand saved the picture on its own machine, when it did." },
      },
    },
    effect: "read", risk: "none", foreground: false,
    errors: ["not_found", "unavailable"],
  },
  {
    name: "browser.evaluate",
    description: "Run JavaScript in the page of a space and return its JSON-serializable result. Runs with the page's own authority, logged in as the owner.",
    label: "在网页里运行脚本",
    input_schema: object({ code: { type: "string", minLength: 1, maxLength: 100000, description: "JavaScript expression or function body; its value is returned." }, space: spaceProp() }, ["code"]),
    result_schema: {
      type: "object", required: ["space", "value"],
      properties: {
        space: { type: "string" },
        value: { description: "The returned value; null when the script returned nothing." },
        truncated: { type: "boolean" },
      },
    },
    effect: "execute", risk: "structure", foreground: false,
    errors: ["not_found", "unavailable", "result_unknown"],
  },
  {
    name: "browser.close",
    description: "Close a browser space and forget its page (logins stay). space \"*\" closes every space of the caller.",
    label: "在关网页",
    input_schema: object({ space: { type: "string", pattern: BROWSER_CLOSE_PATTERN, description: "The space to close (default main), or * for all of them." } }),
    result_schema: {
      type: "object", required: ["closed"],
      properties: { closed: { type: "array", items: { type: "string" }, description: "The spaces that were closed; empty when none was open." } },
    },
    effect: "act", risk: "none", foreground: false,
    errors: ["unavailable"],
  },
  {
    name: "browser.spaces",
    description: "List the open browser spaces of the caller: address, title and when each was last used (most recent first).",
    label: "在看打开了哪些网页",
    input_schema: object({}),
    result_schema: {
      type: "object", required: ["spaces"],
      properties: {
        spaces: {
          type: "array",
          items: {
            type: "object", required: ["space", "url", "title", "last_used"],
            properties: { space: { type: "string" }, url: { type: "string" }, title: { type: "string" }, last_used: { type: "integer", description: "Unix time, milliseconds." } },
          },
        },
      },
    },
    effect: "read", risk: "none", foreground: false,
    errors: ["unavailable"],
  },
]);

export const BROWSER_ACTION_NAMES: readonly string[] = Object.freeze(BROWSER_ACTIONS.map((action) => action.name));

/** Non-standard browser capabilities that exist today; they stay out of the standard because only one kind of hand can do them. */
export const BROWSER_EXTENSIONS: readonly string[] = Object.freeze([
  "x.android.browser.show", "x.android.browser.run", "x.android.browser.clear_logins", "x.kimi.browser.upload", "x.kimi.browser.network", "x.ego.browser.script",
]);

// ---------------------------------------------------------------------------------------------------------------------
// the other standard namespaces
// ---------------------------------------------------------------------------------------------------------------------

const str = (description?: string): SchemaObject => ({ type: "string", ...(description ? { description } : {}) });
const text1 = (description?: string): SchemaObject => ({ type: "string", minLength: 1, ...(description ? { description } : {}) });
const bool = (description?: string): SchemaObject => ({ type: "boolean", ...(description ? { description } : {}) });
const num = (description?: string): SchemaObject => ({ type: "number", ...(description ? { description } : {}) });
const int = (description?: string, minimum?: number, maximum?: number): SchemaObject =>
  ({ type: "integer", ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...(description ? { description } : {}) });
const choice = (values: readonly string[], description?: string): SchemaObject => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const list = (items: SchemaObject, description?: string): SchemaObject => ({ type: "array", items, ...(description ? { description } : {}) });
/** A result: the listed fields are promised, a hand may add more. */
const loose = (properties: Record<string, SchemaObject> = {}, required: readonly string[] = []): SchemaObject =>
  ({ type: "object", additionalProperties: true, required, properties });
const anyResult = (): SchemaObject => loose();
const nullable = (schema: SchemaObject): SchemaObject => ({ anyOf: [schema, { type: "null" }] });

function action(name: string, label: string, description: string, input: SchemaObject, result: SchemaObject, effect: Effect, risk: Risk,
  extra: { foreground?: boolean; errors?: readonly ErrorCode[]; per_call_risk?: boolean; callers?: CallerKind[] } = {}): StandardAction {
  return {
    name, description, label, input_schema: input, result_schema: result, effect, risk, foreground: extra.foreground ?? false, errors: extra.errors ?? [],
    ...(extra.per_call_risk ? { per_call_risk: true } : {}), ...(extra.callers ? { callers: extra.callers } : {}),
  };
}

/** A point on the screen: fractions of the screen (preferred) or pixels. `suffix` "1" / "2" names the two ends of a swipe. */
const pointProps = (suffix = "", what = "point"): Record<string, SchemaObject> => ({
  [`fx${suffix}`]: num(`${what} x as a fraction 0..1 of the screen width (preferred)`),
  [`fy${suffix}`]: num(`${what} y as a fraction 0..1 of the screen height (preferred)`),
  [`x${suffix}`]: num(`${what} x in screen pixels`),
  [`y${suffix}`]: num(`${what} y in screen pixels`),
});
const finger = (description: string): SchemaObject => int(description, 0, 7);
const A11Y = ["unavailable"] as const;

// ---- screen: the phone's real screen, through accessibility ---------------------------------------------------------

const strokeSchema = (): SchemaObject => ({
  type: "object", required: ["kind"], additionalProperties: false,
  properties: {
    kind: choice(["down", "move", "up", "tap", "swipe", "hold", "wait"], "Stroke type."),
    finger: finger("Finger 0-7 (needed for down / move / up)."),
    ...pointProps(),
    ...pointProps("2", "swipe end"),
    durationMs: num("Stroke time in ms (tap 60, swipe 300, hold 500, move / up 100 by default)."),
    ms: num("Wait time in ms."),
  },
});
const heldFingers = (): SchemaObject => list(loose({ finger: int(), x: int(), y: int(), fx: num(), fy: num(), elapsedMs: int() }, ["finger"]));
const heldResult = (): SchemaObject => loose({ held: heldFingers() });
const SCREEN_ACTIONS: readonly StandardAction[] = [
  action("screen.read", "在读屏幕内容", "Read the phone's current screen as a list of UI elements (foreground app, screen size, and each visible element with its centre point, size and flags). Use it to see what is on screen and where to tap.",
    object({}),
    loose({ package: str(), screenW: int(), screenH: int(), count: int(), truncated: bool(), note: str(), nodes: list(loose({ text: str(), desc: str(), cls: str(), id: str(), x: int(), y: int(), w: int(), h: int(), clickable: bool(), input: bool(), checked: bool(), selected: bool(), scrollable: bool() })) }),
    "read", "none", { errors: A11Y }),
  action("screen.see", "在看屏幕", "Take a screenshot of the phone's screen and look at it (the image is the image part of the result, long side at most 1280 px). Use it when the element list is not enough: pictures, layout, games. Secure screens cannot be captured.",
    object({ grid: { type: "integer", enum: [0, 4, 8], description: "0 (default) none; 4 or 8 overlays an N x N grid to help locate things." }, elements: bool("Also put the element list in the caption."), display: int("Display id (default 0, the main screen; a virtual display id also works).", 0) }),
    anyResult(), "read", "none", { errors: A11Y }),
  action("screen.screenshot", "在截屏", "Save a full-resolution PNG screenshot of the phone's screen to a file and return its path (the picture itself is not shown; use screen.see to look at the screen).",
    object({ path: str("Absolute file path to write (parent directories are created); default a file under the phone's Ash screenshots folder."), display: int("Display id (default 0).", 0) }),
    loose({ path: str(), width: int(), height: int(), bytes: int() }, ["path"]), "read", "none", { errors: A11Y }),
  action("screen.touch_status", "在看触控状态", "Show which virtual fingers are held down by screen.touch or screen.gesture: finger, position, how long, plus the screen size and limits.",
    object({}), loose({ held: heldFingers(), screenW: int(), screenH: int(), maxFingers: int(), holdTimeoutMs: int() }),
    "read", "none", { errors: A11Y }),
  action("screen.tap", "在点屏幕", "Tap an element on the phone's screen: by text or content description, by view id, or by coordinates (fractions preferred). With text or id it clicks through accessibility; long: true long-presses.",
    object({ text: str("Text or content description of the element (case-insensitive, exact or contained)."), desc: str("Alias of text."), id: str("View resource id, e.g. send_button or com.app:id/send_button."), ...pointProps(), long: bool("Long-press instead of a tap.") }),
    loose({ method: str(), x: int(), y: int() }), "act", "outward", { foreground: true, errors: [...A11Y, "not_found"] }),
  action("screen.type", "在屏幕上输入", "Type text into an input field on the phone's screen through accessibility (any language). mode set replaces the field's content, paste pastes at the cursor (use it for web pages). It does not press Enter.",
    object({ text: { type: "string", description: "The text to enter (empty clears the field in set mode)." }, mode: choice(["set", "paste"], "set (default) replaces the content; paste pastes at the cursor."), field: str("Text, hint, description or view id of the field to type into.") }, ["text"]),
    loose({ method: str(), focused: bool(), fallback: bool() }), "act", "outward", { foreground: true, errors: [...A11Y, "not_found"] }),
  action("screen.scroll", "在滚动屏幕", "Scroll the scrollable area of the phone's screen by one page. direction is where you want to see more content (down = further down the list).",
    object({ direction: choice(["up", "down", "left", "right"], "Where you want to see more content.") }, ["direction"]),
    loose({ method: str() }), "act", "outward", { foreground: true, errors: A11Y }),
  action("screen.swipe", "在滑动屏幕", "Swipe one finger from a start point to an end point on the phone's screen (press, move, lift). Give each end as fractions (preferred) or pixels.",
    object({ ...pointProps("1", "start"), ...pointProps("2", "end"), durationMs: num("Swipe time in ms (default 300)."), finger: finger("Optional finger 0-7; a held finger swipes from where it is.") }),
    heldResult(), "act", "outward", { foreground: true, errors: A11Y }),
  action("screen.hold", "在长按屏幕", "Press and hold one point on the phone's screen for durationMs (default 500), then lift: long-press an icon, charge a game action.",
    object({ ...pointProps(), durationMs: num("How long to hold, in ms (default 500)."), finger: finger("Optional finger 0-7.") }),
    heldResult(), "act", "outward", { foreground: true, errors: A11Y }),
  action("screen.touch", "在操作触屏", "A stateful virtual touchscreen for multi-finger control: action down presses finger N and keeps it pressed after the call, move slides a held finger, up lifts it, release_all lifts every finger.",
    object({ action: choice(["down", "move", "up", "release_all"], "down keeps holding; move slides a held finger; up lifts it; release_all lifts all."), finger: finger("Finger number 0-7 (needed except for release_all)."), ...pointProps() }, ["action"]),
    heldResult(), "act", "outward", { foreground: true, errors: A11Y }),
  action("screen.gesture", "在做屏幕手势", "Perform a multi-finger gesture on the phone's screen: strokes run one after another on one timeline and are injected together as one real multi-touch gesture (total at most 60 s).",
    object({ strokes: { type: "array", minItems: 1, items: strokeSchema(), description: "The strokes, in timeline order." } }, ["strokes"]),
    heldResult(), "act", "outward", { foreground: true, errors: A11Y }),
  action("screen.global_action", "在操作手机系统键", "Press a system button on the phone: back, home, recents, notifications (pull down the shade), quick_settings, power_dialog, split_screen, lock_screen.",
    object({ action: choice(["back", "home", "recents", "notifications", "quick_settings", "power_dialog", "split_screen", "lock_screen"], "Which system action.") }, ["action"]),
    anyResult(), "act", "outward", { foreground: true, errors: A11Y }),
];

// ---- input, vscreen -------------------------------------------------------------------------------------------------

const INPUT_ACTIONS: readonly StandardAction[] = [
  action("input.key", "在按手机按键", "Press a key on the phone: media keys (play_pause, next, previous ...), volume keys, and other keys (back, home, recents, power ... or an Android keycode number). Keys other than media and volume need the phone's debug identity (「后台也能动手」), which the owner connects.",
    object({ key: text1("Key name, or a numeric KeyEvent keycode."), long_press: bool("Long-press (injected keys only).") }, ["key"]),
    anyResult(), "act", "outward", { foreground: true, errors: ["unavailable"] }),
];

const VSCREEN_NEEDS = " Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+).";
const vscreenXY = (): Record<string, SchemaObject> => ({ x: num("X in virtual-screen pixels."), y: num("Y in virtual-screen pixels.") });
const VSCREEN_ACTIONS: readonly StandardAction[] = [
  action("vscreen.create", "在创建虚拟屏", `Create (or reuse) the virtual screen: a separate phone-shaped display, invisible to the owner, where apps can be launched, seen and operated without disturbing the real screen. Only one exists; calling again with another size recreates it.${VSCREEN_NEEDS}`,
    object({ orientation: choice(["portrait", "landscape"], "portrait (9:16, default) or landscape (16:9)."), short_edge: int("Short side in pixels, rounded to a multiple of 144 (288..1440, default 720).", 288, 1440), dpi: int("Density (default 320).", 120, 640) }),
    loose({ displayId: int(), width: int(), height: int(), dpi: int(), reused: bool() }, ["displayId"]), "act", "structure", { errors: ["unavailable"] }),
  action("vscreen.close", "在关闭虚拟屏", `Destroy the virtual screen (apps running on it are closed or moved) and stop its server. Call it when the task is done.${VSCREEN_NEEDS}`,
    object({}), anyResult(), "act", "structure", { errors: ["unavailable"] }),
  action("vscreen.status", "在看虚拟屏状态", "Report whether the virtual screen exists, its display id, size and dpi, and whether it has rendered a frame.",
    object({}), loose({ running: bool(), displayId: int(), width: int(), height: int(), dpi: int() }, ["running"]), "read", "none", { errors: ["unavailable"] }),
  action("vscreen.see", "在看虚拟屏", `Screenshot of the virtual screen (JPEG, long side at most 1280 px); the caption gives the factor from image pixels to the screen coordinates vscreen.tap uses.${VSCREEN_NEEDS}`,
    object({ max_side: int("Longest side of the image in pixels (160-1280, default 1280); the owner's live preview asks for less.", 160, 1280), quality: int("JPEG quality (30-90, default 80).", 30, 90) }), anyResult(), "read", "none", { errors: ["unavailable"] }),
  action("vscreen.record.start", "在录虚拟屏", `Start recording the virtual screen to a video (mp4). Call it when the owner asks you to record ("录下来"); do the work on the virtual screen as usual, then vscreen.record.stop. It stops by itself at max_seconds (default 120, at most 600) or when the virtual screen closes.${VSCREEN_NEEDS}`,
    object({ max_seconds: int("Longest recording in seconds (10-600, default 120).", 10, 600) }), loose({ startedAt: int(), maxSeconds: int() }), "act", "structure", { errors: ["unavailable"] }),
  action("vscreen.record.stop", "在停止录虚拟屏", `Stop the recording and save it in your workspace (/root/work/recordings/vscreen-<time>.mp4); the reply gives the path, length and size. Show it to the owner with human_show as a file card (workspace body:main, mime video/mp4). Also hands over a recording that stopped by itself.${VSCREEN_NEEDS}`,
    object({}), loose({ path: str(), seconds: num(), bytes: int(), reason: str() }, ["path"]), "act", "structure", { errors: ["unavailable", "bad_request"] }),
  action("vscreen.launch", "在虚拟屏里打开应用", `Launch an app onto the virtual screen for delegated work (use apps.open to show an app to the owner). Wait a moment, then vscreen.see.${VSCREEN_NEEDS}`,
    object({ app: text1("Package name or launcher label of the app.") }, ["app"]), loose({ package: str(), component: str() }), "act", "outward", { errors: ["unavailable", "not_found"] }),
  action("vscreen.tap", "在点虚拟屏", `Tap on the virtual screen at (x, y) in virtual-screen pixels (see vscreen.see for the scale).${VSCREEN_NEEDS}`,
    object(vscreenXY(), ["x", "y"]), anyResult(), "act", "outward", { errors: ["unavailable"] }),
  action("vscreen.swipe", "在滑动虚拟屏", `Swipe on the virtual screen from (x1, y1) to (x2, y2) in virtual-screen pixels, e.g. to scroll (drag upwards to scroll down).${VSCREEN_NEEDS}`,
    object({ x1: num("Start X."), y1: num("Start Y."), x2: num("End X."), y2: num("End Y."), duration_ms: int("Duration in ms (default 300; 1000 and more acts like a drag).", 10, 10000) }, ["x1", "y1", "x2", "y2"]),
    anyResult(), "act", "outward", { errors: ["unavailable"] }),
  action("vscreen.key", "在虚拟屏按键", `Send a key press to the virtual screen: a name (back, home, enter, menu, app_switch, tab, escape, delete ...) or an Android keycode number.${VSCREEN_NEEDS}`,
    object({ key: text1("Key name, or a numeric KeyEvent keycode."), long_press: bool("Long-press instead of a short press.") }, ["key"]),
    anyResult(), "act", "outward", { errors: ["unavailable"] }),
  action("vscreen.type", "在虚拟屏输入", `Type text into the focused field of the virtual screen (tap the field first). Text with non-ASCII characters is pasted through the clipboard, replacing the owner's clipboard content.${VSCREEN_NEEDS}`,
    object({ text: { type: "string", description: "Text to type." } }, ["text"]), anyResult(), "act", "outward", { errors: ["unavailable"] }),
];

// ---- apps, settings, clipboard, device ------------------------------------------------------------------------------

const SETTINGS_PAGES = ["settings", "wifi", "bluetooth", "mobile_network", "data_usage", "airplane_mode", "vpn", "nfc", "display", "sound",
  "battery_saver", "battery_usage", "location", "security", "storage", "date_time", "language", "keyboard", "accessibility", "developer", "device_info",
  "apps", "default_apps", "home_app", "notification_access", "app_details", "app_notifications", "overlay", "write_settings", "install_unknown_apps",
  "all_files_access", "usage_access"] as const;
const SETTINGS_NAMESPACES = ["system", "secure", "global"] as const;

const APPS_ACTIONS: readonly StandardAction[] = [
  action("apps.list", "在看装了哪些应用", "List the apps on the phone that have a launcher icon: label and package name, sorted by label. Optionally filter by a substring of the label or package.",
    object({ query: str("Only apps whose label or package contains this text (case-insensitive)."), include_system: bool("Include preinstalled system apps (default true).") }),
    loose({ apps: list(loose({ label: str(), package: str() }, ["label", "package"])) }, ["apps"]), "read", "none"),
  action("apps.info", "在查看应用信息", "Details of an installed package: label, version, install and update time, system or disabled, SDK levels, installer, launcher activity, APK path, and the permissions it requests with their grant state.",
    object({ app: text1("Package name or launcher label."), permissions: bool("Include the requested permissions (default true).") }, ["app"]),
    loose({ package: str(), label: str(), version: str() }), "read", "none", { errors: ["not_found"] }),
  action("apps.usage", "在看应用使用情况", "How long each app was used in the foreground (screen time), most used first, with the last time it was used. Needs the Usage access permission.",
    object({ days: int("Range in days from local midnight (default 1 = today, at most 30).", 1, 30), limit: int("Most apps returned (default 20).", 1), app: str("Only this package (or label substring).") }),
    loose({ apps: list(loose({ package: str() })) }), "read", "none", { errors: ["forbidden", "unavailable"] }),
  action("apps.open", "在打开应用", "Open (launch or bring to front) an app on the real foreground screen, by package name or launcher label, for the owner to use. With the phone's debug identity connected (「后台也能动手」) the host opens it; without, Ash opens it itself, which Android allows only while Ash is in front or its accessibility service or overlay permission is on (the error says what to turn on).",
    object({ app: text1("Package name (e.g. com.tencent.mm) or launcher label.") }, ["app"]),
    loose({ package: str(), opened: bool() }), "act", "outward", { foreground: true, errors: ["not_found", "unavailable"] }),
  action("apps.open_direct", "在直接打开应用", "Open an app on the real foreground screen from the hand app itself, which needs Ash in front or its accessibility service or overlay permission. For the hub's `service:host/apps.open`, which uses it when the host cannot open apps; an agent calls apps.open.",
    object({ app: text1("Package name (e.g. com.tencent.mm) or launcher label.") }, ["app"]),
    loose({ package: str(), opened: bool() }), "act", "outward", { foreground: true, errors: ["not_found", "unavailable"], callers: ["kernel"] }),
  action("apps.open_url", "在打开链接", "Open a URL or deep link on the phone's screen with the app that handles it (https in the browser or a matching app, geo:, tel: opens the dialer without calling, mailto:, app schemes).",
    object({ uri: text1("The URL or deep link."), package: str("Open with this app only (package name).") }, ["uri"]),
    loose({ opened: bool() }), "act", "outward", { foreground: true, errors: ["not_found"] }),
];

const SETTINGS_ACTIONS: readonly StandardAction[] = [
  action("settings.get", "在读系统设置", "Read an Android system setting from system, secure or global (e.g. screen_brightness, screen_off_timeout, airplane_mode_on). A few protected keys cannot be read by an app.",
    object({ namespace: choice(SETTINGS_NAMESPACES, "system, secure or global."), key: text1("Setting key.") }, ["namespace", "key"]),
    loose({ value: nullable(str()) }), "read", "none", { errors: ["forbidden", "unavailable"] }),
  action("settings.put", "在改系统设置", "Change an Android system setting in the system namespace (brightness, screen timeout, rotation, font scale ...); needs the owner's Modify system settings grant. Secure and global settings are the owner's to change in Settings. volume_music, volume_ring and the other volume_* keys set that volume. Returns the previous and the new value.",
    object({ namespace: choice(["system"], "Always system."), key: text1("Setting key."), value: { type: "string", description: "New value, as a string." } }, ["namespace", "key", "value"]),
    loose({ previous: nullable(str()), value: nullable(str()) }), "write", "structure", { errors: ["forbidden", "unavailable"] }),
  action("settings.open", "在打开设置页", "Open a system settings page on the phone's screen for the owner: a named page, an app's details or notification settings (give package), or any raw android.settings.* action.",
    object({ page: choice(SETTINGS_PAGES, "Named page."), action: str("A raw settings intent action instead of page."), package: str("Package for app pages (default: this app).") }),
    loose({ opened: bool() }), "act", "outward", { foreground: true }),
];

const CLIPBOARD_ACTIONS: readonly StandardAction[] = [
  action("clipboard.get", "在读剪贴板", "Read the text on the phone's clipboard. Android 10 and later only let the app in the foreground read it, so this can fail while Ash is in the background.",
    object({}), loose({ text: str() }, ["text"]), "read", "none", { errors: ["unavailable"] }),
  action("clipboard.set", "在改剪贴板", "Put text on the phone's clipboard, replacing what is there, so the owner can paste it anywhere.",
    object({ text: secret({ type: "string", description: "The text to copy; kept out of the ledger." }) }, ["text"]), anyResult(), "act", "structure"),
];

const DEVICE_ACTIONS: readonly StandardAction[] = [
  action("device.status", "在看手机状态", "The device's current status: battery and charging, network (type, online, metered), free storage, memory, screen on or locked, ringer mode and volumes, time, time zone, locale, model and OS version.",
    object({}), loose({ battery: loose({ percent: int(), charging: bool() }), time: str() }), "read", "none"),
];

// ---- workspace, body: the body contract (SPEC-09), registered under body:<id> ------------------------------------------

const wsBase = (): Record<string, SchemaObject> => ({ workdir: text1("Working directory; relative paths start here. Default: the body's work directory.") });
const wsPath = (description = "File or directory path."): SchemaObject => text1(description);
const limit = (max: number, description = "Most results."): SchemaObject => int(description, 1, max);
const procRef = (): SchemaObject => text1("The process id a bash call returned.");
const jobResult = (): SchemaObject => loose({ process: str(), running: bool(), exit_code: nullable(int()), output: str(), path: str(), truncated: bool(), error: str() }, ["process", "running"]);

const WORKSPACE_ACTIONS: readonly StandardAction[] = [
  action("workspace.ls", "在看目录", "List a directory on the body: name, type (file, directory, symlink) and size.",
    object({ ...wsBase(), path: wsPath("Directory path (default the work directory)."), limit: limit(1000) }),
    loose({ path: str(), truncated: bool(), entries: list(loose({ name: str(), type: choice(["file", "directory", "symlink"]), size: nullable(int()) }, ["name", "type"])) }, ["path", "entries"]),
    "read", "none", { errors: ["not_found", "forbidden"] }),
  action("workspace.read", "在读文件", "Read a text file by lines (offset is the first line, from 1), or an image. A binary or large file comes back as a stream reference in the result's content, for download.",
    object({ ...wsBase(), path: wsPath(), offset: int("First line to read, from 1 (default 1).", 1), limit: limit(100000, "Most lines (default 2000).") }, ["path"]),
    loose({ path: str(), text: str(), offset: int(), next_offset: int(), truncated: bool() }), "read", "none", { errors: ["not_found", "forbidden", "too_large"] }),
  action("workspace.find", "在找文件", "Find files by a glob pattern under a directory.",
    object({ ...wsBase(), path: wsPath("Directory to search (default the work directory)."), pattern: text1("Glob pattern, e.g. **/*.ts."), limit: limit(1000) }, ["pattern"]),
    loose({ paths: list(str()), truncated: bool() }, ["paths"]), "read", "none", { errors: ["not_found", "forbidden"] }),
  action("workspace.grep", "在搜文件内容", "Search file contents for a pattern (regular expression, or literal text), with optional context lines.",
    object({
      ...wsBase(), path: wsPath("File or directory to search (default the work directory)."), pattern: { type: "string", description: "What to search for." },
      glob: text1("Only files matching this glob."), literal: bool("Treat pattern as plain text."), ignoreCase: bool("Ignore letter case."),
      context: int("Lines of context around a match.", 0, 20), limit: limit(1000, "Most matches (default 100)."),
    }, ["pattern"]),
    loose({ matches: list(loose({ path: str(), line: int(), text: str(), context: bool() })), truncated: bool() }, ["matches"]), "read", "none", { errors: ["not_found", "forbidden"] }),
  action("workspace.write", "在写文件", "Write a whole file (creating folders), replacing what is there; at most 4 MiB. The risk is assessed per call: a write inside the work directory is harmless, anywhere else it is a lasting change.",
    object({ ...wsBase(), path: wsPath(), content: { type: "string", description: "The file's new content." } }, ["path", "content"]),
    loose({ path: str(), bytes: int() }, ["path"]), "write", "structure", { per_call_risk: true, errors: ["forbidden", "too_large"] }),
  action("workspace.edit", "在改文件", "Edit a file by exact text replacement: each oldText must match exactly once or nothing is saved. The risk is assessed per call like workspace.write.",
    object({ ...wsBase(), path: wsPath(), edits: { type: "array", minItems: 1, maxItems: 1000, items: object({ oldText: text1("Text to replace; must occur exactly once."), newText: { type: "string", description: "Its replacement." } }, ["oldText", "newText"]) } }, ["path", "edits"]),
    loose({ path: str(), edits: int() }, ["path"]), "write", "structure", { per_call_risk: true, errors: ["not_found", "forbidden", "bad_request", "too_large"] }),
  action("workspace.bash", "在执行命令", "Run a shell command on the body. It returns what it printed within yield_ms; if it is still running, use workspace.poll with the process id for more, and workspace.signal to stop it. " +
    "env adds environment variables; a value \"$vault.<name>\" is the vault entry of that name (a password, a key, a connection's token): the hub puts the value in just before the command runs, you and the record only ever see the name, and the value is masked as *** in what comes back. The first use of a name on a body asks the owner.",
    object({ ...wsBase(), command: text1("The command line."), timeout: int("Stop it after this many seconds.", 1, 86400), yield_ms: int("How long to wait for output before returning (ms, default 10000).", 0, 30000),
      env: { type: "object", description: "Environment variables for this command: NAME -> text, or \"$vault.<name>\" for a vault entry.", propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }, additionalProperties: { type: "string", maxLength: 8192 }, maxProperties: 50 } }, ["command"]),
    jobResult(), "execute", "structure", { errors: ["forbidden", "timeout"] }),
  action("workspace.poll", "在读命令输出", "Read the new output of a command started with workspace.bash, waiting up to yield_ms for more.",
    object({ process: procRef(), yield_ms: int("How long to wait for output (ms, default 1000).", 0, 30000) }, ["process"]),
    jobResult(), "read", "none", { errors: ["not_found"] }),
  action("workspace.signal", "在停止命令", "Send INT or TERM to a command started with workspace.bash.",
    object({ process: procRef(), signal: choice(["INT", "TERM"], "Which signal.") }, ["process", "signal"]),
    loose({ process: str(), signalled: bool() }, ["process"]), "act", "structure", { errors: ["not_found"] }),
];

const BODY_ACTIONS: readonly StandardAction[] = [
  action("body.info", "在看身体信息", "What this body is: system and architecture, whether it is a full Linux, the package manager, resources (CPU, memory, disk), the work directory, and whether it is Ash's own or borrowed from the owner.",
    object({}),
    loose({
      system: str(), arch: str(), full_linux: bool(), package_manager: nullable(str()), workdir: str(),
      resources: loose({ cpu: loose(), memory: loose(), disk: loose() }), ownership: choice(["own", "borrowed"]),
    }, ["system", "arch", "workdir", "ownership"]), "read", "none"),
];

// ---- calendar, media, camera ------------------------------------------------------------------------------------------

const CALENDAR_ACTIONS: readonly StandardAction[] = [
  action("calendar.search", "在看日历", "Find events in the owner's phone calendar within a time window: titles, times, locations and provider ids. Needs calendar read permission; changes nothing.",
    object({ start_ms: int("Window start, Unix ms (default now)."), end_ms: int("Window end, Unix ms (default seven days after start)."), query: str("Case-insensitive title or location filter."), limit: limit(50, "Most events (default 20).") }),
    loose({ events: list(loose({ id: text1(), title: str(), start: num(), end: num(), location: str() })) }, ["events"]), "read", "none", { errors: ["forbidden"] }),
  action("calendar.list", "在看有哪些日历", "List the owner's phone calendars: id, name, account, writable, shown, primary. Use an id from here as calendar.create's calendar_id. Needs calendar read permission.",
    object({}),
    loose({ calendars: list(loose({ id: int(), name: str(), account: str(), writable: bool(), shown: bool(), primary: bool() }, ["id", "name"])) }, ["calendars"]), "read", "none", { errors: ["forbidden"] }),
  action("calendar.create", "在添加日历事件", "Add one event to a writable phone calendar. This changes the owner's calendar. Needs calendar write permission.",
    object({
      calendar_id: int("Id of a writable calendar (from calendar.list)."), title: text1("Event title."), start_ms: int("Start, Unix ms."), end_ms: int("End, Unix ms, after start."),
      description: str("Event description."), location: str("Location."), time_zone: str("IANA time zone (default the phone's)."),
    }, ["calendar_id", "title", "start_ms", "end_ms"]),
    loose({ id: text1() }), "write", "outward", { errors: ["forbidden", "not_found"] }),
];

const MEDIA_TYPES = ["image", "video", "audio", "any"] as const;
const MEDIA_ACTIONS: readonly StandardAction[] = [
  action("media.list", "在看你的照片和视频", "List the owner's photos, videos and audio on the phone, newest first. Filter by type, time, album and file name; page with limit and offset. Each item has an id for media.read. Needs the photos permission.",
    object({
      type: choice(MEDIA_TYPES, "image, video, audio or any (default any)."), since_ms: int("Only items taken at or after this Unix ms."), until_ms: int("Only items taken before this Unix ms."),
      album: str("Only this album (folder name as media.albums lists it)."), name: str("Only items whose file name contains this text."),
      order: choice(["newest", "oldest"], "newest (default) or oldest first."), limit: limit(100, "Items per page (default 30)."), offset: int("Items to skip (next_offset of the previous page).", 0),
      with_location: bool("Also return latitude and longitude of photos that record it (slower)."),
    }),
    loose({ items: list(loose({ id: int(), name: str(), type: str(), size: int(), taken: int(), album: str(), uri: str() }, ["id"])), next_offset: nullable(int()) }, ["items"]),
    "read", "none", { errors: ["forbidden"] }),
  action("media.albums", "在看你的相册", "The albums (folders) the owner's media is in, with how many items each holds and the newest item's time, largest first. Use a name with media.list album.",
    object({ type: choice(MEDIA_TYPES, "image, video, audio or any (default any).") }),
    loose({ albums: list(loose({ name: str(), count: int(), newest: int() }, ["name", "count"])) }, ["albums"]), "read", "none", { errors: ["forbidden"] }),
  action("media.read", "在看你的照片", "Open one item from media.list by id. A photo comes back as an image you can look at (scaled to max_size) with its details; a video comes back with one frame; video and audio come with a path to process.",
    object({ id: int("The item's id from media.list."), max_size: int("Longest side of the returned image in px (default 1280).", 256, 2048), copy: bool("Also hand over a copy of the original file.") }, ["id"]),
    anyResult(), "read", "none", { errors: ["forbidden", "not_found"] }),
  action("media.save", "在存图片到相册", "Save a photo or video into the owner's gallery (Pictures/<album> or Movies/<album>, default album Ash) so it shows up in the Photos app. Give a path or the file as base64 (about 10 MB at most).",
    object({
      path: str("Absolute path of the image or video file."), data: str("The file as base64, instead of path."), name: str("File name in the gallery."),
      mime_type: str("image/... or video/..."), album: str("Folder under Pictures or Movies (default Ash)."),
    }),
    loose({ uri: str() }), "write", "none", { errors: ["forbidden", "too_large"] }),
];

const CAMERA_ACTIONS: readonly StandardAction[] = [
  action("camera.capture", "在等你拍照", "Ask the owner to take a photo: the phone's own camera opens and the owner presses the shutter. Returns the photo as an image and its path; fails with cancelled when the owner closes the camera without a photo.",
    object({ reason: str("What the photo is for, shown to the owner when Ash has to ask through a notification (short)."), timeout_s: int("How long to wait for the photo (default 120).", 15, 150), max_size: int("Longest side of the returned image in px (default 1280).", 256, 2048) }),
    loose({ path: str() }), "act", "none", { errors: ["cancelled", "timeout"] }),
];

// ---- ocr, tts: cheap, offline perception on the hand ----------------------------------------------------------------------

const OCR_ACTIONS: readonly StandardAction[] = [
  action("ocr.read", "在识别图片里的字", "Read the text in an image on the hand, offline (no cloud): returns the text in reading order and each line with its box and confidence. Give path (a file in shared storage, /sdcard/...) or data (base64). Good for screenshots, photos of documents, receipts, signs; the model reads Chinese, English, Japanese and many Latin-script languages in one pass. The first call downloads the model once.",
    object({
      path: str("Absolute path of the image file (shared storage, /sdcard/...)."), data: str("The image itself as base64 (about 10 MB at most), instead of path."),
      max_side: int("Longest side in px the image is scaled to for finding text, 320..2048 (default 960); raise it for small text on a large image.", 320, 2048),
      min_score: num("Drop lines the reader is less sure of than this, 0..1 (default 0.5)."),
    }),
    loose({
      text: str("All recognised text, one line per row, top to bottom."), width: int("Image width in px."), height: int("Image height in px."),
      blocks: list(loose({ text: str(), box: list(int(), "[left, top, right, bottom] in image pixels."), score: num() }, ["text", "box", "score"])),
      ms: int("Time the call took, ms (model loading included)."),
    }, ["text", "blocks", "ms"]),
    "read", "none", { errors: ["bad_request", "not_found", "forbidden", "too_large", "unavailable", "timeout"] }),
];

const TTS_ACTIONS: readonly StandardAction[] = [
  action("tts.speak", "在念出文字", "Turn text into speech on the hand, offline. play true (default) says it aloud on the phone and returns when it has finished; play false writes a WAV file in shared storage and returns its path, for you to send or keep. Chinese text is spoken in Chinese, other text in English, unless lang says otherwise.",
    object({
      text: text1("What to say, at most 4000 characters."), lang: str("BCP 47 tag, e.g. zh-CN, en-US (default: from the text)."), voice: str("A voice name of the phone's speech engine (an unknown name returns the names it has)."),
      rate: num("Speed, 0.25..4 (default 1)."), pitch: num("Pitch, 0.5..2 (default 1)."), play: bool("true (default) plays it on the phone; false writes a file instead."),
    }, ["text"]),
    loose({
      played: bool(), path: str("WAV file in shared storage, when play is false."), mime_type: str(), bytes: int(), duration_ms: int("Length of the speech, ms."),
      lang: str(), voice: str(), engine: str(), ms: int(),
    }, ["played", "ms"]),
    "act", "none", { errors: ["bad_request", "forbidden", "too_large", "unavailable", "timeout"] }),
];

// ---- location, activity, health, sensors, sense -------------------------------------------------------------------------

const ACCURACIES = ["high", "balanced", "low"] as const;
export const ACTIVITY_STATES = ["still", "walking", "running", "cycling", "in_vehicle"] as const;
export const HEALTH_METRICS = ["steps", "heart_rate", "spo2", "sleep", "weight", "body_fat", "active_calories", "distance", "exercise"] as const;
export const HEALTH_SOURCES = ["health_connect", "gadgetbridge", "xiaomi_scale"] as const;
const SENSE_ERRORS = ["forbidden", "unavailable"] as const;
const timeRange = (defaultFrom: string): Record<string, SchemaObject> => ({
  from: str(`Start: ISO-8601 date/time or epoch ms. Default: ${defaultFrom} before 'to'.`),
  to: str("End: ISO-8601 date/time or epoch ms. Default: now."),
});
const fix = (): SchemaObject => loose({ ts: int(), lat: num(), lon: num(), accuracy_m: num(), provider: str() }, ["lat", "lon"]);

const LOCATION_ACTIONS: readonly StandardAction[] = [
  action("location.get", "在看手机位置", "The phone's location now: the fused, GPS and network providers are asked together and the first fix good enough for the accuracy wins. The result says which provider answered, its accuracy and the fix's age.",
    object({ accuracy: choice(ACCURACIES, "high (GPS), balanced (default) or low (network)."), timeout_s: int("Seconds to wait for a fix (default 30).", 5, 120) }),
    loose({ ...fix().properties, age_s: int(), source: choice(["live", "last_known"]), accuracy_met: bool() }, ["lat", "lon"]), "read", "none", { errors: SENSE_ERRORS }),
  action("location.history", "在看位置记录", "Recorded location points in a time range (default the last 24 hours), thinned evenly to max_points.",
    object({ ...timeRange("24 hours"), max_points: int("At most this many points (default 500).", 1, 5000) }),
    loose({ points: list(fix()) }), "read", "none", { errors: SENSE_ERRORS }),
  action("location.track", "在开关位置记录", "Turn location and motion recording on or off. While on, the app keeps a notification with a stop button, takes a point when movement starts or stops and every interval_min minutes, and reports new points to Ash.",
    object({ on: bool("true to record, false to stop."), interval_min: int("Minutes between points (default 30).", 5, 240) }, ["on"]),
    loose({ recording: bool() }), "write", "none", { errors: SENSE_ERRORS }),
];

const ACTIVITY_ACTIONS: readonly StandardAction[] = [
  action("activity.current", "在看运动状态", "What the owner is doing now (still, walking, running, cycling, in_vehicle) and since when, from step cadence and location speed. Needs recording on.",
    object({}), loose({ state: choice(ACTIVITY_STATES), since: int() }, ["state"]), "read", "none", { errors: SENSE_ERRORS }),
  action("activity.history", "在看运动记录", "Recorded activity segments (still, walking, running, cycling, in_vehicle) in a time range (default the last 24 hours), with minutes per state.",
    object(timeRange("24 hours")),
    loose({ segments: list(loose({ ts_start: int(), ts_end: int(), state: choice(ACTIVITY_STATES) }, ["ts_start", "state"])) }, ["segments"]), "read", "none", { errors: SENSE_ERRORS }),
];

const HEALTH_ACTIONS: readonly StandardAction[] = [
  action("health.sources", "在看健康数据来源", "Health data sources and their state: Health Connect, Gadgetbridge, a Xiaomi scale; for each set-up source the time of its newest reading, whether it is stale, and a plain-language summary for the owner.",
    object({}), loose({ sources: list(loose({ source: choice(HEALTH_SOURCES), stale: nullable(bool()), latest_data_ts: nullable(int()) }, ["source"])) }, ["sources"]), "read", "none", { errors: SENSE_ERRORS }),
  action("health.read", "在读健康数据", "Health readings in a time range (default the last 7 days) as rows {ts, metric, value, unit, source}. Read only.",
    object({
      metrics: list(choice(HEALTH_METRICS), "Metrics to read (default all)."), ...timeRange("7 days"), sources: list(choice(HEALTH_SOURCES), "Sources to read (default all)."),
      max_rows: int("At most this many rows (default 2000).", 1, 20000),
    }),
    loose({ rows: list(loose({ ts: int(), metric: choice(HEALTH_METRICS), value: num(), unit: str(), source: str() }, ["ts", "metric", "value", "unit", "source"])) }, ["rows"]), "read", "none", { errors: SENSE_ERRORS }),
  action("health.summary", "在看健康汇总", "A day's or a week's health in a few numbers (steps, heart rate, sleep, weight ...), computed by rule from health.read, with the sources that have gone stale.",
    object({ period: choice(["day", "week"], "day (default) or week (the 7 days ending with date)."), date: { type: "string", pattern: DATE_PATTERN, description: "YYYY-MM-DD (default today)." } }),
    loose({ stale_sources: list(loose({ source: str(), summary: str() })) }), "read", "none", { errors: SENSE_ERRORS }),
  action("health.sync", "在让手表同步健康数据", "Ask Gadgetbridge to fetch new data from the watch and export its database now, and wait up to 90 s for the export. Needs Gadgetbridge's Intent API enabled.",
    object({}), anyResult(), "act", "none", { errors: [...SENSE_ERRORS, "timeout"] }),
];

const SENSORS_ACTIONS: readonly StandardAction[] = [
  action("sensors.steps", "在看今日步数", "Steps today from the phone's step counter. A complete count needs recording on since midnight; otherwise complete is false and since says from when it counts.",
    object({}), loose({ steps: int(), complete: bool(), since: int() }, ["steps"]), "read", "none", { errors: SENSE_ERRORS }),
];

const SENSE_ACTIONS: readonly StandardAction[] = [
  action("sense.status", "在看感知记录状态", "The sensing app's state: recording on or off and its settings, permissions, each location provider, the last location attempt, batches waiting for Ash, stored rows per kind.",
    object({}), loose({ recording: bool() }), "read", "none"),
  action("sense.configure", "在改感知记录设置", "Change what is recorded: recording on or off, interval_min, accuracy, retention_days, geofences (named circles; crossing one is reported to Ash), stale_hours per health source. Only the given keys change.",
    object({
      recording: bool("Record location and motion."), interval_min: int("Minutes between points.", 5, 240), accuracy: choice(ACCURACIES, "Location accuracy."),
      retention_days: int("Days to keep recorded rows.", 1, 3650),
      geofences: list(object({ name: text1("Name of the place, e.g. home."), lat: num("Latitude."), lon: num("Longitude."), radius_m: { type: "number", minimum: 20, maximum: 50000, description: "Radius in metres." } }, ["name", "lat", "lon", "radius_m"]), "All geofences; replaces the list ([] removes them)."),
      stale_hours: { type: "object", additionalProperties: int("Hours without a new reading before the source counts as stale; 0 = not checked.", 0, 720), description: "Per health source." },
    }),
    loose({ recording: bool() }), "write", "none", { errors: [...SENSE_ERRORS, "bad_request"] }),
  action("sense.delete", "在删除感知记录", "Delete recorded rows of a kind (location, activity, steps, health, all) in a time range (default everything), including rows not yet delivered to Ash.",
    object({ kind: choice(["location", "activity", "steps", "health", "all"], "What to delete."), from: str("Start: ISO-8601 or epoch ms (default the beginning)."), to: str("End: ISO-8601 or epoch ms (default now and later).") }, ["kind"]),
    loose({ deleted: int() }), "write", "structure"),
];

// ---- config: the hand app's own settings (SPEC-05 §5) ----------------------------------------------------------------

export const CONFIG_PERMISSIONS = ["accessibility", "notification_listener", "notifications", "exact_alarm", "battery_optimization", "kernel_battery_optimization",
  "location", "location_background", "activity_recognition", "health", "calendar", "photos", "all_files", "overlay", "write_settings", "host_shell", "usage_access"] as const;
const configItem = (): SchemaObject => loose({ item: str(), state: choice(["granted", "missing", "unsupported"]), detail: str() }, ["item", "state"]);

const CONFIG_ACTIONS: readonly StandardAction[] = [
  action("config.status", "在看手机App的权限和开关", "The state of every permission and switch the hand app needs: accessibility, notification listener, notifications, exact alarms, battery optimization (app and kernel), location, activity recognition, health, overlay, modify system settings, the phone's debug identity (host_shell, 「后台也能动手」), usage access, storage. These are host services the owner grants; the app reads them and never switches one itself.",
    object({}), loose({ items: list(configItem()) }, ["items"]), "read", "none"),
  action("config.permission.request", "在请求权限", "Show the system permission prompt, or open the matching settings page, for one permission or switch the owner has to grant by hand.",
    object({ name: choice(CONFIG_PERMISSIONS, "Which permission or switch.") }, ["name"]),
    loose({ requested: bool() }), "act", "none", { foreground: true, errors: ["bad_request"] }),
  action("config.keepalive.status", "在看保活状态", "The vendor's auto-start and background-limit switches for Ash's apps, and whether each is on.",
    object({}), loose({ supported: bool(), items: list(configItem()) }, ["items"]), "read", "none"),
  action("config.permission.revoke", "在收回权限", "Give one permission or switch back: the system page where it is turned off, or the app turns it off itself.",
    object({ name: choice(CONFIG_PERMISSIONS, "Which permission or switch.") }, ["name"]),
    loose({ requested: bool() }), "act", "none", { foreground: true, errors: ["bad_request"] }),
  action("config.owner_said", "在记下你说已开", "Record that the owner says a switch the app cannot read is on (the maker's auto-start, the locked recents card); on: false takes it back.",
    object({ item: str("The item of config.keepalive.status."), on: bool("false takes it back (default true).") }, ["item"]),
    loose({ item: str(), on: bool() }), "write", "none", { errors: ["bad_request"] }),
  action("config.switch.set", "在改App开关", "Turn one of the app's own switches on or off: notifications_read (read new notifications as a sense), island_resident (the always-on island entry).",
    object({ name: choice(["notifications_read", "island_resident"], "Which switch."), on: bool("On or off.") }, ["name", "on"]),
    loose({ name: str(), on: bool() }), "write", "none", { errors: ["bad_request", "failed"] }),
];

// ---- decision: the hub's reflex asks the hand; never for agents (callers: kernel) -----------------------------------------

const KERNEL: CallerKind[] = ["kernel"];
const DECISION_ACTIONS: readonly StandardAction[] = [
  action("decision.surface", "在看界面是否在前台", "Whether the hand app's home page is visible and live, with an epoch that changes when visibility changes. For the hub's reflex only.",
    object({}), loose({ home_visible: bool(), page_live: bool(), visibility_epoch: int() }, ["home_visible", "page_live", "visibility_epoch"]), "read", "none", { callers: KERNEL }),
  action("decision.screen", "在看前台应用", "The foreground app and a state epoch. For the hub's reflex only (the virtual screen is the host's, see service:host).",
    object({}), loose({ foreground_package: str(), state_epoch: int() }, ["foreground_package", "state_epoch"]), "read", "none", { callers: KERNEL }),
  action("decision.return", "在回到原来的应用", "Return to the app that was in front, when the state epoch still matches. For the hub's reflex only.",
    object({ expected_package: str(), expected_state_epoch: int(), decision_id: text1() }, ["expected_package", "expected_state_epoch", "decision_id"]),
    loose({ acted: bool() }, ["acted"]), "act", "none", { callers: KERNEL }),
];

// ---------------------------------------------------------------------------------------------------------------------
// the registry of standard actions
// ---------------------------------------------------------------------------------------------------------------------

/** Every standard namespace and its actions, in the order SPEC-02 §4.3 lists them. */
export const STANDARD_NAMESPACES: Readonly<Record<string, readonly StandardAction[]>> = Object.freeze({
  screen: SCREEN_ACTIONS, input: INPUT_ACTIONS, vscreen: VSCREEN_ACTIONS, apps: APPS_ACTIONS, settings: SETTINGS_ACTIONS,
  clipboard: CLIPBOARD_ACTIONS, device: DEVICE_ACTIONS, workspace: WORKSPACE_ACTIONS, body: BODY_ACTIONS,
  browser: BROWSER_ACTIONS, calendar: CALENDAR_ACTIONS, media: MEDIA_ACTIONS, camera: CAMERA_ACTIONS, ocr: OCR_ACTIONS, tts: TTS_ACTIONS, location: LOCATION_ACTIONS,
  activity: ACTIVITY_ACTIONS, health: HEALTH_ACTIONS, sensors: SENSORS_ACTIONS, sense: SENSE_ACTIONS, config: CONFIG_ACTIONS, decision: DECISION_ACTIONS,
});
export const STANDARD_ACTIONS: readonly StandardAction[] = Object.freeze(Object.values(STANDARD_NAMESPACES).flat());

const BY_NAME = new Map(STANDARD_ACTIONS.map((item) => [item.name, item]));
export const standardAction = (name: string): StandardAction | undefined => BY_NAME.get(name);
/** The namespace of a capability name (`screen.tap` -> `screen`), or null for a name that is not `<namespace>.<action>`. */
export const namespaceOf = (name: string): string | null => (name.includes(".") ? name.slice(0, name.indexOf(".")) : null);
/** Hand capabilities with this prefix are not standard; they are named x.<who>.<action>. */
export const isExtensionName = (name: string): boolean => /^x\.[a-z0-9_-]+\.[a-z0-9_.-]+$/.test(name);

/**
 * The member a standard action is registered under: `workspace.*` and `body.info` live on the body; the phone's
 * high-privilege actions (the virtual screen, injected keys, launching an app in the background) live on `service:host`,
 * the kernel's host layer, so they keep working when the hand app is not running and are absent until the host is
 * paired ("部位不在就不列"); the rest live on the hand.
 */
export const standardMember = (name: string): "body:*" | "device:*" | "service:host" => {
  if (name.startsWith("workspace.") || name === "body.info") return "body:*";
  if (name.startsWith("vscreen.") || name === "input.key" || name === "apps.open") return "service:host";
  return "device:*";
};

/** A standard action as a word contract (the form words.json and the lint use). */
export function standardContract(item: StandardAction): WordContract {
  return {
    member: standardMember(item.name), word: item.name, kind: "request", direction: "in", description: item.description,
    input_schema: item.input_schema, result_schema: item.result_schema, effect: item.effect, risk: item.risk,
    ...(item.per_call_risk ? { per_call_risk: true } : {}), ...(item.foreground ? { foreground: true } : {}),
    callers: [...(item.callers ?? DEFAULT_CALLERS)], label: { doing: item.label },
  };
}
export const standardContracts = (): WordContract[] => STANDARD_ACTIONS.map(standardContract);
