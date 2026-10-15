/**
 * The service words: the one list of every word the hub's members speak, apart from the standard hand actions
 * (namespaces.ts) and app tools (app.ts). It covers the services (SPEC-02 §4.1), the owner's words (§4.2), the words
 * every agent speaks, `service:llm/complete`, and the events. Contracts only; nothing here runs.
 *
 * `callers` defaults to owner, agent, app (SPEC-01 §5.2). Words that are not default are listed in the callers snapshot
 * (test/callers.snapshot.txt) so a review sees every change. Events are always `kernel`: they are sent by the hub's
 * own edges and services (the human module, the hands module, the agents module), never by an agent or an app.
 * An agent's name never appears here; `agent:*` stands for every declared agent.
 */
import { AGENT_ID, AGENT_ID_PATTERN, APP_NAME_PATTERN, BODY_ID_PATTERN, CLIENT_ID_PATTERN, DATE_PATTERN, DEDUPE_KEY_PATTERN, DEVICE_ID_PATTERN, HAND_ID_PATTERN, SURFACE_ID_PATTERN, TOOL_NAME_PATTERN } from "./ids";
import { CTX_FILES, CTX_READ_MAX } from "./host";
import { ACTIVITY_STATES } from "./namespaces";
import {
  DEFAULT_CALLERS, RISKS, secret, sensitive, wordEffect,
  type CallerKind, type Effect, type JsonSchema, type Risk, type WordContract,
} from "./word";

// ---- schema kit -----------------------------------------------------------------------------------------------------
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
const empty = obj();
const accepted = obj({ accepted: bool }, ["accepted"]);
const free = obj({}, [], true);
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: "null" }] });
const positiveSafe: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegativeSafe: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const sha: JsonSchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const deliveryDedupeKey: JsonSchema = { type: "string", minLength: 1, maxLength: 128, pattern: DEDUPE_KEY_PATTERN };
const attachmentInput = obj({ name: nonempty, mime_type: nonempty, data: nonempty }, ["name", "mime_type", "data"]);
const agentRef: JsonSchema = { type: "string", pattern: AGENT_ID_PATTERN };
const deviceRef: JsonSchema = { type: "string", pattern: DEVICE_ID_PATTERN };
const bodyRef: JsonSchema = { type: "string", pattern: BODY_ID_PATTERN };
const handRef: JsonSchema = { type: "string", pattern: HAND_ID_PATTERN };
const ref: JsonSchema = { type: "string", minLength: 1, maxLength: 128 };
/** What the host module sends when the device's environment changes (the host event env.changed of ash-host/1, minus its `event` name). */
const ENV_CHANGED: JsonSchema = { type: "object", oneOf: [
  obj({ what: { const: "network" }, network: obj({ proxy: nullable(obj({ http: str, https: str, no_proxy: str })) }, ["proxy"]), online: bool }, ["what", "network", "online"]),
  obj({ what: { const: "power" }, saver: bool }, ["what", "saver"]),
] };

// ---- how a word is written --------------------------------------------------------------------------------------------
const OWNER: CallerKind[] = ["owner"];
const OWNER_AGENT: CallerKind[] = ["owner", "agent"];
/** For the readings only the owner and an app the owner installed may see (the app is granted them in its needs). */
const OWNER_APP: CallerKind[] = ["owner", "app"];
const KERNEL: CallerKind[] = ["kernel"];

interface Options {
  /** Default: derived from risk (none -> read). Say it for anything that changes something. */
  effect?: Effect;
  /** Default none. */
  risk?: Risk;
  /** What the owner sees while it runs, in the present continuous: 「在看提醒」. Required. */
  label?: string;
  /** For the agent: what it does and when to use it, at least 20 characters. Required. */
  description?: string;
  callers?: CallerKind[];
  local_only?: boolean;
  per_call_risk?: boolean;
  timeout_ms?: number;
  /** Events: out = the member emits it, in = the member receives it (default out). */
  direction?: "in" | "out";
  /** Events only: goes into the ledger. */
  record?: boolean;
}

const entries: WordContract[] = [];
function add(member: string, word: string, kind: "request" | "event", input: JsonSchema, result: JsonSchema | undefined, o: Options): void {
  if (!o.label || !o.description) throw new TypeError(`${member}/${word}: label and description are required`);
  const event = kind === "event";
  const risk: Risk = event ? "none" : o.risk ?? "none";
  const effect: Effect = event ? "read" : o.effect ?? wordEffect({ risk });
  entries.push({
    member, word, kind, direction: event ? o.direction ?? "out" : "in", description: o.description, input_schema: input,
    ...(result ? { result_schema: result } : {}), effect, risk,
    ...(o.per_call_risk ? { per_call_risk: true } : {}),
    callers: event ? o.callers ?? [...KERNEL] : [...(o.callers ?? DEFAULT_CALLERS)],
    ...(o.local_only ? { local_only: true } : {}), ...(o.record ? { record: true } : {}),
    ...(o.timeout_ms ? { timeout_ms: o.timeout_ms } : {}), label: { doing: o.label },
  });
}

// ===================================================================================================================
// service:admin: switches and settings
// ===================================================================================================================
add("service:admin", "pause", "request", obj({ by: id }), obj({ paused: { const: true } }, ["paused"]),
  { callers: OWNER_AGENT, effect: "write", label: "在暂停", description: "Durably pause all activity (agent turns, timers that would wake an agent). An agent pauses when the owner says stop: `by` cites that owner message. Resuming is the owner's." });
add("service:admin", "resume", "request", obj({ confirmed: { const: true } }, ["confirmed"]), obj({ paused: { const: false } }, ["paused"]),
  { callers: OWNER_AGENT, effect: "write", label: "在恢复", description: "Resume after a pause, after an explicit confirmation." });
add("service:admin", "settings.get", "request", obj({ keys: strings }), free,
  { label: "在看设置", description: "Read the hub's settings (all of them, or the named keys). Credentials are never part of the result." });
add("service:admin", "settings.set", "request", free, free,
  { effect: "write", risk: "structure", label: "在改设置", description: "Change settings: the body is the keys to change and their new values. The gate decides whether the owner is asked." });
add("service:admin", "model.set", "request", obj({ provider: nonempty, model: nonempty }, ["provider", "model"]),
  obj({ provider: nonempty, model: nonempty, restart_required: bool }, ["provider", "model", "restart_required"]),
  { effect: "write", risk: "structure", label: "在换主模型", description: "Choose the main model (provider and model name) the hub's own agents run on; restart_required says whether an agent must be restarted for it to apply." });
add("service:admin", "plugins.list", "request", empty, free, { label: "在看插件", description: "List the plugins of the agent runtime and whether each is enabled." });
add("service:admin", "plugins.op", "request", { type: "object", oneOf: [
  obj({ op: choice("enable", "disable"), name: nonempty }, ["op", "name"]),
  obj({ op: { const: "plugin" }, id: nonempty, enabled: bool }, ["op", "id", "enabled"]),
] }, free, { effect: "write", risk: "structure", label: "在调整插件", description: "Enable or disable a plugin of the agent runtime. Plugins change what an agent can do; the gate decides whether the owner is asked." });
add("service:admin", "status", "request", empty,
  obj({ now: integer, time_zone: str, paused: bool, version: str, uptime_ms: nonnegativeSafe, agents: integer, hands_online: integer }, ["now", "paused"], true),
  { label: "在看系统状态", description: "The hub's state in a few facts: the time and time zone, whether activity is paused, the version, how long it has been up, how many agents and hands are online." });
add("service:admin", "logs", "request", obj({ lines: { type: "integer", minimum: 1, maximum: 1000 }, level: choice("error", "warn", "info", "debug"), since: nonnegativeSafe }),
  obj({ lines: strings }, ["lines"]),
  { callers: OWNER_AGENT, label: "在看日志", description: "The tail of the hub's log file (default 200 lines, newest last; the hub's own lines start with their UTC time; level and since do not narrow them yet). For diagnosing the hub." });
const checkupGroup = obj({ id: nonempty, title: { type: "string", minLength: 1, maxLength: 40 }, todo: nonnegativeSafe, optional: bool, text: { type: "string", maxLength: 40 } }, ["id", "title", "todo"]);
const checkupSummary = { todo: nonnegativeSafe, groups: { type: "array", items: checkupGroup, maxItems: 16 } };
add("service:admin", "checkup.changed", "event", obj(checkupSummary, ["todo", "groups"]), undefined,
  { direction: "in", label: "在收手机的体检摘要", description: "A hand reports its checkup in counts: how many things need dealing with, and for each part of the phone its name, the count and a short phrase. No contents. Sent when the summary changes and when the hand connects; not recorded." });
add("service:admin", "checkup", "request", empty,
  obj({ known: bool, ...checkupSummary, at: nonnegativeSafe, device: nonempty }, ["known"]),
  { label: "在看手机的体检", description: "The last checkup summary the phone reported (how many things need dealing with, per part of the phone). known is false until a phone has reported. Use it when asked whether the phone's permissions and keep-alive switches are in order; the details are on the phone." });
add("service:admin", "settings.changed", "event", obj({ keys: strings, by: id }, ["keys"]), undefined,
  { record: true, label: "在记下设置改动", description: "A setting was changed (the key names, never the values). Goes into the ledger so that what changed, when and by whom can be found again." });

// ===================================================================================================================
// service:health: how the hub itself is behaving (counts and budgets, never contents)
// ===================================================================================================================
const healthKey = obj({ key: nonempty, per_min: num }, ["key", "per_min"]);
const healthEvent = obj({ at: nonnegativeSafe, type: choice("breach", "start", "ok"), id: nonempty, since: nonnegativeSafe, peak: num, value: num, budget: num, window_s: integer, idle: bool, top: array(obj({ key: nonempty, n: num }, ["key", "n"])), note: str, last_seen: nonnegativeSafe },
  ["at", "type", "id"]);
add("service:health", "status", "request", obj({ window_s: { type: "integer", minimum: 60, maximum: 3600 } }),
  obj({
    now: integer, uptime_s: nonnegativeSafe, idle: bool, window_s: integer,
    rates: obj({ msg_per_min: num, ledger_rows_per_min: num, link_opens: num, errors_per_min: num }, ["msg_per_min", "ledger_rows_per_min", "link_opens", "errors_per_min"]),
    top: array(healthKey),
    proc: obj({ cpu_pct: num, rss_mb: num, heap_mb: num, lag_p99_ms: num }, ["cpu_pct", "rss_mb", "heap_mb", "lag_p99_ms"]),
    invariants: array(obj({ id: nonempty, ok: bool, value: nullable(num), budget: num, since: nonnegativeSafe }, ["id", "ok", "value", "budget"])),
    last_events: array(healthEvent),
  }, ["now", "uptime_s", "idle", "window_s", "rates", "top", "proc", "invariants", "last_events"]),
  { label: "在看自己的运行状况", description: "How the hub is doing right now: message and ledger rates, the busiest words, process CPU and memory, event loop delay, and which behaviour budgets (idle traffic, ledger growth, reconnect storms, errors) are kept or broken. Use it when asked why Ash is slow, busy or heating the phone. It counts words and callers, never contents." });
add("service:health", "recent", "request", obj({ since: nonnegativeSafe, limit: { type: "integer", minimum: 1, maximum: 1440 }, kind: choice("event", "minute") }),
  obj({ events: array(healthEvent), minutes: array(obj({ at: nonnegativeSafe, idle: bool, msg: num, ledger: num, err: num, link_opens: num, cpu_pct: num, rss_mb: num, lag_p99_ms: num, top: array(healthKey) }, ["at"])) }),
  { label: "在翻运行记录", description: "The health history: budget breaches and starts (kind event, default) or one summary per minute for up to seven days (kind minute), newest first. Use it to find out when something started misbehaving and which word did it." });

// ===================================================================================================================
// service:gate: approval rules and pending requests
// ===================================================================================================================
const gateRisk = choice(...RISKS);
const gateRule = obj({ id, subject: nonempty, device_id: id, capability_id: id, to: id, word: id, object_pattern: nonempty,
  risk: gateRisk, contract_fingerprint: sha, created_at: nonnegativeSafe, expires_at: nonnegativeSafe, revoked_at: nonnegativeSafe },
["id", "subject", "to", "word", "object_pattern", "risk", "contract_fingerprint", "created_at", "expires_at"]);
const gateDecision = choice("once", "always", "deny", "timeout", "cancelled", "rule", "review", "carry", "hand_full", "declared_none", "assessed_none");
const gateHistoryItem = obj({ id, request_id: id, ask_id: id, subject: nonempty, to: id, word: id, risk: gateRisk, decision: gateDecision, at: nonnegativeSafe, rule_id: id,
  reason: { type: "string", maxLength: 500 }, label: { type: "string", maxLength: 120 } }, ["id", "request_id", "decision", "at"]);
const gateEvidence = obj({ request_id: id, at: nonnegativeSafe, requester: str, member: str, word: str, label: str, effect: str, turn: str,
  content: str, facts: any, review: any, card: any, decision: str, decided_by: str, reason: str, rule_id: str, answered_at: any, executed: any },
["request_id", "at", "requester", "member", "word"], true);
const pendingState = choice("waiting", "approved", "denied", "expired", "withdrawn", "skipped", "redeemed");
const pendingItem = obj({ id, to: id, word: id, label: str, state: pendingState, created_at: nonnegativeSafe, expires_at: nonnegativeSafe }, ["id", "to", "word", "state", "expires_at"]);

add("service:gate", "rules.list", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  obj({ rules: { type: "array", items: gateRule, maxItems: 100 }, next_before: positiveSafe, mode: choice("auto", "always") }, ["rules"]),
  { label: "在看审批规则", description: "Inspect the current approval rules (who may use which capability without asking, until when) and the approval mode. Do not assume a risky action is already allowed." });
