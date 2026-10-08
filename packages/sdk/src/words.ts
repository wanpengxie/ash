import type { Card, JsonSchema, WordEffect, WordSpec } from "./api";
import { matchesSchema } from "./schema";
import { DEVICE_WORDS } from "./device-words";

export interface WordContract extends WordSpec { member: string; direction: "in" | "out" }
const str: JsonSchema = { type: "string" };
const nonempty: JsonSchema = { type: "string", minLength: 1 };
const num: JsonSchema = { type: "number" };
const integer: JsonSchema = { type: "integer" };
const bool: JsonSchema = { type: "boolean" };
const any: JsonSchema = {};
const strings: JsonSchema = { type: "array", items: str };
const obj = (properties: Record<string, JsonSchema> = {}, required: string[] = [], additionalProperties = false): JsonSchema => ({ type: "object", properties, required, additionalProperties });
const array = (items: JsonSchema): JsonSchema => ({ type: "array", items });
const choice = (...values: string[]): JsonSchema => ({ type: "string", enum: values });
const id = nonempty;
const workName: JsonSchema = { type: "string", minLength: 1, maxLength: 48, pattern: "^[a-z][a-z0-9._-]*$" };
const workRunId: JsonSchema = { type: "string", minLength: 3, maxLength: 128, pattern: "^r_[A-Za-z0-9_-]+$" };
const workReason: JsonSchema = { type: "string", minLength: 1, maxLength: 96, pattern: "^[a-z][a-z0-9._-]*$" };
const workTime: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const workRunInfo: JsonSchema = obj({
  run: workRunId, flow: workName, trigger: choice("manual", "cooldown", "hourly", "event"),
  state: choice("running", "done", "no_change", "failed"), started_at: workTime,
  ended_at: { anyOf: [workTime, { type: "null" }] },
}, ["run", "flow", "trigger", "state", "started_at", "ended_at"]);
const deliveryDedupeKey: JsonSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const empty = obj();
const accepted = obj({ accepted: bool }, ["accepted"]);
const attachmentInput = obj({ name: nonempty, mime_type: nonempty, data: nonempty }, ["name", "mime_type", "data"]);
// from_agent: the agent whose question or news the Agent system delivers; reply_from: the agent whose answer it passes back.
const sayExtras = { attachments: array(attachmentInput), in_reply_to: id, option_id: id, from_agent: id, reply_from: id };
const askChoice = choice("once", "always", "deny");
const askOption = obj({ id: askChoice, label: nonempty }, ["id", "label"]);
const origin = obj({ screen: nonempty, label: str }, ["screen", "label"]);
const cardOption = obj({ id: nonempty, text: nonempty }, ["id", "text"]);
export const PHONE_PERMISSIONS = ["calendar", "notifications", "battery", "accessibility", "photos", "all_files", "usage", "write_settings", "overlay", "shizuku"] as const;
export const CARD_SCHEMA: JsonSchema = { oneOf: [
  obj({ type: { const: "options" }, prompt: str, options: { type: "array", items: cardOption, minItems: 1 }, allow_custom: bool }, ["type", "options"]),
  obj({ type: { const: "file" }, workspace: nonempty, path: nonempty, name: nonempty, mime_type: nonempty, size: { type: "integer", minimum: 0 } }, ["type", "workspace", "path", "name", "mime_type", "size"]),
  obj({ type: { const: "image" }, workspace: nonempty, path: nonempty, alt: str }, ["type", "workspace", "path"]),
  obj({ type: { const: "link" }, url: nonempty, title: nonempty, summary: str }, ["type", "url", "title"]),
  // An Android setting the owner switches on by hand; the phone app opens exactly that page.
  obj({ type: { const: "permission" }, permission: choice(...PHONE_PERMISSIONS), why: nonempty }, ["type", "permission", "why"]),
] };
const sha = { type: "string", pattern: "^[0-9a-f]{64}$" } as const satisfies JsonSchema;
const positiveSafe: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegativeSafe: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const datePath = { type: "string", pattern: "^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$" } as const satisfies JsonSchema;
const selfPath = { type: "string", pattern: "^(SOUL|IDENTITY|USER|MEMORY|HEARTBEAT|PROACTIVE)\\.md$|^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$" } as const satisfies JsonSchema;
// Requests accept any short path so that service:self answers a non-managed one with forbidden (F-S22).
const selfPathRequest = { type: "string", minLength: 1, maxLength: 256 } as const satisfies JsonSchema;
const edit = obj({ op: choice("replace", "delete", "insert_after"), start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 }, guard: str, text: str, reason: choice("promote", "correct", "complete", "expire", "dedupe", "condense", "demote"), evidence: strings }, ["op", "start", "end", "guard", "reason", "evidence"]);
const claim = obj({ text: nonempty, type: choice("fact", "preference", "relationship", "event", "boundary", "correction"), salience: choice("low", "medium", "high"), evidence: strings, quote: str, supersedes: str, valid_until: str }, ["text", "type", "salience", "evidence"]);
const message = obj({ seq: integer, id, ts: num, from: id, to: { anyOf: [str, { type: "null" }] }, kind: choice("request", "response", "event"), word: id, body: obj({}, [], true), reply_to: str, origin, turn: str, thread: str }, ["seq", "id", "ts", "from", "to", "kind", "word", "body"]);
const noChange = obj({ no_change: obj({ checked: strings, details: str }, ["checked", "details"]) }, ["no_change"]);
const workerResult = (normal: JsonSchema): JsonSchema => ({ oneOf: [normal, noChange] });

