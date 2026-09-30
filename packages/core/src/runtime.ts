// Agent runtime adapter: how ash drives one kind of agent world (DSH first).
//
// ash owns the agent's identity, queue, workspace, devices, grants and event log; the
// runtime owns the thinking. Two handles cross between the worlds:
//   ① ash → runtime   this interface (start / runTurn / steer / cancel …)
//   ② runtime → ash   `RuntimeContext.ash`, an AgentPort scoped to exactly one agent
// An adapter declares what it can do (RuntimeCapabilities) and ash only uses what is declared.
// Adding Claude Code, Codex, Pi … means adding an adapter; DSH defines the ceiling.

import type {
  AshEvent,
  CallResult,
  CapabilitySpec,
  DeviceInfo,
  Grant,
  Identity,
  Member,
  NotifyRequest,
  RuntimeCapabilities,
  Timer,
  TimerRequest,
} from "../../sdk/src/api";

/** Where a message came from, resolved by ash (model-facing wording is the runtime's job). */
export interface Origin {
  member: string; // "person:owner", "device:<id>", "agent:<name>", "timer:<id>"
  kind: "owner" | "device" | "agent" | "timer" | "service";
  /** Human name: "Mac Chrome", "agent:research", "提醒 tmr_…" */
  name: string;
  /** Owner-level trust: the owner, the owner's own devices with web_ui, the agent's own timers. */
  trusted: boolean;
  /** The device may ask for sensitive actions (the owner still confirms). */
  mayRequestSensitive: boolean;
}

export interface InboundAttachment {
  name: string;
  mimeType: string;
  size: number;
  /** Absolute path of the saved file. */
  path: string;
  /** Path inside the agent's workspace. */
  rel: string;
}

export interface InboundMessage {
  message_id: string;
  from: string;
  origin: Origin;
  text: string;
  mode: "queue" | "steer";
  attachments?: InboundAttachment[];
}

/** Normalized things that happen inside one turn; ash writes them to the event log. */
export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "tool.call"; name: string; args: unknown }
  | { type: "tool.result"; name: string; ok: boolean; preview: string };

export interface TurnResult {
  reason: "completed" | "error" | "cancelled" | "blocked";
  error?: string;
}

/** Decision for one model step (loop gate). */
export type StepDecision = { allow: true } | { allow: false; reason: string };

/** Decision for one tool call inside the runtime (bash, write …) before it runs. */
export type ToolDecision = { allow: true } | { allow: false; reason: string };

/**
 * Handle ② — everything one agent may do in ash, always on its own behalf. The runtime binding
 * exposes it to the agent (DSH: `ctx.ash` + native `ash_*` tools + projected device tools).
 */
export interface AgentPort {
  readonly agentId: string;
  readonly space: string;
  whoami(): Identity;
  members(): Member[];
  /** Devices with the capabilities this agent is granted (others are listed without them). */
  devices(): DeviceInfo[];
  call(device: string, capability: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult>;
  send(to: string, text: string): { message_id: string };
  setTimer(req: TimerRequest): Timer;
  listTimers(): Timer[];
  cancelTimer(id: string): { cancelled: boolean };
  notify(req: NotifyRequest): Promise<{ ok: true }>;
  log(limit: number): AshEvent[];
  grants(): Grant[];
  requestGrant(scope: string, reason: string): Promise<{ granted: boolean }>;
  /** Ask the owner a yes/no question (sensitive action). Resolves when answered or expired. */
  confirm(title: string, detail: string, kind?: "tool" | "other", signal?: AbortSignal): Promise<boolean>;
  /** The message the agent is working on right now (who is speaking). */
  currentOrigin(): Origin | null;
  /** Loop gate: called before every model step. */
  gateStep(): StepDecision;
  /** Tool gate: called before a runtime-native tool runs (bash, write, …). */
  gateTool(name: string, args: unknown, signal?: AbortSignal): Promise<ToolDecision>;
  /** Model-facing context ash owns (identity, members, devices …), rendered as text. */
  contextSections(): { identity: string; state: string };
  /** Device capabilities changed (online, offline, granted, revoked): re-project tools. */
  onCapabilitiesChanged(fn: () => void): () => void;
  /** Every capability this agent may call right now, flattened for projection into tools. */
  projectedCapabilities(): { device: DeviceInfo; capability: CapabilitySpec }[];
}

export interface RuntimeContext {
  agentId: string; // "agent:main"
  name: string;
  workspaceDir: string;
  stateDir: string; // private dir for the adapter's own state (session ids …)
  /** Handle ② for in-process runtimes. */
  ash: AgentPort;
  /** The same services as an MCP server, for out-of-process runtimes. */
  mcp: { url: string; headers: Record<string, string> };
  log: (...a: unknown[]) => void;
}

export interface AgentRuntime {
  readonly kind: string;
  readonly capabilities: RuntimeCapabilities;
  /** Prepare (create or resume the conversation). Called once before the first turn. */
  start(ctx: RuntimeContext): Promise<void>;
  /** Run one turn for a queued message; stream what happens through `emit`. */
  runTurn(msg: InboundMessage, emit: (e: RuntimeEvent) => void, signal: AbortSignal): Promise<TurnResult>;
  /** Inject into the running turn (only if capabilities.deliver_steer). */
  steer?(msg: InboundMessage): Promise<void>;
  cancel?(): Promise<void>;
  /** Runtime-side handle for tooling (e.g. DSH session id). */
  handle?(): string | undefined;
  /** Model in use, when the runtime can tell. */
  model?(): string | undefined;
  stop(): Promise<void>;
}

export const NO_CAPABILITIES: RuntimeCapabilities = {
  deliver_queue: false,
  deliver_steer: false,
  cancel: false,
  events_stream: false,
  resume: false,
  mcp_client: false,
  loop_gate: false,
  context_sections: false,
  tool_projection: false,
  approval_answerer: false,
};
