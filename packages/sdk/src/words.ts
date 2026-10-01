import type { Card, JsonSchema, WordSpec } from "./api";
import { matchesSchema } from "./schema";

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
const deliveryDedupeKey: JsonSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
const empty = obj();
const accepted = obj({ accepted: bool }, ["accepted"]);
const attachmentInput = obj({ name: nonempty, mime_type: nonempty, data: nonempty }, ["name", "mime_type", "data"]);
const sayExtras = { attachments: array(attachmentInput), in_reply_to: id, option_id: id };
const askChoice = choice("once", "always", "deny");
const askOption = obj({ id: askChoice, label: nonempty }, ["id", "label"]);
const origin = obj({ screen: nonempty, label: str }, ["screen", "label"]);
const cardOption = obj({ id: nonempty, text: nonempty }, ["id", "text"]);
export const CARD_SCHEMA: JsonSchema = { oneOf: [
  obj({ type: { const: "options" }, prompt: str, options: { type: "array", items: cardOption, minItems: 1 }, allow_custom: bool }, ["type", "options"]),
  obj({ type: { const: "file" }, workspace: nonempty, path: nonempty, name: nonempty, mime_type: nonempty, size: { type: "integer", minimum: 0 } }, ["type", "workspace", "path", "name", "mime_type", "size"]),
  obj({ type: { const: "image" }, workspace: nonempty, path: nonempty, alt: str }, ["type", "workspace", "path"]),
  obj({ type: { const: "link" }, url: nonempty, title: nonempty, summary: str }, ["type", "url", "title"]),
  obj({ type: { const: "permission" }, permission: nonempty, why: nonempty }, ["type", "permission", "why"]),
] };
const sha = { type: "string", pattern: "^[0-9a-f]{64}$" } as const satisfies JsonSchema;
const positiveSafe: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegativeSafe: JsonSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const datePath = { type: "string", pattern: "^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$" } as const satisfies JsonSchema;
const selfPath = { type: "string", pattern: "^(SOUL|IDENTITY|USER|MEMORY|HEARTBEAT|PROACTIVE)\\.md$|^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$" } as const satisfies JsonSchema;
const edit = obj({ op: choice("replace", "delete", "insert_after"), start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 }, guard: str, text: str, reason: choice("promote", "correct", "complete", "expire", "dedupe", "condense", "demote"), evidence: strings }, ["op", "start", "end", "guard", "reason", "evidence"]);
const claim = obj({ text: nonempty, type: choice("fact", "preference", "relationship", "event", "boundary", "correction"), salience: choice("low", "medium", "high"), evidence: strings, quote: str, supersedes: str, valid_until: str }, ["text", "type", "salience", "evidence"]);
const message = obj({ seq: integer, id, ts: num, from: id, to: { anyOf: [str, { type: "null" }] }, kind: choice("request", "response", "event"), word: id, body: obj({}, [], true), reply_to: str, origin, turn: str }, ["seq", "id", "ts", "from", "to", "kind", "word", "body"]);
const noChange = obj({ no_change: obj({ checked: strings, details: str }, ["checked", "details"]) }, ["no_change"]);
const workerResult = (normal: JsonSchema): JsonSchema => ({ oneOf: [normal, noChange] });

