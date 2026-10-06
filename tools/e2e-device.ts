// Local-only integration: real core OwnerLink, gateway, device process, and workspace.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startOwner } from "../packages/core/src/main";
import { startDevice } from "../packages/device/src/main";

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:18988";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local gateway only");
const secret = process.env.BOOTSTRAP_SECRET;
if (!secret) throw new Error("Set a local test bootstrap secret");
const dir = await mkdtemp(join(tmpdir(), "ash-device-e2e-")), stateDir = join(dir, "owner");
await mkdir(stateDir); await writeFile(join(stateDir, "bootstrap-secret"), secret, { mode: 0o600 });
const owner = await startOwner({ listen: "127.0.0.1:0", stateDir, gateway: { url: base }, agents: [{ id: "agent:main", runtime: "echo" }] });
let device: Awaited<ReturnType<typeof startDevice>> | undefined;
const until = async <T>(check: () => Promise<T | undefined>): Promise<T> => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Local device integration timed out");
};
try {
  const link = owner.link!;
  const ticket = await link.ticket();
  const pairing = startDevice({ gateway: base, name: "Test workstation", stateDir: join(dir, "device"), workdir: join(dir, "work") }, ticket.ticket);
  const pending = await until(async () => [...link.pending.values()].find(p => p.name === "Test workstation"));
  await link.approve(pending.request_id, ["expose_capability"]); device = await pairing;
  const id = `device:${pending.client_id}`;
  await until(async () => { await link.refreshDevices(); return owner.members.describe("owner").members.find(m => m.id === id && m.online); });
  console.log("ok: real device pairs and advertises workspace through OwnerLink");
  const token = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")![0];
  const call = async (word: string, body: Record<string, unknown>) => {
    const response = await fetch(`${owner.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: id, kind: "request", word: `workspace.${word}`, body, wait: true }) });
    assert.equal(response.status, 200);
    const result = (await response.json() as any).reply.body;
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result.data;
  };
  await call("write", { path: "hello.md", content: "# Hello\n完整结果\n" });
  assert.match((await call("read", { path: "hello.md" })).text, /完整结果/);
  await call("edit", { path: "hello.md", edits: [{ oldText: "Hello", newText: "Device" }] });
  assert.match((await call("read", { path: "hello.md" })).text, /Device/);
  console.log("ok: real core → gateway → workspace write/read/edit");
  const job = await call("bash", { command: "printf start; sleep 0.3; printf end", yield_ms: 20 });
  assert.equal(job.running, true);
  const result = await call("poll", { process: job.process, yield_ms: 2000 });
  assert.equal(job.output + result.output, "startend"); assert.equal(result.running, false);
  console.log("ok: command yields process, polling recovers new output");
  await link.revoke(id);
  await link.refreshDevices();
  assert.ok(!owner.members.describe("owner").members.some(m => m.id === id));
  await Promise.race([device.run, new Promise((_, reject) => setTimeout(() => reject(new Error("Revoked device kept reconnecting")), 3000))]);
  console.log("ok: revoke removes member and stops device reconnect loop");
} finally { await device?.close(); await owner.close(); }
