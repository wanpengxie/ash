// Test runtime: answers "echo: <text>" and, for messages starting with "tool:", calls one
// ash system service through MCP exactly like a real agent would — used by the SDK
// contract tests so they run without a model.

import { NO_CAPABILITIES, type AgentRuntime, type InboundMessage, type RuntimeContext, type RuntimeEvent, type TurnResult } from "../runtime";

export class EchoRuntime implements AgentRuntime {
  readonly kind = "echo";
  readonly capabilities = { ...NO_CAPABILITIES, deliver_queue: true, cancel: true, events_stream: true, mcp_client: true };
  private ctx!: RuntimeContext;
  private rpcId = 0;

  async start(ctx: RuntimeContext): Promise<void> {
    this.ctx = ctx;
    await this.mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "echo", version: "1" } });
  }

  async runTurn(msg: InboundMessage, emit: (e: RuntimeEvent) => void, signal: AbortSignal): Promise<TurnResult> {
    // "tool:<name> <json args>" → call an ash system tool
    const m = /^tool:(\w+)\s*(.*)$/s.exec(msg.text);
    if (m) {
      const args = m[2] ? JSON.parse(m[2]) : {};
      emit({ type: "tool.call", name: m[1], args });
      const r = (await this.mcp("tools/call", { name: m[1], arguments: args })) as { content?: { text: string }[]; isError?: boolean };
      const text = r.content?.[0]?.text ?? "";
      emit({ type: "tool.result", name: m[1], ok: !r.isError, preview: text.slice(0, 200) });
      emit({ type: "text", text: `done: ${text}` });
      return { reason: "completed" };
    }
    if (msg.text === "slow") {
      await new Promise((r, j) => {
        const t = setTimeout(r, 5000);
        signal.addEventListener("abort", () => (clearTimeout(t), j(new Error("cancelled"))));
      }).catch(() => undefined);
      if (signal.aborted) return { reason: "cancelled" };
    }
    emit({ type: "text", text: `echo(${msg.from}): ${msg.text}` });
    return { reason: "completed" };
  }

  async stop(): Promise<void> {}

  private async mcp(method: string, params: unknown): Promise<unknown> {
    const res = await fetch(this.ctx.mcp.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.ctx.mcp.headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.rpcId, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
}
