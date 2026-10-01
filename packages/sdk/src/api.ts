// ash SDK — `ash-api/1`
//
// ash is the personal-agent layer (the "system"); agent runtimes such as DSH are the
// "apps" it hosts. This file is the contract between the two worlds, in both directions:
//
//   control plane    ash → runtime   lifecycle, delivery, cancel, loop gate, context, tools, approval
//   system services  runtime → ash   inbox, members/devices, calls, timers, notify, workspace, grants
//
// Inside one process (ash core hosting DSH) both directions are direct calls: ash holds the
// runtime's root context, the runtime gets `ctx.ash` (see packages/dsh-binding). HTTP (below)
// only exists at the edges: the UI, the Android host, remote devices, out-of-process runtimes.
//
// The contract is designed around the strongest runtime (DSH). A runtime declares which
// control capabilities it actually supports (`RuntimeCapabilities`); ash never assumes more.

export const API_VERSION = "ash-api/1";

// ------------------------------------------------------------------ members

/** Everything that can act in a space has a stable id: `<kind>:<name>`. */
export type MemberKind = "person" | "agent" | "device" | "service";

export interface Member {
  id: string; // e.g. "agent:main", "device:phone", "person:owner"
  kind: MemberKind;
  name: string;
  online: boolean;
}

// ------------------------------------------------------------------ devices & capabilities

/** One thing a member can do for others, self-described (the device's manifest entry). */
export interface CapabilitySpec {
  name: string; // e.g. "notify.post", "files.read_file"
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema (type: object)
  /** A person must confirm each call (enforced by ash, never by the caller). */
  confirm?: boolean;
  /** Hint for callers and projections; ash does not enforce it. */
  timeout_ms?: number;
}

export type DeviceKind = "phone" | "laptop" | "browser" | "server" | "other";

export interface DeviceInfo {
  id: string; // "device:phone", "device:<gateway id>"
  name: string;
  kind: DeviceKind;
  online: boolean;
  /** How ash reaches it: the local Android host, the gateway, or this process. */
  via: "host" | "gateway" | "local";
  /** Gateway permissions the owner granted this device (pairing). */
  permissions: string[];
  capabilities: CapabilitySpec[];
}

export interface CallRequest {
  device: string;
  capability: string;
  args?: Record<string, unknown>;
}

/** Content blocks follow MCP's shape so tool results project 1:1 into agent runtimes. */
export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface CallResult {
  ok: boolean;
  content: ContentBlock[];
  /** Structured result when the capability returns one. */
  data?: unknown;
  error?: string;
}

// ------------------------------------------------------------------ grants & confirmations

/**
 * A grant lets a member use something. `scope` is `device:<id>/*`, `device:<id>/<capability>`
 * or `*`. Grants are the owner's decision; ash checks them on every call.
 */
export interface Grant {
  id: string;
  member: string;
  scope: string;
  created_by: string;
  created_at: number;
}

export type ConfirmState = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** A question to the owner ("may agent:main run X on device Y?"), answered in the UI or a notification. */
export interface Confirmation {
  id: string;
  asker: string; // member on whose behalf
  title: string;
  detail: string;
  /** What the answer unlocks: a call, a DSH tool call, a grant request … */
  kind: "call" | "tool" | "grant" | "other";
  state: ConfirmState;
  created_at: number;
  expires_at: number;
  answered_by?: string;
}

// ------------------------------------------------------------------ agents (control plane)

/** Control features a runtime can support. DSH supports all of them through the in-process binding. */
export interface RuntimeCapabilities {
  deliver_queue: boolean; // deliver a message after the current turn
  deliver_steer: boolean; // inject into the running turn
  cancel: boolean; // stop the running turn
  events_stream: boolean; // turn/text/tool events as they happen
  resume: boolean; // the same conversation survives restarts
  mcp_client: boolean; // can consume ash system services over MCP
  loop_gate: boolean; // ash may allow/deny each model step
  context_sections: boolean; // ash owns model-facing context (identity, devices, origin)
  tool_projection: boolean; // ash adds/removes native tools at runtime (device capabilities)
  approval_answerer: boolean; // ash answers the runtime's approval requests / gates tool calls
}

export type AgentStatus = "starting" | "idle" | "running" | "stopped" | "error";

