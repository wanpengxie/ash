// SDK contract tests, group 2: the DSH binding against an installed DSH (run for every DSH
// release). DSH runs in-process, exactly as on the phone; the model is a scripted
// Anthropic-compatible mock, so no key and no network are needed.
//
//   ASH_TEST_DSH_ROOT=/…/lib/node_modules/@deepseek-ai/dsh  npm test
// (skipped when no DSH install is found; node must run with --expose-internals)

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { AshEvent } from "../../sdk/src/api";
import { AshClient } from "../../sdk/src/client";
import { OWNER } from "../../core/src/core";
import { type Running, startOwner } from "../../core/test/legacy/main";

const ROOT = process.env.ASH_TEST_DSH_ROOT ?? join(homedir(), "ashwork/dsh020/linux/lib/node_modules/@deepseek-ai/dsh");
const skip = !existsSync(join(ROOT, "package.json")) ? "no DSH install (set ASH_TEST_DSH_ROOT)" : !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

// ------------------------------------------------------------------ scripted model

type Plan = { tool: string; input: Record<string, unknown> } | { text: string };
const plans: Plan[] = [];
const seen: { system: string; tools: string[]; lastUser: string; toolResults: string[]; images: number }[] = [];
let mock: Server;

function startMock(): Promise<number> {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) {
        res.writeHead(404).end("{}");
        return;
      }
      const p = JSON.parse(body || "{}");
      const tools: string[] = (p.tools ?? []).map((t: { name: string }) => t.name);
      const system = Array.isArray(p.system) ? p.system.map((b: { text?: string }) => b.text ?? "").join("\n") : String(p.system ?? "");
      const texts = (p.messages ?? []).flatMap((m: { role: string; content: unknown }) => (m.role === "user" ? (typeof m.content === "string" ? [m.content] : (m.content as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "")) : []));
      const last = p.messages?.at(-1);
      const toolResults = Array.isArray(last?.content) ? last.content.filter((b: { type: string }) => b.type === "tool_result").map((b: { content: unknown }) => JSON.stringify(b.content)) : [];
      // Title generation and other helper calls come without tools.
      const plan: Plan = tools.length === 0 ? { text: "title" } : (plans.shift() ?? { text: "done" });
      const images = (p.messages ?? []).reduce((n: number, m: { content: unknown }) => n + (Array.isArray(m.content) ? (m.content as { type: string }[]).filter((b) => b.type === "image").length : 0), 0);
      if (tools.length) seen.push({ system, tools, lastUser: texts.join("\n"), toolResults, images });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: "msg_x", type: "message", role: "assistant", model: p.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if ("tool" in plan) {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${Math.random().toString(36).slice(2)}`, name: plan.tool, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(plan.input) } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: plan.text } });
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      }
      ev("message_stop", {});
      res.end();
    });
  });
  return new Promise((r) => mock.listen(0, "127.0.0.1", () => r((mock.address() as { port: number }).port)));
}

// ------------------------------------------------------------------ ash with DSH

let run: Running;
let ash: AshClient;
let stateDir: string;
const calls: { capability: string; caller: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: (e: AshEvent) => boolean, after = 0, ms = 20_000): Promise<AshEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = (await ash.events({ after, limit: 1000 })).events.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error("event not seen in time");
}
const lastSeq = async () => (await ash.events({ limit: 1000 })).events.at(-1)?.seq ?? 0;

async function boot(dir: string) {
  const port = (mock.address() as { port: number }).port;
  run = await startOwner({
    space: "t",
    owner: "Tester",
    listen: "127.0.0.1:0",
    stateDir: join(dir, "state"),
    workspaces: { home: join(dir, "home") },
    dsh: { root: ROOT, home: join(dir, "dsh-home"), env: { DSH_PERMISSION_MODE: "danger-full-access", DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic` } },
    agents: [
      { id: "agent:main", name: "Ash", runtime: "dsh", grants: ["*"] },
      { id: "agent:helper", runtime: "echo" },
    ],
    policy: { maxStepsPerTurn: 4, confirmTtlMs: 5000 },
  });
  ash = new AshClient(run.url, Object.entries(run.tokens.api).find(([, m]) => m === OWNER)![0]);
  run.core.devices.upsert(
    { id: "device:lab", name: "Lab Mac", kind: "laptop", online: true, via: "local", permissions: ["expose_capability"], capabilities: [{ name: "files.list", description: "list files", input_schema: { type: "object", properties: { dir: { type: "string" } } } }] },
    {
      call: async (capability, _args, ctx) => {
        calls.push({ capability, caller: ctx.caller });
        return { ok: true, content: [{ type: "text", text: "a.txt b.txt" }] };
      },
    },
  );
}

before(async () => {
  if (skip) return;
  await startMock();
  stateDir = mkdtempSync(join(tmpdir(), "ash-dsh-"));
  await boot(stateDir);
});