const entries: WordContract[] = [];
entries.push(...DEVICE_WORDS.map(spec => ({ ...spec, member: "service:devices", direction: "in" as const })));
const guidance: Record<string, string> = {
  "agent:main/say": "Use to tell the agent something or answer an active option card. It acknowledges receipt immediately; read later conversation messages for the answer.",
  "person:owner/say": "Use to reply or offer a heads-up to the owner. This records immediately; it does not wait for a response or replace ask.",
  "person:owner/react": "Use for a brief reaction to a known message. Do not use for a new explanation; send say instead.",
  "person:owner/show": "Use to present a file, image, link, permission, or choices. Showing choices does not itself authorize an action. A permission card only names an Android setting the owner must switch on (calendar, notifications, battery, accessibility, photos, all_files, usage, write_settings, overlay, shizuku); never use it to ask for access to a phone capability, because calling the capability asks the owner by itself.",
  "person:owner/ask": "Use when the owner must choose before an action continues. It waits for the first valid unexpired answer; do not treat mere presentation as consent.",
  "screen:*/ui.open": "Use to ask a named screen to show a view. A suggested opening may be declined; check opened in the response.",
  "service:clock/set": "Use for a future or repeating message, not for immediate delivery. Record the returned timer id for cancellation.",
  "service:clock/cancel": "Use to cancel a known timer id; check cancelled because the timer may already have fired.",
  "service:clock/list": "Use to inspect active timers before changing them; the result is a snapshot.",
  "service:gate/rules.list": "Use to inspect current approval rules, not to assume a risky action is already allowed.",
  "service:gate/rules.revoke": "Use to remove a known rule with local owner authority; this changes future decisions, not past actions.",
  "service:gate/history": "Use to review earlier gate decisions; this is read-only.",
  "service:gate/access.list": "Inspect the earlier device access grants. They are kept as a record only: agents no longer need one, and none approves an action.",
  "service:gate/access.grant": "Legacy: record one exact agent and device capability for 30 days. Agents no longer need a grant; the approval gate judges each action.",
  "service:gate/access.revoke": "Legacy: revoke one recorded device access grant. It changes no approval decision; already executed actions cannot be undone.",
  "service:self/read": "Use to read an allowed managed file and its hash before editing. Do not infer a stable baseline from stale conversation context.",
  "service:self/write": "Use for a complete managed-file replacement with the exact baseline hash; null creates only a missing file. Do not use native file tools for managed writes.",
  "service:self/append": "Use to atomically add text to an allowed dated log, including an older date. No baseline hash is required.",
  "service:self/apply_plan": "Use for guarded line edits against a saved baseline hash. A stale hash or guard rejects the whole batch; reread before retrying.",
  "service:self/rollback": "Use to restore a known snapshot when a prior change was wrong; this changes the managed file.",
  "service:self/history": "Use to inspect available managed-file snapshots before choosing a rollback target.",
  "service:work/run": "Use for an authorized manual background-flow trigger, not for a conversational answer. Follow its run id for outcome.",
  "service:work/runs": "Use to inspect recent background runs; this does not start a run.",
};
// What the owner reads for a request word that declares no label of its own: the status line, the activity page and the
// approval card all show it, so it is plain Chinese. Events keep the neutral default; they never appear as an action.
const ownerLabels: Record<string, string> = {
  "agent:main/cancel_turn": "停下手头的事", "agent:main/wake": "醒来想一想",
  "person:owner/react": "给消息加表情", "person:owner/show": "给你看卡片", "person:owner/ask": "问你",
  "screen:*/ui.open": "打开页面", "service:agents/answer": "回答帮手",
  "service:clock/set": "定提醒", "service:clock/cancel": "取消提醒", "service:clock/list": "看提醒",
  "service:post/deliver": "送达消息",
  "service:gate/rules.list": "看审批规则", "service:gate/rules.revoke": "撤销审批规则", "service:gate/history": "查审批记录",
  "service:gate/access.list": "看帮手的授权", "service:gate/access.grant": "给帮手授权", "service:gate/access.revoke": "收回帮手的授权",
  "service:self/read": "看资料", "service:self/apply_plan": "改资料", "service:self/rollback": "撤回改动", "service:self/history": "看改动记录",
  "service:reflex/task.stop": "停下任务", "service:reflex/task.end": "结束任务", "service:reflex/before_turn": "准备动手",
  "service:reflex/surface.get": "看界面状态", "service:reflex/screen.get": "看前台应用", "service:reflex/screen.return": "回到原来的应用",
  "service:reflex/virtual.close": "关闭后台屏幕",
  "service:work/run": "做后台任务", "service:work/runs": "看后台任务",
  "worker:extract/extract": "整理要点", "worker:verify_claims/verify_claims": "核对说法", "worker:reconcile/reconcile": "整理记忆",
  "worker:verify_plan/verify_plan": "核对计划", "worker:proactive/proactive": "想想要不要找你", "worker:opener/opener": "想想怎么开口",
  "service:admin/settings.get": "看设置", "service:admin/settings.set": "改设置", "service:admin/plugins.list": "看插件",
  "service:admin/plugins.op": "调整插件", "service:admin/gateway.state": "看网关", "service:admin/gateway.op": "调整网关",
  "service:admin/model.set": "换主模型", "service:admin/pause": "暂停", "service:admin/resume": "恢复",
};
function add(member: string, word: string, kind: "request" | "event", input_schema: JsonSchema, result_schema?: JsonSchema, options: Partial<Pick<WordSpec, "risk" | "effect" | "label" | "audience" | "timeout_ms">> & { direction?: "in" | "out"; description?: string } = {}) {
  entries.push({ member, word, kind, description: options.description ?? guidance[`${member}/${word}`] ?? (kind === "event" ? `Status event ${word} from ${member}; observe rather than call it.` : `Use ${word} on ${member} for the declared input only; inspect the result before following up.`), input_schema, ...(result_schema ? { result_schema } : {}), risk: options.risk ?? "none", ...(options.effect ? { effect: options.effect } : {}), label: options.label ?? ownerLabels[`${member}/${word}`] ?? "Working", audience: options.audience ?? "all", ...(options.timeout_ms ? { timeout_ms: options.timeout_ms } : {}), direction: options.direction ?? "in" });
}

export const WORD_EFFECTS: readonly WordEffect[] = Object.freeze(["read", "act", "write", "send", "execute", "structure"]);
export const isWordEffect = (value: unknown): value is WordEffect => typeof value === "string" && (WORD_EFFECTS as readonly string[]).includes(value);
/**
 * The effect a word declares; without one it follows risk (none -> read, outward -> act, structure -> write).
 * A word that claims to only read while its risk says otherwise is treated by its risk: a mismatch never relaxes the gate.
 */
export function wordEffect(spec: Pick<WordSpec, "risk" | "effect">): WordEffect {
  const derived: WordEffect = spec.risk === "outward" ? "act" : spec.risk === "structure" ? "write" : "read";
  if (!isWordEffect(spec.effect)) return derived;
  return spec.effect === "read" && derived !== "read" ? derived : spec.effect;
}

// Main agent: a queued conversation and a separately driven secondary session.
add("agent:main", "say", "request", { oneOf: [
  obj({ text: nonempty, ...sayExtras }, ["text"]),
  obj({ text: { const: "" }, attachments: { type: "array", items: attachmentInput, minItems: 1 }, in_reply_to: id, option_id: id }, ["text", "attachments"]),
] }, accepted, { label: "读你的消息", description: "Use to speak to the agent or send attachments; accepted immediately and queued." });
add("agent:main", "cancel_turn", "request", obj({ reason: nonempty, by: id }, ["reason"]), obj({ cancelled: bool }, ["cancelled"]), { audience: "owner", description: "Control only; stop the current turn and settle pending requests." });
add("agent:main", "wake", "request", obj({ reason: nonempty, context: obj({}, [], true) }, ["reason", "context"]), accepted, { audience: "owner", description: "Internal wake for the secondary session." });
add("agent:main", "typing", "event", empty, undefined, { audience: "owner", description: "Current authenticated screen is composing a message." });
add("agent:main", "status", "event", obj({ state: choice("idle", "listening", "thinking", "working", "done", "waiting_you", "resting"), text: str }, ["state", "text"]), undefined, { direction: "out" });
add("agent:main", "received", "event", obj({ ids: strings }, ["ids"]), undefined, { direction: "out" });
add("agent:main", "read", "event", obj({ ids: strings, turn: id }, ["ids", "turn"]), undefined, { direction: "out" });
add("agent:main", "turn.start", "event", obj({ turn: id, ids: strings }, ["turn", "ids"]), undefined, { direction: "out" });
add("agent:main", "turn.end", "event", obj({ turn: id, reason: choice("completed", "cancelled", "error"), error: str }, ["turn", "reason"]), undefined, { direction: "out" });

add("person:owner", "say", "request", { oneOf: [
  obj({ text: nonempty, kind: choice("reply", "due"), facts: strings }, ["text", "kind"]),
  obj({ text: nonempty, kind: choice("offer", "heads_up"), facts: strings, dedupe_key: deliveryDedupeKey }, ["text", "kind"]),
] }, accepted, { label: "回你消息", description: "Send a short message; it is acknowledged when recorded. Proactive offers may carry an opaque stable dedupe_key at initial acceptance. facts are source message or fact IDs after the flow maps worker-local numeric indices, never those indices themselves." });
add("person:owner", "react", "request", obj({ message_id: id, emoji: nonempty }, ["message_id", "emoji"]), accepted, { description: "React to one existing message; unknown ids fail." });
add("person:owner", "show", "request", obj({ card: CARD_SCHEMA }, ["card"]), accepted, { description: "Show a result or choice card; it is acknowledged when recorded." });
add("person:owner", "ask", "request", obj({ title: nonempty, detail: str, human_kind: choice("question", "confirmation"), allow_custom: bool,
  options: { type: "array", items: obj({ id: nonempty, label: nonempty }, ["id", "label"]), minItems: 1 }, expires_at: num,
  source: obj({ word: nonempty, to: id, body_preview: str, body_full: str }, ["word", "to", "body_preview"]) }, ["title", "detail", "options", "expires_at", "source"]),
  obj({ choice: nonempty, text: nonempty }, ["choice"]), { timeout_ms: 600_000, description: "A durable owner question. A valid answer or expiry is recorded; approval does not itself execute an action." });
