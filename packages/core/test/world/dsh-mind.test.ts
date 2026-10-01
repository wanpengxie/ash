import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("wake uses a second DSH session; only explicit ash_say reaches the owner", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-mind-"));
  const home = join(root, "home"); mkdirSync(home);
  const requests: { user: string; mind: boolean }[] = [];
  let serial = 0;
  const model = createServer(async (request, response) => {
    if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw) as { model?: string; messages?: { role: string; content: unknown }[] };
    const user = (input.messages ?? []).filter((item) => item.role === "user").map((item) => JSON.stringify(item.content)).join("\n");
    const mind = user.includes("MIND_WAKE_MARKER");
    requests.push({ user, mind });
    const last = input.messages?.at(-1);
    const toolResult = JSON.stringify(last?.content ?? "").includes("tool_result");
    const callTool = mind && !toolResult;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (kind: string, data: object) => response.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_mind_${++serial}`, type: "message", role: "assistant", model: input.model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (callTool) {
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_mind_say_1", name: "ash_say", input: {} } });
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ text: "MIND_PUBLIC_MESSAGE", kind: "heads_up" }) } });
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: mind ? "MIND_PRIVATE_OUTPUT" : "MAIN_VISIBLE_OUTPUT" } });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: callTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
    event("message_stop", {}); response.end();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = (model.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install!, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    const sessions = new Map<string, unknown[]>();
    const off = running.dsh!.onSessionEvent((id, event) => sessions.set(id, [...(sessions.get(id) ?? []), event]));
    const owner = { transport: "api" as const, transportPrincipal: "test-owner", member: "person:owner", local: true, remote: false, ownerProxy: true };
    const clock = { transport: "service" as const, transportPrincipal: "service:clock", member: "service:clock", local: true, remote: false, ownerProxy: false };
    const first = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "MAIN_FIRST" }, wait: true });
    assert.equal(first.reply?.body.ok, true);
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && !check()) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(check(), true, "timed out waiting for a DSH turn");
    };
    await until(() => running!.ledger.list().some((item) => item.word === "turn.end" && item.body.reason === "completed"));
    const wake = await running.world.send(clock, { to: "agent:main", kind: "request", word: "wake",
      body: { reason: "calendar", context: { marker: "MIND_WAKE_MARKER" } }, wait: true });
    assert.equal(wake.reply?.body.ok, true);
    const publicSays = running.ledger.list().filter((item) => item.from === "agent:main" && item.to === "person:owner" && item.kind === "request" && item.word === "say");
    assert.deepEqual(publicSays.map((item) => [item.body.text, item.body.kind]), [["MAIN_VISIBLE_OUTPUT", "reply"], ["MIND_PUBLIC_MESSAGE", "heads_up"]]);
    assert.equal(JSON.stringify(running.ledger.list()).includes("MIND_PRIVATE_OUTPUT"), false);
    const mainId = [...sessions].find(([, events]) => events.some((event) => JSON.stringify(event).includes(`core-`)))?.[0];
    const mindId = [...sessions].find(([, events]) => events.some((event) => JSON.stringify(event).includes(`wake-${wake.id}`)))?.[0];
    assert.ok(mainId && mindId && mainId !== mindId);
    assert.equal(JSON.stringify(sessions.get(mainId)).includes("MIND_WAKE_MARKER"), false);
    const second = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "MAIN_AFTER" }, wait: true });
    assert.equal(second.reply?.body.ok, true);
    await until(() => requests.filter((item) => !item.mind).length >= 2);
    assert.equal(requests.filter((item) => !item.mind).some((item) => item.user.includes("MIND_WAKE_MARKER")), false);
    off();
  } finally {
    await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