export interface AgentInfo {
  id: string; // member id, e.g. "agent:main"
  name: string;
  runtime: string; // "dsh" | "echo" | …
  workspace: string;
  status: AgentStatus;
  capabilities: RuntimeCapabilities;
  /** Runtime-side handle (e.g. the DSH session id), for tooling. */
  handle?: string;
  queued: number;
  last_error?: string;
  /** Model the runtime uses, when it can tell. */
  model?: string;
}

/** A file sent along with a message (base64 on the wire). */
export interface AttachmentInput {
  name: string;
  mime_type: string;
  data: string; // base64
}

/** A file that arrived with a message, saved into the agent's workspace. */
export interface Attachment {
  name: string;
  mime_type: string;
  size: number;
  /** Path inside the workspace (e.g. inbox/20260930-1015-photo.jpg). */
  path: string;
  workspace: string;
}

export interface DeliverRequest {
  text: string;
  /** Images go to the model as images; other files are saved for the agent's tools. */
  attachments?: AttachmentInput[];
  /** Who is speaking; defaults to the caller's member id (only the owner may speak for others). */
  from?: string;
  /** queue (default) waits for the current turn; steer injects into it (if supported). */
  mode?: "queue" | "steer";
  /** Idempotency key: a retry with the same id is accepted once. */
  message_id?: string;
}

export interface DeliverResult {
  accepted: true;
  message_id: string;
  /** Position in the agent's queue (0 = running now, -1 = duplicate). */
  position: number;
}

// ------------------------------------------------------------------ events (workspace log)

/**
 * The event log is append-only; every event names its workspace and the member that
 * caused it. Clients resume with `after=<seq>`.
 */
export type EventType =
  | "message.delivered" // {to, from, text, message_id, mode, origin, attachments?}
  | "agent.status" // {status, error?}
  | "agent.turn.started" // {message_id}
  | "agent.text" // {text, message_id}             — one assistant message
  | "agent.tool.call" // {name, args, message_id}
  | "agent.tool.result" // {name, ok, preview, message_id}
  | "agent.turn.ended" // {message_id, reason: "completed"|"error"|"cancelled"|"blocked", error?}
  | "timer.set" // {timer}
  | "timer.fired" // {timer}
  | "timer.cancelled" // {id}
  | "notify" // {title, text, urgency}
  | "call.started" // {id, device, capability, caller}
  | "call.ended" // {id, ok, error?}
  | "confirm.requested" // {confirmation}
  | "confirm.answered" // {confirmation}
  | "grant.changed" // {grant?, revoked?}
  | "device.changed" // {device}
  | "member.changed"; // {member}

export interface AshEvent {
  seq: number;
  ts: number;
  workspace: string;
  member: string; // who caused it
  type: EventType;
  data: Record<string, unknown>;
}

// ------------------------------------------------------------------ system services

export interface TimerRequest {
  /** Member the timer delivers to (defaults to the caller). */
  owner?: string;
  text: string;
  in_seconds?: number;
  at?: number; // unix ms
  repeat_seconds?: number;
}

export interface Timer {
  id: string;
  owner: string;
  text: string;
  fire_at: number;
  repeat_seconds: number | null;
  created_by: string;
}

export interface NotifyRequest {
  title: string;
  text: string;
  urgency?: "low" | "normal" | "high";
}

export interface Identity {
  me: string;
  kind: MemberKind;
  space: string;
  owner: string;
  /** For agents: the workspace directory the runtime works in. */
  workspace?: string;
  grants: Grant[];
}

export interface WorkspaceFile {
  path: string;
  size: number;
  mtime: number;
  dir: boolean;
}

// ------------------------------------------------------------------ HTTP surface (edges)

/**
 * Local HTTP (127.0.0.1), `Authorization: Bearer <token>`. Each caller (host, UI, plugin,
 * out-of-process runtime) gets its own token; the token decides which member it speaks for.
 * Through the gateway tunnel the paired device is the caller (the gateway authenticates it).
 */