add("service:gate", "human.pending", "event", obj({}, [], true), undefined, { direction: "out", description: "Durable human request state, including approval redemption or an explicit decision not to continue." });

add("screen:*", "ui.open", "request", obj({ target: choice("activity", "upcoming", "approvals", "identity", "memory", "settings", "turn"), id: str, mode: choice("perform", "suggest") }, ["target", "mode"]), obj({ opened: bool }, ["opened"]), { description: "Open or suggest a view on a named screen." });
// The Agent system: ash holds every agent's declaration, runs their lifecycle and carries what they say to each other.
// Discovery and communication (agent words) are for every agent; management (system words) for those granted it.
const agentRef: JsonSchema = { type: "string", pattern: "^agent:[a-z][a-z0-9_-]{0,31}$" };
export const AGENT_RUNTIME_SCHEMA: JsonSchema = { anyOf: [{ const: "container" }, obj({ device: { type: "string", pattern: "^device:[A-Za-z0-9_-]+$" }, kind: choice("codex", "claude", "workbuddy"), cwd: nonempty, model: nonempty, effort: nonempty }, ["device", "kind"])] };
const agentFields: Record<string, JsonSchema> = { name: nonempty, summary: nonempty, brief: nonempty, runtime: AGENT_RUNTIME_SCHEMA, tools: strings, words: strings, every: { type: "integer", minimum: 600 } };
const agentInfo = obj({ id: agentRef, name: str, summary: str, state: choice("idle", "working", "stopped", "error"), available: bool, main: bool, manage: bool,
  brief: str, runtime: AGENT_RUNTIME_SCHEMA, created_by: str, tools: { anyOf: [strings, { type: "null" }] }, words: { anyOf: [strings, { type: "null" }] }, every: { anyOf: [integer, { type: "null" }] }, built_in: bool },
  ["id", "name", "summary", "state"]);
add("service:agents", "list", "request", empty, obj({ agents: array(agentInfo) }, ["agents"]), { label: "看有哪些帮手", description: "Every agent: id, name, what it does, and whether it is idle, working or stopped." });
add("service:agents", "runtimes", "request", empty, obj({ runtimes: array(obj({}, [], true)) }, ["runtimes"]), { label: "查看可用运行时", description: "Online devices allowed to host agents and their installed runtimes and models. Query before creating a remote agent." });
add("service:agents", "threads", "request", empty, obj({ threads: array(obj({}, [], true)) }, ["threads"]), { label: "查看工作串", audience: "owner" });
add("service:agents", "thread.stop", "request", obj({ thread: id }, ["thread"]), obj({ cancelled: bool }, ["cancelled"]), { label: "停止工作串", audience: "owner" });
add("service:agents", "describe", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { label: "看帮手", description: "One agent's declaration and state." });
add("service:agents", "ask", "request", obj({ agent: agentRef, text: nonempty }, ["agent", "text"]), obj({ agent: agentRef, answer: str }, ["agent", "answer"]),
  { label: "问帮手", timeout_ms: 600_000, description: "Put a question to another agent; the answer it gives in the turn that takes the question is the result." });
add("service:agents", "tell", "request", obj({ agent: agentRef, text: nonempty }, ["agent", "text"]), obj({ sent: bool, message_id: id }, ["sent", "message_id"]),
  { label: "告诉帮手", description: "Deliver news to another agent; what it says back is passed to the sender later as a message." });
add("service:agents", "answer", "request", obj({ in_reply_to: id, text: nonempty }, ["in_reply_to", "text"]), accepted, { audience: "owner", description: "Internal: an agent's words in a turn that answers a delivered question or news." });
add("service:agents", "declare", "request", obj({ id: agentRef, ...agentFields }, ["id", "name", "summary", "brief"]), agentInfo,
  { label: "新建帮手", description: "Create a new agent from a declaration. It starts at once, in its own session and workspace." });
add("service:agents", "update", "request", obj({ agent: agentRef, ...agentFields }, ["agent"]), agentInfo,
  { label: "调整帮手", description: "Change an agent's declaration; it applies from its next turn." });
add("service:agents", "start", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { label: "启动帮手", description: "Let a stopped agent take turns again." });
add("service:agents", "stop", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { label: "停下帮手", description: "Stop an agent: its current turn is cancelled and it takes no new ones; messages wait for it." });
add("service:agents", "restart", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { label: "重启帮手", description: "Cancel an agent's current turn and reopen its session; its history is kept." });
add("service:agents", "remove", "request", obj({ agent: agentRef }, ["agent"]), obj({ removed: bool }, ["removed"]),
  { label: "删除帮手", description: "Remove a declared agent. The main agent cannot be removed; built-in agents can only be stopped." });
add("service:clock", "set", "request", obj({ at: num, every: { type: "integer", minimum: 60 }, to: id, word: id, body: obj({}, [], true), label: nonempty }, ["to", "word", "body", "label"]), obj({ id, next: num }, ["id", "next"]));
// Secure vault: the agent may look, never touch. Values enter through the owner's settings route and leave only to ash's own code.
const vaultEntry = obj({ ref: nonempty, label: nonempty, kind: choice("model", "login", "api", "other"), configured: bool, updated_at: nonnegativeSafe }, ["ref", "label", "kind", "configured"]);
add("service:vault", "list", "request", empty, obj({ entries: { type: "array", items: vaultEntry } }, ["entries"]),
  { label: "看保存的密钥", description: "Which credentials are saved (names and kinds only, never a value)." });
add("service:vault", "describe", "request", obj({ ref: nonempty }, ["ref"]), vaultEntry,
  { label: "看保存的密钥", description: "Whether one credential is saved, and what it is for. A value is never returned." });
add("service:vault", "vault.changed", "event", obj({ ref: nonempty, action: choice("saved", "removed") }, ["ref", "action"]), undefined,
  { direction: "out", audience: "owner", description: "A credential was saved or removed. Names only; the value is never on the ledger." });
// Home-screen widgets: cards anyone may put on the owner's phone home screen, drawn natively from a small A2UI subset.
const widgetCardId: JsonSchema = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" };
const widgetId: JsonSchema = { type: "string", minLength: 1, maxLength: 12 };
const widgetSize = choice("2x2", "4x2", "4x4");
const widgetCardInfo = obj({ id: widgetCardId, title: nonempty, size: widgetSize, owner: id, updated_at: nonnegativeSafe,
  expires_at: { anyOf: [nonnegativeSafe, { type: "null" }] }, expired: bool, actions: strings }, ["id", "title", "size", "owner", "updated_at", "expires_at", "expired", "actions"]);
