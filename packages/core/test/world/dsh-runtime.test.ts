import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("production DSH main uses one bounded followup, routes its tool once, and splits only assistant text", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-main-"));
  const home = join(root, "home"); mkdirSync(home);
  const captured: { tools: string[]; user: string; toolResult: boolean }[] = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: { name: string }[]; messages?: { role: string; content: unknown }[]; model?: string };
      const tools = (request.tools ?? []).map((tool) => tool.name);
      const last = request.messages?.at(-1);
      const toolResult = Array.isArray(last?.content) && last.content.some((part: { type?: string }) => part.type === "tool_result");
      const user = (request.messages ?? []).filter((message) => message.role === "user").flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part: { type?: string }) => part.type === "text").map((part: { text?: string }) => part.text ?? "") : []).join("\n");
      if (tools.length) captured.push({ tools, user, toolResult });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_main", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (tools.length && !toolResult) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_main", name: "ash_say", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ text: "tool said" }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "first\n\nsecond\n\n```js\na()\n\nb()\n```" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: tools.length && !toolResult ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "synthetic input" }, client_id: "dsh-main-input" }) });
    assert.equal(response.status, 200);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.kind === "request" && message.word === "say").length < 4)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(captured.length, 2);
    assert.deepEqual(captured[0].tools.sort(), ["ash_describe", "ash_react", "ash_say", "ash_send", "ash_show"]);
    assert.equal(captured[1].toolResult, true);
    assert.match(captured[0].user, /synthetic input/);
    const says = running.ledger.list().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say" && message.kind === "request");
    assert.deepEqual(says.map((message) => message.body.text), ["tool said", "first", "second", "```js\na()\n\nb()\n```"]);
    assert.equal(new Set(says.map((message) => message.turn)).size, 1);
    assert.equal(running.ledger.list().filter((message) => message.word === "turn.end" && message.body.reason === "completed").length, 1);
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL during a real model request leaves a read turn trace and never blindly replays it", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-kill-"));
  mkdirSync(join(root, "home"));
  let requests = 0;
  let firstRequest!: () => void;
  const requested = new Promise<void>((resolve) => { firstRequest = resolve; });
  const model = createServer((req, res) => {
    if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; model?: string };
      if (request.tools?.length) { requests++; firstRequest(); return; } // hold the actual turn, not a helper title request
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_title", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "title" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      event("message_stop", {}); res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const childPath = fileURLToPath(new URL("./fixtures/dsh-kill-child.ts", import.meta.url));
  const launch = (phase: string) => fork(childPath, [], { execArgv: ["--expose-internals", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, TEST_ROOT: root, TEST_PHASE: phase, TEST_MODEL_URL: `http://127.0.0.1:${port}/anthropic`,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`, DEEPSEEK_API_KEY: "sk-synthetic", ASH_TEST_DSH_ROOT: install! } });
  let child = launch("first");
  let childError = "";
  child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
  const timeout = async <T>(label: string, promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout: ${childError}`)), 12_000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  try {
    const accepted = new Promise<{ type: string; status: number }>((resolve) => child.once("message", (message) => resolve(message as { type: string; status: number })));
    assert.deepEqual(await timeout("accepted", accepted), { type: "accepted", status: 200 });
    await timeout("provider request", requested);
    child.kill("SIGKILL");
    await timeout("first exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    child = launch("second");
    child.stderr?.on("data", (part) => { childError += String(part).slice(0, 1000); });
    const recovered = new Promise<{ type: string; turns: string[]; replies: unknown[] }>((resolve) => child.once("message", (message) => resolve(message as { type: string; turns: string[]; replies: unknown[] })));
    const result = await timeout("recovered", recovered);
    assert.equal(result.type, "recovered");
    assert.deepEqual(result.turns, ["error"]);
    assert.deepEqual(result.replies, []);
    await timeout("second exit", new Promise<void>((resolve) => child.once("exit", () => resolve())));
    assert.equal(requests, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