export const ROUTES = {
  manifest: "GET /api/manifest", // {api, space, me, members, agents, devices}
  me: "GET /api/me", // Identity
  members: "GET /api/members",
  agents: "GET /api/agents",
  deliver: "POST /api/agents/:id/deliver", // DeliverRequest → DeliverResult
  cancel: "POST /api/agents/:id/cancel",
  inbox: "GET /api/agents/:id/inbox", // queued messages not yet taken by the agent
  events: "GET /api/events?after=&limit=&workspace=&type=", // {events, next}
  stream: "GET /api/events/stream?after=", // Server-Sent Events, one AshEvent per `data:`
  devices: "GET /api/devices", // DeviceInfo[]
  call: "POST /api/call", // CallRequest → CallResult
  timersList: "GET /api/timers",
  timersSet: "POST /api/timers", // TimerRequest → Timer
  timersCancel: "DELETE /api/timers/:id",
  notify: "POST /api/notify", // NotifyRequest
  confirms: "GET /api/confirms", // pending Confirmation[]
  confirmAnswer: "POST /api/confirms/:id", // {approve: boolean}
  grants: "GET /api/grants",
  grantAdd: "POST /api/grants", // {member, scope}
  grantRevoke: "DELETE /api/grants/:id",
  files: "GET /api/workspaces/:ws/files?path=", // WorkspaceFile[] or file bytes
  fileWrite: "PUT /api/workspaces/:ws/files?path=",
  settings: "GET /api/settings", // {model, providers, credentials: {name: set?}}
  settingsSet: "POST /api/settings", // {model?, credentials?: {name: value}}
  gateway: "GET /api/gateway", // link state, pending pairings, paired devices (owner only)
  /** System services for one agent as an MCP server (Streamable HTTP, JSON responses). */
  mcp: "POST /mcp/:agent", // header x-ash-token: <that agent's token>
} as const;

/** System-service tools every agent gets (native in DSH as ash_<name>; over MCP as <prefix>__<name>). */
export const SYSTEM_TOOLS = ["whoami", "members", "devices", "call", "send", "timer_set", "timer_list", "timer_cancel", "notify", "log", "grants", "request_grant"] as const;

export class AshApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

// The next protocol is additive until the edge client and server switch together.
export const API_VERSION_V2 = "ash-api/2" as const;
export type Kind = "request" | "response" | "event";
export type MessageErrorCode = "bad_request" | "not_found" | "forbidden" | "denied" | "cancelled" | "timeout" | "offline" | "failed";
export type ResponseBody = { ok: true; result?: unknown } | { ok: false; error: { code: MessageErrorCode; message: string } };
export interface Message {
  seq: number;
  id: string;
  ts: number;
  from: string;
  to: string | null;
  kind: Kind;
  word: string;
  body: Record<string, unknown>;
  reply_to?: string;
  origin?: { screen: string; label: string };
  turn?: string;
}

/** Read-only projection of a ledger row. It is never a Message or a send body. */
export interface MessageSummaryV2 extends Omit<Message, "body"> {
  summary: true;
  body_summary: Record<string, unknown>;
  inline_attachments?: { index: number; name: string; mime_type: string; size: number }[];
}
export const MESSAGE_SUMMARY_EVENT = "message.summary" as const;
export const AUTH_SCOPE_EVENT = "auth.scope" as const;
export const STREAM_PAGE_END_EVENT = "stream.page_end" as const;
export const STREAM_ERROR_EVENT = "stream.error" as const;
export const STREAM_SUMMARY_PAGE_BYTES = 4 * 1024 * 1024;
export const STREAM_SUMMARY_ITEM_BYTES = 1024 * 1024;
export const STREAM_SUMMARY_CONTROL_RESERVE_BYTES = 256 * 1024;
export const STREAM_RAW_PAGE_BYTES = 32 * 1024 * 1024;
export interface AuthScopeControlV2 { auth_scope: string }
export interface StreamPageEndV2 { has_more: boolean; first_seq: number | null; last_seq: number | null }
export interface StreamErrorV2 { code: "too_large" | "failed" }

const streamObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const streamSeq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const streamScope = (value: unknown): value is string => typeof value === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(value);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));

export function isAuthScopeControlV2(value: unknown): value is AuthScopeControlV2 {
  return streamObject(value) && exactKeys(value, ["auth_scope"]) && streamScope(value.auth_scope);
}

export function isStreamPageEndV2(value: unknown): value is StreamPageEndV2 {
  if (!streamObject(value) || !exactKeys(value, ["has_more", "first_seq", "last_seq"]) || typeof value.has_more !== "boolean") return false;
  return value.first_seq === null && value.last_seq === null && value.has_more === false || streamSeq(value.first_seq) && streamSeq(value.last_seq) && value.first_seq <= value.last_seq;
}

