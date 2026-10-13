// app:v2raya, the proxy organ (packages/ash-skills/organs/v2raya): run with a stand-in for v2rayA, over MCP on stdio.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkManifest } from "../../src/edges/apps/check";

const ORGAN = fileURLToPath(new URL("../../../ash-skills/organs/v2raya", import.meta.url));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

async function rig(fakeBody: (panel: number, proxy: number) => string = () => "") {
  const dir = mkdtempSync(join(tmpdir(), "v2raya-"));
  const fake = join(dir, "fake.mjs");
  const log = join(dir, "v2raya.log");
  const panel = await freePort();
  const proxy = await freePort();
  writeFileSync(fake, `import { createServer } from "node:net"; import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));
${fakeBody(panel, proxy)}
setInterval(() => {}, 1000);`);
  const server = spawn("node", [join(ORGAN, "server.mjs")], {
    env: { ...process.env, V2RAYA_ARGV: JSON.stringify([process.execPath, fake]), V2RAYA_LOG: log, V2RAYA_CWD: dir, V2RAYA_PANEL_PORT: String(panel), V2RAYA_PROXY_PORT: String(proxy) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  const waiting = new Map<number, (m: any) => void>();
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      const m = JSON.parse(line); waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve) => { const id = ++n; waiting.set(id, resolve); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const exited = new Promise<number | null>((r) => server.on("exit", (code) => r(code)));
  const pid = async () => { for (let i = 0; i < 100; i++) { try { return Number(readFileSync(join(dir, "pid"), "utf8")); } catch { await new Promise((r) => setTimeout(r, 50)); } } throw new Error("no pid"); };
  return { dir, log, panel, proxy, server, rpc, exited, pid };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };

test("app.json is a valid ash-app/1 manifest without needs", () => {
  const { manifest, problems } = checkManifest(readFileSync(join(ORGAN, "app.json"), "utf8"), "v2raya");
  assert.deepEqual(problems.filter((p) => p.level === "error"), []);
  assert.deepEqual(manifest!.needs ?? [], []);
});

test("it starts v2rayA, reports status and logs, and ends v2rayA when stdin closes", async () => {
  const r = await rig();
  const fakePid = await r.pid();
  writeFileSync(r.log, "one\ntwo\nthree\n");
  const tools = await r.rpc("tools/list");
  assert.deepEqual(tools.result.tools.map((t: any) => t.name), ["v2raya.status", "v2raya.logs"]);
  const status = (await r.rpc("tools/call", { name: "v2raya.status" })).result.structuredContent;
  assert.equal(status.running, true);
  assert.equal(status.pid, fakePid);
  assert.equal(status.panel_port_open, false);
  const logs = (await r.rpc("tools/call", { name: "v2raya.logs", arguments: { lines: 2 } })).result.structuredContent;
  assert.deepEqual(logs.lines, ["two", "three"]);
  r.server.stdin.end();
  assert.equal(await r.exited, 0);
  await until(() => !alive(fakePid));
  assert.equal(alive(fakePid), false, "v2rayA does not outlive the app");
});

test("the ports show in the status; when v2rayA ends the app ends with a non-zero code", async () => {
  const r = await rig((panel, proxy) => `for (const p of [${panel}, ${proxy}]) createServer((s) => s.end()).listen(p, "127.0.0.1");`);
  await r.pid();
  let status: any;
  for (let i = 0; i < 60; i++) {
    status = (await r.rpc("tools/call", { name: "v2raya.status" })).result.structuredContent;
    if (status.panel_port_open && status.proxy_port_open) break;
    await new Promise((x) => setTimeout(x, 50));
  }
  assert.equal(status.panel_port_open, true);
  assert.equal(status.proxy_port_open, true);
  process.kill(status.pid, "SIGKILL");
  const code = await r.exited;
  assert.ok(code !== 0 && code !== null, `exit code ${code}`);
});
