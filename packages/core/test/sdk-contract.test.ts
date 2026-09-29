// SDK contract tests (group 1: core implements ash-api/1). Uses the echo runtime, which
// calls ash's MCP system services the same way a real agent does — no model needed.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AshClient, API_VERSION, type AshEvent } from "../../sdk/src/client";
import { startCore } from "../src/main";

let ash: AshClient;
let close: () => Promise<void>;
let base: string;
let mcpToken: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: (e: AshEvent) => boolean, after = 0, ms = 8000): Promise<AshEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = (await ash.events({ after, limit: 1000 })).events.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  throw new Error("event not seen in time");
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-core-"));
  const started = await startCore({
    space: "test",
    listen: "127.0.0.1:0",
    stateDir: join(dir, "state"),
    agents: [
      { id: "agent:main", runtime: "echo" },
      { id: "agent:helper", runtime: "echo" },
    ],
  });
  base = started.url;
  close = started.close;
  mcpToken = started.tokens.mcp["agent:main"];
  ash = new AshClient(base, Object.keys(started.tokens.api)[0]);
});

after(async () => close());

test("manifest describes the space, the caller and the agents with their capabilities", async () => {
  const m = await ash.manifest();
  assert.equal(m.api, API_VERSION);
  assert.equal(m.me, "person:owner");
  const main = m.agents.find((a) => a.id === "agent:main")!;
  assert.equal(main.runtime, "echo");
  assert.equal(main.status, "idle");
  assert.equal(main.capabilities.mcp_client, true);
  assert.equal(main.capabilities.loop_gate, false);
});

test("requests without a token are refused", async () => {
  assert.equal((await fetch(`${base}/v1/agents`)).status, 401);
  assert.equal((await fetch(`${base}/v1/agents`, { headers: { authorization: "Bearer nope" } })).status, 401);
});

test("deliver runs a turn and the log shows it end to end", async () => {
  const { next } = await ash.events();
  const r = await ash.deliver("agent:main", { text: "hello" });
  assert.equal(r.accepted, true);
  const text = await waitFor((e) => e.type === "agent.text" && e.data.message_id === r.message_id, next);
  assert.equal(text.data.text, "echo(person:owner): hello");
  const end = await waitFor((e) => e.type === "agent.turn.ended" && e.data.message_id === r.message_id, next);
  assert.equal(end.data.reason, "completed");
});

test("a retried message_id is accepted once", async () => {
  const a = await ash.deliver("agent:main", { text: "once", message_id: "fixed-1" });
  const b = await ash.deliver("agent:main", { text: "once", message_id: "fixed-1" });
  assert.equal(a.position >= 0, true);
  assert.equal(b.position, -1);
  await sleep(500);
  const turns = (await ash.events({ type: "agent.turn.started", limit: 1000 })).events.filter((e) => e.data.message_id === "fixed-1");
  assert.equal(turns.length, 1);
});

test("steer is refused when the runtime cannot steer", async () => {
  await assert.rejects(ash.deliver("agent:main", { text: "x", mode: "steer" }), /unsupported/);
});

test("messages queue behind a running turn and cancel stops it", async () => {
  const { next } = await ash.events();
  const slow = await ash.deliver("agent:main", { text: "slow" });
  await waitFor((e) => e.type === "agent.turn.started" && e.data.message_id === slow.message_id, next);
  const queued = await ash.deliver("agent:main", { text: "after" });
  assert.equal(queued.position, 1);
  assert.deepEqual(await ash.cancel("agent:main"), { cancelled: true });
  const end = await waitFor((e) => e.type === "agent.turn.ended" && e.data.message_id === slow.message_id, next);
  assert.equal(end.data.reason, "cancelled");
  await waitFor((e) => e.type === "agent.text" && e.data.text === "echo(person:owner): after", next);
});

test("an agent sets its own timer through MCP and gets the reminder delivered back", async () => {
  const { next } = await ash.events();
  await ash.deliver("agent:main", { text: 'tool:timer_set {"text":"drink water","in_seconds":1}' });
  const set = await waitFor((e) => e.type === "timer.set", next);
  assert.equal((set.data.timer as { owner: string }).owner, "agent:main");
  const fired = await waitFor((e) => e.type === "timer.fired", next);
  const id = (fired.data.timer as { id: string }).id;
  const back = await waitFor((e) => e.type === "agent.text" && String(e.data.text).includes("drink water"), next);
  assert.equal(back.data.text, `echo(timer:${id}): drink water`);
});

test("agents can message each other and notify the owner", async () => {
  const { next } = await ash.events();
  await ash.deliver("agent:main", { text: 'tool:send {"to":"agent:helper","text":"ping"}' });
  const got = await waitFor((e) => e.type === "agent.text" && e.member === "agent:helper", next);
  assert.equal(got.data.text, "echo(agent:main): ping");
  await ash.deliver("agent:main", { text: 'tool:notify {"title":"done","text":"all good"}' });
  const n = await waitFor((e) => e.type === "notify", next);
  assert.equal(n.member, "agent:main");
});

test("timers can also be managed over the SDK", async () => {
  const t = await ash.setTimer({ owner: "agent:helper", text: "later", in_seconds: 3600 });
  assert.equal((await ash.timers()).some((x) => x.id === t.id), true);
  assert.deepEqual(await ash.cancelTimer(t.id), { cancelled: true });
  assert.equal((await ash.timers()).some((x) => x.id === t.id), false);
});

test("the MCP endpoint requires that agent's token and lists the system tools", async () => {
  const call = (tok: string) =>
    fetch(`${base}/mcp/agent:main`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": tok }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await call("wrong")).status, 401);
  const body = (await (await call(mcpToken)).json()) as { result: { tools: { name: string }[] } };
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), ["log", "members", "notify", "send", "timer_cancel", "timer_list", "timer_set"]);
});

test("the event stream replays from a cursor and then follows live", async () => {
  const { next } = await ash.events();
  const seen: AshEvent[] = [];
  const stop = ash.stream((e) => seen.push(e), { after: next });
  await ash.deliver("agent:helper", { text: "streamed" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !seen.some((e) => e.type === "agent.turn.ended")) await sleep(100);
  stop();
  assert.ok(seen.some((e) => e.type === "agent.text" && e.data.text === "echo(person:owner): streamed"));
  assert.ok(seen.every((e, i) => i === 0 || e.seq > seen[i - 1].seq), "events arrive in order without repeats");
});