export function isStreamErrorV2(value: unknown): value is StreamErrorV2 {
  return streamObject(value) && exactKeys(value, ["code"]) && (value.code === "too_large" || value.code === "failed");
}

export function isMessageSummaryV2(value: unknown): value is MessageSummaryV2 {
  if (!streamObject(value) || !exactKeys(value, ["seq", "id", "ts", "from", "to", "kind", "word", "reply_to", "origin", "turn", "summary", "body_summary", "inline_attachments"]) || value.summary !== true || Object.hasOwn(value, "body") || !streamSeq(value.seq) || typeof value.id !== "string" || !value.id || !Number.isSafeInteger(value.ts) || typeof value.from !== "string" || !value.from || !(value.to === null || typeof value.to === "string") || !["request", "response", "event"].includes(String(value.kind)) || typeof value.word !== "string" || !value.word || !streamObject(value.body_summary)) return false;
  if (value.reply_to !== undefined && (typeof value.reply_to !== "string" || !value.reply_to)) return false;
  if (value.turn !== undefined && (typeof value.turn !== "string" || !value.turn)) return false;
  if (value.origin !== undefined && (!streamObject(value.origin) || !exactKeys(value.origin, ["screen", "label"]) || typeof value.origin.screen !== "string" || typeof value.origin.label !== "string")) return false;
  if (value.inline_attachments !== undefined) {
    if (!Array.isArray(value.inline_attachments) || !value.inline_attachments.every((item) => streamObject(item) && exactKeys(item, ["index", "name", "mime_type", "size"]) && Number.isSafeInteger(item.index) && typeof item.index === "number" && item.index >= 0 && typeof item.name === "string" && item.name.length > 0 && typeof item.mime_type === "string" && item.mime_type.length > 0 && Number.isSafeInteger(item.size) && typeof item.size === "number" && item.size >= 0)) return false;
    if (new Set(value.inline_attachments.map((item) => item.index)).size !== value.inline_attachments.length) return false;
  }
  if (Object.hasOwn(value.body_summary, "attachments") && (!Array.isArray(value.body_summary.attachments) || value.body_summary.attachments.some((item) => !streamObject(item) || Object.hasOwn(item, "data")))) return false;
  return true;
}

/** Counts UTF-8 SSE bytes, not JavaScript code units; rows must be visited in page order. */
export class SummaryPageBudgetV2 {
  private readonly rows: number[] = [];
  private bytes = STREAM_SUMMARY_CONTROL_RESERVE_BYTES;
  private full = false;
  tryInclude(seq: number, encodedSseBytes: number): boolean {
    if (!streamSeq(seq) || !Number.isSafeInteger(encodedSseBytes) || encodedSseBytes <= 0) throw new TypeError("invalid summary row budget input");
    if (encodedSseBytes > STREAM_SUMMARY_ITEM_BYTES) throw new RangeError("summary row exceeds 1 MiB");
    if (this.full) return false;
    if (this.rows.length >= 1000 || this.bytes + encodedSseBytes > STREAM_SUMMARY_PAGE_BYTES) { this.full = true; return false; }
    this.rows.push(seq);
    this.bytes += encodedSseBytes;
    return true;
  }
  end(hasMore: boolean): StreamPageEndV2 {
    if (hasMore && !this.rows.length || this.full && !hasMore) throw new RangeError("invalid summary page continuation");
    return { has_more: hasMore, first_seq: this.rows.length ? Math.min(...this.rows) : null, last_seq: this.rows.length ? Math.max(...this.rows) : null };
  }
}

/** Authoritative pending-delivery count emitted to the owner by the delivery service. */
export interface PostChangedBody { held: number }
/** Dropped suppresses only a repeated presentation; the original owner message remains in the ledger. */
export type PostDeliveryChannel = "inapp" | "notification" | "held" | "dropped";
/** Per-message chat visibility, distinct from an external notification outcome. */
export type PostDeliveryState = "held" | "released" | "dropped";
export interface PostDeliveryBodyV2 { message_id: string; state: PostDeliveryState }
/** A bounded read-only stream control frame; version_seq names a real ledger state event. */
export interface PostDeliverySnapshotV2 {
  at_seq: number;
  items: { message_id: string; state: PostDeliveryState; version_seq: number }[];
}
export const POST_DELIVERY_SNAPSHOT_EVENT = "post.delivery.snapshot" as const;
/** Read-only owner-facing alias; never a bearer token or credential digest. */
export interface GateRuleItemV2 {
  id: string;
  subject: string;
  device_id?: string;
  capability_id?: string;
  to: string;
  word: string;
  object_pattern: string;
  risk: "outward" | "structure";
  contract_fingerprint: string;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}
