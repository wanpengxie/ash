// DSH runtime: an ash agent backed by one DSH agent living in the in-process DSH world
// (see dsh/host.ts). Everything is a direct call — no HTTP, no polling:
//   deliver → agent.followup / agent.steer      cancel → agent.cancel
//   who is speaking → agent.inject (lands in the same model step, model-visible and logged)
//   what happens → the `session/event` feed (assistant messages, tool calls, turn ends)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type DshAgent, type DshHost, userMessage } from "../dsh/host";
import type { AgentRuntime, InboundMessage, RuntimeContext, RuntimeEvent, TurnResult } from "../runtime";

export class DshRuntime implements AgentRuntime {
  readonly kind = "dsh";
  readonly capabilities = {
    deliver_queue: true,
    deliver_steer: true,
    cancel: true,
    events_stream: true,
    resume: true,
    mcp_client: true,
    loop_gate: true, // agent/pre-step
    context_sections: true, // agent.inject (per step); system-prompt sections next
    tool_projection: true, // ash system services are native DSH tools (ash_*)
    approval_answerer: false, // next: answer dsh-user-approval requests from ash
  };
  private agent!: DshAgent;
  private sessionId = "";

  constructor(private readonly host: DshHost) {}

  handle(): string | undefined {
    return this.sessionId || undefined;
  }

  async start(ctx: RuntimeContext): Promise<void> {
    const file = join(ctx.stateDir, "dsh-session.json");
    const saved = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).sessionId as string) : undefined;
    const { agent, sessionId } = await this.host.agent(ctx.agentId, ctx.workspaceDir, saved);
    this.agent = agent;
    this.sessionId = sessionId;
    writeFileSync(file, JSON.stringify({ sessionId }));
    ctx.log(`DSH session ${sessionId}${saved === sessionId ? " (resumed)" : " (new)"}`);
  }

  runTurn(msg: InboundMessage, emit: (e: RuntimeEvent) => void, signal: AbortSignal): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      const dshId = randomUUID();
      const tools = new Map<string, string>();
      let mine = false;
      let done = false;
      const finish = (r: TurnResult) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        resolve(r);
      };
      const off = this.host.onSessionEvent((sid, e) => {
        if (sid !== this.sessionId || done) return;
        if (!mine) {
          if (e.type === "user/message" && e.data?.id === dshId) mine = true;
          return;
        }
        switch (e.type) {
          case "assistant/message": {
            const text = (e.data?.message?.content ?? [])
              .filter((c: { type: string }) => c.type === "text")
              .map((c: { text: string }) => c.text)
              .join("");
            if (text.trim()) emit({ type: "text", text });
            return;
          }
          case "tool/call":
            tools.set(e.data.callId, e.data.name);
            emit({ type: "tool.call", name: e.data.name, args: parse(e.data.arguments) });
            return;
          case "tool/result": {
            const m = e.data?.message ?? {};
            const preview = (m.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").slice(0, 300);
            emit({ type: "tool.result", name: tools.get(m.toolCallId) ?? "?", ok: !m.isError && !e.data?.error, preview });
            return;
          }
          case "turn/end": {
            const kind = e.data?.reason?.kind;
            if (kind === "completed") return finish({ reason: "completed" });
            if (kind === "interrupted" || kind === "cancelled") return finish({ reason: "cancelled" });
            return finish({ reason: "error", error: e.data?.reason?.error?.message ?? String(kind) });
          }
        }
      });
      const timer = setTimeout(() => finish({ reason: "error", error: "turn timed out" }), 15 * 60_000);
      signal.addEventListener("abort", () => this.agent.cancel("cancelled by ash"), { once: true });
      // Who is speaking is model-visible context for this step, not part of the user's words.
      const origin = describe(msg.from);
      if (origin) this.agent.inject(userMessage(`[ash] ${origin}`));
      this.agent.followup(userMessage(msg.text, dshId));
    });
  }

  async steer(msg: InboundMessage): Promise<void> {
    const origin = describe(msg.from);
    this.agent.steer(userMessage(origin ? `[ash] ${origin}\n${msg.text}` : msg.text));
  }

  async cancel(): Promise<void> {
    this.agent.cancel("cancelled by ash");
  }

  async stop(): Promise<void> {}
}

function describe(from: string): string | null {
  if (from === "person:owner") return null;
  if (from.startsWith("timer:")) return `这是你之前用 ash_timer_set 设的提醒（${from}）到点了，下面是提醒内容。`;
  if (from.startsWith("agent:")) return `下面这条消息来自同一空间里的另一个 Agent：${from}（用 ash_send 回复它）。`;
  if (from.startsWith("device:")) return `下面这条消息来自设备 ${from}。`;
  return `下面这条消息来自 ${from}。`;
}

function parse(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
