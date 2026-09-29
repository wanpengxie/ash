// ash SDK — `ash-api/1`
//
// ash is the personal-agent layer (the "system"); agent runtimes such as DSH are the
// "apps" it hosts. This file is the contract between the two worlds, in both directions:
//
//   control plane    ash → runtime   lifecycle, delivery, cancel, loop gate, context, tools, approval
//   system services  runtime → ash   inbox, members/devices, timers, notify, workspace log, grants
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
  /** What this member offers to others (self-description). */
  capabilities: CapabilitySpec[];
}

export interface CapabilitySpec {
  name: string; // e.g. "files.read", "notify.post"
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
  /** A person must confirm each call (enforced by ash, not by the caller). */
  confirm?: boolean;
}

// ------------------------------------------------------------------ agents (control plane)

/** Control features a runtime can support. DSH supports all of them (some via the in-process binding). */
export interface RuntimeCapabilities {
  deliver_queue: boolean; // deliver a message after the current turn
  deliver_steer: boolean; // inject into the running turn
  cancel: boolean; // stop the running turn
  events_stream: boolean; // turn/text/tool events as they happen
  resume: boolean; // the same conversation survives restarts
  mcp_client: boolean; // can consume ash system services over MCP
  loop_gate: boolean; // ash may allow/deny each model step (needs in-process binding)
  context_sections: boolean; // ash may inject model-facing context each step (needs binding)
  tool_projection: boolean; // ash may add/remove native tools at runtime (needs binding)
  approval_answerer: boolean; // ash answers the runtime's approval requests (needs binding)
}

export type AgentStatus = "starting" | "idle" | "running" | "stopped" | "error";

export interface AgentInfo {
  id: string; // member id, e.g. "agent:main"
  runtime: string; // "dsh" | "echo" | …
  workspace: string;
  status: AgentStatus;
  capabilities: RuntimeCapabilities;
  /** Runtime-side handle (e.g. the DSH session id), for tooling. */
  handle?: string;
  queued: number;
  last_error?: string;
}

export interface DeliverRequest {
  text: string;
  /** Who is speaking; defaults to the caller's member id. */
  from?: string;
  /** queue (default) waits for the current turn; steer injects into it (if supported). */
  mode?: "queue" | "steer";
  /** Idempotency key: a retry with the same id is accepted once. */
  message_id?: string;
}

export interface DeliverResult {
  accepted: true;
  message_id: string;
  /** Position in the agent's queue (0 = running now). */
  position: number;
}

// ------------------------------------------------------------------ events (workspace log)

/**
 * The event log is append-only and per space; every event names its workspace and the
 * member that caused it. Clients resume with `after=<seq>`.
 */
export type EventType =
  | "message.delivered" // data: {to, from, text, message_id, mode}
  | "agent.status" // data: {status, error?}
  | "agent.turn.started" // data: {message_id}
  | "agent.text" // data: {text}                    — one assistant message
  | "agent.tool.call" // data: {name, args}
  | "agent.tool.result" // data: {name, ok, preview}
  | "agent.turn.ended" // data: {message_id, reason: "completed"|"error"|"cancelled", error?}
  | "timer.set" // data: {timer}
  | "timer.fired" // data: {timer}
  | "timer.cancelled" // data: {id}
  | "notify" // data: {title, text, urgency}
  | "member.changed"; // data: {member}

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

// ------------------------------------------------------------------ HTTP surface

/**
 * Local HTTP (127.0.0.1), `Authorization: Bearer <token>`. Each caller (host, runtime
 * binding, plugin, UI) gets its own token; the token decides which member it speaks for.
 */
export const ROUTES = {
  manifest: "GET /v1/manifest", // {api, space, me, members, agents}
  members: "GET /v1/members",
  agents: "GET /v1/agents",
  deliver: "POST /v1/agents/:id/deliver", // DeliverRequest → DeliverResult
  cancel: "POST /v1/agents/:id/cancel",
  events: "GET /v1/events?after=&limit=&workspace=&type=", // {events, next}
  stream: "GET /v1/events/stream?after=", // Server-Sent Events, one AshEvent per `data:`
  timersList: "GET /v1/timers",
  timersSet: "POST /v1/timers", // TimerRequest → Timer
  timersCancel: "DELETE /v1/timers/:id",
  notify: "POST /v1/notify", // NotifyRequest
  /** System services for one agent as an MCP server (Streamable HTTP, JSON responses). */
  mcp: "POST /mcp/:agent", // header x-ash-token: <that agent's token>
} as const;

/** Names of the system-service tools every MCP-capable agent gets (prefixed by the runtime, e.g. mcp__ash__send). */
export const SYSTEM_TOOLS = ["members", "send", "timer_set", "timer_list", "timer_cancel", "notify", "log"] as const;

export class AshApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}