/** Device access is distinct from an approval rule and never waives a risk ask. */
export interface GateAccessItemV2 {
  id: string;
  member: string;
  scope: string;
  source: "current" | "legacy";
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}
export type GateHistoryDecisionV2 =
  | "once" | "always" | "deny" | "timeout" | "cancelled" | "rule"
  | "legacy_unresolved" | "legacy_approved" | "legacy_denied" | "legacy_expired" | "legacy_cancelled"
  | "legacy_access_imported" | "legacy_access_expired" | "legacy_access_invalid";
export type GateHistoryItemV2 =
  | { id: string; request_id: string; ask_id?: string; subject?: string; to?: string; word?: string; risk?: "outward" | "structure";
      decision: "once" | "always" | "deny" | "timeout" | "cancelled" | "rule"; at: number; rule_id?: string; source: "current" }
  | { id: string; subject?: string; to?: string; word?: string; risk?: "outward" | "structure";
      decision: Exclude<GateHistoryDecisionV2, "once" | "always" | "deny" | "timeout" | "cancelled" | "rule">;
      at: number; legacy_scope?: string; source: "legacy" };
/** Provenance stamped only by the v10 migration; never accepted from a normal send body. */
export interface LegacyConversationMetadata {
  seq: number;
  workspace: string;
  member: string;
}

export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

export interface WordSpec {
  word: string;
  kind: "request" | "event";
  description: string;
  input_schema?: JsonSchema;
  result_schema?: JsonSchema;
  risk?: "none" | "outward" | "structure";
  label?: string;
  timeout_ms?: number;
  audience?: "agent" | "owner" | "all";
}
export interface MemberInfo { id: string; kind: "person" | "screen" | "agent" | "device" | "service" | "worker"; name: string; online?: boolean }
export interface DescribeSummary { members: (MemberInfo & { words: string[] })[] }
export interface DescribeDetail { members: (MemberInfo & { words: WordSpec[] })[] }
export type Describe = DescribeSummary | DescribeDetail;

export type Card =
  | { type: "options"; prompt?: string; options: { id: string; text: string }[]; allow_custom?: boolean }
  | { type: "file"; workspace: string; path: string; name: string; mime_type: string; size: number }
  | { type: "image"; workspace: string; path: string; alt?: string }
  | { type: "link"; url: string; title: string; summary?: string }
  | { type: "permission"; permission: string; why: string };
export type AskOption = { id: "once" | "always" | "deny"; label: string };
export type EditReason = "promote" | "correct" | "complete" | "expire" | "dedupe" | "condense" | "demote";
export interface Edit { op: "replace" | "delete" | "insert_after"; start: number; end: number; guard: string; text?: string; reason: EditReason; evidence: string[] }

export interface Claim {
  text: string;
  type: "fact" | "preference" | "relationship" | "event" | "boundary" | "correction";
  salience: "low" | "medium" | "high";
  evidence: string[];
  quote?: string;
  supersedes?: string;
  valid_until?: string;
}
export interface NoChange { no_change: { checked: string[]; details: string } }
export type WorkerName = "extract" | "verify_claims" | "reconcile" | "verify_plan" | "proactive" | "opener";
export interface WorkerInputMap {
  extract: { chunk: Message[]; summary: string; known: string[] };
  verify_claims: { claims: Claim[]; evidence: Message[] };
  reconcile: { file: "MEMORY.md" | "USER.md"; numbered: string; claims: Claim[] };
  verify_plan: { file: "MEMORY.md" | "USER.md"; before: string; edits: Edit[] };
  proactive: { prefs: string; recent: Message[]; facts: { n: number; text: string }[]; upcoming: unknown[]; delivered: unknown[] };
  opener: { away_ms: number; last_topic: string; pending: unknown[]; changes: unknown[] };
}
export interface WorkerOutputMap {
  extract: { claims: Claim[] };
  verify_claims: { verdicts: { i: number; lens: "refute" | "grounded"; pass: boolean; confidence: number; why: string }[] };
  reconcile: { edits: Edit[] };
  verify_plan: { verdicts: { i: number; lens: "evidence" | "temporal" | "preservation"; pass: boolean; why: string }[] };
  proactive: { suggestion: { kind: "offer" | "heads_up"; title: string; text: string; urgency: "regular" | "high"; facts: number[] } };
  opener: { speak: boolean; why: string; hint?: string };
}
export type WorkerRequest<N extends WorkerName = WorkerName> = { input: WorkerInputMap[N]; run: string };
export type WorkerResult<N extends WorkerName = WorkerName> = WorkerOutputMap[N] | NoChange;

