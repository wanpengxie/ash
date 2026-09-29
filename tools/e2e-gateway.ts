// End-to-end through a real ash gateway: ash core as the owner (echo agent), a paired browser
// reaching the ash UI/API through the tunnel, and ash core as a laptop (client role) lending
// an MCP server's tools as device capabilities.
//
//   (in ash-gateway)  npm run dev            # fresh local gateway on :8787
//   GATEWAY_URL=http://127.0.0.1:8787 BOOTSTRAP_SECRET=… npx tsx tools/e2e-gateway.ts

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceKey, GatewayClient } from "ash-gateway/client/client";
import type { AshEvent } from "../packages/sdk/src/api";
import { AshClient } from "../packages/sdk/src/client";
import { OWNER } from "../packages/core/src/core";
import { startClient, startOwner } from "../packages/core/src/main";

const BASE = (process.env.GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const SECRET = process.env.BOOTSTRAP_SECRET ?? "";
let passed = 0;
const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  passed++;
  console.log(`  ✓ ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T | undefined> {
  for (let t = 0; t < ms; t += 250) {
    const v = await fn().catch(() => undefined);
    if (v) return v as T;
    await sleep(250);
  }
  return undefined;
}

const dir = mkdtempSync(join(tmpdir(), "ash-e2e-gw-"));
const stateDir = join(dir, "owner");
const { mkdirSync } = await import("node:fs");
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, "bootstrap-secret"), SECRET);

console.log(`gateway ${BASE}\nowner (ash core)`);
const owner = await startOwner({ space: "e2e", listen: "127.0.0.1:0", stateDir, gateway: { url: BASE }, name: "e2e phone", agents: [{ id: "agent:main", name: "Ash", runtime: "echo", grants: ["*"] }] });
const ash = new AshClient(owner.url, Object.entries(owner.tokens.api).find(([, m]) => m === OWNER)![0]);
ok(await until(async () => (await ash.gateway()).connected), "ash core claims the gateway and connects as owner");

// ---------------------------------------------------------------- browser
console.log("browser");
async function pair(name: string, permissions: string[]) {
  const { ticket } = (await ash.gatewayOp("ticket")) as { ticket: string };
  const key = await DeviceKey.generate();
  const gw = new GatewayClient(BASE, key);
  const pr = await gw.requestPairing(ticket, name);
  const pending = await until(async () => ((await ash.gateway()).pending as { request_id: string; name: string }[]).find((p) => p.name === name));
  ok(pending, `the owner sees ${name}'s pairing request`);
  await ash.gatewayOp("approve", { request_id: pending!.request_id, permissions });
  await gw.waitForApproval(pr.request_id, pr.owner_key);
  return { key, gw };
}
const b = await pair("E2E Chrome", ["chat", "web_ui"]);
const session = await b.gw.authenticate();
const cookie = `ash_session=${session.token}`;
const H = { cookie, "content-type": "application/json", origin: new URL(BASE).origin };
const page = await fetch(`${BASE}/`, { headers: { cookie, accept: "text/html" } });
ok(page.status === 200 && (await page.text()).includes("<title>Ash</title>"), "the paired browser gets the ash UI through the tunnel");
const m = (await (await fetch(`${BASE}/api/manifest`, { headers: H })).json()) as { me: string; caller: { local: boolean; manage: boolean } };
ok(m.me === `device:${b.key.id}` && !m.caller.local && !m.caller.manage, "ash sees the browser as its device (remote, no management)");
ok((await fetch(`${BASE}/api/settings`, { headers: H })).status === 403, "credentials/settings are not reachable remotely");

const ac = new AbortController();
const events: AshEvent[] = [];
const sse = await fetch(`${BASE}/api/events/stream?after=${(await ash.events({ limit: 1000 })).next}`, { headers: { cookie, accept: "text/event-stream" }, signal: ac.signal });
void (async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of sse.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
})().catch(() => {});
const d = await fetch(`${BASE}/api/agents/agent:main/deliver`, { method: "POST", headers: H, body: JSON.stringify({ text: "hello from chrome" }) });
ok(d.status === 200, "the browser delivers a message through the tunnel");
ok(await until(async () => events.find((e) => e.type === "agent.text" && String(e.data.text).includes("hello from chrome"))), "the answer streams back to the browser (SSE through the tunnel)");
const delivered = events.find((e) => e.type === "message.delivered")!;
ok(delivered.data.from === `device:${b.key.id}` && delivered.data.origin === "E2E Chrome", "the agent knows the message came from E2E Chrome");
ac.abort();

// ---------------------------------------------------------------- laptop (ash core, client role)
console.log("laptop");
const fake = join(dir, "fake-mcp.mjs");
writeFileSync(
  fake,
  `import { createInterface } from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  else if (m.method === "tools/call") out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "laptop says: " + m.params.arguments.text }] } });
});`,
);
const { ticket } = (await ash.gatewayOp("ticket")) as { ticket: string };
const laptopP = startClient({ role: "client", name: "E2E Laptop", stateDir: join(dir, "laptop"), gateway: { url: BASE }, mcp: { fake: { command: process.execPath, args: [fake] } } }, ticket);
const lp = await until(async () => ((await ash.gateway()).pending as { request_id: string; name: string }[]).find((p) => p.name === "E2E Laptop"));
ok(lp, "the owner sees the laptop's pairing request");
await ash.gatewayOp("approve", { request_id: lp!.request_id, permissions: ["chat", "expose_capability"] });
const laptop = await laptopP;
const dev = await until(async () => (await ash.devices()).find((x) => x.name === "E2E Laptop" && x.online && x.capabilities.length > 0));
ok(dev && dev.capabilities[0].name === "fake.echo", "the laptop appears as a device with its MCP tools as capabilities");
const r = await ash.callDevice({ device: dev!.id, capability: "fake.echo", args: { text: "你好" } });
ok(r.ok && r.content[0].type === "text" && r.content[0].text === "laptop says: 你好", "a capability call runs on the laptop through the gateway");
const mcp = await fetch(`${owner.url}/mcp/agent:main`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": owner.tokens.mcp["agent:main"] }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
ok(((await mcp.json()) as { result: { tools: { name: string }[] } }).result.tools.some((t) => t.name === "e2e_laptop__fake_echo"), "the agent gets the laptop's tool without any runtime configuration");
laptop.close();
ok(await until(async () => (await ash.devices()).find((x) => x.name === "E2E Laptop" && !x.online), 15_000), "the laptop going away is noticed (device presence)");
await ash.gatewayOp("revoke", { device: dev!.id });
ok(!(await ash.devices()).some((x) => x.id === dev!.id), "revoking removes the device");

console.log(`\nall ${passed} checks passed`);
await owner.close();
process.exit(0);
