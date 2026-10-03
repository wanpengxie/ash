// ACP superset for ash: the official ACP bridge keeps every standard method; this plugin owns stdin/stdout,
// answers ash's extension methods (_ash/steer, _ash/inject) through the live Agent, and passes everything else through.
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

export const name = "dsh-ash-control";
export const inject = ["agents", "llm", "sessionPersistence", "sessions", "acpAppStartup"];

export async function apply(ctx, config) {
  const req = createRequire(realpathSync(process.argv[1]));
  const acpPath = req.resolve("@deepseek-ai/dsh-acp");
  const sdkPath = createRequire(acpPath).resolve("@agentclientprotocol/sdk");
  const acp = await import(pathToFileURL(acpPath).href);
  const { ndJsonStream } = await import(pathToFileURL(sdkPath).href);
  // DSH's own constructor gives each message the identity a stored session needs to load again.
  const { createUserMessage } = await import(pathToFileURL(createRequire(acpPath).resolve("@deepseek-ai/dsh-llm")).href);

  // One writer for stdout: ACP frames and our own replies never interleave mid-line.
  const out = (line) => process.stdout.write(line.endsWith("\n") ? line : line + "\n");
  let feed;
  const input = new ReadableStream({ start(controller) { feed = controller; } });
  const output = new WritableStream({ write(chunk) { out(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); } });
  const encoder = new TextEncoder();

  const reply = (id, result, error) => out(JSON.stringify(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }));
  const extension = (msg) => {
    const { sessionId, content } = msg.params ?? {};
    const agent = typeof sessionId === "string" ? ctx.agents.get(sessionId) : undefined;
    if (!agent) return reply(msg.id, undefined, { code: -32602, message: `unknown session: ${sessionId}` });
    if (!Array.isArray(content) || !content.length) return reply(msg.id, undefined, { code: -32602, message: "content must be a non-empty array" });
    // A steer is the owner speaking; injected context is ash's own producer kind (DSH retired the generic "plugin" kind).
    const message = createUserMessage({ content, source: { kind: msg.method === "_ash/steer" ? "user" : "ash-context" } });
    // A steer only joins work in progress. An idle agent would start a turn nobody is watching, so ash keeps the words
    // for its next prompt instead.
    if (msg.method === "_ash/steer") {
      if (agent.status !== "running") return reply(msg.id, { steered: false });
      agent.steer(message);
      return reply(msg.id, { steered: true });
    }
    agent.inject(message);
    reply(msg.id, {});
  };

  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg?.method === "string" && (msg.method === "_ash/steer" || msg.method === "_ash/inject")) return extension(msg);
    feed.enqueue(encoder.encode(line + "\n"));
  });
  lines.on("close", () => { try { feed.close(); } catch {} });

  acp.apply(ctx, { ...config, stream: ndJsonStream(output, input) });
}