/** One durable scheduled occurrence; dispatched means accepted by the router, not completed externally. */
export interface ClockFiredBodyV2 {
  timer_id: string;
  scheduled_at: number;
  outcome: "dispatched" | "skipped" | "failed";
  reason?: string;
  request_id?: string;
}

/** Bounded, non-content metadata for one background run. Never include step input, output, or prompts. */
export interface WorkRunInfoV2 {
  run: string;
  flow: string;
  trigger: "manual" | "cooldown" | "hourly" | "event";
  state: "running" | "done" | "no_change" | "failed";
  started_at: number;
  ended_at: number | null;
}

/** A pure-code step is an outbound ledger fact, not a callable tool. */
export interface WorkRunStepBodyV2 {
  run: string;
  step: string;
  state: "started" | "done" | "failed" | "skipped";
}

export interface SendRequestV2 {
  to: string | null;
  kind: Kind;
  word: string;
  body: Record<string, unknown>;
  reply_to?: string;
  wait?: boolean;
  /** Stable per authenticated transport. For responses, retry the identical envelope after a lost acknowledgement. */
  client_id?: string;
}
export interface SendResultV2 { id: string; seq: number; reply?: Message }
/** Existing send response wire for the one registered target screen; identity comes from Ash-Screen, never this body. */
export type ScreenUiOpenAnswerV2 = SendRequestV2 & {
  kind: "response";
  word: "ui.open";
  reply_to: string;
  body: { ok: true; result: { opened: boolean } };
};
export interface StreamQueryV2 { after?: number; before?: number; limit?: number; follow?: boolean; screen?: string; label?: string; summary?: boolean }
/** A live stream control frame, not a ledger message or cursor-bearing SSE event. */
/** Opaque credential scope for browser-local pending data; never an authorization proof. */
/** A display hint only. The server must still authorize every administration request. */
export interface ScreenRegistration { screen: string; token: string; label: string; auth_scope: string; local_management?: boolean }
export function isScreenRegistration(value: unknown): value is ScreenRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return typeof frame.screen === "string" && /^screen:[A-Za-z0-9_-]+$/.test(frame.screen) &&
    typeof frame.token === "string" && /^[A-Za-z0-9_-]{32,}$/.test(frame.token) &&
    typeof frame.label === "string" && frame.label.length > 0 && frame.label.length <= 80 &&
    typeof frame.auth_scope === "string" && /^v1_[A-Za-z0-9_-]{43}$/.test(frame.auth_scope) &&
    (frame.local_management === undefined || typeof frame.local_management === "boolean");
}
export const SCREEN_REGISTRATION_EVENT = "screen.registered" as const;
/** Browser proof survives the gateway's reserved x-ash-* header stripping. */
export const SCREEN_TOKEN_HEADER = "Ash-Screen" as const;
export const SCREEN_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Server-owned authentication facts; never accepted from a request body. */
export interface AuthenticatedCallerContext {
  /** Stable authenticated identity used for persisted client_id deduplication. */
  transportPrincipal: string;
  pairedDeviceId?: string;
  local: boolean;
  remote: boolean;
  ownerProxy: boolean;
  member: string;
  /** Only populated after validating a server-minted registration for this transport. */
  screenId?: string;
}
export const ROUTES_V2 = {
  send: "POST /api/send",
  stream: "GET /api/stream",
  describe: "GET /api/describe",
  filesRead: "GET /api/workspaces/:ws/files",
  filesWrite: "PUT /api/workspaces/:ws/files",
  mcp: "POST /mcp/:agent",
} as const;