const placedWidget = obj({ id: widgetId, type: choice("ash", "card") }, ["id", "type"]);
const widgetListResult = obj({ cards: array(widgetCardInfo), widgets: array(obj({ id: widgetId, type: choice("ash", "card"), card: { anyOf: [widgetCardId, { type: "null" }] } }, ["id", "type", "card"])) }, ["cards", "widgets"]);
export const WIDGET_A2UI_GUIDE = "a2ui is an A2UI v0.9 component list: {components:[...], root?:'root', data?:{...}}. Components are flat objects {id, component, ...} linked by id; " +
  "the root (id 'root' unless root is given) is drawn. Allowed components only: " +
  "Column {children:[ids], align?:'start'|'center'} and Row {children:[ids], justify?:'start'|'spaceBetween'} (at most 3 Column/Row levels); " +
  "Text {text, variant?:'h1' big number|'h2'/'h3' title|'body' (default)|'caption' secondary} (at most 3 lines shown); " +
  "Image {url:'avatar' (Ash's face) or 'icon:<name>' with name one of sun, cloud, rain, snow, wind, moon, heart, steps, weight, sleep, water, fire, calendar, clock, check, alert, star, bell, mail, home, car, money, chart}; no web images; " +
  "Button {child:<id of a Text used as its label>, action:{event:{name:'<action name>'}}} (at most 2 buttons; a tap sends you widget.action with that name, it never runs anything by itself); " +
  "Divider {axis?:'horizontal'}; ProgressBar {value: 0-100, label?}; Badge {text} (at most 8 characters). " +
  "Any text, value or label may instead be {path:'/a/b'} read from the card's own data object. At most 40 components and 8 KB of JSON. " +
  "Example: {components:[{id:'root',component:'Column',children:['t','n']},{id:'t',component:'Text',text:'Weight',variant:'caption'},{id:'n',component:'Text',text:{path:'/kg'},variant:'h1'}],data:{kg:'61.8 kg'}}";
add("service:widgets", "widget.list", "request", empty, widgetListResult,
  { label: "看桌面小组件", effect: "read", description: "What is on the owner's phone home screen: each placed widget (the 'ash' widget, or an 'Ash 卡片' card widget with the card it shows), and every card that exists with its owner, size, expiry and button action names." });
add("service:widgets", "widget.card.put", "request", obj({ id: { type: "string", minLength: 1, maxLength: 64 }, title: str, size: widgetSize,
  a2ui: obj({}, [], true), ttl_min: { type: "integer", minimum: 1, maximum: 43200 } }, ["id", "title", "size", "a2ui"]),
  obj({ card: widgetCardInfo, bound_widgets: array(widgetId) }, ["card", "bound_widgets"]),
  { label: "更新桌面卡片", effect: "write", description: "Create or replace (same id) a card the owner can place on the phone home screen with the 'Ash 卡片' widget; widgets already showing it redraw. " +
    "id: lowercase letters, digits, . _ - (at most 64); title: at most 40 characters. The card belongs to whoever created it: only its creator or the owner may replace or remove it. size is the intended widget size (2x2 small, 4x2 wide, 4x4 large). " +
    "ttl_min: after this many minutes the card shows as expired until updated. Invalid cards are refused with the reason. " + WIDGET_A2UI_GUIDE });
add("service:widgets", "widget.card.remove", "request", obj({ id: widgetCardId }, ["id"]), obj({ removed: bool }, ["removed"]),
  { label: "移除桌面卡片", effect: "write", description: "Remove a card you created (the owner may remove any). Widgets that showed it ask the owner to pick another card." });
add("service:widgets", "widget.bind", "request", obj({ widget: widgetId, card: widgetCardId }, ["widget", "card"]), obj({ widget: widgetId, card: widgetCardId }, ["widget", "card"]),
  { label: "选小组件显示的卡片", effect: "write", description: "Make one placed 'Ash 卡片' widget (an id from widget.list) show an existing card. The owner normally picks the card when placing the widget." });
add("service:widgets", "widget.tap", "request", obj({ card: widgetCardId, action: { type: "string", minLength: 1, maxLength: 64 } }, ["card", "action"]), accepted,
  { audience: "owner", label: "转达小组件上的点击", effect: "write", description: "The phone reports that the owner tapped a card button. Owner only." });
add("service:widgets", "widget.placed", "request", obj({ widgets: { type: "array", items: placedWidget, maxItems: 64 } }, ["widgets"]), accepted,
  { audience: "owner", label: "记下放好的小组件", effect: "write", description: "The phone reports which Ash widgets are on its home screen. Owner only." });
add("service:widgets", "widget.action", "event", obj({ card: widgetCardId, action: nonempty, owner: id, title: str }, ["card", "action", "owner"]), undefined,
  { direction: "out", description: "The owner tapped a button on a home-screen card. owner is the card's creator, who decides what it means; the tap itself does nothing else." });
// Independent apps (contract ash-app/1): discovery, install with the owner's approval of what an app needs, and grants.
const appId: JsonSchema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" };
const appInfo = obj({ id: appId, name: str, version: str, summary: str, publisher: str, enabled: bool, granted: bool, running: bool,
  needs: array(obj({}, [], true)), surfaces: array(obj({}, [], true)), events: strings, tools: strings, error: str }, ["id", "name", "version", "enabled", "granted", "running"], true);
add("service:apps", "apps.list", "request", empty, obj({ apps: array(appInfo) }, ["apps"]),
  { label: "看有哪些应用", description: "Every app found in the container (/root/apps/<id>/app.json): name, version, whether the owner installed (granted) it and whether it is running." });
add("service:apps", "apps.describe", "request", obj({ id: appId }, ["id"]), appInfo,
  { label: "看应用详情", description: "One app: what it needs from ash (needs), its screens (surfaces), events and tools." });
add("service:apps", "apps.install", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "execute", label: "安装应用", description: "Install an app from /root/apps/<id>/ (ash's own, or one you wrote): it is checked first as apps.validate does, " +
    "and a failing app is refused with the problems (error.detail.problems) before anyone is asked. Then the owner approves, on one card, everything it needs (needs); " +
    "an app you wrote is shown as written by you, not published. Then its grants are stored and it starts as member app:<id>. Installing again after editing restarts it with the new files." });
add("service:apps", "apps.enable", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "execute", label: "重新启用应用", description: "Start an installed app that was turned off, within the grants the owner already gave. An agent's request asks the owner." });
add("service:apps", "apps.disable", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "write", label: "停用应用", description: "Stop an app; its grants are kept so it can be turned on again." });
add("service:apps", "apps.revoke", "request", obj({ id: appId, need: nonempty }, ["id"]), appInfo,
  { risk: "structure", effect: "write", label: "收回应用的权限", description: "Take back one need (need: a member id such as device:phone, or notify / widgets / card), or every grant when need is left out, which stops the app." });
add("service:apps", "apps.refresh", "request", empty, obj({ apps: array(appInfo) }, ["apps"]),
  { label: "查找新应用", description: "Read /root/apps again: new apps appear, removed ones stop." });
// Writing apps: the contract to read, a skeleton to start from, and a check that says exactly what is wrong.
const appProblem = obj({ level: choice("error", "warning"), where: str, problem: str, fix: str }, ["level", "where", "problem"]);
const appTool = obj({ name: { type: "string", pattern: "^[a-z][a-z0-9_.-]{0,63}$" }, title: { type: "string", minLength: 1, maxLength: 60 },
  description: { type: "string", minLength: 1, maxLength: 2000 }, read_only: bool }, ["name"]);
