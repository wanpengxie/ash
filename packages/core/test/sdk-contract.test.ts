// SDK contract tests, group 1: ash core implements `ash-api/1`. Uses the echo runtime (which
// calls ash's MCP projection exactly like an out-of-process agent would) and a fake device,
// so no model and no phone are needed.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { API_VERSION, type AshEvent } from "../../sdk/src/api";
import { AshClient } from "../../sdk/src/client";
import { OWNER } from "../src/core";
import { type Running, startOwner } from "../src/main";

let ash: AshClient;
let run: Running;
let base: string;
let mcpToken: string;
const calls: { capability: string; args: unknown; caller: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: (e: AshEvent) => boolean, after = 0, ms = 8000): Promise<AshEvent> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = (await ash.events({ after, limit: 1000 })).events.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  throw new Error("event not seen in time");
}

const lastSeq = async () => {
  const all = await ash.events({ limit: 1000 });
  return all.events.at(-1)?.seq ?? 0;
};

async function mcp(method: string, params: unknown = {}, agent = "agent:main", token = mcpToken) {
  const r = await fetch(`${base}/mcp/${agent}`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as any) : null };
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-core-"));
  run = await startOwner({
    space: "test",
    owner: "Tester",
    listen: "127.0.0.1:0",
    stateDir: join(dir, "state"),
    agents: [
      { id: "agent:main", name: "Ash", runtime: "echo", grants: ["*"] },
      { id: "agent:helper", runtime: "echo" },
    ],
    policy: { confirmTtlMs: 3000 },
  });
  base = run.url;
  mcpToken = run.tokens.mcp["agent:main"];
  ash = new AshClient(base, Object.entries(run.tokens.api).find(([, m]) => m === OWNER)![0]);
  // A fake device with one plain and one confirm-first capability.
  run.core.devices.upsert(
    {
      id: "device:lab",
      name: "Lab Mac",
      kind: "laptop",
      online: true,
      via: "local",
      permissions: ["expose_capability"],
      capabilities: [
        { name: "files.list", description: "list files", input_schema: { type: "object", properties: { dir: { type: "string" } } } },
        { name: "shell.run", description: "run a command", input_schema: { type: "object", properties: { cmd: { type: "string" } } }, confirm: true },
      ],
    },
    {
      call: async (capability, args, ctx) => {
        calls.push({ capability, args, caller: ctx.caller });
        return { ok: true, content: [{ type: "text", text: `${capability} ran` }] };
      },
    },
  );
});

after(async () => run.close());

test("manifest describes the space, the caller, agents and devices", async () => {
  const m = await ash.manifest();
  assert.equal(m.api, API_VERSION);
  assert.equal(m.me, OWNER);
  assert.equal(m.caller.manage, true);
  const main = m.agents.find((a) => a.id === "agent:main")!;
  assert.equal(main.runtime, "echo");
  assert.equal(main.name, "Ash");
  assert.equal(main.capabilities.mcp_client, true);
  assert.equal(main.capabilities.loop_gate, false);
  assert.ok(m.devices.some((d) => d.id === "device:lab"));
  assert.ok(m.members.some((x) => x.id === "device:lab" && x.kind === "device"));
});

test("requests without a token are refused; the UI trades its token for a cookie", async () => {
  assert.equal((await fetch(`${base}/api/agents`)).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 401);
  const tok = Object.entries(run.tokens.api).find(([, m]) => m === OWNER)![0];
  const r = await fetch(`${base}/?token=${tok}`, { redirect: "manual" });
  assert.equal(r.status, 303);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const page = await fetch(`${base}/`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Ash<\/title>/);
  assert.equal((await fetch(`${base}/api/manifest`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200);
});

test("deliver → the agent answers; retries with the same message_id are accepted once", async () => {
  const from = await lastSeq();
  const r = await ash.deliver("agent:main", { text: "hello", message_id: "m-1" });
  assert.equal(r.accepted, true);
  const again = await ash.deliver("agent:main", { text: "hello", message_id: "m-1" });
  assert.equal(again.position, -1);
  const reply = await waitFor((e) => e.type === "agent.text" && String(e.data.text).includes("hello"), from);
  assert.equal(reply.member, "agent:main");
  await waitFor((e) => e.type === "agent.turn.ended" && e.data.message_id === "m-1", from);
});

test("steer is refused when the runtime cannot steer; cancel stops a running turn", async () => {
  await assert.rejects(ash.deliver("agent:main", { text: "x", mode: "steer" }), /cannot steer/);
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: "slow" });
  await waitFor((e) => e.type === "agent.status" && e.data.status === "running", from);
  assert.deepEqual(await ash.cancel("agent:main"), { cancelled: true });
  const ended = await waitFor((e) => e.type === "agent.turn.ended" && e.data.reason === "cancelled", from);
  assert.ok(ended);
});

test("MCP projection lists system tools and granted device capabilities, and runs them as the agent", async () => {
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.match(init.body.result.instructions, /ash space "test"/);
  const list = await mcp("tools/list");
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  for (const n of ["whoami", "devices", "call", "send", "timer_set", "notify", "request_grant"]) assert.ok(names.includes(n), n);
  assert.ok(names.includes("lab_mac__files_list"), "device tool projected");
  const who = await mcp("tools/call", { name: "whoami", arguments: {} });
  assert.match(who.body.result.content[0].text, /agent:main/);
  const r = await mcp("tools/call", { name: "lab_mac__files_list", arguments: { dir: "/" } });
  assert.equal(r.body.result.isError, false);
  assert.equal(calls.at(-1)!.caller, "agent:main");
  // helper has no grants: no device tools, and calls are refused
  const hList = await mcp("tools/list", {}, "agent:helper", run.tokens.mcp["agent:helper"]);
  assert.ok(!hList.body.result.tools.some((t: { name: string }) => t.name.startsWith("lab_mac__")));
  const denied = await mcp("tools/call", { name: "call", arguments: { device: "device:lab", capability: "files.list" } }, "agent:helper", run.tokens.mcp["agent:helper"]);
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /not granted/);
  // wrong token
  assert.equal((await mcp("tools/list", {}, "agent:main", "nope")).status, 401);
});

