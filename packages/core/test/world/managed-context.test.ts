// F-A14: after a managed file changes, the next turn's context says who changed which file and how; later turns do not repeat it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("a managed-file change reaches the next turn's context once, with author, file and summary", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-managed-context-"));
  const home = join(root, "home"); mkdirSync(home);
  writeFileSync(join(home, "SOUL.md"), "OLD_SOUL_MARKER\n");
  const turns: string[] = []; // the newest owner-side input of each main turn
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { tools?: unknown[]; messages?: { role: string; content: unknown }[]; model?: string };
      const messages = request.messages ?? [];
      const main = Boolean(request.tools?.length) && !JSON.stringify(messages).includes("This is your private mind space");
      const lastAssistant = messages.map((message) => message.role).lastIndexOf("assistant");
      if (main) turns.push(JSON.stringify(messages.slice(lastAssistant + 1)));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_ctx", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
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
    const send = async (body: object) => (await (await fetch(`${running!.url}/api/send`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { reply?: { body: { ok: boolean } } };
    const completed = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 })
      .filter((message) => message.from === "agent:main" && message.word === "turn.end" && message.body.reason === "completed").length;
    const turn = async (text: string, n: number) => {
      await send({ to: "agent:main", kind: "request", word: "say", body: { text }, client_id: `ctx-${n}` });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && completed() < n) await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(completed(), n);
    };
    // A device that gains a capability mid-conversation: the next turn states the current list.
    const caps = [{ name: "clipboard.get", description: "Read the clipboard", label: "读剪贴板", risk: "none" as const, input_schema: { type: "object", properties: {}, additionalProperties: false } }];
    running.members.registerDevice({ id: "device:phone", kind: "device", name: "Test phone", online: true, capabilities: () => caps,
      handle: () => ({ ok: true, result: {} }) } as never);
    await turn("first", 1);
    const written = await send({ to: "service:self", kind: "request", word: "write", wait: true, client_id: "ctx-soul",
      body: { path: "SOUL.md", content: "NEW_SOUL_MARKER\n", why: "owner edit", expected_hash: createHash("sha256").update("OLD_SOUL_MARKER\n").digest("hex") } });
    assert.equal(written.reply?.body.ok, true);
    const changed = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 }).filter((message) => message.word === "self.changed" && message.body.path === "SOUL.md");
    assert.equal(changed.length, 1);
    caps.push({ name: "calendar.search", description: "Search the calendar", label: "看日历", risk: "none", input_schema: { type: "object", properties: {}, additionalProperties: false } });
    // The host's manifest changed (calendar permission granted): the core replaces the device member.
    running.members.replaceDevice({ id: "device:phone", kind: "device", name: "Test phone", online: true, capabilities: () => caps,
      handle: () => ({ ok: true, result: {} }) } as never);
    await turn("second", 2);
    await turn("third", 3);
    assert.equal(turns.length, 3);
    const [, second, third] = turns;
    assert.ok(second.includes("NEW_SOUL_MARKER") && !second.includes("OLD_SOUL_MARKER"), "the next turn sees the new content");
    for (const part of ["self.changed", "SOUL.md", `by ${changed[0].body.by}`, String(changed[0].body.summary)]) assert.ok(second.includes(part), `next turn names ${part}`);
    assert.ok(!third.includes("self.changed"), "a later turn does not repeat the change");
    const devicesOf = (text: string) => { const at = text.indexOf("Devices now"); return at < 0 ? "" : text.slice(at, text.indexOf("[ash] ", at)); };
    assert.match(devicesOf(turns[0]), /device:phone[^]*clipboard\.get/);
    assert.ok(!devicesOf(turns[0]).includes("calendar.search"));
    assert.match(devicesOf(second), /calendar\.search/, "a capability granted mid-conversation is visible on the next turn");
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
