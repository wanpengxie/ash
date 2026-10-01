// ash-api/2 over a real gateway tunnel. Run only against a controlled gateway:
// GATEWAY_URL=http://127.0.0.1:8787 BOOTSTRAP_SECRET=... npx tsx tools/e2e-gateway.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceKey, GatewayClient } from "ash-gateway/client/client";
import { startClient, startOwner } from "../packages/core/src/main";

const base = process.env.GATEWAY_URL?.replace(/\/$/, "");
const secret = process.env.BOOTSTRAP_SECRET;
if (!base || !secret) throw new Error("controlled GATEWAY_URL and BOOTSTRAP_SECRET are required");
const dir = mkdtempSync(join(tmpdir(), "ash-v2-gateway-"));
const stateDir = join(dir, "owner");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
writeFileSync(join(stateDir, "bootstrap-secret"), secret, { mode: 0o600 });
const check = (value: unknown, label: string) => { if (!value) throw new Error(`gateway e2e failed: ${label}`); console.log(`ok ${label}`); };
const wait = async <T>(probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("gateway e2e deadline");
};

const owner = await startOwner({ listen: "127.0.0.1:0", stateDir, gateway: { url: base }, agents: [{ id: "agent:main", runtime: "echo" }] });
try {
  const link = owner.link!;
  check(link.connected, "owner tunnel connected before edge opened");
  const { ticket } = await link.ticket();
  const key = await DeviceKey.generate();
  const gateway = new GatewayClient(base, key);
  const pairing = await gateway.requestPairing(ticket, "Controlled browser");
  const pending = await wait(async () => [...link.pending.values()].find((item) => item.name === "Controlled browser"));
  await link.approve(pending.request_id, ["chat", "web_ui"]);
  const grant = await gateway.waitForApproval(pairing.request_id, pairing.owner_key);
  check(grant, "browser grant approved");
  const session = await gateway.authenticate();
  const cookie = `ash_session=${session.token}`;
  const headers = { cookie, origin: new URL(base).origin };
  const oldRoute = await fetch(`${base}/api/agents`, { headers });
  check(oldRoute.status === 404, "retired production route absent through tunnel");
  const stream = await fetch(`${base}/api/stream?follow=false&after=0&label=Gateway%20Tab`, { headers: { ...headers, accept: "text/event-stream" } });
  check(stream.status === 200, "screen registration stream reachable");
  const frame = await stream.text();
  const registration = JSON.parse(frame.split("\ndata: ")[1]?.split("\n\n")[0] ?? "null") as { screen: string; token: string; label: string } | null;
  check(registration?.screen && registration.label === "Gateway Tab", "screen identity registered");
  const request = { to: "agent:main", kind: "request", word: "say", body: { text: "controlled tunnel message" }, client_id: "gateway-e2e-say" };
  const denied = await fetch(`${base}/api/send`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(request) });
  check(denied.status === 403, "unregistered browser send rejected");
  const sent = await fetch(`${base}/api/send`, { method: "POST", headers: { ...headers, "content-type": "application/json", "ash-screen": registration!.token }, body: JSON.stringify(request) });
  check(sent.status === 200, "registered browser send accepted");
  const accepted = await sent.json() as { id: string; seq: number };
  const describe = await fetch(`${base}/api/describe?member=agent:main`, { headers });
  check(describe.status === 200 && JSON.stringify(await describe.json()).includes('"say"'), "member describe through tunnel");
  const replay = await fetch(`${base}/api/stream?follow=false&after=0`, { headers: { ...headers, "Last-Event-ID": "0" } });
  const events = (await replay.text()).split("\n\n").filter((block) => block.startsWith("id: ")).map((block) => JSON.parse(block.split("\ndata: ")[1] ?? "null"));
  check(events.some((event) => event.id === accepted.id && event.from === "person:owner" && event.origin?.screen === registration!.screen), "trusted origin and durable replay");
  check(events.filter((event) => event.id === accepted.id).length === 1, "single accepted request");

  // A synthetic MCP server exercises the actual client tunnel and v2 device adapter.
  const fake = join(dir, "controlled-mcp.mjs");
  writeFileSync(fake, `import { createInterface } from "node:readline";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") out({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "controlled", version: "1" } } });
  else if (request.method === "tools/list") out({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "echo", description: "Echo controlled text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }] } });
  else if (request.method === "tools/call") out({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "synthetic:" + request.params.arguments.text }] } });
});`, { mode: 0o600 });
  const remoteTicket = (await link.ticket()).ticket;
  const laptopPromise = startClient({ role: "client", name: "Controlled laptop", stateDir: join(dir, "laptop"), gateway: { url: base },
    mcp: { fake: { command: process.execPath, args: [fake] } } }, remoteTicket);
  const remotePending = await wait(async () => [...link.pending.values()].find((item) => item.name === "Controlled laptop"));
  await link.approve(remotePending.request_id, ["expose_capability"]);
  const laptop = await laptopPromise;
  try {
    const remoteId = `device:${remotePending.client_id}`;
    const detail = await wait(async () => {
      await link.refreshDevices();
      try { return owner.members.describe("agent", remoteId).members[0]; } catch { return undefined; }
    });
    check(detail.online && detail.words.some((word) => word.word === "fake.echo" && word.risk === "structure"), "paired remote MCP is a conservative structure-risk device word");
    let approvals = 0;
    owner.world.setGate(async (message) => {
      const allowed = message.to === remoteId && message.word === "fake.echo" && message.body.text === "controlled" && approvals++ === 0;
      return { allow: allowed, by: "rule", reason: "synthetic gate rejects all other effects" };
    });
    const result = await owner.world.send({ transport: "agent", transportPrincipal: "e2e-agent", member: "agent:main", local: true, remote: false, ownerProxy: false },
      { to: remoteId, kind: "request", word: "fake.echo", body: { text: "controlled" }, wait: true });
    check(result.reply?.body.ok === true && JSON.stringify(result.reply.body.result).includes("synthetic:controlled"), "one explicitly gated synthetic remote effect returns through the tunnel");
    check(approvals === 1, "test-only gate saw exactly one remote effect");
    await link.revoke(remoteId);
    await link.refreshDevices();
    check(!owner.members.describe("agent").members.some((member) => member.id === remoteId), "revocation removes remote routes");
  } finally { laptop.close(); }
} finally { await owner.close(); }