const appSurface = obj({ id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" }, title: { type: "string", minLength: 1, maxLength: 20 } }, ["id", "title"]);
add("service:apps", "apps.contract", "request", empty,
  obj({ contract: str, doc: str, doc_path: str, schema: obj({}, [], true), example: obj({ path: str, files: obj({}, [], true) }, ["path", "files"]) }, ["contract", "doc", "schema", "example"], true),
  { label: "看应用契约", description: "The ash-app/1 contract for writing an app, in full (doc, markdown): app.json fields, how ash starts the server and talks to it, " +
    "pages (ui:// resources), tools, needs, events, entry cards. Also the app.json JSON Schema and a small runnable example app (hello: one page, one tool) with its files. " +
    "The same doc and example are in the container at doc_path and example.path." });
add("service:apps", "apps.scaffold", "request", obj({ id: appId, name: { type: "string", minLength: 1, maxLength: 40 }, summary: { type: "string", minLength: 1, maxLength: 200 },
  surfaces: { type: "array", items: appSurface, minItems: 1, maxItems: 16 }, tools: { type: "array", items: appTool, minItems: 1, maxItems: 32 } }, ["id", "name"]),
  obj({ id: appId, path: str, files: strings, next: str }, ["id", "path", "files", "next"], true),
  { effect: "write", label: "写应用骨架", description: "Write a new app's skeleton into /root/apps/<id>/ (app.json, a dependency-free server.mjs, one ui/<page>.html per surface, " +
    "shared ui/app.css and ui/app.js, icon.png). It runs as it is: each tool answers with a placeholder until you write it in server.mjs. " +
    "surfaces default to one page home; tools default to one read-only <id>.status. Refuses a folder that already has an app.json. " +
    "No approval is needed: it only writes files. Then edit, apps.validate, and apps.install (the owner approves what it needs)." });
add("service:apps", "apps.validate", "request", obj({ id: appId, path: { type: "string", minLength: 1, maxLength: 300 } }),
  obj({ id: str, path: str, ok: bool, problems: array(appProblem), tools: strings, surfaces: strings }, ["path", "ok", "problems", "tools", "surfaces"], true),
  { label: "检查应用", description: "Check an app folder the way install will: app.json against the contract (each missing or wrong field by its path), " +
    "the icon file, then a trial start of its server (it must start and speak MCP over stdio), its tools (names, input schemas) and every page " +
    "(each surface's ui:// resource must be served as HTML). Give id (the folder /root/apps/<id>) or path (/root/apps/<folder>). " +
    "ok is true when nothing would stop it from installing and opening; warnings are worth fixing but do not block. Nothing is installed or changed." });
add("service:cost", "usage.recorded", "event", obj({ scope: choice("chat", "mind", "background", "title", "compaction", "review", "progress", "other"), provider: str, model: str,
  input_tokens: nonnegativeSafe, output_tokens: nonnegativeSafe, cache_read_tokens: nonnegativeSafe, cache_write_tokens: nonnegativeSafe,
  cost_usd: { anyOf: [{ type: "number", minimum: 0 }, { type: "null" }] }, cost_source: { anyOf: [str, { type: "null" }] }, ms: nonnegativeSafe, ok: bool, at: nonnegativeSafe },
["scope", "provider", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "cost_source", "ms", "ok"]), undefined,
{ direction: "out", audience: "owner", description: "One model call as the DSH side measured it, priced from the installed model catalog; cost_usd is null when no price is known, never zero." });
add("service:cost", "usage.get", "request", obj({ days: { type: "integer", minimum: 1, maximum: 90 } }), obj({}, [], true),
  { audience: "owner", label: "看用量", description: "What the models used and cost: today, 7 and 30 days, by part of Ash, by day, and the latest calls." });
add("service:cost", "balance.get", "request", empty, obj({}, [], true),
  { audience: "owner", label: "看余额", description: "The provider account balance for the configured API key; fails rather than reporting zero when it cannot be read." });
add("service:clock", "cancel", "request", obj({ id }, ["id"]), obj({ cancelled: bool }, ["cancelled"]));
add("service:clock", "list", "request", empty, obj({ timers: array(any) }, ["timers"]));
add("service:clock", "clock.fired", "event", obj({ timer_id: id, scheduled_at: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  outcome: choice("dispatched", "skipped", "failed"), reason: str, request_id: id }, ["timer_id", "scheduled_at", "outcome"]), undefined,
{ direction: "out", description: "Durable scheduled occurrence outcome; dispatched records router acceptance, not external completion." });
add("service:post", "deliver", "request", obj({ message_id: id, kind: choice("reply", "offer", "heads_up", "approval", "due"), dedupe_key: deliveryDedupeKey }, ["message_id", "kind"]), obj({ channel: choice("inapp", "notification", "held", "dropped") }, ["channel"]), { audience: "owner" });
add("service:post", "visible", "event", empty, undefined, { audience: "owner", description: "Presence from the authenticated screen only." });
add("service:post", "hidden", "event", empty, undefined, { audience: "owner", description: "The authenticated screen left the foreground; deliveries notify again at once." });
add("service:post", "post.changed", "event", obj({ held: { type: "integer", minimum: 0 } }, ["held"]), undefined, { direction: "out", audience: "owner", label: "更新待送达消息", description: "Authoritative current held-delivery count for the owner; never infer a count from deliver results." });
add("service:post", "post.delivery", "event", obj({ message_id: id, state: choice("held", "released", "dropped") }, ["message_id", "state"]), undefined,
  { direction: "out", audience: "owner", label: "更新消息是否可见", description: "Per-message chat visibility for a new offer or heads-up; released is in-app visibility, not a host notification." });

/** Control frames do not have ledger seq or advance the stream cursor. */
export const POST_DELIVERY_SNAPSHOT_SCHEMA_V2: JsonSchema = obj({
  at_seq: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  items: { type: "array", maxItems: 1000, items: obj({
    message_id: id, state: choice("held", "released", "dropped"),
    version_seq: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  }, ["message_id", "state", "version_seq"]) },
}, ["at_seq", "items"]);

export function postDeliverySnapshotErrors(value: unknown): string[] {
  if (!matchesSchema(POST_DELIVERY_SNAPSHOT_SCHEMA_V2, value)) return ["invalid snapshot shape"];
  const snapshot = value as { at_seq: number; items: { message_id: string; version_seq: number }[] };
  if (new Set(snapshot.items.map((item) => item.message_id)).size !== snapshot.items.length) return ["duplicate message_id"];
  if (snapshot.items.some((item) => item.version_seq > snapshot.at_seq)) return ["version_seq exceeds at_seq"];
  return [];
}
const gateRisk = choice("outward", "structure");
const gateRule = obj({ id, subject: nonempty, device_id: id, capability_id: id, to: id, word: id, object_pattern: nonempty,
  risk: choice("none", "outward", "structure"), contract_fingerprint: sha, created_at: nonnegativeSafe, expires_at: nonnegativeSafe, revoked_at: nonnegativeSafe },
["id", "subject", "to", "word", "object_pattern", "risk", "contract_fingerprint", "created_at", "expires_at"]);
// A word whose effect is not read is gated even when its legacy risk says none.
const gateCurrentHistory = obj({ id, request_id: id, ask_id: id, subject: nonempty, to: id, word: id, risk: choice("none", "outward", "structure"),
  decision: choice("once", "always", "deny", "timeout", "cancelled", "rule", "review", "carry", "device_full"), at: nonnegativeSafe, rule_id: id,
  reason: { type: "string", maxLength: 500 }, label: { type: "string", maxLength: 120 }, source: { const: "current" } },
["id", "request_id", "decision", "at", "source"]);
const gateLegacyScope: JsonSchema = { type: "string", pattern: "^(\\*|device:[A-Za-z0-9_-]+/(\\*|[A-Za-z0-9_.-]+))$" };
const gateLegacyHistory = obj({ id, subject: nonempty, to: id, word: id, risk: gateRisk,
  decision: choice("legacy_unresolved", "legacy_approved", "legacy_denied", "legacy_expired", "legacy_cancelled",
    "legacy_access_imported", "legacy_access_expired", "legacy_access_invalid"), at: nonnegativeSafe,
  legacy_scope: gateLegacyScope, source: { const: "legacy" } }, ["id", "decision", "at", "source"]);
const gateAccessScope: JsonSchema = { type: "string", pattern: "^device:[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+$" };
const gateAccessItem = obj({ id, member: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+$" }, scope: gateLegacyScope,
  source: choice("current", "legacy"), created_at: nonnegativeSafe, expires_at: nonnegativeSafe, revoked_at: nonnegativeSafe },
["id", "member", "scope", "source", "created_at", "expires_at"]);
// A current case always names its accepted request; a migrated row is never an actionable ask.
add("service:gate", "rules.list", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  obj({ rules: { type: "array", items: gateRule, maxItems: 100 }, next_before: positiveSafe, mode: choice("auto", "always") }, ["rules"]), { audience: "owner" });
add("service:gate", "rules.revoke", "request", obj({ id }, ["id"]), obj({ revoked: bool }, ["revoked"]), { audience: "owner", risk: "structure", effect: "structure" });
add("service:gate", "history", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 1000 } }),
  obj({ items: { type: "array", items: { oneOf: [gateCurrentHistory, gateLegacyHistory] }, maxItems: 1000 }, next_before: positiveSafe }, ["items"]), { audience: "owner" });
