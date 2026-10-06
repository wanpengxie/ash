import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { CodexSession } from "../src/agents/codex";
import { ClaudeSession } from "../src/agents/claude";
import { WorkBuddySession, workbuddyEnvironment } from "../src/agents/workbuddy";
import { JsonProcess } from "../src/agents/process";
import { AshTools, serveTools } from "../src/agents/mcp";
import type { AgentEvent, OpenOptions } from "../src/agents/types";

const fixture = fileURLToPath(new URL("./fixtures/agent-cli.mjs", import.meta.url));
const tools = [{ name: "agent_list", description: "List agents", inputSchema: { type: "object", additionalProperties: false } }];
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  assert.fail("event did not arrive");
}

for (const [kind, Driver] of [["codex", CodexSession], ["claude", ClaudeSession], ["workbuddy", WorkBuddySession]] as const) {
  test(`${kind}: open, attributed tools, steer, full result, interrupt, resume and crash`, async t => {
    const events: AgentEvent[] = [], outbound: string[] = [];
    const options: OpenOptions = { cwd: process.cwd(), tools, onEvent: e => events.push(e), onOutbound: async call => { outbound.push(call.turn); return { agents: [] }; } };
    const command = { command: process.execPath, args: [fixture, kind] };
    const session = await Driver.open(options, command);
    t.after(() => session.close());
    const seed = events.find(e => e.type === "seed_updated"); assert.equal(seed?.type, "seed_updated");
    await session.select("test-model");
    await session.send("first", "hello");
    await assert.rejects(session.send("overlap", "no"), /idle|busy/);
    await until(() => outbound.length === 1);
    assert.deepEqual(outbound, ["first"]);
    assert.equal(await session.steer("wrong", "no"), false);
    assert.equal(await session.steer("first", "finish"), true);
    await until(() => events.some(e => e.type === "turn_ended" && e.turn === "first"));
    const ended = events.find(e => e.type === "turn_ended" && e.turn === "first");
    assert.ok(ended?.type === "turn_ended"); assert.equal(ended.outcome, "ok");
    assert.ok(ended.reply.length > 4096); assert.ok(ended.reply.includes("完整结果🙂"));
    assert.ok(!events.some(e => e.type === "note" && /WRONG|LATE/.test(e.text)));
    assert.equal(events.filter(e => e.type === "turn_started" && e.turn === "first").length, 1);
    assert.ok(events.some(e => e.type === "tool" && e.phase === "start"));
    await session.send("second", "wait");
    await session.interrupt("second");
    assert.ok(!events.some(e => e.type === "turn_ended" && e.turn === "second"));
    await until(() => events.some(e => e.type === "turn_ended" && e.turn === "second"));
    assert.ok(events.some(e => e.type === "turn_ended" && e.turn === "second" && e.outcome === "interrupted"));
    await session.close();
    const resumed = await Driver.open({ ...options, seed: seed!.type === "seed_updated" ? seed!.seed : "" }, command);
    t.after(() => resumed.close());
    await resumed.send("third", "crash");
    await until(() => events.some(e => e.type === "turn_ended" && e.turn === "third"));
    assert.ok(events.some(e => e.type === "turn_ended" && e.turn === "third" && e.outcome === "unknown"));
    await assert.rejects(resumed.send("fourth", "never replay"), /idle|unavailable/);
  });
}

