import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnerLink } from "../../src/gateway/link";
import { startOwner } from "../../src/main";
import { EdgeRouter } from "../../src/server";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter } from "../../src/world/router";

const signer = { id: "this-phone", publicKey: "public", sign: async () => "signature" };

/** A gateway that answers health and refuses claims the way the real one does. */
async function gateway(health: Record<string, unknown>, claim: { status: number; body: Record<string, unknown> } = { status: 200, body: { owner_id: "this-phone" } }) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const reply = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/v1/health") return reply(200, { ok: true, protocol: "ash-gw/1", ...health });
    if (req.url === "/v1/bootstrap/challenge") return reply(200, { nonce: "nonce" });
    if (req.url === "/v1/bootstrap/claim") return reply(claim.status, claim.body);
    reply(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, hits, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

async function owner(url: string) {
  const dir = mkdtempSync(join(tmpdir(), "ash-gateway-start-"));
  const ledger = await Ledger.open(join(dir, "ledger.db")), world = new WorldRouter(ledger, async () => true), members = new WorldMembers(world);
  const edge = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
  return { dir, ledger, link: new OwnerLink(url, signer, edge, () => {}) };
}

test("a gateway claimed by another phone or refusing the secret stops the link, not ash, and says why", async () => {
  for (const [health, claim, problem] of [
    [{ claimed: true, owner_id: "another-phone" }, undefined, "claimed_by_other"],
    [{ claimed: false, owner_id: null }, { status: 401, body: { error: "bad_mac", message: "bootstrap secret proof does not match" } }, "bad_secret"],
    [{ claimed: false, owner_id: null }, { status: 409, body: { error: "already_claimed", message: "this gateway already has an owner" } }, "claimed_by_other"],
  ] as const) {
    const server = await gateway(health, claim), { dir, ledger, link } = await owner(server.url);
    const secret = join(dir, "bootstrap-secret"); writeFileSync(secret, "wrong");
    try {
      await link.start(secret, "Ash owner"); // returns instead of throwing or retrying
      assert.equal(link.problem, problem);
      assert.equal(await link.waitConnected(), false);
      assert.deepEqual({ connected: link.state().connected, error: link.state().error }, { connected: false, error: problem });
      assert.equal(existsSync(secret), true, "a refused secret stays for the owner to replace");
      assert.equal(server.hits.filter((hit) => hit === "GET /v1/health").length, 1, "a refusal is not retried");
    } finally { link.stop(); ledger.close(); await server.close(); }
  }
});

test("an unclaimed gateway without a secret asks for one; an unreachable gateway is retried until stopped", async () => {
  const server = await gateway({ claimed: false, owner_id: null }), first = await owner(server.url);
  try {
    await first.link.start(join(first.dir, "bootstrap-secret"), "Ash owner");
    assert.equal(first.link.state().error, "missing_secret");
  } finally { first.link.stop(); first.ledger.close(); await server.close(); }
  const { dir, ledger, link } = await owner("http://127.0.0.1:1");
  try {
    const running = link.start(join(dir, "bootstrap-secret"), "Ash owner");
    const started = Date.now();
    assert.equal(await link.waitConnected(10_000), false);
    assert.ok(Date.now() - started < 5_000, "startup does not wait out the timeout for an unreachable gateway");
    assert.equal(link.state().error, "unreachable");
    link.stop();
    await running; // the retry loop ends with the link
  } finally { link.stop(); ledger.close(); }
});

test("ash starts and reports the gateway problem when the gateway belongs to another phone", async () => {
  const server = await gateway({ claimed: true, owner_id: "another-phone" });
  const stateDir = mkdtempSync(join(tmpdir(), "ash-gateway-owner-"));
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir, listen: "127.0.0.1:0", gateway: { url: server.url }, agents: [{ id: "agent:main", runtime: "echo" }] });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "service:devices", kind: "request", word: "gateway_status", body: {}, wait: true }) });
    const reply = (await response.json() as { reply: { body: { ok: boolean; result: Record<string, unknown> } } }).reply.body;
    assert.equal(reply.ok, true);
    assert.deepEqual({ configured: reply.result.configured, connected: reply.result.connected, error: reply.result.error },
      { configured: true, connected: false, error: "claimed_by_other" });
  } finally { await running?.close(); await server.close(); }
});