// Evidence of every approval decision, for the owner and for an agent helping to look into one.
const gateEvidence = obj({ request_id: id, at: nonnegativeSafe, requester: str, member: str, word: str, label: str, effect: str, turn: str,
  content: str, facts: any, review: any, card: any, decision: str, decided_by: str, reason: str, rule_id: str, answered_at: any,
  executed: any }, ["request_id", "at", "requester", "member", "word"], true);
add("service:gate", "audit", "request", obj({ request_id: id, requester: str, word: str, decision: str, before: positiveSafe,
  limit: { type: "integer", minimum: 1, maximum: 50 } }), obj({ entries: array(gateEvidence), next_before: any }, ["entries"]),
  { label: "查审批记录", description: "Approval evidence, newest first: what was asked, the facts the reviewer saw and its verdict, the card shown, the owner's answer, and whether the action then ran." });
// Changing approval rules always asks the owner when an agent asks for it; it is never covered by a rule, the mode or the reviewer.
add("service:gate", "rules.set", "request", obj({ agent: { type: "string", pattern: "^agent:[a-z][a-z0-9_-]{0,31}$" }, member: id, word: id,
  target: nonempty, days: { type: "integer", minimum: 1, maximum: 30 } }, ["agent", "member", "word"]), obj({ id, expires_at: nonnegativeSafe }, ["id", "expires_at"]),
  { audience: "owner", risk: "structure", effect: "structure", label: "新增审批规则",
    description: "Allow one agent to use one outside capability without asking, for up to 30 days, optionally only for one target (site:<host>, a calendar id, a recipient id, browse)." });
add("service:gate", "mode.set", "request", obj({ mode: choice("auto", "always") }, ["mode"]), obj({ mode: choice("auto", "always") }, ["mode"]),
  { audience: "owner", risk: "structure", effect: "structure", label: "改审批档位",
    description: "Switch the approval mode: auto asks only when an outside action needs it; always asks about every outside action that is not a read." });