test("private MCP exposes only communication tools, validates input and captures the turn", async t => {
  let current: string | undefined = "turn-a";
  const calls: string[] = [];
  const toolsApi = new AshTools({ cwd: process.cwd(), tools, onEvent() {}, onOutbound: async call => { calls.push(call.turn); await delay(20); return { ok: true }; } }, () => current);
  const endpoint = await serveTools(toolsApi); t.after(() => endpoint.close());
  const send = (method: string, params: unknown = {}, headers: Record<string, string> = {}) => fetch(endpoint.url, { method: "POST", headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }) });
  assert.equal((await send("tools/list", {}, { authorization: "Bearer wrong" })).status, 403);
  assert.equal((await send("tools/list", {}, { origin: "https://example.com" })).status, 403);
  assert.equal((await (await send("tools/list")).json() as any).result.tools.length, 1);
  assert.equal((await (await send("tools/call", { name: "shell", arguments: {} })).json() as any).result.isError, true);
  assert.equal((await (await send("tools/call", { name: "agent_list", arguments: { extra: true } })).json() as any).result.isError, true);
  const call = toolsApi.call("req", "agent_list", {}); current = "turn-b"; await call;
  assert.deepEqual(calls, ["turn-a"]);
  current = undefined; await assert.rejects(toolsApi.call("late", "agent_list", {}));
});

test("WorkBuddy uses desktop login without inherited provider overrides", () => {
  const env = workbuddyEnvironment({ PATH: "/bin", CODEBUDDY_API_KEY: "do-not-use", CODEBUDDY_AUTH_TOKEN: "do-not-use", CODEBUDDY_BASE_URL: "https://wrong.invalid", WORKBUDDY_CONFIG_DIR: "/wrong" });
  assert.equal(env.PATH, "/bin"); assert.equal(env.CODEBUDDY_API_KEY, undefined);
  assert.equal(env.CODEBUDDY_AUTH_TOKEN, undefined); assert.equal(env.CODEBUDDY_BASE_URL, undefined);
  assert.equal(env.WORKBUDDY_CONFIG_DIR, undefined); assert.equal(env.CODEBUDDY_HOST, "workbuddy-desktop");
});

test("control timeout is result-unknown, malformed protocol retires process", async t => {
  const runtime = new JsonProcess({ command: process.execPath, args: ["-e", "process.stdin.resume()"] }, process.cwd());
  t.after(() => runtime.close());
  await assert.rejects(runtime.request("ignored", {}, 15), /result unknown/);
  const invalid = new JsonProcess({ command: process.execPath, args: ["-e", "console.log('not json');process.stdin.resume()"] }, process.cwd());
  t.after(() => invalid.close());
  const reason = await new Promise<string>(resolve => { invalid.onExit = resolve; });
  assert.match(reason, /invalid runtime frame/);
});

test("closing a runtime kills a TERM-resistant child even after its parent exits", {skip:process.platform!=="linux"},async t=>{
  const childCode="process.on('SIGTERM',()=>{});console.log(JSON.stringify({ready:process.pid}));setInterval(()=>{},1000)";
  const parentCode=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;
  const runtime=new JsonProcess({command:process.execPath,args:["-e",parentCode]},process.cwd());t.after(()=>runtime.close());
  const pid=await new Promise<number>(resolve=>{runtime.onFrame=f=>resolve(f.ready);});
  await runtime.close();
  await until(()=>runtime.child.exitCode!==null||runtime.child.signalCode!==null);
  // A reparented zombie is already stopped and waits only for init to reap it.
  let state="";
  for(let i=0;i<100;i++) {
    state=await readFile(`/proc/${pid}/stat`,"utf8").catch(()=>"");
    if(!state||/^\d+ \(.*\) Z /.test(state))break;
    await delay(5);
  }
  assert.ok(!state||/^\d+ \(.*\) Z /.test(state),"descendant still running");
});

test("resume rejects a changed tool surface without running a task",async()=>{
  const options:OpenOptions={cwd:process.cwd(),tools,onEvent(){},onOutbound:async()=>({}),seed:"ash-codex-v1:wrong:thread"};
  await assert.rejects(CodexSession.open(options,{command:process.execPath,args:[fixture,"codex"]}),/tool contract changed/);
  await assert.rejects(WorkBuddySession.open({...options,seed:"ash-workbuddy-v1:wrong:session"},{command:process.execPath,args:[fixture,"workbuddy"]}),/tool contract changed/);
});