const entries: WordContract[] = [];
const guidance: Record<string, string> = {
  "agent:main/say": "Use to tell the agent something or answer an active option card. It acknowledges receipt immediately; read later conversation messages for the answer.",
  "person:owner/say": "Use to reply or offer a heads-up to the owner. This records immediately; it does not wait for a response or replace ask.",
  "person:owner/react": "Use for a brief reaction to a known message. Do not use for a new explanation; send say instead.",
  "person:owner/show": "Use to present a file, image, link, permission, or choices. Showing choices does not itself authorize an action.",
  "person:owner/ask": "Use when the owner must choose before an action continues. It waits for the first valid unexpired answer; do not treat mere presentation as consent.",
  "screen:*/ui.open": "Use to ask a named screen to show a view. A suggested opening may be declined; check opened in the response.",
  "service:clock/set": "Use for a future or repeating message, not for immediate delivery. Record the returned timer id for cancellation.",
  "service:clock/cancel": "Use to cancel a known timer id; check cancelled because the timer may already have fired.",
  "service:clock/list": "Use to inspect active timers before changing them; the result is a snapshot.",
  "service:gate/rules.list": "Use to inspect current approval rules, not to assume a risky action is already allowed.",
  "service:gate/rules.revoke": "Use to remove a known rule with local owner authority; this changes future decisions, not past actions.",
  "service:gate/history": "Use to review earlier gate decisions; this is read-only.",
  "service:gate/access.list": "Inspect device access grants; access alone never approves a protected action.",
  "service:gate/access.grant": "As the local owner, grant one exact agent and device capability for 30 days; risk approval remains separate.",
  "service:gate/access.revoke": "As the local owner, revoke one device access grant; already executed actions cannot be undone.",
  "service:self/read": "Use to read an allowed managed file and its hash before editing. Do not infer a stable baseline from stale conversation context.",
  "service:self/write": "Use for a complete managed-file replacement with the exact baseline hash; null creates only a missing file. Do not use native file tools for managed writes.",
  "service:self/append": "Use to atomically add text to an allowed dated log, including an older date. No baseline hash is required.",
  "service:self/apply_plan": "Use for guarded line edits against a saved baseline hash. A stale hash or guard rejects the whole batch; reread before retrying.",
  "service:self/rollback": "Use to restore a known snapshot when a prior change was wrong; this changes the managed file.",
  "service:self/history": "Use to inspect available managed-file snapshots before choosing a rollback target.",
  "service:work/run": "Use for an authorized manual background-flow trigger, not for a conversational answer. Follow its run id for outcome.",
  "service:work/runs": "Use to inspect recent background runs; this does not start a run.",
};
function add(member: string, word: string, kind: "request" | "event", input_schema: JsonSchema, result_schema?: JsonSchema, options: Partial<Pick<WordSpec, "risk" | "label" | "audience" | "timeout_ms">> & { direction?: "in" | "out"; description?: string } = {}) {
  entries.push({ member, word, kind, description: options.description ?? guidance[`${member}/${word}`] ?? (kind === "event" ? `Status event ${word} from ${member}; observe rather than call it.` : `Use ${word} on ${member} for the declared input only; inspect the result before following up.`), input_schema, ...(result_schema ? { result_schema } : {}), risk: options.risk ?? "none", label: options.label ?? "Working", audience: options.audience ?? "all", ...(options.timeout_ms ? { timeout_ms: options.timeout_ms } : {}), direction: options.direction ?? "in" });
}

// Main agent: a queued conversation and a separately driven secondary session.
add("agent:main", "say", "request", { oneOf: [
  obj({ text: nonempty, ...sayExtras }, ["text"]),
  obj({ text: { const: "" }, attachments: { type: "array", items: attachmentInput, minItems: 1 }, in_reply_to: id, option_id: id }, ["text", "attachments"]),
] }, accepted, { label: "Reading your message", description: "Use to speak to the agent or send attachments; accepted immediately and queued." });
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
] }, accepted, { label: "Replying", description: "Send a short message; it is acknowledged when recorded. Proactive offers may carry an opaque stable dedupe_key at initial acceptance. facts are source message or fact IDs after the flow maps worker-local numeric indices, never those indices themselves." });
add("person:owner", "react", "request", obj({ message_id: id, emoji: nonempty }, ["message_id", "emoji"]), accepted, { description: "React to one existing message; unknown ids fail." });
add("person:owner", "show", "request", obj({ card: CARD_SCHEMA }, ["card"]), accepted, { description: "Show a result or choice card; it is acknowledged when recorded." });
add("person:owner", "ask", "request", obj({ title: nonempty, detail: str, options: { type: "array", items: askOption, minItems: 1 }, expires_at: num, source: obj({ word: nonempty, to: id, body_preview: str }, ["word", "to", "body_preview"]) }, ["title", "detail", "options", "expires_at", "source"]), obj({ choice: askChoice }, ["choice"]), { timeout_ms: 600_000, description: "Ask the owner; await the first valid answer or expiry." });