after(async () => {
  await run?.close();
  mock?.close();
});

test("the DSH agent starts in-process with every control capability", { skip }, async () => {
  const m = await ash.manifest();
  const main = m.agents.find((a) => a.id === "agent:main")!;
  assert.equal(main.runtime, "dsh");
  assert.equal(main.status, "idle");
  assert.ok(main.handle?.startsWith("session-"));
  for (const v of Object.values(main.capabilities)) assert.equal(v, true);
});

test("a turn: origin line, ash context in the system prompt, native ash_* tool, device tool", { skip }, async () => {
  plans.push({ tool: "ash_timer_set", input: { text: "check the oven", in_seconds: 600 } }, { tool: "lab_mac__files_list", input: { dir: "/" } }, { text: "all set" });
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: "remind me about the oven" });
  await waitFor((e) => e.type === "agent.text" && e.data.text === "all set", from);
  const first = seen.at(-3)!;
  assert.match(first.system, /# ash/);
  assert.match(first.system, /You are Ash \(agent:main\)/);
  assert.match(first.lastUser, /\[ash\] .* the owner is talking to you/);
  assert.ok(first.tools.includes("ash_timer_set"));
  assert.ok(first.tools.includes("lab_mac__files_list"));
  await waitFor((e) => e.type === "timer.set" && (e.data.timer as { text: string }).text === "check the oven", from);
  assert.deepEqual(calls.at(-1), { capability: "files.list", caller: "agent:main" });
  assert.match(seen.at(-1)!.toolResults.join(""), /a\.txt b\.txt/);
  const ended = await waitFor((e) => e.type === "agent.turn.ended", from);
  assert.equal(ended.data.reason, "completed");
});

test("an attached image reaches the model as an image; other files are named by path", { skip }, async () => {
  plans.push({ text: "nice picture" });
  const from = await lastSeq();
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await ash.deliver("agent:main", { text: "what is this?", attachments: [{ name: "dot.png", mime_type: "image/png", data: png }, { name: "a.csv", mime_type: "text/csv", data: Buffer.from("x,y").toString("base64") }] });
  await waitFor((e) => e.type === "agent.text" && e.data.text === "nice picture", from);
  const last = seen.at(-1)!;
  assert.ok(last.images >= 1, "image block sent to the model");
  assert.match(last.lastUser, /inbox\/.*a\.csv/);
});

test("devices appear and disappear as tools while the agent runs", { skip }, async () => {
  run.core.devices.setOnline("device:lab", false);
  plans.push({ text: "ok" });
  let from = await lastSeq();
  await ash.deliver("agent:main", { text: "what can you use?" });
  await waitFor((e) => e.type === "agent.turn.ended", from);
  assert.ok(!seen.at(-1)!.tools.includes("lab_mac__files_list"));
  run.core.devices.setOnline("device:lab", true);
  plans.push({ text: "ok" });
  from = await lastSeq();
  await ash.deliver("agent:main", { text: "and now?" });
  await waitFor((e) => e.type === "agent.turn.ended", from);
  assert.ok(seen.at(-1)!.tools.includes("lab_mac__files_list"));
});

test("sensitive DSH tools from an untrusted origin ask the owner (denied here)", { skip }, async () => {
  const bash = seen.at(-1)!.tools.find((t) => t === "bash" || t === "Bash" || t.startsWith("bash")) ?? "bash";
  plans.push({ tool: bash, input: { command: "echo hi", description: "say hi" } }, { text: "understood" });
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: "please run echo hi", from: "agent:helper" });
  const asked = await waitFor((e) => e.type === "confirm.requested", from);
  assert.match((asked.data.confirmation as { title: string }).title, /agent:helper|helper/);
  await ash.answer((asked.data.confirmation as { id: string }).id, false);
  await waitFor((e) => e.type === "agent.text" && e.data.text === "understood", from);
  assert.match(seen.at(-1)!.toolResults.join(""), /declined/);
  assert.match(seen.at(-2)!.lastUser, /message from agent agent:helper/);
});

test("the loop gate stops a runaway turn at the step budget", { skip }, async () => {
  for (let i = 0; i < 10; i++) plans.push({ tool: "ash_whoami", input: {} });
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: "loop forever" });
  const ended = await waitFor((e) => e.type === "agent.turn.ended", from, 30_000);
  assert.notEqual(ended.data.reason, "completed");
  assert.ok(seen.some((s) => /step/.test(s.lastUser) && /\[ash\]/.test(s.lastUser)));
  plans.length = 0;
});

test("the session survives a restart (resume)", { skip }, async () => {
  const before = (await ash.agents()).find((a) => a.id === "agent:main")!.handle;
  await run.close();
  await boot(stateDir);
  const after = (await ash.agents()).find((a) => a.id === "agent:main")!;
  assert.equal(after.handle, before);
  assert.equal(after.status, "idle");
});
