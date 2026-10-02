// A turn in which the model repeats one tool call until DSH's detailed reminder appears must not block the next start.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("the session resumes after DSH reminded the model about a repeated tool call", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-repeat-"));
  const home = join(root, "home"); mkdirSync(home);
  let calls = 0;
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; messages?: unknown[]; model?: string };
      const main = Boolean(request.tools?.length) && !JSON.stringify(request.messages ?? []).includes("This is your private mind space");
      const repeat = main && calls < 6 && !JSON.stringify(request.messages ?? []).includes("SECOND_TURN_MARKER");
      if (repeat) calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_repeat", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (repeat) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_repeat_${calls}`, name: "ash_say", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ text: "same" }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: repeat ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const config = { stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "dsh" as const }],
    dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/anthropic` } } };
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    const turn = async (text: string, n: number) => {
      const token = Object.entries(running!.tokens.api).find(([, member]) => member === "person:owner")![0];
      await fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text }, client_id: `repeat-${n}` }) });
      const completed = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 }).filter((message) => message.word === "turn.end" && message.body.reason === "completed").length;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && completed() < n) await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(completed(), n);
    };
    running = await startOwner(config);
    await turn("say it", 1);
    assert.ok(calls >= 5, `the model repeated the call past DSH detailed-reminder threshold (${calls})`);
    await running.close(); running = null;
    running = await startOwner(config);
    await turn("SECOND_TURN_MARKER", 2);
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
