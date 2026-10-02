// The closing text is dropped only when it repeats words the owner already received through ash_say.
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

test("a failed ash_say keeps its closing text; a delivered multi-paragraph ash_say is not repeated", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-say-dedupe-"));
  const home = join(root, "home"); mkdirSync(home);
  // Per owner input: one ash_say call, then closing text identical to what it tried to say.
  const plans: Record<string, { input: object; closing: string }> = {
    BAD_KIND: { input: { text: "tool said", kind: "notice" }, closing: "tool said" },
    TWO_PARAS: { input: { text: "para one\n\npara two" }, closing: "para one\n\npara two" },
  };
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; messages?: { role: string; content: unknown }[]; model?: string };
      const messages = request.messages ?? [];
      const text = JSON.stringify(messages);
      const main = Boolean(request.tools?.length) && !text.includes("This is your private mind space");
      const key = Object.keys(plans).filter((name) => text.includes(name)).at(-1);
      const last = messages.at(-1);
      const afterTool = Array.isArray(last?.content) && (last.content as { type?: string }[]).some((part) => part.type === "tool_result");
      const plan = main && key ? plans[key] : undefined;
      const toolUse = Boolean(plan) && !afterTool;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_dedupe", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (toolUse) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${key}`, name: "ash_say", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(plan!.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: plan ? plan.closing : "ok" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: toolUse ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/anthropic` } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const all = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    const turn = async (text: string, n: number) => {
      await fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text }, client_id: `dedupe-${n}` }) });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && all().filter((message) => message.word === "turn.end" && message.from === "agent:main").length < n)
        await new Promise((resolve) => setTimeout(resolve, 30));
      const ends = all().filter((message) => message.word === "turn.end" && message.from === "agent:main");
      assert.equal(ends.length, n);
      return all().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say" &&
        message.kind === "request" && message.turn === ends.at(-1)!.body.turn).map((message) => message.body.text);
    };
    assert.deepEqual(await turn("BAD_KIND", 1), ["tool said"], "the failed ash_say's words still reach the owner once");
    assert.deepEqual(await turn("TWO_PARAS", 2), ["para one\n\npara two"], "two paragraphs said through ash_say are not sent again");
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
