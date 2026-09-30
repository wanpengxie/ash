import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshHost } from "../../packages/dsh-binding/src/host";

export type Request = { system: string; messages: { role: string; content: unknown }[]; tools: unknown[]; model: string };

export type ScriptedReply = string | { tool: string; input: Record<string, unknown> };

export async function startHarness(reply: (request: Request) => ScriptedReply) {
  const root = process.env.ASH_TEST_DSH_ROOT;
  assert.ok(root, "set ASH_TEST_DSH_ROOT to the installed DSH package directory");
  assert.ok(existsSync(join(root, "package.json")), "DSH install missing; set ASH_TEST_DSH_ROOT");
  assert.ok(process.execArgv.includes("--expose-internals"), "run node with --expose-internals");
  const requests: Request[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const data = JSON.parse(body || "{}");
      const request: Request = { system: Array.isArray(data.system) ? data.system.map((x: { text?: string }) => x.text ?? "").join("\n") : String(data.system ?? ""), messages: data.messages ?? [], tools: data.tools ?? [], model: data.model };
      requests.push(request);
      const value = reply(request);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, payload: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      ev("message_start", { message: { id: "msg_spike", type: "message", role: "assistant", model: data.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (typeof value === "string") {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: value } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${requests.length}`, name: value.tool, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(value.input) } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: typeof value === "string" ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "ash-dsh-spike-"));
  process.env.DEEPSEEK_API_KEY = "sk-spike-local";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}/anthropic`;
  const host = new DshHost({ root, home: join(dir, "dsh-home"), env: { DSH_PERMISSION_MODE: "danger-full-access", DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-spike-local", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic` } }, () => {});
  try {
    await host.boot();
  } catch (error) {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { host, requests, dir, port, async close() { await host.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); } };
}

export function requestText(request: Request): string {
  return request.messages.flatMap((message) => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "") : []).join("\n");
}

export async function waitForTurn(host: DshHost, sessionId: string, send: () => void): Promise<{ text: string; events: string[] }> {
  return new Promise((resolve, reject) => {
    let text = "";
    const events: string[] = [];
    const timer = setTimeout(() => { off(); reject(new Error(`turn timeout for ${sessionId}`)); }, 20_000);
    const off = host.onSessionEvent((id, event) => {
      if (id !== sessionId) return;
      events.push(event.type);
      if (event.type === "assistant/message") text += (event.data.message?.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("");
      if (event.type === "turn/end") { clearTimeout(timer); off(); resolve({ text, events }); }
    });
    send();
  });
}
