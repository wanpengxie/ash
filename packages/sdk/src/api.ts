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

export interface DeliverRequest {
  text: string;
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
  | "message.delivered" // {to, from, text, message_id, mode}
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
