export interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }
export type AgentEvent =
  | { type: "turn_started"; turn: string }
  | { type: "note"; turn: string; kind: "thinking" | "plan" | "text"; text: string }
  | { type: "tool"; turn: string; phase: "start" | "end"; name: string; summary?: string }
  | { type: "turn_ended"; turn: string; outcome: "ok" | "failed" | "interrupted" | "unknown"; reply: string; error?: string; usage?: unknown }
  | { type: "seed_updated"; seed: string }
  | { type: "ended"; reason: string };

export interface OpenOptions {
  cwd: string; seed?: string; model?: string; effort?: string; system?: string; tools: Tool[];
  onEvent(event: AgentEvent): void;
  /** Read-only discovery; absence means this runtime did not expose a catalog. */
  onModels?(models: { id: string; efforts?: string[] }[]): void;
  /** The turn is captured at receipt, never inferred when the async reply arrives. */
  onOutbound(call: { turn: string; requestId: string; tool: string; args: Record<string, unknown> }): Promise<unknown>;
}
export interface AgentSession {
  send(turn: string, text: string): Promise<void>;
  steer(turn: string, text: string): Promise<boolean>;
  interrupt(turn: string): Promise<void>;
  select(model?: string, effort?: string): Promise<void>;
  close(): Promise<void>;
}

export function checkTools(tools: Tool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (!["agent_list", "agent_ask", "agent_tell"].includes(tool.name) || names.has(tool.name)) throw new Error("unsupported or duplicate Ash tool");
    names.add(tool.name);
  }
}