add("service:gate", "access.list", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  obj({ items: { type: "array", items: gateAccessItem, maxItems: 100 }, next_before: positiveSafe }, ["items"]), { audience: "owner" });
add("service:gate", "access.grant", "request", obj({ member: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+$" }, scope: gateAccessScope }, ["member", "scope"]),
  obj({ id, member: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+$" }, scope: gateAccessScope, expires_at: nonnegativeSafe }, ["id", "member", "scope", "expires_at"]),
  { audience: "owner", risk: "structure", effect: "structure" });
add("service:gate", "access.revoke", "request", obj({ id }, ["id"]), obj({ revoked: bool }, ["revoked"]),
  { audience: "owner", risk: "structure", effect: "structure" });
add("service:gate", "gate.asked", "event", obj({ request_id: id, ask_id: id, risk: choice("none", "outward", "structure"), to: id, word: id,
  expires_at: nonnegativeSafe }, ["request_id", "ask_id", "risk", "to", "word", "expires_at"]), undefined, { direction: "out" });
// by review: the reviewer judged the action reversible or already asked for; carry: the same thing was allowed minutes ago.
add("service:gate", "gate.passed", "event", obj({ request_id: id, by: choice("rule", "answer", "review", "carry", "device_full"), rule_id: id, ask_id: id,
  reason: { type: "string", minLength: 1, maxLength: 500 } }, ["request_id", "by"]), undefined, { direction: "out" });
add("service:gate", "gate.denied", "event", obj({ request_id: id, by: choice("answer", "timeout"), ask_id: id },
  ["request_id", "by"]), undefined, { direction: "out" });

add("service:self", "read", "request", obj({ path: selfPathRequest }, ["path"]), obj({ content: str, hash: sha, version: integer }, ["content", "hash"]));
add("service:self", "write", "request", obj({ path: selfPathRequest, content: str, why: str, expected_hash: { anyOf: [sha, { type: "null" }] } }, ["path", "content", "why", "expected_hash"]), obj({ hash: sha, version: integer }, ["hash"]), { label: "改资料", description: "Write a managed file with its exact baseline hash; null only creates a new file." });
add("service:self", "append", "request", obj({ path: selfPathRequest, text: str }, ["path", "text"]), obj({ hash: sha }, ["hash"]), { label: "记日志", description: "Atomically append to any allowed dated log." });
add("service:self", "apply_plan", "request", obj({ path: selfPathRequest, expected_hash: sha, edits: array(edit) }, ["path", "expected_hash", "edits"]), obj({ applied: integer, hash: sha }, ["applied", "hash"]));
add("service:self", "rollback", "request", obj({ path: selfPathRequest, to_ts: num, expected_hash: sha }, ["path", "to_ts", "expected_hash"]), empty, { risk: "structure", effect: "write" });
add("service:self", "history", "request", obj({ path: selfPathRequest }, ["path"]), obj({ versions: array(any) }, ["versions"]));
add("service:self", "self.changed", "event", obj({ path: selfPath, by: id, summary: str, version: integer }, ["path", "by", "summary"]), undefined, { direction: "out" });

const calendarEvent = obj({ id, title: str, start: num, end: num, important: bool }, ["id", "title", "start", "end"]);
add("service:senses", "sense.calendar", "event", obj({ kind: choice("upcoming", "changed"), event: calendarEvent }, ["kind", "event"]), undefined, { audience: "owner" });
add("service:senses", "sense.battery", "event", obj({ level: { type: "number", minimum: 0, maximum: 100 } }, ["level"]), undefined, { audience: "owner" });
add("service:senses", "sense.screen", "event", obj({ state: choice("on", "app_open"), away_ms: { type: "number", minimum: 0 } }, ["state", "away_ms"]), undefined, { audience: "owner" });
add("service:senses", "sense.notification", "event", obj({ app: str, title: str, text: str }, ["app", "title", "text"]), undefined, { audience: "owner" });
// Batched facts from the phone's sensing companion. A batch_id makes a redelivered batch idempotent; time is epoch milliseconds.
export const SENSE_BATCH_MAX = 500;
export const ACTIVITY_STATES = ["still", "walking", "running", "cycling", "in_vehicle"] as const;
const senseText = (max: number, min = 1): JsonSchema => ({ type: "string", minLength: min, maxLength: max });
const senseBatch = (item: JsonSchema): JsonSchema => obj({
  batch_id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
  items: { type: "array", items: item, minItems: 1, maxItems: SENSE_BATCH_MAX },
}, ["batch_id", "items"]);
add("service:senses", "sense.location", "event", senseBatch(obj({ ts: nonnegativeSafe, lat: { type: "number", minimum: -90, maximum: 90 },
  lon: { type: "number", minimum: -180, maximum: 180 }, accuracy_m: { type: "number", minimum: 0, maximum: 1_000_000 }, provider: senseText(32), is_mocked: bool },
  ["ts", "lat", "lon", "accuracy_m", "provider"])), undefined, { audience: "owner" });
add("service:senses", "sense.activity", "event", senseBatch(obj({ ts_start: nonnegativeSafe, ts_end: nonnegativeSafe, state: choice(...ACTIVITY_STATES) },
  ["ts_start", "state"])), undefined, { audience: "owner" });
add("service:senses", "sense.health", "event", senseBatch(obj({ ts: nonnegativeSafe, metric: senseText(64), value: num, unit: senseText(32, 0), source: senseText(128) },
  ["ts", "metric", "value", "unit", "source"])), undefined, { audience: "owner" });
add("service:senses", "sense.geofence", "event", obj({ name: senseText(64), transition: choice("enter", "exit"), ts: nonnegativeSafe }, ["name", "transition", "ts"]),
  undefined, { audience: "owner" });
add("service:reflex", "reflex.judged", "event", obj({ message_id: id, stage: choice("keyword", "jev"), intent: str, confidence: { type: "number", minimum: 0, maximum: 1 }, acted: bool,
  fallback: choice("timeout", "unavailable", "invalid", "error"), fallback_ms: { type: "integer", minimum: 0 } }, ["message_id", "stage", "intent", "confidence", "acted"]), undefined,
  { direction: "out", description: "One reflex decision. fallback says why JEV was asked but the keyword rule decided." });
add("service:reflex", "task.stop", "request", obj({ turn: id }, ["turn"]), obj({ cancelled: bool }, ["cancelled"]),
  { audience: "owner", timeout_ms: 3000, description: "Stop only the owner's explicitly selected current task, never a newer turn." });
add("service:reflex", "task.end", "request", obj({ turn: id, pending_ids: { type: "array", items: id, maxItems: 100, uniqueItems: true } }, ["turn", "pending_ids"]),
  obj({ ended: bool }, ["ended"]), { audience: "owner", timeout_ms: 5000, description: "End the selected capsule interaction: stop its current turn and withdraw only the explicitly displayed pending requests. Never stop a newer turn." });
add("service:reflex", "before_turn", "request", obj({ turn: id }, ["turn"]), obj({ captured: bool,
  captures: array(obj({ route: id, state: { type: "object" } }, ["route", "state"])) }, ["captured"]),
  { audience: "owner", timeout_ms: 10000, description: "Internal bounded pre-run capture and execution-screen judgment for peripheral decision routes." });
add("service:reflex", "surface.get", "request", obj({}), obj({ home_visible: bool, page_live: bool, visibility_epoch: nonnegativeSafe, virtual_available: bool },
  ["home_visible", "page_live", "visibility_epoch"]), { audience: "owner", timeout_ms: 2000 });
add("service:reflex", "screen.get", "request", obj({}), obj({ foreground_package: str, state_epoch: nonnegativeSafe,
  virtual_generation: nonnegativeSafe, virtual_owner_turn: str, virtual_open: bool },
  ["foreground_package", "state_epoch", "virtual_generation", "virtual_owner_turn", "virtual_open"]), { audience: "owner", timeout_ms: 3000 });
add("service:reflex", "screen.return", "request", obj({ expected_package: str, expected_state_epoch: nonnegativeSafe, decision_id: id },
  ["expected_package", "expected_state_epoch", "decision_id"]), obj({ acted: bool }, ["acted"]), { audience: "owner", timeout_ms: 3000 });
add("service:reflex", "virtual.close", "request", obj({ expected_generation: nonnegativeSafe, owner_turn: id, decision_id: id },
  ["expected_generation", "owner_turn", "decision_id"]), obj({ acted: bool }, ["acted"]), { audience: "owner", timeout_ms: 10000 });
const decisionMeta = { decision_id: id, route: id, route_version: positiveSafe, trigger_id: id };
add("service:reflex", "decision.started", "event", obj({ ...decisionMeta, evidence_ids: array(id), state_fingerprint: sha },
  ["decision_id", "route", "route_version", "trigger_id", "evidence_ids", "state_fingerprint"]), undefined, { direction: "out" });
add("service:reflex", "decision.judged", "event", obj({ ...decisionMeta, outcome: { type: "object" }, stage: str,
  confidence: { type: "number", minimum: 0, maximum: 1 }, fallback: str, latency_ms: nonnegativeSafe },
  ["decision_id", "route", "route_version", "trigger_id", "outcome", "stage", "latency_ms"]), undefined, { direction: "out" });
add("service:reflex", "decision.applied", "event", obj({ ...decisionMeta, outcome: { type: "object" }, acted: bool, skipped: str, effects: array(str) },
  ["decision_id", "route", "route_version", "trigger_id", "acted"]), undefined, { direction: "out" });
add("service:work", "run", "request", obj({ flow: workName }, ["flow"]), obj({ run: workRunId }, ["run"]), { audience: "owner" });
add("service:work", "runs", "request", obj({ flow: workName, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  obj({ runs: { type: "array", items: workRunInfo, maxItems: 100 } }, ["runs"]), { audience: "owner" });
add("service:work", "run.start", "event", obj({ run: workRunId, flow: workName, trigger: choice("manual", "cooldown", "hourly", "event") }, ["run", "flow", "trigger"]), undefined, { direction: "out" });
add("service:work", "run.end", "event", obj({ run: workRunId, outcome: choice("done", "no_change", "failed"), detail: workReason }, ["run", "outcome", "detail"]), undefined, { direction: "out" });
add("service:work", "run.step", "event", obj({ run: workRunId, step: workName, state: choice("started", "done", "failed", "skipped") }, ["run", "step", "state"]), undefined,
  { direction: "out", description: "Pure-code step lifecycle for a background run; metadata only, never step content." });

/** JSON Schema checks the item shape; this enforces the temporal invariant on readback. */
export function workRunsResultErrors(value: unknown): string[] {
  const schema = wordContract("service:work", "runs")?.result_schema;
  if (!schema || !matchesSchema(schema, value)) return ["invalid runs result shape"];
  const runs = (value as { runs: { state: string; started_at: number; ended_at: number | null }[] }).runs;
  return runs.flatMap((run, index) => run.state === "running"
    ? (run.ended_at === null ? [] : [`runs[${index}]: running has ended_at`])
    : (run.ended_at !== null && run.ended_at >= run.started_at ? [] : [`runs[${index}]: terminal ended_at invalid`]));
}

/** The run identity is the ledger turn; callers must not prepend another r_. */
export function workRunTurn(run: string): string {
  if (!matchesSchema(workRunId, run)) throw new TypeError("invalid work run id");
  return run;
}

const worker = (name: string, input: JsonSchema, normal: JsonSchema) => add(`worker:${name}`, name, "request", obj({ input, run: id }, ["input", "run"]), workerResult(normal), { audience: "owner", description: "One tool-free model judgment with validated structured output." });
worker("extract", obj({ chunk: array(message), summary: str, known: strings }, ["chunk", "summary", "known"]), obj({ claims: array(claim) }, ["claims"]));
worker("verify_claims", obj({ claims: array(claim), evidence: array(message) }, ["claims", "evidence"]), obj({ verdicts: array(obj({ i: integer, lens: choice("refute", "grounded"), pass: bool, confidence: { type: "number", minimum: 0, maximum: 1 }, why: str }, ["i", "lens", "pass", "confidence", "why"])) }, ["verdicts"]));
worker("reconcile", obj({ file: choice("MEMORY.md", "USER.md"), numbered: str, claims: array(claim) }, ["file", "numbered", "claims"]), obj({ edits: array(edit) }, ["edits"]));
worker("verify_plan", obj({ file: choice("MEMORY.md", "USER.md"), before: str, edits: array(edit), evidence: array(message) }, ["file", "before", "edits"]), obj({ verdicts: array(obj({ i: integer, lens: choice("evidence", "temporal", "preservation"), pass: bool, why: str }, ["i", "lens", "pass", "why"])) }, ["verdicts"]));
worker("proactive", obj({ prefs: str, recent: array(message), facts: array(obj({ n: integer, text: str }, ["n", "text"])), upcoming: array(any), delivered: array(any) }, ["prefs", "recent", "facts", "upcoming", "delivered"]), obj({ suggestion: obj({ kind: choice("offer", "heads_up"), title: str, text: str, urgency: choice("regular", "high"), facts: array(integer) }, ["kind", "title", "text", "urgency", "facts"]) }, ["suggestion"]));
worker("opener", obj({ away_ms: num, last_topic: str, pending: array(any), changes: array(any) }, ["away_ms", "last_topic", "pending", "changes"]), obj({ speak: bool, why: str, hint: str }, ["speak", "why"]));

// Management bodies retain the current extension payloads until the edge migrates.
for (const [word, input, result] of [
  ["settings.get", empty, obj({}, [], true)], ["settings.set", obj({}, [], true), obj({}, [], true)],
  ["plugins.list", empty, obj({}, [], true)], ["plugins.op", { oneOf: [
    obj({ op: choice("enable", "disable"), name: nonempty }, ["op", "name"]),
    obj({ op: { const: "plugin" }, id: nonempty, enabled: bool }, ["op", "id", "enabled"]),
  ] }, obj({}, [], true)],
  ["gateway.state", empty, obj({}, [], true)], ["gateway.op", { oneOf: [
    obj({ op: { const: "approve" }, request_id: nonempty,
      permissions: array(choice("chat", "read_status", "cancel_own_task", "request_sensitive_action", "expose_capability", "web_ui")) },
    ["op", "request_id", "permissions"]),
    obj({ op: { const: "reject" }, request_id: nonempty }, ["op", "request_id"]),
    obj({ op: { const: "revoke" }, device: { type: "string", pattern: "^device:[A-Za-z0-9_-]+$" } }, ["op", "device"]),
    obj({ op: { const: "sync" } }, ["op"]),
    // A short-lived one-time code a new browser or computer presents; the phone still asks the owner before anything is granted.
    obj({ op: { const: "ticket" } }, ["op"]),
  ] }, obj({}, [], true)],
  ["model.set", obj({ provider: nonempty, model: nonempty }, ["provider", "model"]),
    obj({ provider: nonempty, model: nonempty, restart_required: bool }, ["provider", "model", "restart_required"])],
] as [string, JsonSchema, JsonSchema][]) add("service:admin", word, "request", input, result, { audience: "owner", ...(word === "plugins.op" || word === "gateway.op" ? { risk: "structure" as const, effect: "structure" as const } : { risk: "none" as const }), description: "Local owner administration; never available to a remote screen." });
add("service:admin", "pause", "request", { oneOf: [empty, obj({ by: id }, ["by"]) ] },
  obj({ paused: { const: true } }, ["paused"]), { audience: "owner", description: "Durably pause activity; a trusted local reflex may cite one authenticated owner message once." });
add("service:admin", "resume", "request", obj({ confirmed: { const: true } }, ["confirmed"]),
  obj({ paused: { const: false } }, ["paused"]), { audience: "owner", description: "Resume only after explicit confirmation on a verified local owner screen." });

export const WORD_CONTRACTS: readonly WordContract[] = Object.freeze(entries);
/** An agent member id: agent:main is the one the owner talks with; the others are declared. */
export const AGENT_ID = /^agent:[a-z][a-z0-9_-]{0,31}$/;
export function wordContract(member: string, word: string): WordContract | undefined {
  // Every agent speaks the same words; they are written once under the main agent.
  return WORD_CONTRACTS.find((item) => item.word === word && (item.member === member || (item.member === "screen:*" && /^screen:[^:]+$/.test(member)) ||
    (item.member === "agent:main" && AGENT_ID.test(member))));
}
export function deviceWordSpec(capability: { name: string; description: string; input_schema: JsonSchema; result_schema?: JsonSchema; risk: "none" | "outward" | "structure"; effect?: WordEffect; label: string }): WordSpec {
  if (typeof capability.name !== "string" || !capability.name.trim() || typeof capability.description !== "string" || !capability.description.trim() || typeof capability.label !== "string" || !capability.label.trim() || !["none", "outward", "structure"].includes(capability.risk)) throw new TypeError("device capability needs valid name, description, risk and label");
  if (capability.effect !== undefined && !isWordEffect(capability.effect)) throw new TypeError("device capability effect must be read, act, write, send, execute or structure");
  if (!capability.input_schema || typeof capability.input_schema !== "object" || Array.isArray(capability.input_schema) || capability.input_schema.type !== "object") throw new TypeError("device capability needs an object input schema");
  // Full externally supplied JSON Schemas must be compiled by a standards-compliant validator at registration.
  return { word: capability.name, kind: "request", description: capability.description, input_schema: capability.input_schema, result_schema: capability.result_schema ?? obj({}, [], true), risk: capability.risk, ...(capability.effect ? { effect: capability.effect } : {}), label: capability.label, audience: "all" };
}

/** Cross-field checks that JSON Schema alone cannot express for a choice card. */
export function cardErrors(card: Card): string[] {
  if (!matchesSchema(CARD_SCHEMA, card)) return ["card schema mismatch"];
  if (card.type !== "options") return [];
  const ids = card.options.map((option) => option.id);
  return [
    ...(new Set(ids).size === ids.length ? [] : ["duplicate option id"]),
    ...(ids.includes("__custom") ? ["reserved option id"] : []),
  ];
}

/** Static shape only; pending/expiry/first-answer checks belong to the router transaction. */
export function optionReplyErrors(body: { text?: unknown; in_reply_to?: unknown; option_id?: unknown }): string[] {
  const hasReply = body.in_reply_to !== undefined;
  const hasOption = body.option_id !== undefined;
  if (hasReply !== hasOption) return ["in_reply_to and option_id must appear together"];
  if (hasReply && (typeof body.in_reply_to !== "string" || !body.in_reply_to || typeof body.option_id !== "string" || !body.option_id || typeof body.text !== "string")) return ["invalid option reply"];
  return [];
}

/** Cross-field checks a phone sense body needs beyond its schema: an activity segment cannot end before it starts. */
export function senseBodyErrors(word: string, body: Record<string, unknown>): string[] {
  if (word !== "sense.activity" || !Array.isArray(body.items)) return [];
  return (body.items as { ts_start?: unknown; ts_end?: unknown }[]).flatMap((item, index) =>
    typeof item.ts_end === "number" && typeof item.ts_start === "number" && item.ts_end < item.ts_start ? [`items[${index}]: ends before it starts`] : []);
}