add("screen:*", "ui.open", "request", obj({ target: choice("activity", "upcoming", "approvals", "identity", "memory", "settings", "turn"), id: str, mode: choice("perform", "suggest") }, ["target", "mode"]), obj({ opened: bool }, ["opened"]), { description: "Open or suggest a view on a named screen." });
add("service:clock", "set", "request", obj({ at: num, every: { type: "integer", minimum: 60 }, to: id, word: id, body: obj({}, [], true), label: nonempty }, ["to", "word", "body", "label"]), obj({ id, next: num }, ["id", "next"]));
add("service:clock", "cancel", "request", obj({ id }, ["id"]), obj({ cancelled: bool }, ["cancelled"]));
add("service:clock", "list", "request", empty, obj({ timers: array(any) }, ["timers"]));
add("service:clock", "clock.fired", "event", obj({ timer_id: id, scheduled_at: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  outcome: choice("dispatched", "skipped", "failed"), reason: str, request_id: id }, ["timer_id", "scheduled_at", "outcome"]), undefined,
{ direction: "out", description: "Durable scheduled occurrence outcome; dispatched records router acceptance, not external completion." });
add("service:post", "deliver", "request", obj({ message_id: id, kind: choice("reply", "offer", "heads_up", "approval", "due"), dedupe_key: deliveryDedupeKey }, ["message_id", "kind"]), obj({ channel: choice("inapp", "notification", "held", "dropped") }, ["channel"]), { audience: "owner" });
add("service:post", "visible", "event", empty, undefined, { audience: "owner", description: "Presence from the authenticated screen only." });
add("service:post", "post.changed", "event", obj({ held: { type: "integer", minimum: 0 } }, ["held"]), undefined, { direction: "out", audience: "owner", label: "Updating deliveries", description: "Authoritative current held-delivery count for the owner; never infer a count from deliver results." });
add("service:post", "post.delivery", "event", obj({ message_id: id, state: choice("held", "released", "dropped") }, ["message_id", "state"]), undefined,
  { direction: "out", audience: "owner", label: "Updating message visibility", description: "Per-message chat visibility for a new offer or heads-up; released is in-app visibility, not a host notification." });

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
  risk: gateRisk, contract_fingerprint: sha, created_at: nonnegativeSafe, expires_at: nonnegativeSafe, revoked_at: nonnegativeSafe },
["id", "subject", "to", "word", "object_pattern", "risk", "contract_fingerprint", "created_at", "expires_at"]);
const gateCurrentHistory = obj({ id, request_id: id, ask_id: id, subject: nonempty, to: id, word: id, risk: gateRisk,
  decision: choice("once", "always", "deny", "timeout", "cancelled", "rule"), at: nonnegativeSafe, rule_id: id,
  source: { const: "current" } },
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
  obj({ rules: { type: "array", items: gateRule, maxItems: 100 }, next_before: positiveSafe }, ["rules"]), { audience: "owner" });
add("service:gate", "rules.revoke", "request", obj({ id }, ["id"]), obj({ revoked: bool }, ["revoked"]), { audience: "owner", risk: "structure" });
add("service:gate", "history", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 1000 } }),
  obj({ items: { type: "array", items: { oneOf: [gateCurrentHistory, gateLegacyHistory] }, maxItems: 1000 }, next_before: positiveSafe }, ["items"]), { audience: "owner" });
add("service:gate", "access.list", "request", obj({ before: positiveSafe, limit: { type: "integer", minimum: 1, maximum: 100 } }),
  obj({ items: { type: "array", items: gateAccessItem, maxItems: 100 }, next_before: positiveSafe }, ["items"]), { audience: "owner" });