test("an agent's timer fires back into its own inbox", async () => {
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: `tool:timer_set {"text":"wake up","in_seconds":1}` });
  await waitFor((e) => e.type === "timer.set", from);
  const fired = await waitFor((e) => e.type === "message.delivered" && e.data.to === "agent:main" && String(e.data.from).startsWith("timer:"), from, 6000);
  assert.equal(fired.data.text, "wake up");
  await waitFor((e) => e.type === "agent.text" && String(e.data.text).includes("wake up"), fired.seq);
});

test("agents talk through ash: send delivers to the other agent's inbox as that agent", async () => {
  const from = await lastSeq();
  await ash.deliver("agent:main", { text: `tool:send {"to":"agent:helper","text":"ping from main"}` });
  const got = await waitFor((e) => e.type === "message.delivered" && e.data.to === "agent:helper", from);
  assert.equal(got.data.from, "agent:main");
  await waitFor((e) => e.type === "agent.text" && e.member === "agent:helper" && String(e.data.text).includes("agent:main"), from);
});

test("confirm-first capabilities wait for the owner; approve runs it, deny or expiry refuses", async () => {
  let from = await lastSeq();
  const p = ash.callDevice({ device: "device:lab", capability: "shell.run", args: { cmd: "ls" } });
  const asked = await waitFor((e) => e.type === "confirm.requested", from);
  const id = (asked.data.confirmation as { id: string }).id;
  assert.equal((await ash.confirms()).length >= 1, true);
  assert.deepEqual(await ash.answer(id, true), { answered: true });
  const r = await p;
  assert.equal(r.ok, true);
  from = await lastSeq();
  const p2 = ash.callDevice({ device: "device:lab", capability: "shell.run", args: { cmd: "rm" } });
  const asked2 = await waitFor((e) => e.type === "confirm.requested", from);
  await ash.answer((asked2.data.confirmation as { id: string }).id, false);
  assert.equal((await p2).ok, false);
  const p3 = ash.callDevice({ device: "device:lab", capability: "shell.run", args: {} });
  assert.equal((await p3).ok, false); // expires after confirmTtlMs
});

test("grants: the owner grants and revokes; the agent's view follows", async () => {
  const g = await ash.grant("agent:helper", "device:lab/files.list");
  let list = await mcp("tools/list", {}, "agent:helper", run.tokens.mcp["agent:helper"]);
  assert.ok(list.body.result.tools.some((t: { name: string }) => t.name === "lab_mac__files_list"));
  assert.ok(!list.body.result.tools.some((t: { name: string }) => t.name === "lab_mac__shell_run"));
  await ash.revokeGrant(g.id);
  list = await mcp("tools/list", {}, "agent:helper", run.tokens.mcp["agent:helper"]);
  assert.ok(!list.body.result.tools.some((t: { name: string }) => t.name.startsWith("lab_mac__")));
});

test("remote callers (paired browsers through the gateway) chat but cannot manage", async () => {
  run.core.devices.upsert({ id: "device:browser1", name: "Mac Chrome", kind: "browser", online: true, via: "gateway", permissions: ["chat", "web_ui"], capabilities: [] }, null);
  run.core.devices.upsert({ id: "device:im", name: "IM bridge", kind: "other", online: true, via: "gateway", permissions: ["chat"], capabilities: [] }, null);
  const router = (run as unknown as { core: unknown }) && (await import("../src/server"));
  const r = new router.Router(run.core, run.tokens, { workspaces: {} });
  const call = (method: string, path: string, member: string, body?: unknown) =>
    r.handle({ method, url: new URL(path, "http://ash"), headers: {}, body: body ? Buffer.from(JSON.stringify(body)) : null }, { member, local: false });
  assert.equal((await call("GET", "/api/manifest", "device:browser1")).status, 200);
  assert.equal((await call("GET", "/api/settings", "device:browser1")).status, 403);
  assert.equal((await call("POST", "/api/grants", "device:browser1", { member: "agent:main", scope: "*" })).status, 403);
  assert.equal((await call("GET", "/api/events", "device:im")).status, 403);
  const from = await lastSeq();
  assert.equal((await call("POST", "/api/agents/agent:main/deliver", "device:browser1", { text: "from chrome", from: OWNER })).status, 200);
  const d = await waitFor((e) => e.type === "message.delivered" && e.data.text === "from chrome", from);
  assert.equal(d.data.from, "device:browser1"); // cannot speak for the owner
  assert.equal(d.data.origin, "Mac Chrome");
});

test("the event stream replays after a cursor and follows live", async () => {
  const from = await lastSeq();
  const ac = new AbortController();
  const seen: AshEvent[] = [];
  const reader = (async () => {
    for await (const e of ash.stream(from, ac.signal)) {
      seen.push(e);
      if (e.type === "notify") break;
    }
  })();
  await sleep(200);
  await ash.notify({ title: "t", text: "stream me" });
  await Promise.race([reader, sleep(4000)]);
  ac.abort();
  assert.ok(seen.some((e) => e.type === "notify" && e.data.text === "stream me"));
});