add("service:gate", "rules.set", "request", obj({ agent: agentRef, member: id, word: id, target: nonempty, days: { type: "integer", minimum: 1, maximum: 30 } }, ["agent", "member", "word"]),
  obj({ id, expires_at: nonnegativeSafe }, ["id", "expires_at"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在申请新增审批规则",
    description: "Allow one agent to use one outside capability without asking, for up to 30 days, optionally only for one target (site:<host>, a calendar id, a recipient id, browse). The gate decides whether the owner is asked." });
add("service:gate", "rules.revoke", "request", obj({ id }, ["id"]), obj({ revoked: bool }, ["revoked"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在申请撤销审批规则", description: "Remove a known approval rule. It changes future decisions, not past actions. The gate decides whether the owner is asked." });
add("service:gate", "mode.set", "request", obj({ mode: choice("auto", "always") }, ["mode"]), obj({ mode: choice("auto", "always") }, ["mode"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在申请改审批档位",
    description: "Switch the approval mode: auto asks only when an outside action needs it; always asks about every outside action that is not a read. The gate decides whether the owner is asked." });
add("service:gate", "audit", "request", obj({ request_id: id, requester: str, word: str, decision: str, before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 50 } }),
  obj({ entries: array(gateEvidence), next_before: any }, ["entries"]),
  { label: "在查审批记录", description: "Approval evidence, newest first: what was asked, the facts the reviewer saw and its verdict, the card shown, the owner's answer, and whether the action then ran." });
add("service:gate", "history", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 1000 } }),
  obj({ items: { type: "array", items: gateHistoryItem, maxItems: 1000 }, next_before: positiveSafe }, ["items"]),
  { label: "在查审批记录", description: "Review earlier gate decisions (who asked for what and how it was decided). Read only." });
const ORIGINATOR = { callers: ["agent"] as CallerKind[] };
add("service:gate", "pending.list", "request", empty, obj({ pending: array(pendingItem) }, ["pending"]),
  { ...ORIGINATOR, label: "在核对待回复的事", description: "The requests you made that are waiting for the owner or have been answered and not yet acted on. Only the agent that made a request sees it." });
add("service:gate", "pending.get", "request", obj({ id }, ["id"]),
  obj({ ...(pendingItem.properties as Record<string, JsonSchema>), request: obj({ to: id, word: id, body: any }, ["to", "word"]), answer: obj({ choice: str, text: str, at: nonnegativeSafe }) }, ["id", "state", "request"]),
  { ...ORIGINATOR, label: "在看原问题与回答", description: "One pending request of yours: the original request, its state and the owner's answer. Use it before redeeming, to be sure the action is still wanted." });
add("service:gate", "pending.redeem", "request", obj({ id }, ["id"]), obj({ result: any }),
  { ...ORIGINATOR, effect: "act", label: "在执行你批准的事", description: "Carry out a request the owner approved: the original request is sent again and, this time, passes the gate as approved. Works once, only for the agent that made it, in its own turn." });
add("service:gate", "pending.skip", "request", obj({ id, reason: str }, ["id"]), obj({ skipped: bool }, ["skipped"]),
  { ...ORIGINATOR, effect: "write", label: "在说明为何不再继续", description: "Say that you will not carry out a request that was answered, for example because it is no longer wanted. The owner is told." });
add("service:gate", "pending.withdraw", "request", obj({ id }, ["id"]), obj({ withdrawn: bool }, ["withdrawn"]),
  { ...ORIGINATOR, effect: "write", label: "在撤回问题", description: "Withdraw a question or approval request you made, while it is still waiting; the owner's card is taken down." });

// ---- screen leases: the owner lends the real screen for a while ---------------------------------------------------------------
const leaseView = obj({ id, agent: nonempty, name: str, kind: choice("task", "timed"), purpose: str, granted_at: nonnegativeSafe, expires_at: nonnegativeSafe, last_action_at: nullable(nonnegativeSafe) },
  ["id", "agent", "kind", "granted_at", "expires_at"]);
add("service:gate", "lease.request", "request", obj({ minutes: { type: "integer", minimum: 1, maximum: 120 }, goal: { type: "string", minLength: 1, maxLength: 200 } }, ["goal"]),
  obj({ status: choice("waiting_owner", "active"), lease_id: id, expires_at: nonnegativeSafe }, ["status", "lease_id"]),
  { callers: ["agent"], effect: "write", label: "在申请操作屏幕",
    description: "Ask the owner to lend you the real phone screen for a while (taps, typing, scrolling, opening an app or a link, keys): the screen words are refused until the owner says yes. Say what for in goal; minutes is how long you need (default 15, the owner may give 'this task' or 1 hour instead). It does not wait: the owner's answer comes as their own message in the conversation. Do not ask again while one is waiting." });
add("service:gate", "lease.status", "request", empty, obj({ lease: nullable(leaseView), asking: bool }, ["asking"]),
  { callers: ["agent"], label: "在看屏幕授权", description: "Your screen lease now: when it ends, or null (and whether a request is waiting for the owner)." });
add("service:gate", "lease.release", "request", empty, obj({ released: bool }, ["released"]),
  { callers: ["agent"], effect: "write", label: "在交还屏幕", description: "Hand the screen back when your work on it is done, so the owner's lease ends at once." });
add("service:gate", "lease.revoke", "request", obj({ id }), obj({ revoked: { type: "integer", minimum: 0 } }, ["revoked"]),
  { callers: OWNER_AGENT, effect: "write", label: "在收回屏幕授权", description: "The owner takes the screen lease back (one by id, else every one): the agent is stopped and told." });
add("service:gate", "lease.list", "request", empty, obj({ leases: array(leaseView) }, ["leases"]),
  { callers: OWNER_AGENT, label: "在看屏幕授权", description: "The screen leases in force now." });
add("service:gate", "lease.state", "event", obj({ leases: array(leaseView) }, ["leases"]), undefined,
  { callers: KERNEL, direction: "out", label: "在转达屏幕授权", description: "The screen leases changed (or, at most once a second, the agent just operated the screen: last_action_at): the whole list for the owner's screens (the human edge pushes it as present{status/lease}; a channel that just connected gets service:gate/lease.list)." });

// ===================================================================================================================
// service:vault: credentials. An agent may look, never touch.
// ===================================================================================================================
const vaultKind = choice("oauth", "key", "password", "generated");
const vaultEntry = obj({ ref: nonempty, label: nonempty, kind: vaultKind, service: str, why: str, help_url: str, account: str, scopes: strings,
  configured: bool, status: choice("ok", "expiring", "broken", "waiting", "missing"), expires_at: nonnegativeSafe, updated_at: nonnegativeSafe, last_used_at: nonnegativeSafe },
  ["ref", "label", "kind", "configured", "status"]);
const vaultRef: JsonSchema = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" };
add("service:vault", "list", "request", empty, obj({ entries: array(vaultEntry) }, ["entries"]),
  { callers: OWNER_AGENT, label: "在看保存的凭据", description: "Every credential the hub keeps, the hub's own connections included: name, kind, service, status, expiry. Never a value." });
add("service:vault", "describe", "request", obj({ ref: vaultRef }, ["ref"]), vaultEntry,
  { callers: OWNER_AGENT, label: "在看保存的凭据", description: "One credential: whether it is set and works, what it is for, when it expires. A value is never returned." });
add("service:vault", "set", "request", obj({ ref: vaultRef, value: secret({ type: "string", minLength: 1 }), label: nonempty, kind: vaultKind }, ["ref", "value"]),
  obj({ ref: nonempty, configured: { const: true } }, ["ref", "configured"]),
  { callers: OWNER, effect: "write", risk: "structure", label: "在保存密钥", description: "The owner saves a key or a password on the phone itself (the keys page, opened from a fill-in card). The value is held sealed and never reaches the ledger or an agent." });
add("service:vault", "put", "request", obj({ ref: vaultRef, value: secret({ type: "string", minLength: 1 }), label: nonempty, kind: choice("key", "password"), service: str }, ["ref", "value", "label"]),
  obj({ ref: nonempty, configured: { const: true } }, ["ref", "configured"]),
  { callers: ["agent"], effect: "write", label: "在存入凭据", description: "Store a key you obtained yourself (one you created in the service's console, an OAuth app's client secret) for the hub's connections to use. Write-only: nobody can read it back, you included. You may replace any key (a new one you made, a model key that stopped working); a connection's token is the hub's to renew." });
add("service:vault", "generate", "request", obj({ ref: vaultRef, label: nonempty, bytes: { type: "integer", minimum: 16, maximum: 64 } }, ["ref", "label"]),
  obj({ ref: nonempty, configured: { const: true } }, ["ref", "configured"]),
  { callers: OWNER_AGENT, effect: "write", label: "在生成密钥", description: "The hub makes a random secret and keeps it (base64url, 32 bytes unless said). Nobody can read it; the hub's own words use it by name." });
add("service:vault", "request", "request", obj({ ref: vaultRef, label: nonempty, why: nonempty, kind: choice("key", "password"), help_url: str, service: str, replace: bool }, ["ref", "label", "why"]),
  obj({ ref: nonempty, status: choice("waiting", "ok") }, ["ref", "status"]),
  { callers: ["agent"], effect: "write", label: "在向你要密钥", description: "Ask the owner for a key or password you cannot get yourself: the entry shows as waiting on the keys page and the owner gets a card to fill it in; the value goes from the page straight into the vault and never to you. Answers at once with status waiting; you are told when it is saved. replace: true asks again for a key that is set but no longer works (rejected, out of balance). Try to obtain a key yourself first." });
add("service:vault", "delete", "request", obj({ ref: vaultRef }, ["ref"]), obj({ deleted: bool }, ["deleted"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在删除凭据", description: "Delete a credential; a connection's token is revoked at the service first when the service allows it." });
add("service:vault", "connect", "request", obj({ service: nonempty, account: str }, ["service"]),
  obj({ ref: nonempty, auth_url: nonempty, scopes: strings, expires_at: num }, ["ref", "auth_url", "scopes", "expires_at"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在连接服务", description: "Connect one of the hub's services (vault.services lists them) to the owner's account with OAuth: the hub starts the flow and answers with the page to authorize on. Open it in the phone's Chrome (apps.open_url, package com.android.chrome) and tap Allow yourself; ask the owner only when the page wants a password, a code or a scan. The hub receives the callback, keeps the token and renews it; vault.describe shows status ok when done. The owner approves the connection (the service and its scopes) once." });
add("service:vault", "provider", "request", obj({ service: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" }, label: nonempty, grants: nonempty, auth_url: nonempty, token_url: nonempty, revoke_url: str,
  scopes: strings, extra: { type: "object", additionalProperties: str }, client_id_ref: vaultRef, client_secret_ref: vaultRef, how: str },
  ["service", "label", "grants", "auth_url", "token_url", "scopes", "client_id_ref", "client_secret_ref"]), obj({ service: nonempty }, ["service"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在添加可连接的服务", description: "Teach the hub a service it can connect with OAuth (authorization code + PKCE, loopback callback): its authorize and token addresses, scopes, extra authorize parameters, and the vault refs of the OAuth app's client id and secret. Write it from the service's OAuth documentation. Addresses are https (http only for 127.0.0.1). The owner approves it: the card shows where tokens would come from." });
add("service:vault", "token", "request", obj({ ref: vaultRef }, ["ref"]), obj({ ref: nonempty, value: str, kind: vaultKind, expires_at: num }, ["ref", "value", "kind"]),
  { callers: ["app"], label: "在取连接的令牌", description: "For an app the owner granted this credential ({credential: <ref>} in app.json's needs): a working value of it — a connection's access token (renewed by the hub when it is about to expire) or the stored key or password. Ask for it each time you call the service; do not keep it on disk. Only apps may call it and an app's reads are not recorded, so the value never reaches the ledger." });
add("service:vault", "services", "request", empty, obj({ services: array(obj({ service: nonempty, label: nonempty, scopes: strings, needs: strings, connected: bool, ref: str, how: str }, ["service", "label", "scopes", "needs", "connected"])) }, ["services"]),
  { callers: OWNER_AGENT, label: "在看能连的服务", description: "The services the hub can connect, what each needs first (an OAuth app's client id and secret stored with vault.put, and how to make one) and whether it is connected." });
add("service:vault", "vault.changed", "event", obj({ ref: nonempty, action: choice("saved", "removed", "connected", "broken") }, ["ref", "action"]), undefined,
  { label: "在记下密钥变化", description: "A credential was saved or removed. Names only; the value is never on the ledger. The agents module listens to configure the runtime's own credentials." });

// ===================================================================================================================
// service:devices: who may connect (the hub's registry of hands)
// ===================================================================================================================
const pairKind = choice("computer", "server");
const accessFields = { tier: choice("ask", "full"), lend: bool, body: bool, local_agents: bool };
const deviceInfo = obj({
  device: deviceRef, name: str, kind: str, online: bool, tier: choice("ask", "full"), lend: bool, body: bool, local_agents: bool,
  via: choice("local", "gateway"), ip: str, last_seen: nonnegativeSafe, revoked_at: nonnegativeSafe,
  version: str, platform: str, latest: bool, updating: str, capabilities: strings,
}, ["device", "name", "online"], true);
const pairState = choice("waiting", "requested", "approved", "connected", "rejected", "expired", "failed");
const pairInfo = obj({ pair_id: id, state: pairState, name: str, kind: pairKind, expires_at: nonnegativeSafe, device: deviceRef, reason: str }, ["pair_id", "state"]);
add("service:devices", "list", "request", obj({ include_revoked: bool }), obj({ devices: array(deviceInfo), release: str }, ["devices"]),
  { label: "在看已连接设备", description: "The owner's devices: name, kind, whether online, what the owner allowed it (lend capabilities, serve as a body, run local agents) and its tier, its program version (latest: whether it runs the hub's release of the computer program, `release`; updating: the release on its way), and the names of the capabilities it gives the hub. Revoked ones (kept on record for restore) only with include_revoked." });
add("service:devices", "describe", "request", obj({ device: deviceRef }, ["device"]), deviceInfo,
  { label: "在看设备详情", description: "One hand in detail: how it connects, what it was allowed, when it was last seen." });
add("service:devices", "pair_start", "request", obj({ kind: pairKind, name: nonempty }),
  obj({ pair_id: id, expires_at: nonnegativeSafe, command: nonempty }, ["pair_id", "expires_at", "command"]),
  { effect: "act", label: "在开始设备配对", description: "Start pairing a new computer or server. You get the pair_id and the whole install command to run in the new computer's terminal: it downloads Ash's program from its GitHub release, checks it, and pairs with a one-time code and a one-time secret. The secret never goes to the relay, so the relay cannot swap either side's key; it lives only in this command, so give the command to the owner in the conversation (or run it yourself on a computer you can already use), nowhere else. The device's request comes back to you; pair_approve lets it in. As the pairing moves on you get a background message; pair_status to look." });
add("service:devices", "pair_status", "request", obj({ pair_id: id }, ["pair_id"]), pairInfo,
  { label: "在看配对进展", description: "Where a pairing is: waiting for the command to be run, requested (a device asked to join), approved, connected, rejected, expired, or failed (with the reason: the device or the hub could not prove the pairing secret on the first connection, so a key was swapped on the way; pair again)." });
add("service:devices", "pair_pending", "request", empty, obj({ pairs: array(pairInfo) }, ["pairs"]),
  { label: "在看配对申请", description: "The pairings a device has answered, waiting for pair_approve or pair_reject." });
add("service:devices", "pair_approve", "request", obj({ pair_id: id, name: nonempty, ...accessFields }, ["pair_id"]), pairInfo,
  { effect: "write", label: "在批准设备配对", description: "Let in the device that answered a pairing, with what it may do: lend capabilities, serve as a body, run local agents; and its tier. The one who started the pairing approves it (the owner asked for this device), right away. The pairing is done when the device connects and proves the pairing secret." });
add("service:devices", "pair_reject", "request", obj({ pair_id: id }, ["pair_id"]), pairInfo,
  { effect: "write", label: "在拒绝设备配对", description: "Reject a pairing request." });
add("service:devices", "revoke", "request", obj({ device: deviceRef }, ["device"]), obj({ revoked: bool }, ["revoked"]),
  { effect: "write", risk: "structure", label: "在断开并撤销设备", description: "Disconnect a hand and revoke it: it can no longer connect, and its capabilities and body go away. The gate decides whether the owner is asked." });
add("service:devices", "restore", "request", obj({ device: deviceRef }, ["device"]), obj({ restored: bool }, ["restored"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在恢复已撤销的设备", description: "Let a revoked hand pair again, with the permissions it had. The gate decides whether the owner is asked." });
add("service:devices", "rename", "request", obj({ device: deviceRef, name: nonempty }, ["device", "name"]), obj({ device: deviceRef, name: str }, ["device", "name"]),
  { effect: "write", label: "在修改设备名称", description: "Change the name a hand is shown with." });
add("service:devices", "access_set", "request", obj({ device: deviceRef, ...accessFields }, ["device"]), deviceInfo,
  { effect: "write", label: "在调整设备权限", description: "Change what a hand may do (lend capabilities, serve as a body, run local agents) and its tier (ask, full): the same choices pair_approve makes." });
add("service:devices", "update", "request", obj({ device: deviceRef, version: { type: "string", pattern: "^v?[0-9]+\\.[0-9]+\\.[0-9]+$" }, sha256: sha }, ["device"]), obj({ started: bool, version: str, sha256: str }, ["started"]),
  { effect: "write", risk: "structure", label: "在更新设备程序", description: "Have a computer update its Ash program from its GitHub release (device-v<version>), checked against sha256, and restart. Give only device: the hub installs the release it was built with and knows the checksum for the computer's platform. Give version and sha256 (the platform's line in that release's SHA256SUMS) for another release. Computers older than the hub's release are also updated by themselves when they connect, unless the setting devices.auto_update is false. Approved here once; the update itself is then run by the hub. The gate decides whether the owner is asked." });
add("service:devices", "pair_code", "request", obj({ pair_id: id }, ["pair_id"]), obj({ command: nonempty, expires_at: nonnegativeSafe }, ["command"]),
  { callers: OWNER_AGENT, label: "在看配对命令", description: "The install command of a pairing still waiting, again. It only lets the device ask; pair_approve lets it in." });
add("service:devices", "pair.changed", "event", obj({ pair_id: id, state: pairState, device: deviceRef, reason: str }, ["pair_id", "state"]), undefined,
  { record: true, label: "在记下配对进展", description: "A pairing moved on (requested, approved, rejected, connected, expired, failed with its reason). The one who started it is told by a background message." });
add("service:devices", "device.changed", "event", obj({ device: deviceRef, change: choice("renamed", "access", "revoked", "restored", "updating", "updated", "paired"), by: nonempty, version: str }, ["device", "change", "by"]), undefined,
  { record: true, label: "在记下设备变化", description: "Something about one device changed and who changed it (by: the owner, an agent, or the service itself for an automatic update): renamed, access (what it may do), revoked, restored, updating (the release it was told to install), updated (it came back on another version), paired. Coming and going online is service:link connected / disconnected; a pairing's progress is pair.changed." });
add("service:devices", "config.changed", "event", obj({ item: nonempty, state: nonempty }, ["item", "state"]), undefined,
  { direction: "in", label: "在记下手机设置变化", description: "A hand reports that one of its own permissions or switches changed (config.*). Sent by the hands module; not recorded." });
add("service:devices", "codex.turn_ended", "event", obj({ thread: nonempty, title: str, outcome: str, said: str }, ["thread"]), undefined,
  { direction: "in", label: "在记下 Codex 做完一轮", description: "A computer reports that a session of its Codex app finished a turn. The owner is told in a short message; not recorded." });
add("service:devices", "codex.approval_pending", "event", obj({ thread: nonempty, title: str, request_id: nonempty, kind: str, summary: str }, ["thread", "request_id"]), undefined,
  { direction: "in", label: "在记下 Codex 等批准", description: "A computer reports that a session of its Codex app is waiting for an approval. The owner is told in a short message; not recorded." });

// ===================================================================================================================
// service:link: how things connect (the connection layer itself)
// ===================================================================================================================
const LINK_CALLERS = OWNER_AGENT;
const conn = obj({ conn: id, hand: handRef, name: str, kind: str, channels: strings, via: choice("local", "gateway"), since: nonnegativeSafe, heartbeat_ms: nonnegativeSafe, address: str }, ["conn", "hand"], true);
add("service:link", "list", "request", empty, obj({ connections: array(conn) }, ["connections"]),
  { callers: LINK_CALLERS, label: "在看当前连接", description: "Every live connection: which hand, which channels are open (device, human, agent), local or through the relay, since when, heartbeat delay." });
add("service:link", "describe", "request", obj({ hand: handRef, conn: id }), conn,
  { callers: LINK_CALLERS, label: "在看连接详情", description: "One connection in detail: each channel's state, calls in flight, the latest disconnect and its reason code. Give hand or conn." });
add("service:link", "diagnose", "request", obj({ hand: handRef }), obj({ ok: bool, findings: array(obj({ code: str, message: str }, ["code", "message"])) }, ["ok", "findings"], true),
  { callers: LINK_CALLERS, label: "在检查连接", description: "A health check: is the relay reachable, the state of each tunnel, the latest handshake failures with what their codes mean, clock difference, whether a capability list was refused." });
add("service:link", "disconnect", "request", obj({ conn: id, reason: str }, ["conn"]), obj({ closed: bool }, ["closed"]),
  { callers: LINK_CALLERS, effect: "act", risk: "outward", label: "在断开连接", description: "Close one connection. The hand may reconnect by itself unless it was revoked." });
add("service:link", "reconnect", "request", obj({ hand: handRef }, ["hand"]), obj({ requested: bool }, ["requested"]),
  { callers: LINK_CALLERS, effect: "act", label: "在重连", description: "Ask the relay to open the tunnel again, or tell a local hand to reconnect." });
add("service:link", "refresh_manifest", "request", obj({ hand: handRef }, ["hand"]), obj({ requested: bool }, ["requested"]),
  { callers: LINK_CALLERS, effect: "act", label: "在请手重发能力清单", description: "Ask a hand to send its capability list again, for example after you changed what it may lend." });
add("service:link", "gateway.status", "request", empty,
  obj({ configured: bool, url: str, claimed: bool, connected: bool, account_email: str, last_error: str }, ["configured", "connected"], true),
  { callers: LINK_CALLERS, label: "在看中转站", description: "The relay: whether there is one, its address, whether it is claimed by this hub, whether the hub is connected to it, and the latest error. The relay itself (deploying it, taking it back, its domain) is the agent's to run with wrangler: skill relay." });
add("service:link", "gateway.use", "request", obj({ url: { type: "string", minLength: 1, maxLength: 2048 }, claim_ref: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" } }, ["url"]), obj({ url: str }, ["url"]),
  { callers: LINK_CALLERS, effect: "write", risk: "structure", label: "在改用中转站", description: "Use the relay at this address: claim it if it has no owner yet and connect. The relay is the owner's own gateway (deployed in the owner's Cloudflare account, skill relay), not a third party's; the hub asks it first and refuses at once what cannot work. claim_ref names the vault entry holding the relay's BOOTSTRAP_SECRET (store it first with service:vault/put; skill relay); it is needed only to claim a relay that has no owner. The gate decides whether the owner is asked." });
const linkEvent = { hand: handRef, conn: id, channel: choice("device", "human", "agent"), code: integer, reason: str };
add("service:link", "gateway.changed", "event", obj({ connected: bool, url: str }, ["connected"]), undefined,
  { record: true, label: "在记下中转站连通变化", description: "The hub's connection to its relay came up or went down (only when it changes)." });
add("service:link", "connected", "event", obj({ hand: handRef, conn: id, channels: strings }, ["hand", "conn"]), undefined,
  { record: true, label: "在记下设备连上", description: "A hand finished the handshake and is connected. Goes into the ledger." });
add("service:link", "disconnected", "event", obj({ ...linkEvent }, ["hand"]), undefined,
  { record: true, label: "在记下设备断开", description: "A hand's connection closed, with the close code and reason. Goes into the ledger." });
add("service:link", "handshake_failed", "event", obj({ ...linkEvent }, ["code"]), undefined,
  { label: "在记下握手失败", description: "A connection attempt failed the handshake (4001 identity, 4003 revoked, 4008 version, ...). Not recorded; service:link/diagnose reports the recent ones." });
add("service:link", "env.changed", "event", ENV_CHANGED, undefined,
  { direction: "in", label: "在处理网络变化", description: "The host reports that the network or the power state changed (what: network with the proxy and whether the device is online, or power with whether it is in power-saving mode); the link layer reconnects the relay. Sent by the host module; not recorded." });

// ===================================================================================================================
// service:bodies: the hub's bodies (file and shell)
// ===================================================================================================================
const bodyInfoResult = obj({ body: bodyRef, name: str, ownership: choice("own", "borrowed"), online: bool, bound: bool, hand: handRef }, ["body", "ownership", "online"], true);
add("service:bodies", "list", "request", empty, obj({ bodies: array(bodyInfoResult) }, ["bodies"]),
  { label: "在看有哪些身体", description: "The bodies the hub has bound: its own (body:main) and any computer the owner lent, with whether each is Ash's own or borrowed, and whether it is online." });
add("service:bodies", "describe", "request", obj({ body: bodyRef }, ["body"]), obj({ info: any, disk: any, last_error: str }, ["info"], true),
  { label: "在看身体详情", description: "One body in detail: its body.info (system, resources, work directory, ownership), disk use, and the latest error." });
add("service:bodies", "bind", "request", obj({ hand: handRef }, ["hand"]), bodyInfoResult,
  { effect: "write", label: "在把电脑当作身体", description: "Bind a paired computer as a body: its workspace.* capabilities become available as body:<hand> (what pair_approve and access_set do with body: true)." });
add("service:bodies", "unbind", "request", obj({ body: bodyRef }, ["body"]), obj({ unbound: bool }, ["unbound"]),
  { effect: "write", label: "在解绑身体", description: "Unbind a body: workspace.* goes offline at once; the computer stays as a hand and as a host for local agents. body:main cannot be unbound." });
// ===================================================================================================================
// service:cards: the cards in the conversation that hold resources, and their lifecycle (docs/CARD-RUNTIME.md)
// ===================================================================================================================
const cardLife = choice("active", "idle", "dormant", "closed");
const cardRunInfo = obj({ id: nonempty, message: nonempty, owner: nonempty, app: str, temporary_app: bool, life: cardLife, pinned: bool, text: str,
  sources: strings, last_seen: num, last_used: num, expires_at: num, updated_at: num }, ["id", "owner", "life", "pinned"]);
const cardRef = obj({ id: nonempty }, ["id"]);
add("service:cards", "list", "request", obj({ life: cardLife }), obj({ cards: array(cardRunInfo), limits: obj({}, [], true) }, ["cards"]),
  { label: "在看运行中的卡片", description: "The cards in the conversation that are not closed (or those in one state): whose they are, which app runs them, their live sources, whether they are active, idle, dormant or pinned, when they were last seen and used; and the limits (how many may be active, how many sources, how many temporary apps)." });
add("service:cards", "describe", "request", cardRef, obj({ card: cardRunInfo, actions: obj({}, [], true) }, ["card"]),
  { callers: OWNER_AGENT, label: "在看一张卡片", description: "One card's runtime: its state, sources, app and the state of its buttons." });
add("service:cards", "sleep", "request", cardRef, obj({ life: cardLife }, ["life"]),
  { effect: "write", label: "在让卡片休眠", description: "Put a card to sleep now: its live data stops and is kept as it is; a temporary app whose cards all sleep is put to sleep too. Seeing or using the card wakes it. A card the owner pinned is refused (conflict): unpin it with pin first." });
add("service:cards", "wake", "request", cardRef, obj({ life: cardLife }, ["life"]),
  { effect: "write", label: "在唤醒卡片", description: "Wake a sleeping card: its app is started, its live data runs again and it is drawn fresh." });
add("service:cards", "close", "request", cardRef, obj({ closed: bool }, ["closed"]),
  { effect: "write", label: "在收起卡片", description: "Close a card (the same as person:owner/card.close): a static picture of it stays in the conversation." });
add("service:cards", "pin", "request", obj({ id: nonempty, pinned: bool }, ["id", "pinned"]), obj({ pinned: bool }, ["pinned"]),
  { effect: "write", label: "在固定卡片", description: "Keep a card running off screen (a delivery being tracked): it does not go idle, dormant or closed by time, though the limits on running cards still apply; unpin to let it stop again. Only the owner decides: an agent's call puts a card in front of him every time, so say why in purpose." });
add("service:cards", "keep", "request", cardRef, obj({ app: str, kept: bool }, ["kept"]),
  { callers: OWNER_AGENT, effect: "write", label: "在保留卡片的应用", description: "The card's temporary app becomes a lasting one: it is no longer removed when its cards are closed (「存成应用」)." });
add("service:cards", "act", "request", obj({ card: nonempty, component: nonempty, data: obj({}, [], true),
  request: { type: "object", description: "only from a card's mini app: {call: {member, word, body}} | {ask: {text}} | {tell: {text}}" } }, ["card", "component"]),
  obj({ state: choice("ok", "failed", "running"), result: any, text: str }, ["state"]),
  { callers: OWNER_AGENT, effect: "act", timeout_ms: 660_000, label: "在按卡片上的按钮", description: "Press a button of a card (its component id) with the values on the card now: pressed by the owner, its call runs as the card's app through the gate (which may ask him); pressed by an agent, the call is the agent's own, judged as any of its calls. Its ask or tell goes to the agent; the outcome is written on the card. A mini app on the card sends its own request here, and may call only its own app's words." });
add("service:cards", "seen", "request", obj({ cards: { type: "array", items: nonempty, maxItems: 50 } }, ["cards"]), obj({ active: strings }, ["active"]),
  { callers: OWNER_AGENT, label: "在记下看到的卡片", description: "The card ids on a screen of the owner now (the conversation reports them when it stops scrolling): those cards are active, the others go idle in time. Not recorded." });
// ===================================================================================================================
// person:owner: the owner's words (what the hub says to the owner). The owner's own words are the other words.
// ===================================================================================================================
const TO_OWNER: CallerKind[] = ["agent", "app"];
const cardOption = obj({ id: nonempty, text: nonempty }, ["id", "text"]);
/** The Android settings a permission card can send the owner to. */
export const PHONE_PERMISSIONS = ["calendar", "notifications", "battery", "accessibility", "photos", "all_files", "usage", "write_settings", "overlay", "host_shell"] as const;
/** What `person:owner/show` presents. */
export const CARD_SCHEMA: JsonSchema = { oneOf: [
  obj({ type: { const: "options" }, prompt: str, options: { type: "array", items: cardOption, minItems: 1 }, allow_custom: bool }, ["type", "options"]),
  obj({ type: { const: "file" }, workspace: nonempty, path: nonempty, name: nonempty, mime_type: nonempty, size: { type: "integer", minimum: 0 } }, ["type", "workspace", "path", "name", "mime_type", "size"]),
  obj({ type: { const: "image" }, workspace: nonempty, path: nonempty, alt: str }, ["type", "workspace", "path"]),
  obj({ type: { const: "link" }, url: nonempty, title: nonempty, summary: str }, ["type", "url", "title"]),
  // An Android setting the owner switches on by hand; the hand app opens exactly that page.
  obj({ type: { const: "permission" }, permission: choice(...PHONE_PERMISSIONS), why: nonempty }, ["type", "permission", "why"]),
] };
add("person:owner", "say", "request", obj({ text: nonempty, kind: choice("reply", "due", "offer", "heads_up"), facts: strings, dedupe_key: deliveryDedupeKey }, ["text"]), accepted,
  { callers: TO_OWNER, effect: "act", label: "在回你消息", description: "Send the owner a short message; it is acknowledged when recorded and does not wait for a reply or replace ask. kind (default reply): reply, due (a reminder), offer or heads_up (unprompted; an opaque stable dedupe_key keeps a repeat from showing twice). facts are source message or fact ids." });
add("person:owner", "notice", "request", obj({ title: { type: "string", minLength: 1, maxLength: 60 }, text: { type: "string", minLength: 1, maxLength: 500 }, open: choice("codex"), dedupe_key: deliveryDedupeKey }, ["title", "text"]), accepted,
  { callers: TO_OWNER, effect: "act", label: "在给你发通知", description: "A notification on the owner's phone that is not part of the conversation: no message is added, nobody answers it, and it rings as a heads-up does (quiet hours, dedupe_key). Opening it opens the page named by open (codex: the Codex page). For news of his own tools, such as his Codex App, that neither the conversation nor an agent needs to keep." });
add("person:owner", "react", "request", obj({ message_id: id, emoji: nonempty }, ["message_id", "emoji"]), accepted,
  { callers: TO_OWNER, effect: "act", label: "在给消息加表情", description: "React to one existing message with an emoji; an unknown message id fails. Not for a new explanation: use say for that." });
/** A card's name in the conversation (default: the id of the message that showed it). */
const chatCardId: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,64}$" };
/** What a card in the conversation is written in: the same A2UI as a home-screen card (widget.card.put), for the conversation. */
export const CHAT_A2UI_GUIDE = "a2ui is the same A2UI as a home-screen card (widget.card.put): {components:[{id, component, ...}], root?:'root', data?:{...}, theme?}. In the conversation it also takes " +
  "TextField {label, value, variant: shortText|longText|number|obscured, placeholder} (obscured is a password box: what is typed is never in data and never reaches you; ask for a password with person:owner/form), " +
  "DateTimeInput {label, value: ISO text, enableDate (default true), enableTime}, Slider {label, value, min, max, step}, Table {columns: [titles], rows: [[cells]] or {path}}, " +
  "and Html {html: one self-contained HTML document with inline CSS and JS, height: dp} for what the components cannot show (a calculator, a game, an unusual chart): it runs sandboxed with no network; " +
  "the theme is in CSS variables --ash-bg, --ash-surface, --ash-text, --ash-text2, --ash-accent, --ash-line; ash.send(action, context) sends an action to you like a button. " +
  "Row, Column, List and Grid take gap (dp between their children; none when left out). A Chart series takes min (the bottom of its axis, for a price or a weight). The conversation draws the card's frame: do not give the root a background, padding or corners. Inputs with value {path} write the owner's value into data on the phone itself: tabs, toggles, choices, sliders and typing need no round trip to you, and any Text or visible that reads such a path follows at once. " +
  "A Button with action {event:{name, context?}} sends you the owner's message `[card <id>, action <name>] {context, data}` with the card's current data. Lists may scroll horizontally here. " +
  "What cannot be drawn is left out and listed in problems; a component named but not given yet shows as a placeholder.";
add("person:owner", "show", "request", { ...obj({ card: CARD_SCHEMA, a2ui: obj({}, [], true), id: chatCardId, text: { type: "string", maxLength: 2000 },
  app: { type: "string", pattern: APP_NAME_PATTERN }, temporary_app: bool, ttl_min: { type: "integer", minimum: 1, maximum: 1440 } }), oneOf: [{ required: ["card"], properties: { card: { type: "object" } } }, { required: ["a2ui"], properties: { a2ui: { type: "object" } } }] },
  obj({ accepted: bool, card: str, problems: strings, hints: strings }, ["accepted"]),
  { callers: TO_OWNER, effect: "act", label: "在给你看卡片", description: "Put a card in the conversation. Either card: a file, image, link, a permission page to switch on, or choices; or a2ui: any card you design — text, tables, charts, lists, images, tabs, buttons, inputs, a small sandboxed page — drawn natively in the chat, in the same card language as the home-screen cards. " +
    "Show the owner what you want to show and ask for choices and input this way, in the conversation: never send them to another page for it. " +
    "app makes the card a surface of that Ash app (docs: card runtime): its buttons may call words ({call}) and its data may be fed live (a2ui.sources), always as app:<app>, within what the app was granted and through the gate; without app a card only talks to agents and does things on the phone. temporary_app: the app exists only for this card and is removed when its cards are closed (unless the owner keeps it). Every card stops by itself: idle a minute after it leaves the screen, dormant after 30 minutes, closed after a day untouched; ttl_min only closes it sooner. Keeping one running is the owner's: suggest it with service:cards/pin. " +
    "id names the card (default: this message's id) so card.update can change it later in place: a follow-up updates the card instead of sending another one. text is a short plain summary for notifications and screens that cannot draw the card (written from the card when left out). " +
    "Answers {accepted, card, problems, hints}: problems lists what was left out and why, hints what usually looks worse (too many accents, icons, titles); fix them with card.update, and look at it with card.preview. A card that cannot be drawn at all is refused with the reason. Showing choices does not itself authorize anything. " + CHAT_A2UI_GUIDE });
add("person:owner", "card.update", "request", obj({ id: chatCardId, a2ui: obj({}, [], true), data: { type: "object", description: "JSON pointer -> new value, merged into the card's data" }, text: { type: "string", maxLength: 2000 } }, ["id"]),
  obj({ updated: bool, problems: strings, hints: strings }, ["updated"]),
  { callers: TO_OWNER, effect: "act", label: "在更新卡片", description: "Change a card you showed in the conversation, where it is: a new a2ui (its layout), and/or data as {\"/pointer\": value} merged into its data model (keeps what the owner entered unless you set it). For a follow-up, a result arriving, or filling in a long card part by part. Only the card's creator may change it. Answers problems like show." });
add("person:owner", "card.close", "request", obj({ id: chatCardId }, ["id"]), obj({ closed: bool }, ["closed"]),
  { callers: TO_OWNER, effect: "act", label: "在收起卡片", description: "Close a card you showed (its creator, its app, or the owner): it stays in the conversation as it is now, its live data and buttons stop, and a temporary app whose cards are all closed is removed. Close a card when its task is done." });
add("person:owner", "card.draft", "request", obj({ card: chatCardId, data: obj({}, [], true) }, ["card", "data"]),
  obj({ card: str, plan: obj({}, [], true) }, ["card"]),
  { callers: OWNER_AGENT, label: "在记下卡片上填的", description: "What has been entered on a card so far (its whole data model; the owner's screen sends it as he types, an agent may fill in for him): kept with the card so it is there again after a refresh, and when something on the card reads it, the card drawn again (plan). Nothing is sent to anyone; an action on the card carries the values. A password box is never part of it." });
add("person:owner", "card.preview", "request", obj({ id: chatCardId, theme: choice("light", "dark") }, ["id"]),
  obj({ card: str, width: num, height: num }, ["card"]),
  { callers: ["agent"], timeout_ms: 30_000, label: "在看卡片的样子", description: "Look at a card you showed in the conversation as the phone draws it (its width in the chat, light or dark): the answer carries the picture, which you can see. Look once after show or card.update and fix what is cramped, cut off, misaligned or a flat line. Fails with offline when no phone is connected." });
const formField = obj({ type: choice("string", "number", "integer", "boolean"), title: str, description: str, default: any, enum: { type: "array", minItems: 1 }, examples: { type: "array" },
  format: choice("date", "time", "date-time", "email", "uri", "multiline"), minimum: num, maximum: num, minLength: integer, maxLength: integer, pattern: str }, ["type"]);
add("person:owner", "form", "request", obj({
  title: nonempty, why: str,
  schema: obj({ type: { const: "object" }, properties: { type: "object", additionalProperties: formField, minProperties: 1, maxProperties: 30 }, required: strings }, ["properties"]),
  values: obj({}, [], true),
  secret: { type: "object", additionalProperties: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$" }, description: "field -> vault name: a password box; its value goes straight into the vault" },
  expires_at: num,
}, ["title", "schema"]),
  obj({ values: obj({}, [], true), secret: { type: "object", additionalProperties: obj({ ref: nonempty, masked: str }, ["ref", "masked"]) } }, ["values", "secret"]),
  { callers: ["agent"], effect: "act", timeout_ms: 604_800_000, label: "在请你填写", description: "Ask the owner to fill in a form card in the conversation and wait for it: everything you need in one card (an address, a port, a user name and a password; a date and a choice …), filled in and sent right there. " +
    "schema is a JSON Schema object: properties with type string|number|integer|boolean, title (the label), description, default, enum (a choice), examples, format (date, time, date-time, email, uri, multiline); required. values prefills. " +
    "secret maps a field to a vault name: that field is a password box, and what the owner types goes from the phone straight into the vault under that name — you never see it; use it as $vault.<name> (workspace.bash env). " +
    "Answers {values (the other fields), secret: {field: {ref, masked}}} when the owner sends it, or fails with cancelled when the owner declines. why says what it is for (shown on the card). Ends at expires_at (default 24 hours, at most 7 days)." });
add("person:owner", "ask", "request", {
  ...obj({
    title: nonempty, detail: str, human_kind: choice("question", "confirmation"), allow_custom: bool,
    options: { type: "array", items: obj({ id: nonempty, label: nonempty }, ["id", "label"]), minItems: 1 }, expires_at: num,
    source: obj({ word: nonempty, to: id, body_preview: str, body_full: str }, ["word", "to", "body_preview"]),
  }, ["title"]),
  // A question (the default kind) needs its options; a confirmation gets the usual yes / no from the owner's side.
  if: { properties: { human_kind: { const: "confirmation" } }, required: ["human_kind"] },
  else: { required: ["options"], properties: { options: { type: "array" } } },
}, obj({ choice: nonempty, text: str }, ["choice"]),
  { callers: ["agent"], effect: "act", timeout_ms: 604_800_000, label: "在问你", description: "A durable question to the owner, who must choose before something continues. Only title is required; a question (the default human_kind) also needs options, while a confirmation without options gets yes and no from the owner's side. detail, source and expires_at are optional: the gate fills them for an approval, the tools fill expires_at from approval_ttl_minutes, and the owner's side ends the question at expires_at (at most seven days). The tools human_ask and human_confirm are this word under two names and take exactly this input. The answer (or the expiry) comes back as the response; an approval does not execute anything by itself. The hub's gate uses this for approval cards." });
add("person:owner", "open", "request", { ...obj({ target: choice("activity", "upcoming", "approvals", "identity", "memory", "settings", "turn", "file"), app: { type: "string", pattern: APP_NAME_PATTERN }, arg: str, id: str, mode: choice("perform", "suggest"), client: { type: "string", pattern: CLIENT_ID_PATTERN } }), anyOf: [{ required: ["target"], properties: { target: str } }, { required: ["app"], properties: { app: str } }] },
  obj({ opened: bool }, ["opened"]),
  { callers: TO_OWNER, effect: "act", label: "在打开页面", description: "Open or suggest a page on one of the owner's channels: settings, the activity of a turn, a file (id says which) — or an app (`app`: an id of service:apps/apps.list, system or installed; `arg`: what it is asked to show). Give target or app. `client` picks the channel; leave it out for the one the owner is on. Check `opened`: a suggestion may be declined." });

// ===================================================================================================================
// agent:*: the words every declared agent speaks
// ===================================================================================================================
add("agent:*", "say", "request", { type: "object", properties: {
    text: { type: "string" }, attachments: { type: "array", items: attachmentInput, minItems: 1 }, in_reply_to: id, option_id: id,
    card: obj({ id: chatCardId, action: { type: "string", pattern: "^[A-Za-z0-9_.:-]{1,64}$" }, context: obj({}, [], true), data: obj({}, [], true) }, ["id", "action"]),
  }, additionalProperties: false, dependentRequired: { in_reply_to: ["option_id"], option_id: ["in_reply_to"] },
  anyOf: [{ required: ["text"], properties: { text: { type: "string", minLength: 1 } } }, { required: ["attachments"], properties: { attachments: { type: "array", minItems: 1 } } }, { required: ["in_reply_to", "option_id"], properties: { in_reply_to: id, option_id: id } }, { required: ["card"], properties: { card: { type: "object" } } }] }, accepted,
  { callers: OWNER, effect: "act", label: "在读你的消息", description: "The owner speaks to the agent, answers an option card (in_reply_to and option_id together), or acts on a card the agent showed (card: which card, which action, its context and the card's data as the owner left it; text is the button's label). Acknowledged at once and queued on the front lane; the agent's answer arrives later as a message." });
add("agent:*", "tell", "request", obj({ text: nonempty, attachments: array(attachmentInput) }, ["text"]), accepted,
  { effect: "act", label: "在告诉帮手", description: "Tell the agent something. It joins the agent's back lane and the agent decides what to do with it; there is no direct answer to the sender." });
add("agent:*", "ask", "request", obj({ text: nonempty }, ["text"]), obj({ answer: str }, ["answer"]),
  { effect: "act", timeout_ms: 600_000, label: "在问帮手", description: "Put a question to the agent; what it says in the turn that takes the question is the answer. A quick answer is returned directly, a slow one as a receipt." });
add("agent:*", "wake", "request", obj({ lane: nonempty, reason: nonempty, context: free }, ["reason"]), accepted,
  { callers: ["agent", "app"], effect: "act", label: "在叫醒帮手", description: "Wake the agent for a reason, on a lane (default back), with the facts it needs in context. Its own turn runs; nothing is said to the owner by this. Harmless by itself, so organs (apps) may use it to alert an agent." });
add("agent:*", "typing", "event", empty, undefined,
  { direction: "in", label: "在等你说完", description: "The owner is composing a message to this agent in some channel; the inbox waits for them to finish before opening a turn. Sent by the human module." });
add("agent:*", "turn.started", "event", obj({ turn: id, lane: nonempty, ids: strings }, ["turn", "lane"]), undefined,
  { record: true, label: "在记下一轮开始", description: "A turn of the agent began (the lane and the ids of the messages it was given). Goes into the ledger." });
add("agent:*", "turn.ended", "event", obj({ turn: id, lane: nonempty, outcome: choice("completed", "cancelled", "error", "interrupted"), error: str }, ["turn", "lane", "outcome"]), undefined,
  { record: true, label: "在记下一轮结束", description: "A turn of the agent ended, with how it ended. Goes into the ledger." });
add("agent:*", "agent.tool", "event", obj({ turn: id, name: nonempty, phase: choice("start", "end"), summary: str, ok: bool }, ["turn", "name", "phase"]), undefined,
  { record: true, label: "在记下工具摘要", description: "One tool call of an agent's turn, as a one-line summary for the activity page. Goes into the ledger; the full result stays where the call was made." });

// ===================================================================================================================
// service:agents: declarations, running agents, sessions
// ===================================================================================================================
const MODEL_SETTINGS = obj({ effort: nonempty });
const AGENT_RUNTIME = obj({ kind: nonempty, model: nonempty, effort: nonempty, models: { type: "object", additionalProperties: MODEL_SETTINGS } }, ["kind"]);
/** An update's runtime: what to change. `kind` may be left out (the same runtime); in `models` a null entry forgets that model's settings. */
const AGENT_RUNTIME_PATCH = obj({ kind: nonempty, model: nonempty, effort: nonempty, models: { type: "object", additionalProperties: nullable(MODEL_SETTINGS) } });
const AGENT_NATIVE = obj({ on: bodyRef, cwd: nonempty, env: { type: "object", additionalProperties: str } }, ["on"]);
const AGENT_LANES: JsonSchema = { type: "object", additionalProperties: obj({ from: strings, on: strings, guide: str, speak: bool }) };
const AGENT_MODULES: JsonSchema = array(choice("identity", "rules", "user", "skills", "environment", "lane"));
const agentFields: Record<string, JsonSchema> = {
  name: nonempty, summary: nonempty, brief: nonempty, runtime: AGENT_RUNTIME, native: AGENT_NATIVE, tools: strings, words: strings,
  lanes: AGENT_LANES, modules: AGENT_MODULES, primary: bool,
};
const agentInfo = obj({ notes: array(str), id: agentRef, name: str, summary: str, state: choice("idle", "working", "starting", "stopped", "error"), available: bool, reachable: bool, primary: bool, ephemeral: bool,
  brief: str, runtime: AGENT_RUNTIME, native: AGENT_NATIVE, created_by: str, tools: nullable(strings), words: nullable(strings), lanes: AGENT_LANES, modules: nullable(AGENT_MODULES) },
["id", "name", "summary", "state"]);
const sessionKey = nonempty;
const sessionTarget = { agent: agentRef, key: sessionKey };
const sessionResult = obj({ key: sessionKey, handle: nullable(str) }, ["key"], true);
/** One rule for every word that gives a new or changed agent its powers (declare, update, spawn); service:agents checks it, with one function for the three words. */
export const DELEGATION_RULE = "Delegation rule: when the caller is not the owner, the tools and words you give the agent must be a subset of the tools and words you have yourself; anything beyond that is refused with forbidden. This is not a question to the owner. Delegation goes at most three levels deep.";
const session = (word: string, label: string, description: string, input: Record<string, JsonSchema>, required: string[], result: JsonSchema, effect: Effect = "act") =>
  add("service:agents", word, "request", obj(input, required), result, { effect, label, description });

add("service:agents", "list", "request", empty, obj({ agents: array(agentInfo) }, ["agents"]),
  { label: "在看有哪些帮手", description: "Every declared agent: id, name, what it does, whether it is idle, working or stopped, and which one is primary." });
add("service:agents", "runtimes", "request", empty, obj({ runtimes: array(free) }, ["runtimes"]),
  { label: "在查能在哪儿开帮手", description: "The agent runtimes you can run your own helper agents on (in the main body, and on computers allowed to host agents: codex = the Codex CLI, claude = Claude Code) with their models. Query before declaring an agent that runs on a computer. Not the owner's Codex App and its sessions: those are x.codex.* on the computer's device." });
add("service:agents", "threads", "request", empty, obj({ threads: array(free) }, ["threads"]),
  { callers: OWNER_AGENT, label: "在看交出去的事", description: "The delegated work in flight (threads between agents)." });
add("service:agents", "thread.stop", "request", obj({ thread: id }, ["thread"]), obj({ cancelled: bool }, ["cancelled"]),
  { callers: OWNER_AGENT, effect: "act", label: "在停下交出去的事", description: "Stop one delegated thread of work." });
add("service:agents", "describe", "request", obj({ agent: agentRef }, ["agent"]), agentInfo,
  { label: "在看帮手", description: "One agent's declaration (role, tools, lanes, modules, where it lives) and its state." });
add("service:agents", "ask", "request", obj({ agent: agentRef, text: nonempty }, ["agent", "text"]), obj({ agent: agentRef, answer: str }, ["agent", "answer"]),
  { effect: "act", timeout_ms: 600_000, label: "在问帮手", description: "Put a question to another agent; the answer it gives in the turn that takes the question is the result." });
add("service:agents", "tell", "request", obj({ agent: agentRef, text: nonempty }, ["agent", "text"]), obj({ sent: bool, message_id: id }, ["sent", "message_id"]),
  { effect: "act", label: "在告诉帮手", description: "Deliver news to another agent; what it says back is passed to the sender later as a message." });
add("service:agents", "answer", "request", obj({ in_reply_to: id, text: nonempty }, ["in_reply_to", "text"]), accepted,
  { callers: ["agent"], effect: "act", label: "在回答", description: "An agent's words in a turn that answers a question or news delivered to it. Only the agent that was asked, in that turn." });
add("service:agents", "declare", "request", obj({ id: agentRef, ...agentFields }, ["id", "name", "summary", "brief"]), agentInfo,
  { effect: "write", label: "在新建帮手", description: "Declare a new agent: who it is, its role (brief), its tools and word policy, its lanes, which prompt modules it loads, and where it runs (native). It starts at once in its own session. " + DELEGATION_RULE });
add("service:agents", "update", "request", obj({ agent: agentRef, ...agentFields, runtime: AGENT_RUNTIME_PATCH }, ["agent"]), agentInfo,
  { effect: "write", label: "在调整帮手", description: "Change an agent's declaration; it applies from its next turn. `primary` can be handed to another agent only through primary.set. The lasting way to choose an agent's model: `runtime` is a patch laid over the declared one: `kind` may be left out, `model` is `provider/model` (see runtime.catalog), `effort` is the thinking effort of that model, and `models` holds settings per model that apply whenever that model is in use (merged model by model; null forgets one). Examples: `runtime: {kind: \"pi\", model: \"deepseek/deepseek-flash\"}` switches the agent to the pi runtime; `runtime: {model: \"openai-codex/gpt-5.5\", models: {\"openai-codex/gpt-5.5\": {effort: \"high\"}, \"deepseek/deepseek-flash\": {effort: \"low\"}}}` changes the model and gives each model its own effort. A model or effort the runtime does not know is refused with the list to choose from. The result's `notes` say what is still missing for the choice to work (a key, a login). On the pi runtime a change of model or settings is taken from the next turn without a restart; a change of runtime kind restarts the agent. " + DELEGATION_RULE });
add("service:agents", "runtime.catalog", "request", obj({ agent: agentRef, provider: nonempty, search: nonempty }, ["agent"]),
  obj({ agent: agentRef, runtime: nonempty, saved: free, effective: free, catalog: free, providers: array(free), notes: array(str), usage: str }, ["agent", "runtime", "saved", "providers"]),
  { label: "在查能用的模型", description: "Which providers and models an agent's runtime can use, and whether each is usable now: for every provider its `ready` flag, what it needs (`auth`: a key in the vault, or a login), `how` to make it ready when it is not (including what to ask the owner), and its models with context length, image and reasoning support and the `efforts` each takes. Also `saved` (the lasting settings in the declaration) and `effective` (what is in force now, which a temporary configure or a fallback can make differ), and `catalog`: how new the model lists are (`checked_at`: when upstream was last asked; `upstream_at`: the date of the newest list received; `refreshing`: a refresh is under way). The lists keep up with upstream by themselves, about once a day, and a stale one is refreshed in the background when you read it; when upstream cannot be reached the last lists are used without any error. A provider with many models lists none until you ask for it with `provider`; `search` keeps the models whose id or name contains the text. Read this before choosing a model with update, and again after the owner has logged in or saved a key." });
add("service:agents", "start", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { effect: "act", label: "在启动帮手", description: "Let a stopped agent take turns again." });
add("service:agents", "stop", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { effect: "act", label: "在停下帮手", description: "Stop an agent: its current turn is cancelled and it leaves the registry, so words sent to it answer offline until it starts again." });
add("service:agents", "restart", "request", obj({ agent: agentRef }, ["agent"]), agentInfo, { effect: "act", label: "在重启帮手", description: "Cancel an agent's current turn and restart its process; its sessions are resumed." });
add("service:agents", "remove", "request", obj({ agent: agentRef }, ["agent"]), obj({ removed: bool }, ["removed"]),
  { effect: "write", label: "在删除帮手", description: "Remove a declared agent. The primary agent cannot be removed; hand `primary` to another one first." });
add("service:agents", "primary.set", "request", obj({ agent: agentRef }, ["agent"]), agentInfo,
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在换主 agent", description: "Make another agent the primary one: the owner's words, the notification and island replies, and the semantic layer's wake-ups go to it. The gate decides whether the owner is asked." });
add("service:agents", "spawn", "request", obj({
  task: nonempty, template: nonempty, runtime: AGENT_RUNTIME, model: nonempty, native: AGENT_NATIVE, tools: strings, timeout: { type: "integer", minimum: 1, maximum: 86400 },
}, ["task"]), obj({ answer: str, agent: agentRef }, [], true),
  { effect: "act", timeout_ms: 600_000, label: "在派临时帮手", description: "Run one task on a temporary agent: declare it, hand it the task, collect the result and delete it, in one step. A quick result is returned, a slow one as a receipt. It can never do more than you can. " + DELEGATION_RULE });
session("session.get", "在看会话", "Which resumable session an agent holds for a lane (the opaque handle the driver gave), or null.", sessionTarget, ["agent", "key"], sessionResult, "read");
session("session.set", "在指定会话", "Point a lane of an agent at a given session handle so the next turn resumes it; with no handle the lane starts fresh.", { ...sessionTarget, handle: nonempty }, ["agent", "key", "handle"], sessionResult, "write");
session("session.new", "在开新会话", "Open a new session for a lane of an agent. The old one is kept in the agent's own history; the ledger still has everything that was said.", sessionTarget, ["agent", "key"], sessionResult);
session("session.reload", "在重新载入会话", "Open a new session with the current static prompt modules (persona, rules). Done only when the agent is idle; skipped if nothing changed.", sessionTarget, ["agent", "key"], sessionResult);
session("session.compact", "在压缩上下文", "Compact the context of a lane's session, when the agent is idle. If it is busy the answer is conflict and the hub tries again after the turn.", sessionTarget, ["agent", "key"], obj({ compacted: bool, detail: str }, ["compacted"], true));
session("session.send", "在发起一轮", "Send messages to an idle agent and open a turn on a lane.", { ...sessionTarget, messages: { type: "array", minItems: 1, items: obj({ text: nonempty, from: id }, ["text"]) } }, ["agent", "key", "messages"], accepted);
session("session.followup", "在排下一轮", "Queue messages for the agent's next turn on a lane, without interrupting the one running.", { ...sessionTarget, messages: { type: "array", minItems: 1, items: obj({ text: nonempty, from: id }, ["text"]) } }, ["agent", "key", "messages"], accepted);
session("session.steer", "在插话", "Say something into the turn that is running on a lane, so the agent takes it into account now.", { ...sessionTarget, text: nonempty }, ["agent", "key", "text"], accepted);
session("session.inject", "在注入内容", "Put content into a lane's session without starting a turn: named prompt modules, or plain text.", { ...sessionTarget, modules: strings, text: nonempty }, ["agent", "key"], accepted);
session("session.interrupt", "在打断这一轮", "Stop the turn that is running on a lane.", sessionTarget, ["agent", "key"], obj({ interrupted: bool }, ["interrupted"]));
session("session.restart", "在重启会话进程", "Restart the agent's process and resume its sessions (one lane, or all when key is left out).", { agent: agentRef, key: sessionKey }, ["agent"], obj({ restarted: bool }, ["restarted"]));
add("service:agents", "configure", "request", obj({ agent: agentRef, key: sessionKey, config: free }, ["agent"]), obj({ config: free }, ["config"]),
  { effect: "write", label: "在配置帮手", description: "Set the runtime's own configuration for an agent (model, effort level, other options the runtime reports it supports), or read it when config is left out. This is the temporary way: it changes what is in force now and is forgotten when the hub restarts; the lasting way is `update` with `runtime`. On the pi runtime: `config: {model: \"deepseek/deepseek-flash\", effort: \"high\"}` takes effect from the next turn; `config: {login: \"openai-codex\"}` starts Codex's browser login (pi's standard one) and returns {url} (the owner opens it in the phone's browser, with the phone's VPN on, and signs in; the browser comes back to the phone itself and you are told when it is done). The read-back gives `effective` (in force now: model, effort, whether it fell back to DeepSeek and why, the route to the model, the login state) and `saved` (the declaration's lasting settings)." });
add("service:agents", "plugins", "request", obj({ agent: agentRef, key: sessionKey, op: choice("list", "enable", "disable"), name: nonempty }, ["agent", "op"]), free,
  { effect: "write", risk: "structure", label: "在调整帮手的插件", description: "List, enable or disable the plugins of one agent's runtime. Plugins change what the agent can do; the gate decides whether the owner is asked." });
add("service:agents", "env.changed", "event", ENV_CHANGED, undefined,
  { direction: "in", label: "在处理网络变化", description: "The host reports that the network or the power state changed (what: network with the proxy and whether the device is online, or power with whether it is in power-saving mode); when the proxy is a different one, the agents module restarts at once the agents running on this phone (they are told the turn was cut off; their waiting messages go to the new process). Sent by the host module; not recorded." });
// ===================================================================================================================
// service:clock: durable timers
// ===================================================================================================================
add("service:clock", "set", "request", obj({ at: num, every: { type: "integer", minimum: 60 }, to: id, word: id, body: free, label: nonempty }, ["to", "word", "body", "label"]), obj({ id, next: num }, ["id", "next"]),
  { effect: "write", label: "在定提醒", description: "Set a timer that sends a word to a member at a time (at, Unix ms) or repeatedly (every, seconds, at least 60). Use for a future or repeating message, not for immediate delivery. Keep the returned id to cancel it." });
add("service:clock", "cancel", "request", obj({ id }, ["id"]), obj({ cancelled: bool, inflight: bool }, ["cancelled"]),
  { effect: "write", label: "在取消提醒", description: "Cancel a timer by id; check `cancelled` because it may already have fired. `inflight: true` (with `cancelled: true`) means a one-time timer's send was already on its way when you cancelled: that send is not taken back and is delivered if it succeeds; cancelling only stops it from being put back and sent again if it is refused." });
add("service:clock", "cancel.owner", "request", obj({ member: id }, ["member"]), obj({ cancelled: integer }, ["cancelled"]),
  { callers: KERNEL, effect: "write", label: "在清理已删成员的提醒", description: "Internal: take back every timer the given member set, and tell how many there were. The agents module calls it when it deletes an agent, and the apps module when an app is removed or loses all its grants, so their timers do not go on firing as a member that no longer exists. The hub itself calls this; nobody else." });
add("service:clock", "list", "request", empty, obj({ timers: array(any) }, ["timers"]),
  { label: "在看提醒", description: "The active timers, to look at before changing them; the result is a snapshot. An agent or an app sees the timers it set; the owner sees all." });
add("service:clock", "wake.fired", "event", obj({ at: nonnegativeSafe }, ["at"]), undefined,
  { direction: "in", label: "在响应唤醒闹钟", description: "The host's alarm went off (the device woke); the clock checks which timers are due. Sent by the host module." });

// ===================================================================================================================
// service:llm: the hub's small model, for the owner, agents and apps
// ===================================================================================================================
add("service:llm", "complete", "request", obj({
  model: nonempty,
  messages: { type: "array", minItems: 1, items: obj({ role: choice("system", "user", "assistant"), content: { type: "string" } }, ["role", "content"]) },
  max_tokens: { type: "integer", minimum: 1, maximum: 8192 },
}, ["messages"]), obj({ text: str, model: str, usage: obj({ input_tokens: nonnegativeSafe, output_tokens: nonnegativeSafe }) }, ["text"]),
  { timeout_ms: 60_000, label: "在问小模型", description: "A short completion from the hub's small model (the model argument is optional). For organs that must judge something in code, e.g. a sensor rule. The usage is counted against the caller and its quota." });

const keyHealth = obj({
  provider: choice("deepseek", "openrouter"), ref: nonempty, configured: bool, status: choice("ok", "rejected", "low_balance", "unknown"),
  reason: str, detail: str, checked_at: nonnegativeSafe,
}, ["provider", "ref", "configured", "status"]);
add("service:llm", "keys.status", "request", empty, obj({ keys: array(keyHealth) }, ["keys"]),
  { callers: OWNER_AGENT, label: "在看模型密钥是否可用", description: "Whether each model key (DeepSeek for the conversation model, OpenRouter for the quick judgement) is saved and whether its provider accepts it: status ok, rejected (the key itself is refused: reason says why, such as expired; ask the owner for a new key), low_balance (accepted, but the account has no balance left, so calls fail; the owner tops up) or unknown (not checked yet or unreachable). Never the key. Use this when the model or quick judgement seems not to work." });
add("service:llm", "keys.check", "request", obj({ provider: choice("deepseek", "openrouter") }), obj({ keys: array(keyHealth) }, ["keys"]),
  { callers: OWNER_AGENT, timeout_ms: 30_000, label: "在验证模型密钥", description: "Ask the provider now whether a model key is accepted (one provider, or both when left out) with a free authenticated request that costs nothing, and return the same as keys.status. A key saved in the vault is checked automatically; use this to check again (an agent asking again within 30 seconds gets the last answer)." });

// ===================================================================================================================
// service:persona: the approved SOUL and IDENTITY
// ===================================================================================================================
const personaFile = choice("SOUL.md", "IDENTITY.md");
add("service:persona", "get", "request", obj({ file: personaFile }), obj({ files: array(obj({ file: personaFile, content: str, version: nonempty, approved_at: nonnegativeSafe }, ["file", "content", "version"])) }, ["files"]),
  { label: "在看人格", description: "The approved versions of SOUL.md and IDENTITY.md, the only ones sessions load. Editing the files in the body changes nothing until a change is proposed and approved." });
add("service:persona", "propose", "request", obj({ file: personaFile, content: { type: "string", minLength: 1, maxLength: 60000 }, reason: nonempty }, ["file", "content", "reason"]), obj({ proposed: bool, applied: bool }, ["proposed"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在提议改人格", description: "Propose a new SOUL.md or IDENTITY.md with the reason. The gate decides whether the owner is asked; a change the owner makes takes effect at once. It shows in new sessions after the next reload." });

// ===================================================================================================================
// service:cost: usage and quota
// ===================================================================================================================
add("service:cost", "usage.get", "request", obj({ days: { type: "integer", minimum: 1, maximum: 90 } }), free,
  { label: "在看用量", description: "What the models used and cost: today, 7 and 30 days, by part of Ash, by day, and the latest calls." });
add("service:cost", "balance.get", "request", empty, free,
  { label: "在看余额", description: "The provider account balance for the configured API key; fails rather than reporting zero when it cannot be read." });
add("service:cost", "quota.check", "request", obj({ agent: agentRef }, ["agent"]), obj({ allowed: bool, reason: str, used: num, limit: num }, ["allowed"]),
  { callers: KERNEL, label: "在查额度", description: "Whether an agent may open another turn under its daily quota, by the latest usage numbers. A soft limit: the numbers are only as fresh as the last poll." });
const USAGE_RECORDED = obj({
  caller: id, provider: nonempty, model: nonempty, input_tokens: nonnegativeSafe, output_tokens: nonnegativeSafe, cache_read_tokens: nonnegativeSafe,
  cost: { type: "number", minimum: 0 }, ok: bool, at: nonnegativeSafe,
}, ["caller", "provider", "model", "input_tokens", "output_tokens", "ok", "at"]);
add("service:cost", "usage.recorded", "event", USAGE_RECORDED, undefined,
  { direction: "in", label: "在记下用量", description: "One model call, as the llm edge reports it for the hub's small models or an agent driver reports it for an agent: who called, which model, tokens in and out (cache_read_tokens: the cached part of the input, priced apart), the cost in US dollars when a price is known (the cost service prices the models it has rates for when none is given) (the field is left out otherwise, never zero), whether it worked. Not recorded: usage has its own table." });

// ===================================================================================================================
// service:reflex: judgments the hub makes in small-model time
// ===================================================================================================================
add("service:reflex", "conversation.control", "request", obj({ message_id: id, agent: agentRef, lane: nonempty }, ["message_id", "agent"]),
  obj({ action: choice("interrupt", "pause", "steer", "followup"), confidence: { type: "number", minimum: 0, maximum: 1 }, stage: choice("keyword", "jev") }, ["action"]),
  { callers: KERNEL, effect: "act", timeout_ms: 8000, label: "在判断要不要打断", description: "The owner spoke while an agent was busy: judge what to do with it (stop it, pause, say it into the running turn, or wait for the next turn). Keywords first, the small model when unclear; a failed judgment means followup." });
add("service:reflex", "task.outcome", "request", obj({ turn: id }, ["turn"]),
  obj({ outcome: choice("delivered", "needs_reply", "needs_action_in_ash", "incomplete"), confidence: { type: "number", minimum: 0, maximum: 1 } }, ["outcome"]),
  { callers: KERNEL, effect: "act", timeout_ms: 8000, label: "在判断结果", description: "After a turn ended normally, label how it ended from the owner's point of view, for the island and the capsule: delivered, needs a reply, needs action in Ash, or incomplete." });
add("service:reflex", "task.stop", "request", obj({ turn: id }, ["turn"]), obj({ cancelled: bool }, ["cancelled"]),
  { callers: OWNER_AGENT, effect: "act", timeout_ms: 3000, label: "在停下任务", description: "Stop only the task the owner selected, never a newer turn." });
add("service:reflex", "task.end", "request", obj({ turn: id, pending_ids: { type: "array", items: id, maxItems: 100, uniqueItems: true } }, ["turn", "pending_ids"]), obj({ ended: bool }, ["ended"]),
  { callers: OWNER_AGENT, effect: "act", timeout_ms: 5000, label: "在结束任务", description: "End the selected capsule interaction: stop its current turn and withdraw only the pending requests that are displayed. Never stops a newer turn." });

// ===================================================================================================================
// service:senses: the archive of what the hands sense. The rules for waking anyone are an organ's, not ours.
// ===================================================================================================================
const SENSE_KIND = choice("location", "activity", "steps", "health", "geofence", "calendar", "battery", "screen", "notification");
add("service:senses", "query", "request", obj({ kind: SENSE_KIND, from: nonnegativeSafe, to: nonnegativeSafe, limit: { type: "integer", minimum: 1, maximum: 5000 } }, ["kind"]),
  obj({ rows: array(free), truncated: bool }, ["rows"]),
  { label: "在翻感知记录", description: "Archived sensor readings of one kind in a time range (Unix ms; default the last day), oldest first. Also what an organ uses to look back." });
add("service:senses", "daily", "request", obj({ date: { type: "string", pattern: DATE_PATTERN } }), free,
  { label: "在看每日统计", description: "The day's statistics, computed from the archive when asked (places, activity minutes, steps, health numbers) for a date (default yesterday). steps is null when the day has no step readings; counts are the readings archived for the day (all 0 = nothing recorded)." });
add("service:senses", "now", "request", empty, free,
  { label: "在看最近读数", description: "The newest reading of each kind (location, activity, battery, ...) and how old each is. No phone call is made; it is what the archive holds." });
const calendarEvent = obj({ id, title: str, start: num, end: num, important: bool }, ["id", "title", "start", "end"]);
const senseText = (max: number, min = 1): JsonSchema => ({ type: "string", minLength: min, maxLength: max });
const senseBatch = (item: JsonSchema): JsonSchema => obj({
  batch_id: deliveryDedupeKey,
  items: { type: "array", items: item, minItems: 1, maxItems: 500 },
}, ["batch_id", "items"]);
const senseEvent = (word: string, body: JsonSchema, label: string, description: string) =>
  add("service:senses", word, "event", body, undefined, { direction: "in", label, description });
senseEvent("sense.calendar", obj({ kind: choice("upcoming", "changed"), event: calendarEvent }, ["kind", "event"]), "在收日程变化", "A calendar event is about to start or changed, from the hand. Archived only; not recorded in the ledger.");
senseEvent("sense.battery", obj({ level: { type: "number", minimum: 0, maximum: 100 } }, ["level"]), "在收电量", "The battery level, from the hand. Archived only; not recorded in the ledger.");
senseEvent("sense.screen", obj({ state: choice("on", "app_open"), away_ms: { type: "number", minimum: 0 } }, ["state", "away_ms"]), "在收屏幕状态", "The screen came on or the app was opened, with how long the owner was away. Archived only; not recorded in the ledger.");
senseEvent("sense.notification", obj({ app: str, title: str, text: str }, ["app", "title", "text"]), "在收通知", "A notification arrived on the hand (app, title, text). Archived only; not recorded in the ledger.");
senseEvent("sense.location", senseBatch(obj({ ts: nonnegativeSafe, lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 },
  accuracy_m: { type: "number", minimum: 0, maximum: 1_000_000 }, provider: senseText(32), is_mocked: bool }, ["ts", "lat", "lon", "accuracy_m", "provider"])),
  "在收位置", "A batch of location points from the hand; a batch_id makes a re-delivered batch idempotent. Archived only; not recorded in the ledger.");
senseEvent("sense.activity", senseBatch(obj({ ts_start: nonnegativeSafe, ts_end: nonnegativeSafe, state: choice(...ACTIVITY_STATES) }, ["ts_start", "state"])),
  "在收运动状态", "A batch of activity segments from the hand. Archived only; not recorded in the ledger.");
senseEvent("sense.health", senseBatch(obj({ ts: nonnegativeSafe, metric: senseText(64), value: num, unit: senseText(32, 0), source: senseText(128) }, ["ts", "metric", "value", "unit", "source"])),
  "在收健康数据", "A batch of health readings from the hand. Archived only; not recorded in the ledger.");
senseEvent("sense.geofence", obj({ name: senseText(64), transition: choice("enter", "exit"), ts: nonnegativeSafe }, ["name", "transition", "ts"]),
  "在收围栏进出", "The owner entered or left a named place. Archived only; an organ that listens decides whether to wake an agent.");
senseEvent("sense.source", obj({ source: senseText(64), state: choice("stale", "fresh"), ts: nonnegativeSafe, stale_hours: { type: "integer", minimum: 1, maximum: 720 }, summary: senseText(200), last_data_ts: nonnegativeSafe },
  ["source", "state", "ts", "stale_hours", "summary"]),
  "在收数据源状态", "A health source stopped bringing new readings for stale_hours (sent once), or came back. last_data_ts is its newest reading; summary is plain Chinese for the owner.");

// ===================================================================================================================
// service:directory, service:history, service:blobs: finding things out
// ===================================================================================================================
add("service:directory", "list", "request", obj({ member: nonempty }), obj({ members: array(obj({ id: nonempty, kind: nonempty, name: str, online: bool,
  words: array(obj({ name: nonempty, label: str, needs_approval: { anyOf: [{ type: "boolean" }, { const: "per_call" }] } }, ["name"])) }, ["id", "kind"])) }, ["members"]),
  { label: "在查能做什么", description: "The members you can reach and the words of each that you may call, with the label and whether a call needs the owner's approval (true, or per_call when it is judged per call). Pass a member id to see just that one." });
add("service:directory", "describe", "request", obj({ member: nonempty, word: nonempty }, ["member"]), obj({ member: nonempty, words: array(free) }, ["member", "words"]),
  { label: "在查怎么做", description: "The full contract of a member's words you may call (description, input and result schemas, effect, risk), or of one word." });
add("service:history", "query", "request", obj({ text: nonempty, speaker: id, lane: nonempty, thread: id, before: positiveSafe, after: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 200 } }),
  obj({ messages: array(free), next_before: positiveSafe }, ["messages"]),
  { label: "在翻聊天记录", description: "Search the ledger: messages by text, speaker, lane or thread, newest first. Long bodies are summaries with an attachment reference; read them with service:blobs/read." });
add("service:history", "read", "request", obj({ from_seq: positiveSafe, to_seq: positiveSafe }, ["from_seq", "to_seq"]), obj({ messages: array(free) }, ["messages"]),
  { label: "在读历史原文", description: "Read ledger messages by sequence range, as recorded (secret values masked)." });
add("service:history", "turn", "request", obj({ turn: id }, ["turn"]), obj({ turn: id, messages: array(free), tools: array(free) }, ["turn"]),
  { label: "在看某一轮做了什么", description: "What happened in one turn of an agent: the messages it was given, its tool calls and results (summaries), and what it said." });
add("service:history", "activity", "request", obj({ id, offset: nonnegativeSafe }, ["id"]), obj({ items: array(free), next_offset: nullable(nonnegativeSafe) }, ["items"]),
  { label: "在看活动详情", description: "The detail of one activity entry (a turn's tool calls), paged by offset." });
const historyPageInput = { before: positiveSafe, after: nonnegativeSafe, limit: { type: "integer", minimum: 1, maximum: 200 }, snapshot_seq: nonnegativeSafe };
const historyPageResult = { dataset_id: nonempty, snapshot_seq: nonnegativeSafe, items: array(free), before: nullable(positiveSafe), after: nullable(positiveSafe), has_more_before: bool, has_more_after: bool, oversized: bool };
const historyPageRequired = ["dataset_id", "snapshot_seq", "items", "before", "after", "has_more_before", "has_more_after", "oversized"];
add("service:history", "window", "request", obj({ ...historyPageInput, around_id: nonempty }),
  obj({ ...historyPageResult, previous: nullable(free), next: nullable(free), intro: bool }, [...historyPageRequired, "previous", "next", "intro"]),
  { callers: OWNER_AGENT, label: "在翻聊天记录", description: "A bounded window of display items with complete answer, delivery and reaction state at snapshot_seq. Before, after and around_id are mutually exclusive. Long text is a preview and blob reference. Oversized marks one legitimate item returned alone." });
add("service:history", "current", "request", obj({ ...historyPageInput, agent: id }),
  obj({ ...historyPageResult, revision: nonnegativeSafe, as_of: nonnegativeSafe, next_change_at: nullable(nonnegativeSafe), total_count: nonnegativeSafe, presence: free, progress: nullable(free) }, [...historyPageRequired, "revision", "as_of", "next_change_at", "total_count", "presence", "progress"]),
  { callers: OWNER_AGENT, label: "在看现在的事", description: "Authoritative current presence and bounded progress, with independently paginated pending questions and complete total count. Optional agent scopes turns and question publishers; gate approvals remain in the unfiltered owner view. Read without snapshot_seq for current state; old conversation windows do not determine current presence." });
add("service:history", "activity.page", "request", obj({ ...historyPageInput, turn: nonempty, since_ts: nonnegativeSafe, until_ts: nonnegativeSafe, agent: id }), obj({ ...historyPageResult, total_count: nonnegativeSafe }, [...historyPageRequired, "total_count"]),
  { callers: OWNER_AGENT, label: "在看她做过的事", description: "Bidirectional bounded turn summaries with an authoritative total count, optionally filtered by inclusive since_ts, exclusive until_ts and agent. With turn, read its safe display steps and complete step count instead; time/agent filters then do not apply. Step details remain on demand through history.activity." });
add("service:history", "activity.count", "request", obj({ since_ts: nonnegativeSafe, until_ts: nonnegativeSafe, agent: id }), obj({ total_count: nonnegativeSafe }, ["total_count"]),
  { label: "在数她做过的事", description: "How many things she did (turns) in a time range, optionally for one agent: the same count as the total of activity.page, without any of the turns. since_ts inclusive, until_ts exclusive. For a status page that only needs the number." });
add("service:history", "confirm", "request", obj({ ids: { type: "array", items: nonempty, maxItems: 24, uniqueItems: true }, snapshot_seq: nonnegativeSafe }, ["ids"]),
  obj({ dataset_id: nonempty, snapshot_seq: nonnegativeSafe, ids: strings }, ["dataset_id", "snapshot_seq", "ids"]),
  { callers: OWNER_AGENT, label: "在确认消息已送达", description: "Confirm at most 24 owner's outgoing message ids against the authoritative ledger, independently of retained history pages. Does not send or execute anything." });
add("service:blobs", "read", "request", obj({ hash: sha, offset: nonnegativeSafe, limit: { type: "integer", minimum: 1, maximum: 200000 } }, ["hash"]),
  obj({ text: str, offset: nonnegativeSafe, next_offset: nullable(nonnegativeSafe), size: nonnegativeSafe, mime: str }, ["text", "size"]),
  { label: "在读附件", description: "Read a text attachment of a ledger message in pieces. You can read an attachment only when you may read the message that holds it." });
add("service:blobs", "get", "request", obj({ hash: sha }, ["hash"]), obj({ stream: nonempty, mime: nonempty, size: nonnegativeSafe }, ["stream", "mime", "size"]),
  { label: "在取附件", description: "Get a binary attachment (an image, a file) of a ledger message as a stream reference. You can get an attachment only when you may read the message that holds it." });

// ===================================================================================================================
// service:host: what the kernel asks of the system under it (ash-host/1)
// ===================================================================================================================
add("service:host", "wake.at", "request", obj({ at: nonnegativeSafe }, ["at"]), empty, { callers: KERNEL, effect: "act", label: "在设唤醒闹钟", description: "Ask the host to wake the device at a time (Unix ms); only the earliest one is kept." });
add("service:host", "wake.clear", "request", empty, empty, { callers: KERNEL, effect: "act", label: "在取消唤醒闹钟", description: "Cancel the host alarm." });
add("service:host", "power.hold", "request", obj({ ms: { type: "integer", minimum: 1, maximum: 600000 }, reason: nonempty }, ["ms", "reason"]), empty,
  { callers: KERNEL, effect: "act", label: "在保持唤醒", description: "Keep the device awake for a while (at most 10 minutes) for a stated reason; released by itself when the time is up." });
add("service:host", "power.release", "request", empty, empty, { callers: KERNEL, effect: "act", label: "在放开唤醒锁", description: "Release the wake lock before its time is up." });
add("service:host", "wake.fired", "event", obj({ at: nonnegativeSafe }, ["at"]), undefined,
  { callers: KERNEL, direction: "out", label: "在转达唤醒闹钟", description: "The host's alarm went off (the device woke): the host module passes it on to service:clock." });
add("service:host", "vscreen.state", "event", obj({ open: bool }, ["open"]), undefined,
  { callers: KERNEL, direction: "out", label: "在转达虚拟屏开关", description: "The virtual screen was made or closed: the host module passes it on to person:owner, whose screens show or hide the live preview (the human edge pushes it as present{status/vscreen})." });
add("service:host", "env.changed", "event", ENV_CHANGED, undefined,
  { callers: KERNEL, direction: "out", label: "在转达环境变化", description: "The network or the power state changed: the host module passes it on to service:agents and service:link (which reconnects the relay)." });
add("service:host", "restart", "request", obj({ reason: { type: "string", maxLength: 200 } }), obj({ restarting: { const: true } }, ["restarting"]),
  { effect: "act", risk: "structure", label: "在重启大脑", description: "Have the host restart the kernel: it is away for about ten seconds and what it was doing is cut off (the calling agent's turn too). The gate decides whether the owner is asked; an app puts the question on its own screen." });
add("service:host", "hands.handoff", "request", obj({ port: { type: "integer", minimum: 1, maximum: 65535 }, token: secret({ type: "string", minLength: 1 }) }, ["port", "token"]), obj({ delivered: strings }, ["delivered"]),
  { callers: KERNEL, effect: "act", label: "在交接本机的手", description: "Hand the local link port and token to the hands on this device (the phone app) so they connect. The token is held in memory and never written down." });
add("service:host", "update.install", "request", obj({ version: { type: "string", pattern: "^v?[0-9]+\\.[0-9]+\\.[0-9]+$" } }),
  obj({ started: bool, version: str, via: choice("shell", "installer"), packages: strings }, ["started", "version", "via"]),
  { callers: OWNER_AGENT, effect: "execute", risk: "structure", label: "在升级手机上的 Ash", description: "Update Ash on this phone to a release (both packages: the app, then the kernel; without version: the latest). The hub reads the release's SHA256SUMS on GitHub (a private repository with the vault's GITHUB_TOKEN); the host downloads each APK, checks it and only then installs it. It answers at once and works in the background: follow it with update.status. With the debug identity it installs by itself (via shell); without it the system installer asks the owner to tap 「安装」 in a notification, once per package (via installer). Installing the kernel restarts the hub: you come back on the new version. The gate decides whether the owner is asked." });
add("service:host", "update.status", "request", empty, obj({ state: str, version: str, message: str, at: nonnegativeSafe }, ["state"], true),
  { callers: OWNER_AGENT, label: "在看手机升级进度", description: "Where the phone's update is: idle, downloading, installing, waiting_user (the owner must tap the system's install confirmation), done or failed (message says why; nothing was installed when a download or checksum failed)." });
add("service:host", "ctx.list", "request", empty,
  obj({ probe: obj({ state: choice("running", "paused", "stopped"), since: nonnegativeSafe, last_exit: str }, ["state"]),
    days: { type: "array", items: obj({ day: str, files: { type: "array", items: obj({ file: choice(...CTX_FILES), bytes: nonnegativeSafe, lines: nonnegativeSafe, lines_estimated: bool, modified: nonnegativeSafe }, ["file", "bytes", "lines"]) } }, ["day", "files"]) } }, ["probe", "days"]),
  { callers: OWNER_AGENT, effect: "read", label: "在看手机上的使用记录", description: "What the phone's context probe has recorded, per day (YYYY-MM-DD, oldest first): each file with its size in bytes and line count (lines_estimated: guessed from the start of a big file), and whether the probe is recording now (running, paused by the owner, or stopped with last_exit saying why). The files are JSON lines: events (the owner's own actions: clicks, typing, scrolling, window changes, notifications), screens (the front window's text whenever it changed), touch (raw touches and keys), stats (what recording costs, every 10 minutes). Read one with ctx.read. Needs the phone's debug identity (「后台也能动手」); without it: unavailable." });
add("service:host", "ctx.read", "request",
  obj({ day: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, file: choice(...CTX_FILES), offset: nonnegativeSafe, limit: { type: "integer", minimum: 1, maximum: CTX_READ_MAX } }, ["day", "file"]),
  obj({ day: str, file: choice(...CTX_FILES), offset: nonnegativeSafe, next_offset: nonnegativeSafe, size: nonnegativeSafe, eof: bool, text: str }, ["day", "file", "offset", "next_offset", "size", "eof", "text"]),
  { callers: OWNER_AGENT, effect: "read", label: "在读手机上的使用记录", description: "Read a piece of one context-probe file (see ctx.list): day YYYY-MM-DD, file events | screens | touch | stats, from byte offset (default 0), at most limit bytes (default and most 262144). text is whole JSON lines (one longer than limit comes in pieces); go on from next_offset until eof. A file that is still being written can grow after eof: read again from next_offset later. Only these files can be read; there is no path." });

// ===================================================================================================================
// app:*: the one word the hub calls on every app
// ===================================================================================================================
add("app:*", "ash.on_event", "request", obj({ word: nonempty, body: any, from: id, at: nonnegativeSafe }, ["word", "from", "at"]), empty,
  { callers: KERNEL, effect: "act", label: "在把事件交给应用", description: "Deliver an event the app listens to (app.json `listens`). The hub calls this reserved tool; an app never sees it in its own list of tools." });


// ===================================================================================================================
// service:widgets: cards on the owner's home screen
// ===================================================================================================================
// Home-screen widgets: cards anyone may put on the owner's phone home screen, drawn natively from A2UI.
const widgetCardId: JsonSchema = { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" };
const widgetId: JsonSchema = { type: "string", minLength: 1, maxLength: 12 };
const widgetSize = choice("2x2", "4x2", "4x4");
const widgetCardInfo = obj({ id: widgetCardId, title: nonempty, size: widgetSize, owner: id, updated_at: nonnegativeSafe,
  expires_at: { anyOf: [nonnegativeSafe, { type: "null" }] }, expired: bool, actions: strings, problem: { anyOf: [str, { type: "null" }] } },
  ["id", "title", "size", "owner", "updated_at", "expires_at", "expired", "actions"]);
const placedWidget = obj({ id: widgetId, type: choice("ash", "card") }, ["id", "type"]);
/** The whole widget state, the same shape as the person:owner/widget.state event: cards (with their parsed a2ui), placed widgets, bindings, revision, preview requests. */
const widgetListResult = obj({ revision: nonnegativeSafe, cards: array({ ...widgetCardInfo, additionalProperties: true }), widgets: array(obj({ id: widgetId, type: choice("ash", "card"), card: { anyOf: [widgetCardId, { type: "null" }] } }, ["id", "type", "card"])),
  bindings: { type: "object" }, previews: { type: "object" } }, ["cards", "widgets"]);
const previewTheme = choice("dark", "light");
const previewSide: JsonSchema = { type: "integer", minimum: 1, maximum: 1200 };
const previewDp = obj({ width: num, height: num }, ["width", "height"]);
// What the phone reports for a card it was asked to draw as an image: the PNG (base64, a few hundred KB at most), or why not.
const widgetPreviewReport = obj({ png: { type: "string", minLength: 1, maxLength: 360000 }, width: previewSide, height: previewSide, theme: previewTheme, dp: previewDp }, ["png", "width", "height", "theme"]);
const widgetRendered = obj({ card: widgetCardId, updated_at: nonnegativeSafe, problem: str, preview: widgetPreviewReport, preview_problem: str, preview_ask: nonnegativeSafe }, ["card", "updated_at"]);
// The card as the phone draws it: an image part, which the agent receives as a picture it can see.
const widgetPreviewImage = obj({ type: { const: "image" }, data: str, mimeType: { const: "image/png" }, width: previewSide, height: previewSide, theme: previewTheme,
  size: widgetSize, layout_dp: previewDp, drawn_at: nonnegativeSafe }, ["type", "data", "mimeType", "width", "height", "theme", "size", "drawn_at"]);
export const WIDGET_A2UI_GUIDE = "a2ui is A2UI v0.9 (basic catalog) as a flat component list: {components:[{id, component, ...}], root?:'root', data?:{...}, sizes?, theme?:{primaryColor}}. " +
  "Anything Android widgets can draw is allowed; what they cannot is refused with the reason. No limit on nesting style, number of buttons or text lines except Android's own (about 10 nested levels; a scrolling List's items get their own budget). " +
  "Components: Text {text, variant: h1..h5|body|caption} — text keeps line breaks and emoji, and simple Markdown (**bold**, *italic*, `code`, ~~strike~~, [link](url), # heading, - list) is drawn as formatting, never shown raw. " +
  "Row/Column {children, justify: start|center|end|spaceBetween|spaceAround|spaceEvenly|stretch, align: start|center|end|stretch}; Stack {children, align} (children overlap; a child's style.place: topStart..bottomEnd); Grid {children, columns}; Card {child}; " +
  "List {children, columns?} scrolls vertically when longer than the widget (horizontal lists are impossible; at most 16 Lists per layout); Tabs {tabs:[{title, child}], selected?} (switches on the phone); Spacer {size?} (flexible when no size); Divider {axis}; " +
  "Image {url, fit: contain|cover|fill|none|scaleDown, variant: icon|avatar|smallFeature|mediumFeature|largeFeature|header} with url https://… or data:image/png|jpeg|webp|gif;base64,… (the phone fetches, downsizes and caches; no SVG), 'avatar' / 'avatar:<face>' (Ash), 'icon:<name>'; " +
  "Icon {name: an A2UI icon name (check, close, star, favorite, home, settings, refresh, add, delete, edit, mail, phone, person, search, share, warning, info, …) or Ash's sun, cloud, rain, snow, wind, moon, heart, steps, weight, sleep, water, fire, calendar, clock, alert, bell, car, money, chart; or {svgPath}}; " +
  "Button {child: any component id, variant: default|primary|borderless, action}; CheckBox / Switch {label, value: bool or {path}}; ChoicePicker {options:[{label, value}], value:[...] or {path}, variant: mutuallyExclusive|multipleSelection, displayStyle: checkbox|chips}; " +
  "ProgressBar {value, max?: 100, label?}; Badge {text}; Clock {format?, timeZone?} (live); Timer {since | until: epoch ms} (live count up/down); " +
  "Chart {series:[1-4 of {type: line|bars, values: 1-240 numbers, color, fill?, width?, dot?, max?, floor?, highlight?: {from, to?, color}, colors?: {\"<bar index>\": colour}, lastColor?, limit?, limitColor?}], gap?} (at most 600 values; style.height in dp is required; the phone draws it as a bitmap of the size it is given, in the colours of the phone's mode). " +
  "Not drawable in a widget (refused): Video, AudioPlayer, TextField, DateTimeInput, Slider, Modal, web pages, scripts, animation. " +
  "Every component may have: weight (share of the free space in a Row/Column), visible (bool or {path}), accessibility {label}, action, and style {background, color (text/icon/tint; inherited by children), cornerRadius, padding, margin, width, height (dp | 'fill' | 'wrap'), fontSize (sp), fontWeight (normal|medium|bold|100-900), italic, underline, strikethrough, textAlign, maxLines, ellipsize (end|start|middle|none), lineHeight, letterSpacing, opacity}. " +
  "Colours: '#RRGGBB', '#RRGGBBAA' (alpha last, e.g. '#000000B3' translucent dark), theme names text, textSecondary, accent, onAccent, background, surface, surfaceVariant, line, transparent, translucentDark, translucentLight, white, black, red, orange, yellow, green, teal, blue, purple, pink, gray (these follow the phone's dark mode), or {light, dark}. " +
  "A background on the root replaces the widget's own background (and its title). " +
  "Actions (any element; in a List each item is tappable): {event:{name, context?}} — sent back to you as widget.action with the item key, checked state or chosen values; " +
  "{openApp:{app, surface?}} or {functionCall:{call:'openUrl', args:{url:'ui://<app>/<surface>'}}} — opens that app's page in 「Ash 应用」; {openAsh:{}}; openUrl with https/mailto/tel/geo. A CheckBox/Switch/ChoicePicker whose value is {path} writes the owner's choice back into the card's data. " +
  "Values may be literals, {path:'/a/b'} into data (relative paths inside templates), or A2UI functions {call: formatString ('${/a} ${b}') | formatNumber | formatCurrency | formatDate | pluralize | and | or | not, args}. " +
  "children may be a template {componentId, path:'/items'}: one copy per array element, with paths relative to the element (its id or key field is the item key in widget.action). " +
  "sizes: [{width, height (dp), root}] gives other layouts for other widget sizes. " +
  "Example: {components:[{id:'root',component:'Column',style:{background:'translucentDark',color:'white',padding:14},children:['t','l']},{id:'t',component:'Text',text:'**待办**',variant:'h3'}," +
  "{id:'l',component:'List',children:{componentId:'row',path:'/todo'}},{id:'row',component:'CheckBox',label:{path:'title'},value:{path:'done'},action:{event:{name:'toggle'}}}],data:{todo:[{id:'a',title:'买菜',done:false}]}}";
add("service:widgets", "widget.list", "request", empty, widgetListResult,
  { label: "在看桌面小组件", effect: "read", description: "What is on the owner's phone home screen: each placed widget (the 'ash' widget, or an 'Ash 卡片' card widget with the card it shows), and every card that exists with its owner, size, expiry, event action names and the phone's last problem drawing it (null when it drew fine or has not reported)." });
add("service:widgets", "widget.card.put", "request", obj({ id: { type: "string", minLength: 1, maxLength: 64 }, title: str, size: widgetSize,
  a2ui: obj({}, [], true), ttl_min: { type: "integer", minimum: 1, maximum: 43200 } }, ["id", "title", "size", "a2ui"]),
  obj({ card: widgetCardInfo, bound_widgets: array(widgetId), phone: choice("drawn", "problem", "unknown"), problem: str, preview: widgetPreviewImage, preview_problem: str }, ["card", "bound_widgets"]),
  { label: "在更新桌面卡片", effect: "write", description: "Create or replace (same id) a card the owner can place on the phone home screen with the 'Ash 卡片' widget; widgets already showing it redraw. " +
    "When the data belongs to an app (a todo list, health numbers…), use that app's own card instead (owner app:<id> in widget.list, drawn from the app's data and kept current; the owner places it on the home screen) — a copy of its data here goes stale. " +
    "id: lowercase letters, digits, . _ - (at most 64); title: at most 40 characters. The card belongs to whoever created it: only its creator or the owner may replace or remove it. size is the intended widget size (2x2 small, 4x2 wide, 4x4 large). " +
    "ttl_min: after this many minutes the card shows as expired until updated. Invalid cards are refused with the component, property and reason. " +
    "The result says whether the phone drew it (phone: drawn), could not (phone: problem, with problem), or did not answer in time (unknown); a later problem (e.g. an image that failed to load) reaches you as widget.problem. " +
    "When the phone can draw it, the result also carries a preview image of the card as the home screen shows it (at the widget's size, in the phone's current dark or light theme): look at it, and fix cut-off text, overflow and empty lists before telling the owner it is done. widget.card.preview shows it again later. " + WIDGET_A2UI_GUIDE });
add("service:widgets", "widget.card.preview", "request", obj({ id: widgetCardId }, ["id"]),
  obj({ card: widgetCardInfo, preview: widgetPreviewImage, preview_problem: str, fresh: bool, note: str }, ["card", "fresh"]),
  { label: "在看桌面卡片的样子", effect: "read", description: "Look at a card again: the phone draws it as the home-screen widget would (its size on this phone, in the current dark or light theme) and returns the picture as an image you can see, or says why it cannot. Use it after the owner changes theme, after an app's card refreshed, or to check a card you did not just put. fresh: false means the phone did not answer in time and the image is the last one it drew." });
add("service:widgets", "widget.card.get", "request", obj({ id: widgetCardId }, ["id"]),
  obj({ card: widgetCardInfo, a2ui: obj({}, [], true), feedback: array(obj({ ts: nonnegativeSafe, feedback: nonempty, action: nonempty, card_updated_at: nonnegativeSafe, component: str, item: str },
    ["ts", "feedback", "action", "card_updated_at"])), preview: widgetPreviewImage, preview_problem: str, note: str }, ["card", "a2ui", "feedback"]),
  { label: "在看桌面卡片的内容", effect: "read", description: "Read one card back: what it says (its a2ui as it was put), size, owner, last update, the owner's answers recorded on it (feedback: what a feedback button said and when; card_updated_at tells which version of the card was answered), and the picture of how the home screen shows it now (the same image as widget.card.preview; preview_problem says why there is none). Use it to see what you showed before and how it was received; widget.list only gives titles." });
add("service:widgets", "widget.card.validate", "request", obj({ a2ui: obj({}, [], true), surface: choice("widget", "chat") }, ["a2ui"]),
  obj({ valid: bool, problem: str, problems: strings, components: { type: "integer", minimum: 0 }, levels: { type: "integer", minimum: 0 }, actions: strings }, ["valid"]),
  { label: "在检查卡片", effect: "read", description: "Check a card's a2ui without saving or showing anything. surface widget (default): exactly as widget.card.put would — valid, or the problem (which component, which property, why); levels is how deep it nests against Android's limit. surface chat: as person:owner/show would — valid unless nothing can be drawn, and problems lists what would be left out." });
add("service:widgets", "widget.card.remove", "request", obj({ id: widgetCardId }, ["id"]), obj({ removed: bool }, ["removed"]),
  { label: "在移除桌面卡片", effect: "write", description: "Remove a card (yours, or any other that is stale). Widgets that showed it ask the owner to pick another card." });
add("service:widgets", "widget.tap", "request", obj({ card: widgetCardId, action: { type: "string", minLength: 1, maxLength: 64 }, component: { type: "string", minLength: 1, maxLength: 200 },
  checked: bool, value: { type: "array", items: str, maxItems: 100 } }, ["card"]), accepted,
  { callers: OWNER, label: "在转达小组件上的点击", effect: "write", description: "The owner tapped, toggled or chose something on a card (sent from the phone as the owner). Owner only; the card's creator is then told by widget.action." });
add("service:widgets", "widget.placed", "event", obj({ widgets: { type: "array", items: placedWidget, maxItems: 64 } }, ["widgets"]), undefined,
  { direction: "in", label: "在记下放好的小组件", description: "The phone reports which Ash widgets are on its home screen. Sent by the hands module from the hand's event; not recorded." });
add("service:widgets", "widget.bind", "event", obj({ widget: widgetId, card: widgetCardId }, ["widget", "card"]), undefined,
  { direction: "in", label: "在记下小组件选的卡片", description: "The owner picked which card one placed 'Ash 卡片' widget shows. Sent by the hands module from the hand's event; not recorded." });
const WIDGET_RENDERED = obj({
  widgets: { type: "array", items: placedWidget, maxItems: 64 }, rendered: { type: "array", items: widgetRendered, maxItems: 200 },
}, ["rendered"]);
add("service:widgets", "widget.rendered", "event", WIDGET_RENDERED, undefined,
  { direction: "in", label: "在记下卡片画出来没有", description: "What a channel reports after being asked to show widget state: which widgets are placed and which cards it drew, with the problem or a preview picture. Turned from the channel's present result by the human module; not recorded." });
// Events declared by their senders too (the router lets a member send the events its own words() declare, HUB-MODULES §1.4).
add("person:owner", "typing", "event", empty, undefined,
  { callers: KERNEL, direction: "out", label: "在等你说完", description: "The human module tells an agent the owner is composing a message to it." });
add("person:owner", "widget.rendered", "event", WIDGET_RENDERED, undefined,
  { callers: KERNEL, direction: "out", label: "在记下卡片画出来没有", description: "The human module passes on what a channel reported after showing widget state, for service:widgets." });
add("service:agents", "usage.recorded", "event", USAGE_RECORDED, undefined,
  { callers: KERNEL, direction: "out", label: "在记下用量", description: "An agent driver's model usage, passed to service:cost." });
add("service:llm", "usage.recorded", "event", USAGE_RECORDED, undefined,
  { callers: KERNEL, direction: "out", label: "在记下用量", description: "One call of the hub's small model (the approval review, JEV, the progress summary, service:llm/complete), passed to service:cost under the caller's name." });
add("service:widgets", "widget.action", "event", obj({ card: widgetCardId, action: nonempty, owner: id, title: str, component: str, item: str, checked: bool, value: strings,
  context: obj({}, [], true) }, ["card", "action", "owner"]), undefined,
  { direction: "out", label: "在转达小组件上的点击", description: "The owner tapped, toggled or chose something on a home-screen card. owner is the card's creator, who decides what it means; component is the element, item the list item's key, checked / value the new state. " +
    "On an app's card (owner app:<id>) the tap goes to the app's own action tool, which changes the app's data; otherwise the tap itself does nothing else." });
add("person:owner", "widget.preview", "request", obj({ card: nonempty, size: choice("2x2", "4x2", "4x4") }, ["card"]), obj({}, [], true),
  { callers: KERNEL, effect: "read", label: "在画卡片预览", description: "Ask a channel that shows widgets to draw a card and return the picture (an image part), for service:widgets." });
add("service:widgets", "widget.state", "event", obj({}, [], true), undefined,
  { callers: KERNEL, direction: "out", label: "在更新桌面卡片", description: "The home-screen cards changed: the whole state for the channels that show widgets (the human edge pushes it as present{widget}). A channel that just connected gets the current state from service:widgets/widget.list." });
add("service:widgets", "widget.problem", "event", obj({ card: widgetCardId, owner: id, title: str, problem: nonempty }, ["card", "owner", "problem"]), undefined,
  { direction: "out", label: "在转达卡片画不出来", description: "The phone could not fully draw a home-screen card (problem says what and why); the card's creator should fix it." });

// ===================================================================================================================
// service:pulse: Ash's own card, the window through which it speaks first
// ===================================================================================================================
// Pulse: Ash's own home-screen card as the window through which it speaks first. Only exists while an "Ash 卡片" widget is placed.
const pulseClock: JsonSchema = { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" };
const pulseDays: JsonSchema = { anyOf: [choice("daily", "weekdays", "weekends"), { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, minItems: 1, maxItems: 7 }] };
const pulseSlot = obj({ time: { anyOf: [pulseClock, obj({ at: positiveSafe }, ["at"])] }, days: pulseDays }, ["time"]);
const pulseNoteKind = choice("pulse", "gap");
const pulseEntry = obj({ id: positiveSafe, ts: nonnegativeSafe, kind: nonempty }, ["id", "ts", "kind"], true);
add("service:pulse", "pulse.get", "request", empty,
  obj({ active: bool, reason: str, enabled: bool, schedule: array(obj({}, [], true)),
    budget: obj({ per_day: positiveSafe, today_count: nonnegativeSafe, left: nonnegativeSafe }, ["per_day", "today_count", "left"]),
    next_wakes: array(nonnegativeSafe), history: array(pulseEntry), gaps: array(pulseEntry) }, ["active", "enabled", "schedule", "budget", "history"], true),
  { label: "在看主动更新的安排", effect: "read", description: "Your pulse: whether it is active (it exists only while an 'Ash 卡片' widget is on the home screen; otherwise active:false, reason:'no widget'), whether the owner has it switched on, your wake schedule, today's wake count against the daily budget, the next scheduled wakes, the latest history entries and gaps you noted." });
add("service:pulse", "pulse.set", "request", obj({ schedule: { type: "array", items: pulseSlot, maxItems: 48 },
    reason: { type: "string", minLength: 1, maxLength: 500 } }, ["reason"]),
  obj({ changed: strings, next_wakes: array(nonnegativeSafe) }, ["changed"], true),
  { label: "在改主动更新的安排", effect: "write", description: "Change your own pulse and say why (reason is required and is kept in the history). Schedule (list of {time:'HH:MM' local, days:'daily'|'weekdays'|'weekends'|[0..6 with 0 = Sunday]} or {time:{at: epoch ms}} for one moment; replaces the whole list; the next 48 hours become real timers). Other fields are refused. PULSE.md, the file that tells you how to use each wake, is in your home folder: edit it there yourself." });
add("service:pulse", "pulse.history", "request", obj({ limit: { type: "integer", minimum: 1, maximum: 100 }, before: positiveSafe }),
  obj({ entries: array(pulseEntry), next_before: positiveSafe }, ["entries"]),
  { label: "在看主动更新的记录", effect: "read", description: "Page through your pulse history, newest first: wakes (why, when), what you did (pulse.note), the owner's feedback on your cards, changes to the schedule with their reasons, skipped wakes and why. limit (default 20), before: an entry id from next_before to read older ones." });
add("service:pulse", "pulse.note", "request", obj({ did: nonempty, why: str, kind: pulseNoteKind, data_used: array(nonempty) }, ["did"]),
  obj({ recorded: bool, id: positiveSafe }, ["recorded", "id"]),
  { label: "在记下这次做了什么", effect: "write", description: "Record what you did on this wake and why (did, why, data_used: what you looked at). kind: pulse (default) for an ordinary wake, gap for something you wanted to know or do but could not get; gaps are collected so the missing source can be added. Nothing here ever reaches the owner." });
add("service:pulse", "pulse.fire", "request", empty,
  obj({ fired: bool, reason: str }, ["fired"]),
  { label: "在试一次主动更新", effect: "write", description: "Wake yourself now as a pulse to try your schedule and cards; it does not use the daily budget. Needs the pulse to be active and switched on." });
add("service:pulse", "pulse.switch", "request", obj({ enabled: bool }, ["enabled"]), obj({ enabled: bool }, ["enabled"]),
  { callers: OWNER_AGENT, label: "在开关主动更新", effect: "write", description: "Switch the whole pulse on or off (an agent does it when the owner says so). Off keeps PULSE.md, history and feedback." });
add("service:pulse", "pulse.due", "request", obj({ kind: choice("wake", "daily", "reload"), at: nonnegativeSafe }, ["kind", "at"]), accepted,
  { callers: KERNEL, label: "在响应到点的主动更新", effect: "write", description: "Internal: the clock reports one of the semantic layer's own timers: wake (an hourly pulse), daily (the evening look back at the day) or reload (the daily new session). The hub itself calls this; nobody else." });

// ===================================================================================================================
// service:apps: independent apps (contract ash-app/1)
// ===================================================================================================================
// Independent apps (contract ash-app/1): discovery, install with the owner's approval of what an app needs, and grants.
const appId: JsonSchema = { type: "string", pattern: APP_NAME_PATTERN };
const appInfo = obj({ id: appId, name: str, version: str, summary: str, role: str, publisher: str, enabled: bool, granted: bool, running: bool,
  kind: choice("system", "app"), ui: choice("native", "web"), icon: str,
  needs: array(obj({}, [], true)), surfaces: array(obj({}, [], true)), events: strings, tools: strings, error: str, badge: choice("warn", "err", "paused"),
  cards: array(obj({ id: str, title: str, size: str, card: widgetCardId, problem: str }, ["id", "title", "size", "card"])) }, ["id", "name", "version", "enabled", "granted", "running"], true);
add("service:apps", "apps.list", "request", empty, obj({ apps: array(appInfo) }, ["apps"]),
  { label: "在看有哪些应用", description: "The system apps that come with Ash (kind system, a native screen on the phone; person:owner/open {app} opens one), then every app found in the container (/root/apps/<id>/app.json): name, version, whether the owner installed (granted) it and whether it is running. " +
    "An installed app whose folder is gone is listed too (error says so); apps.remove or apps.revoke clears it." });
add("service:apps", "apps.describe", "request", obj({ id: appId }, ["id"]), appInfo,
  { label: "在看应用详情", description: "One app: what it needs from ash (needs), its screens (surfaces), events and tools." });
add("service:apps", "apps.install", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "execute", label: "在安装应用", description: "Install an app from /root/apps/<id>/ (ash's own, or one you wrote): it is checked first as apps.validate does, " +
    "and a failing app is refused with the problems (error.detail.problems) before anyone is asked. Then the owner approves, on one card, everything it needs (needs); " +
    "an app you wrote is shown as written by you, not published. Then its grants are stored and it starts as member app:<id>. Installing again after editing restarts it with the new files." });
add("service:apps", "apps.enable", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "execute", label: "在重新启用应用", description: "Start an installed app that was turned off, within the grants the owner already gave. An agent's request asks the owner." });
add("service:apps", "apps.disable", "request", obj({ id: appId }, ["id"]), appInfo,
  { risk: "structure", effect: "write", label: "在停用应用", description: "Stop an app; its grants are kept so it can be turned on again." });
add("service:apps", "apps.revoke", "request", obj({ id: appId, need: nonempty }, ["id"]), appInfo,
  { risk: "structure", effect: "write", label: "在收回应用的权限", description: "Take back one need (need: a member id such as device:<hand_id>, or notify / widgets / card), or every grant when need is left out, which stops the app. Works on an installed app whose folder is gone too." });
add("service:apps", "apps.refresh", "request", empty, obj({ apps: array(appInfo) }, ["apps"]),
  { label: "在查找新应用", description: "Read /root/apps again: new apps appear, removed ones stop." });
// Running apps: restart after editing, read what the server said, clear its data, remove it. No approval: they stay
// within what the owner already granted, or narrow it.
add("service:apps", "apps.badge", "request", obj({ tone: choice("ok", "warn", "err", "paused") }, ["tone"]), obj({ tone: choice("ok", "warn", "err", "paused") }, ["tone"]),
  { callers: ["app"], effect: "write", label: "在亮应用的小点", description: "An app says how it is, for the dot on its icon in the app grid: ok (no dot), warn, err or paused. Only about itself; it shows while the app runs and is asked again by the app when it starts." });
add("service:apps", "apps.sleep", "request", obj({ id: appId }, ["id"]), obj({ id: appId, sleeping: bool }, ["id", "sleeping"]),
  { callers: OWNER_AGENT, effect: "write", risk: "structure", label: "在让应用休眠", description: "Stop an app's server for now without turning the app off: nothing it serves is lost, and the first call to one of its words (or apps.wake) starts it again; while it sleeps it hears no events (an alert it would raise does not come), so the gate decides whether the owner is asked. service:cards does this for a temporary app whose cards are all asleep." });
add("service:apps", "apps.wake", "request", obj({ id: appId }, ["id"]), obj({ id: appId, running: bool }, ["id", "running"]),
  { effect: "write", label: "在唤醒应用", description: "Start an app put to sleep with apps.sleep (an app that is turned off stays off: apps.enable)." });
add("service:apps", "apps.restart", "request", obj({ id: appId }, ["id"]), obj({ id: appId, running: bool, problems: array(obj({}, [], true)) }, ["id", "running"], true),
  { effect: "act", label: "在重启应用", description: "Restart an installed app's server so edits to its files (server.mjs, tools, app.json cards) take effect. It is checked first as apps.validate does: " +
    "a failing app is not restarted and the problems come back (error.detail.problems). If app.json's needs changed, use apps.install instead (the owner approves them). Pages need no restart." });
add("service:apps", "apps.logs", "request", obj({ id: appId, lines: { type: "integer", minimum: 1, maximum: 400 } }, ["id"]),
  obj({ id: appId, running: bool, lines: strings, last_exit: { anyOf: [obj({ ts: nonnegativeSafe, code: { anyOf: [{ type: "integer" }, { type: "null" }] }, signal: { anyOf: [str, { type: "null" }] }, reason: str }, ["ts", "reason"], true), { type: "null" }] }, error: str },
    ["id", "running", "lines", "last_exit"]),
  { label: "在看应用日志", description: "An app's recent output: what its server wrote to stderr, protocol errors (anything but MCP on stdout), and Ash's notes on starts, exits and restarts (newest last, default 100 lines, at most 400). " +
    "last_exit says how the server last ended (exit code or signal); error is why it is not running, if Ash knows." });
add("service:apps", "apps.reset", "request", obj({ id: appId }, ["id"]), obj({ id: appId, cleared: str }, ["id", "cleared"], true),
  { effect: "write", label: "在清空应用数据", description: "Empty the app's data folder (app.json data_dir, e.g. /root/apps/<id>/data) and restart it, so it starts over with no data; its cards redraw. " +
    "Only for an app that declares data_dir. The owner's data is gone afterwards: do it only when the owner wants it, or for an app you are still building." });
add("service:apps", "apps.remove", "request", obj({ id: appId, keep_data: bool }, ["id"]), obj({ id: appId, removed: bool, kept: { anyOf: [str, { type: "null" }] } }, ["id", "removed", "kept"]),
  { effect: "write", label: "在卸载应用", description: "Uninstall an app: stop it, drop everything the owner granted it and its home-screen cards, and delete its folder /root/apps/<id>/. " +
    "keep_data: true keeps the folder (its data and files) so it can be installed again as it was. Ash's own apps cannot be removed (they come back): disable them instead. An installed app whose folder is already gone is removed from the records (and its timers cleared); there is no folder to delete." });
// Writing apps: the contract to read, a skeleton to start from, and a check that says exactly what is wrong.
const appProblem = obj({ level: choice("error", "warning"), where: str, problem: str, fix: str }, ["level", "where", "problem"]);
const appTool = obj({ name: { type: "string", pattern: TOOL_NAME_PATTERN }, title: { type: "string", minLength: 1, maxLength: 60 },
  description: { type: "string", minLength: 1, maxLength: 2000 }, read_only: bool }, ["name"]);
const surfaceId: JsonSchema = { type: "string", pattern: SURFACE_ID_PATTERN };
const appSurface = obj({ id: surfaceId, title: { type: "string", minLength: 1, maxLength: 20 } }, ["id", "title"]);
add("service:apps", "apps.contract", "request", empty,
  obj({ contract: str, doc: str, doc_path: str, schema: obj({}, [], true), example: obj({ path: str, files: obj({}, [], true) }, ["path", "files"]) }, ["contract", "doc", "schema", "example"], true),
  { label: "在看应用契约", description: "The ash-app/1 contract for writing an app, in full (doc, markdown): app.json fields, how ash starts the server and talks to it, " +
    "pages (ui:// resources), tools, needs, events, listens. Also the app.json JSON Schema and a small runnable example app (hello: a list with one page and four tools, the same skeleton apps.scaffold writes) with its files. " +
    "The same doc and example are in the container at doc_path and example.path." });
add("service:apps", "apps.scaffold", "request", obj({ id: appId, name: { type: "string", minLength: 1, maxLength: 40 }, summary: { type: "string", minLength: 1, maxLength: 200 },
  role: { type: "string", minLength: 1, maxLength: 200 },
  surfaces: { type: "array", items: appSurface, minItems: 1, maxItems: 16 }, tools: { type: "array", items: appTool, minItems: 1, maxItems: 32 } }, ["id", "name"]),
  obj({ id: appId, path: str, files: strings, next: str }, ["id", "path", "files", "next"], true),
  { effect: "write", label: "在写应用骨架", description: "Write a new app's skeleton into /root/apps/<id>/ (app.json, a dependency-free server.mjs, one ui/<page>.html per surface, " +
    "shared ui/app.css and ui/app.js, an empty data/ folder). It runs as it is: a small working list in data/data.json with tools <id>.list, <id>.add, <id>.done (mark done/undone), <id>.remove, " +
    "and a first page with the list and done/undone toggles. " +
    "Change them to what the app is about; tools you name besides those answer with a placeholder until you write them in server.mjs. " +
    "role (default: summary) says what the app is for and when to use it; you and Ash see it in every conversation. " +
    "surfaces default to one page home: give the app tools that read and change its data, " +
    "so you can do through them everything the owner does on its pages. Refuses a folder that already has an app.json. " +
    "No approval is needed: it only writes files. Then edit, apps.validate, and apps.install (the owner approves what it needs)." });
add("service:apps", "apps.validate", "request", obj({ id: appId, path: { type: "string", minLength: 1, maxLength: 300 } }),
  obj({ id: str, path: str, ok: bool, problems: array(appProblem), tools: strings, surfaces: strings }, ["path", "ok", "problems", "tools", "surfaces"], true),
  { label: "在检查应用", description: "Check an app folder the way install will: app.json against the contract (each missing or wrong field by its path), " +
    "the icon file, then a trial start of its server (it must start and speak MCP over stdio), its tools (names, input schemas) and every page " +
    "(each surface's ui:// resource must be served as HTML). Give id (the folder /root/apps/<id>) or path (/root/apps/<folder>). " +
    "ok is true when nothing would stop it from installing and opening; warnings are worth fixing but do not block. Nothing is installed or changed." });

add("service:apps", "apps.surface", "request", obj({ id: appId, surface: surfaceId }, ["id", "surface"]),
  obj({ id: appId, surface: str, mime: nonempty, html: str,
    csp: obj({ connectDomains: strings, resourceDomains: strings }, ["connectDomains", "resourceDomains"]) }, ["id", "surface", "mime"]),
  { label: "在取应用页面", description: "The page resource of one of an app's surfaces (the ui:// resource its app.json lists), for a channel to show; csp lists the domains the page declared it may connect to and load from. Pages talk to the app through the bridge, not through this word." });
add("service:apps", "apps.icon", "request", obj({ id: appId }, ["id"]), obj({ id: appId, mime: nonempty, data: str }, ["id", "mime", "data"]),
  { label: "在取应用图标", description: "The icon file of an app (base64 in data), for a channel to show in its list of apps. An app with no icon, or whose icon file is gone, gets Ash's default PNG icon instead of an error." });

// ===================================================================================================================
// the list
// ===================================================================================================================
/** Every service word, owner word, agent word and event, in the order written above. */
export const WORD_CONTRACTS: readonly WordContract[] = Object.freeze(entries.map((entry) => Object.freeze(entry)));

/** The member a concrete id belongs to in the list: every agent id is `agent:*`, every app `app:*`. */
const contractMember = (member: string): string => (AGENT_ID.test(member) ? "agent:*" : member.startsWith("app:") ? "app:*" : member);

/** The contract of a word on a member (an agent id finds the `agent:*` words). */
export function wordContract(member: string, word: string): WordContract | undefined {
  const key = contractMember(member);
  return WORD_CONTRACTS.find((item) => item.member === key && item.word === word);
}
/** All words of one member (use the id, or the starred form). */
export const wordsOf = (member: string): WordContract[] => WORD_CONTRACTS.filter((item) => item.member === contractMember(member));
/** The services that have words, in the order they are written in this file. */
export const SERVICE_NAMES: readonly string[] = Object.freeze([...new Set(WORD_CONTRACTS.map((item) => item.member).filter((member) => member.startsWith("service:")))]);