add("service:gate", "access.grant", "request", obj({ member: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+$" }, scope: gateAccessScope }, ["member", "scope"]),
  obj({ id, member: { type: "string", pattern: "^agent:[A-Za-z0-9_-]+$" }, scope: gateAccessScope, expires_at: nonnegativeSafe }, ["id", "member", "scope", "expires_at"]),
  { audience: "owner", risk: "structure" });
add("service:gate", "access.revoke", "request", obj({ id }, ["id"]), obj({ revoked: bool }, ["revoked"]),
  { audience: "owner", risk: "structure" });
add("service:gate", "gate.asked", "event", obj({ request_id: id, ask_id: id, risk: gateRisk, to: id, word: id,
  expires_at: nonnegativeSafe }, ["request_id", "ask_id", "risk", "to", "word", "expires_at"]), undefined, { direction: "out" });
add("service:gate", "gate.passed", "event", obj({ request_id: id, by: choice("rule", "answer"), rule_id: id, ask_id: id },
  ["request_id", "by"]), undefined, { direction: "out" });
add("service:gate", "gate.denied", "event", obj({ request_id: id, by: choice("answer", "timeout"), ask_id: id },
  ["request_id", "by"]), undefined, { direction: "out" });

add("service:self", "read", "request", obj({ path: selfPath }, ["path"]), obj({ content: str, hash: sha, version: integer }, ["content", "hash"]));
add("service:self", "write", "request", obj({ path: selfPath, content: str, why: str, expected_hash: { anyOf: [sha, { type: "null" }] } }, ["path", "content", "why", "expected_hash"]), obj({ hash: sha, version: integer }, ["hash"]), { label: "Updating a file", description: "Write a managed file with its exact baseline hash; null only creates a new file." });
add("service:self", "append", "request", obj({ path: datePath, text: str }, ["path", "text"]), obj({ hash: sha }, ["hash"]), { label: "Adding to a log", description: "Atomically append to any allowed dated log." });
add("service:self", "apply_plan", "request", obj({ path: selfPath, expected_hash: sha, edits: array(edit) }, ["path", "expected_hash", "edits"]), obj({ applied: integer, hash: sha }, ["applied", "hash"]));
add("service:self", "rollback", "request", obj({ path: selfPath, to_ts: num, expected_hash: sha }, ["path", "to_ts", "expected_hash"]), empty, { risk: "structure" });
add("service:self", "history", "request", obj({ path: selfPath }, ["path"]), obj({ versions: array(any) }, ["versions"]));
add("service:self", "self.changed", "event", obj({ path: selfPath, by: id, summary: str, version: integer }, ["path", "by", "summary"]), undefined, { direction: "out" });

const calendarEvent = obj({ id, title: str, start: num, end: num, important: bool }, ["id", "title", "start", "end"]);
add("service:senses", "sense.calendar", "event", obj({ kind: choice("upcoming", "changed"), event: calendarEvent }, ["kind", "event"]), undefined, { audience: "owner" });
add("service:senses", "sense.battery", "event", obj({ level: { type: "number", minimum: 0, maximum: 100 } }, ["level"]), undefined, { audience: "owner" });
add("service:senses", "sense.screen", "event", obj({ state: choice("on", "app_open"), away_ms: { type: "number", minimum: 0 } }, ["state", "away_ms"]), undefined, { audience: "owner" });
add("service:senses", "sense.notification", "event", obj({ app: str, title: str, text: str }, ["app", "title", "text"]), undefined, { audience: "owner" });
add("service:reflex", "reflex.judged", "event", obj({ message_id: id, stage: choice("keyword", "jev"), intent: str, confidence: { type: "number", minimum: 0, maximum: 1 }, acted: bool }, ["message_id", "stage", "intent", "confidence", "acted"]), undefined, { direction: "out" });
add("service:work", "run", "request", obj({ flow: nonempty }, ["flow"]), obj({ run: id }, ["run"]), { audience: "owner" });
add("service:work", "runs", "request", obj({ flow: str, limit: { type: "integer", minimum: 1 } }), obj({ runs: array(any) }, ["runs"]), { audience: "owner" });
add("service:work", "run.start", "event", obj({ run: id, flow: nonempty, trigger: str }, ["run", "flow", "trigger"]), undefined, { direction: "out" });
add("service:work", "run.end", "event", obj({ run: id, outcome: choice("done", "no_change", "failed"), detail: str }, ["run", "outcome", "detail"]), undefined, { direction: "out" });

const worker = (name: string, input: JsonSchema, normal: JsonSchema) => add(`worker:${name}`, name, "request", obj({ input, run: id }, ["input", "run"]), workerResult(normal), { audience: "owner", description: "One tool-free model judgment with validated structured output." });
worker("extract", obj({ chunk: array(message), summary: str, known: strings }, ["chunk", "summary", "known"]), obj({ claims: array(claim) }, ["claims"]));
worker("verify_claims", obj({ claims: array(claim), evidence: array(message) }, ["claims", "evidence"]), obj({ verdicts: array(obj({ i: integer, lens: choice("refute", "grounded"), pass: bool, confidence: { type: "number", minimum: 0, maximum: 1 }, why: str }, ["i", "lens", "pass", "confidence", "why"])) }, ["verdicts"]));
worker("reconcile", obj({ file: choice("MEMORY.md", "USER.md"), numbered: str, claims: array(claim) }, ["file", "numbered", "claims"]), obj({ edits: array(edit) }, ["edits"]));
worker("verify_plan", obj({ file: choice("MEMORY.md", "USER.md"), before: str, edits: array(edit) }, ["file", "before", "edits"]), obj({ verdicts: array(obj({ i: integer, lens: choice("evidence", "temporal", "preservation"), pass: bool, why: str }, ["i", "lens", "pass", "why"])) }, ["verdicts"]));
worker("proactive", obj({ prefs: str, recent: array(message), facts: array(obj({ n: integer, text: str }, ["n", "text"])), upcoming: array(any), delivered: array(any) }, ["prefs", "recent", "facts", "upcoming", "delivered"]), obj({ suggestion: obj({ kind: choice("offer", "heads_up"), title: str, text: str, urgency: choice("regular", "high"), facts: array(integer) }, ["kind", "title", "text", "urgency", "facts"]) }, ["suggestion"]));
worker("opener", obj({ away_ms: num, last_topic: str, pending: array(any), changes: array(any) }, ["away_ms", "last_topic", "pending", "changes"]), obj({ speak: bool, why: str, hint: str }, ["speak", "why"]));

// Management bodies retain the current extension payloads until the edge migrates.
for (const [word, input, result] of [
  ["settings.get", empty, obj({}, [], true)], ["settings.set", obj({}, [], true), obj({}, [], true)],
  ["plugins.list", empty, obj({}, [], true)], ["plugins.op", obj({}, [], true), obj({}, [], true)],
  ["gateway.state", empty, obj({}, [], true)], ["gateway.op", obj({}, [], true), obj({}, [], true)],
  ["model.set", obj({}, [], true), obj({}, [], true)],
] as [string, JsonSchema, JsonSchema][]) add("service:admin", word, "request", input, result, { audience: "owner", risk: word === "plugins.op" || word === "gateway.op" ? "structure" : "none", description: "Local owner administration; never available to a remote screen." });
add("service:admin", "pause", "request", { oneOf: [empty, obj({ by: id }, ["by"]) ] },
  obj({ paused: { const: true } }, ["paused"]), { audience: "owner", description: "Durably pause activity; a trusted local reflex may cite one authenticated owner message once." });
add("service:admin", "resume", "request", obj({ confirmed: { const: true } }, ["confirmed"]),
  obj({ paused: { const: false } }, ["paused"]), { audience: "owner", description: "Resume only after explicit confirmation on a verified local owner screen." });

export const WORD_CONTRACTS: readonly WordContract[] = Object.freeze(entries);
export function wordContract(member: string, word: string): WordContract | undefined {
  return WORD_CONTRACTS.find((item) => item.word === word && (item.member === member || (item.member === "screen:*" && /^screen:[^:]+$/.test(member))));
}
export function deviceWordSpec(capability: { name: string; description: string; input_schema: JsonSchema; result_schema?: JsonSchema; risk: "none" | "outward" | "structure"; label: string }): WordSpec {
  if (typeof capability.name !== "string" || !capability.name.trim() || typeof capability.description !== "string" || !capability.description.trim() || typeof capability.label !== "string" || !capability.label.trim() || !["none", "outward", "structure"].includes(capability.risk)) throw new TypeError("device capability needs valid name, description, risk and label");
  if (!capability.input_schema || typeof capability.input_schema !== "object" || Array.isArray(capability.input_schema) || capability.input_schema.type !== "object") throw new TypeError("device capability needs an object input schema");
  // Full externally supplied JSON Schemas must be compiled by a standards-compliant validator at registration.
  return { word: capability.name, kind: "request", description: capability.description, input_schema: capability.input_schema, result_schema: capability.result_schema ?? obj({}, [], true), risk: capability.risk, label: capability.label, audience: "all" };
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
