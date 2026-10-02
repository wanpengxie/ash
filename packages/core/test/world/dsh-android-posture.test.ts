// The phone runs DSH without a file sandbox (danger-full-access). Door tools must still work there, and a
// session holding workspace instructions must resume after a restart.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("door tools run under the phone's full-access posture and the session resumes after restart", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-phone-"));
  const home = join(root, "home"); mkdirSync(home);
  writeFileSync(join(home, "AGENTS.md"), "# Ash\n\nStanding brief.\n");
  const results: string[] = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: { name: string }[]; messages?: { role: string; content: unknown }[]; model?: string };
      const last = request.messages?.at(-1);
      const user = JSON.stringify(request.messages ?? []);
      const main = Boolean(request.tools?.length) && !user.includes("This is your private mind space");
      const result = Array.isArray(last?.content) ? last.content.find((part: { type?: string }) => part.type === "tool_result") : undefined;
      if (main && result) results.push(JSON.stringify(result));
      const toolUse = main && !result;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_phone", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (toolUse) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_phone_${results.length}`, name: "ash_say", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ text: "tool said" }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: toolUse ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  const config = { stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "dsh" as const }],
    dsh: { root: install!, home: join(root, "dsh"), env: { DSH_PERMISSION_MODE: "danger-full-access", DSH_TELEMETRY_DISABLED: "1",
      DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic` } } };
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner(config);
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const send = async (text: string, client_id: string) => {
      const response = await fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text }, client_id }) });
      assert.equal(response.status, 200);
      await response.json();
    };
    const completed = () => running!.ledger.list().filter((message) => message.from === "agent:main" && message.word === "turn.end" && message.body.reason === "completed").length;
    const waitFor = async (check: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await send("hello", "phone-1");
    await waitFor(() => completed() === 1);
    assert.equal(completed(), 1);
    assert.equal(results.length, 1);
    assert.doesNotMatch(results[0], /approval no longer valid|is_error":true/);
    const says = running.ledger.list().filter((message) => message.from === "agent:main" && message.word === "say" && message.kind === "request");
    assert.deepEqual(says.map((message) => message.body.text), ["tool said", "done"]);
    assert.equal(running.ledger.responseTo(says[0].id)?.body.ok, true);
    await running.close();
    running = null;
    running = await startOwner(config);
    await send("again", "phone-2");
    await waitFor(() => completed() === 2);
    assert.equal(completed(), 2);
    assert.equal(results.length, 2);
    assert.doesNotMatch(results[1], /approval no longer valid|is_error":true/);
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
