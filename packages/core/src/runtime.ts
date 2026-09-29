// Agent runtime adapter: how ash drives one kind of agent world (DSH first).
//
// ash owns the agent's identity, queue, workspace and event log; the runtime owns the
// thinking. An adapter declares what it can do (RuntimeCapabilities) and ash only uses
// what is declared. Adding Claude Code, Codex, Pi … means adding an adapter.

import type { RuntimeCapabilities } from "../../sdk/src/api";

export interface RuntimeContext {
  agentId: string; // "agent:main"
  workspaceDir: string;
  stateDir: string; // private dir for the adapter's own state (session ids …)
  /** ash system services for this agent, as an MCP server the runtime can mount. */
  mcp: { url: string; headers: Record<string, string> };
  log: (...a: unknown[]) => void;
}

export interface InboundMessage {
  message_id: string;
  from: string;
  text: string;
  mode: "queue" | "steer";
}

/** Normalized things that happen inside one turn; ash writes them to the event log. */
export type RuntimeEvent =
  | { type: "text"; text: string }
  | { type: "tool.call"; name: string; args: unknown }
  | { type: "tool.result"; name: string; ok: boolean; preview: string };

export interface TurnResult {
  reason: "completed" | "error" | "cancelled";
  error?: string;
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
