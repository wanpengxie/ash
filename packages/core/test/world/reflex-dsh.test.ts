import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";
import type { TrustedRouteContext } from "../../src/world/router";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;
const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic",
  local: true, remote: false, ownerProxy: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, name: string): Promise<void> {
  const end = Date.now() + 12_000;
  while (Date.now() < end) { if (predicate()) return; await sleep(20); }
  throw new Error(`${name} did not appear`);
}

test("real DSH turn: ambiguous owner messages stay queued and an explicit stop cancels a busy device turn", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-reflex-dsh-"));
  const home = join(root, "home"); mkdirSync(home);
  let entered!: () => void, release!: () => void;
  const deviceEntered = new Promise<void>((resolve) => { entered = resolve; });
  const deviceRelease = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, deviceSettled = false;
  const inputs: string[] = [];
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { messages?: unknown[]; tools?: unknown[]; model?: string };
      const hasTools = Boolean(request.tools?.length);
      if (hasTools) { calls++; inputs.push(JSON.stringify(request.messages ?? [])); }
      const first = hasTools && calls === 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_reflex_${calls}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (first) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_reflex_1", name: "ash_send", input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ to: "device:probe", word: "hold", body: {} }) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "next answer" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } });
      event("message_stop", {}); res.end();
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
    running.members.registerDevice({ id: "device:probe", kind: "device", name: "Synthetic probe", online: true,
      capabilities: () => [{ name: "hold", description: "Hold a controlled fake device operation", input_schema: { type: "object" as const, additionalProperties: false },
        result_schema: { type: "object" as const, properties: { done: { type: "boolean" as const } }, required: ["done"], additionalProperties: false },
        risk: "none" as const, label: "Synthetic wait" }],
      handle: async () => { entered(); await deviceRelease; deviceSettled = true; return { ok: true, result: { done: true } }; } });
    const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const access = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`,
      "content-type": "application/json" }, body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
        body: { member: "agent:main", scope: "device:probe/hold" }, wait: true }) });
    assert.equal(access.status, 200);
    assert.equal((await access.json() as { reply?: { body?: { ok?: boolean } } }).reply?.body?.ok, true);
    const rows = () => running!.ledger.list({ limit: 1000 });
    await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "start synthetic hold" }, wait: true });
    await deviceEntered;
    const ambiguous = await Promise.all(["别忘了明天带伞", "我停在楼下了"].map((text) =>
      running!.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text }, wait: true })));
    await until(() => ambiguous.every((sent) => rows().some((row) => row.word === "reflex.judged" && row.body.message_id === sent.id)), "ambiguous judgments");
    assert.equal(rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length, 0);
    const stop = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "停" }, wait: true });
    await until(() => rows().some((row) => row.word === "reflex.judged" && row.body.message_id === stop.id), "stop judgment");
    assert.equal(deviceSettled, false);
    const decision = rows().find((row) => row.word === "reflex.judged" && row.body.message_id === stop.id)!;
    assert.deepEqual(decision.body, { message_id: stop.id, stage: "keyword", intent: "stop", confidence: 1, acted: true });
    const cancel = rows().find((row) => row.word === "cancel_turn" && row.kind === "request")!;
    assert.ok(cancel.ts - running.ledger.byId(stop.id)!.ts < 1000, "reflex waited for the non-cooperative device");
    assert.equal(cancel.body.by, stop.id);
    assert.deepEqual(running.ledger.responseTo(cancel.id)?.body, { ok: true, result: { cancelled: true } });
    await until(() => inputs.some((input) => input.includes("我停在楼下了") && input.includes("Owner asked to stop")), "next model batch with stop fact");
    assert.ok(inputs.some((input) => input.includes("别忘了明天带伞") && input.includes("我停在楼下了") && input.includes("停")));
    release(); await sleep(40);
    assert.equal(rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length, 1);
    assert.equal(rows().filter((row) => row.word === "reflex.judged" && ambiguous.some((sent) => sent.id === row.body.message_id) && row.body.acted === false).length, 2);
  } finally {
    release(); await running?.close();
    model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
