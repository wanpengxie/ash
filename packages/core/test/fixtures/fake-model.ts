import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

type Plan = { type: "text"; text: string } | { type: "tool"; name: string; input: unknown } | { type: "json"; value: unknown };
export class FakeModel {
  readonly requests: unknown[] = [];
  readonly plans: Plan[] = [];
  private server?: Server;
  url = "";
  text(value: string) { this.plans.push({ type: "text", text: value }); }
  tool(name: string, input: unknown) { this.plans.push({ type: "tool", name, input }); }
  json(value: unknown) { this.plans.push({ type: "json", value }); }
  assertDrained() { assert.equal(this.plans.length, 0, "unconsumed model plans"); }
  async start(): Promise<string> {
    assert.ok(!this.server, "model already running");
    let serial = 0;
    this.server = createServer(async (req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/messages")) { res.writeHead(404).end("{}"); return; }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let request: unknown;
      try { request = JSON.parse(raw); } catch { res.writeHead(400).end("{}"); return; }
      this.requests.push(request);
      const plan = this.plans.shift();
      if (!plan) { res.writeHead(409).end(JSON.stringify({ error: "unexpected_model_request" })); return; }
      const p = request as { model?: string; stream?: boolean };
      const block = plan.type === "tool" ? { type: "tool_use", id: `toolu_${++serial}`, name: plan.name, input: plan.input } : { type: "text", text: plan.type === "json" ? JSON.stringify(plan.value) : plan.text };
      const message = { id: `msg_${++serial}`, type: "message", role: "assistant", model: p.model, content: [block], stop_reason: plan.type === "tool" ? "tool_use" : "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
      if (!p.stream) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(message)); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { ...message, content: [], stop_reason: null } });
      ev("content_block_start", { index: 0, content_block: plan.type === "tool" ? { type: "tool_use", id: block.id, name: plan.name, input: {} } : { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: plan.type === "tool" ? { type: "input_json_delta", partial_json: JSON.stringify(plan.input) } : { type: "text_delta", text: (block as { text: string }).text } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 1 } });
      ev("message_stop", {});
      res.end();
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/anthropic`;
    return this.url;
  }
  async close() { if (this.server) { await new Promise<void>((resolve, reject) => this.server!.close(e => e ? reject(e) : resolve())); this.server = undefined; } }
}
