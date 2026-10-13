/**
 * The Codex App's way into Ash, end to end on this computer's side: a real `ash-device mcp` process on stdio (what Codex
 * starts) -> the local socket of a running ash-device -> its agent channel -> a stand-in for the hub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { startDevice, type DeviceDeps } from "../src/main";
import { loadIdentity } from "../src/link";
import { eventually, openTunnel, startKernel } from "./kernel";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const codexOnly: DeviceDeps["detect"] = async () => [{ kind: "codex", installed: true, logged_in: true, models: [] }];

/** What Codex does: starts `ash-device mcp --config <file>` and talks JSON lines to it. */
function codex(config: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--import", "tsx", MAIN, "mcp", "--config", config], { stdio: ["pipe", "pipe", "pipe"] });
  const replies = new Map<number, (frame: any) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => { const frame = JSON.parse(line); replies.get(frame.id)?.(frame); });
  let n = 0, stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve) => { const id = ++n; replies.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  return { rpc, stderr: () => stderr, close: () => { child.stdin.end(); child.kill(); } };
}

async function running(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-"));
  const stateDir = join(dir, "state");
  const kernel = await startKernel();
  const identity = await loadIdentity(stateDir);
  kernel.pair({ id: identity.id, publicKey: identity.publicKey });
  const device = await startDevice({ gateway: "", name: "Test Mac", stateDir, workdir: join(dir, "work") }, undefined, { relay: false, detect: codexOnly, ego: null, kimiPorts: [0] });
  t.after(async () => { await device.close(); await kernel.stop(); });
  openTunnel(kernel, device, identity.id);
  await device.client.ready();
  await eventually(() => kernel.remote.session, "the agent channel");
  const config = join(dir, "device.json");
  await writeFile(config, JSON.stringify({ stateDir }));
  return { dir, kernel, device, config, stateDir };
}

test("tools/list, a call with the Codex session, and a refusal of the hub: all through the one process Codex starts", async (t) => {
  const s = await running(t);
  s.kernel.remote.answer = (frame) => {
    if (frame.outbound === "tools/list") return { ok: true, result: { tools: [{ name: "agent_list", description: "from the hub", inputSchema: { type: "object" } }], caller: { id: "agent:codex-test-mac" } } };
    if (frame.args?.refuse) return { ok: false, error: { code: "forbidden", message: "Ash said no" } };
    return { ok: true, result: { content: [{ type: "text", text: "from the hub" }], structuredContent: { args: frame.args } } };
  };
  const c = codex(s.config);
  t.after(() => c.close());
  const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex", version: "0" } });
  assert.equal(init.result.serverInfo.name, "ash");
  const listed = await c.rpc("tools/list");
  assert.equal(listed.result.tools[0].description, "from the hub", c.stderr());

  const called = await c.rpc("tools/call", { name: "capability_list", arguments: { member: "device:x" }, _meta: { "x-codex-turn-metadata": { session_id: "S-77" } } });
  assert.deepEqual(called.result, { content: [{ type: "text", text: "from the hub" }], structuredContent: { args: { member: "device:x" } } });
  const frame = s.kernel.remote.tools.at(-1)!;
  assert.deepEqual([frame.outbound, frame.attached, frame.args, "agent" in frame, "turn" in frame], ["capability_list", { session: "S-77" }, { member: "device:x" }, false, false], "no agent and no turn: it is not an agent's call");

  const refused = await c.rpc("tools/call", { name: "capability_call", arguments: { refuse: true } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /Ash said no/);
});

test("the hub is not reachable: the call says so plainly, and it works again when the connection is back", async (t) => {
  const s = await running(t);
  const c = codex(s.config);
  t.after(() => c.close());
  await c.rpc("initialize", { protocolVersion: "2025-06-18" });
  s.device.agents.closed();
  const down = await c.rpc("tools/call", { name: "agent_list", arguments: {} });
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /not connected to Ash/);
  assert.equal((await c.rpc("tools/list")).result.tools.length, 9, "the tools still show");
  s.device.agents.opened();
  const back = await c.rpc("tools/call", { name: "agent_list", arguments: {} });
  assert.notEqual(back.result.isError, true);
});

test("ash-device is not running (or not set up): the call says what to do", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-off-"));
  await writeFile(join(dir, "device.json"), JSON.stringify({ stateDir: join(dir, "state") }));
  const off = codex(join(dir, "device.json"));
  t.after(() => off.close());
  await off.rpc("initialize", { protocolVersion: "2025-06-18" });
  const reply = await off.rpc("tools/call", { name: "agent_list", arguments: {} });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /ash-device is not running/);

  const unset = codex(join(dir, "missing.json"));
  t.after(() => unset.close());
  await unset.rpc("initialize", { protocolVersion: "2025-06-18" });
  const none = await unset.rpc("tools/call", { name: "agent_list", arguments: {} });
  assert.match(none.result.content[0].text, /not set up/);
});
