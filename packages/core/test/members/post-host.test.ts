import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import type { TrustedRouteContext } from "../../src/world/router";
import { FakeHost } from "../fixtures/fake-host";
import { STUCK_MS } from "../fixtures/wait";

const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
test("production owner entrypoint presents a due message through authenticated host /present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-host-"));
  const host = new FakeHost("synthetic-post-token");
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    await host.start();
    running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }],
      host: { url: host.url, token: host.token } });
    const source = await running.world.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic due notification", kind: "due" }, wait: true });
    const deadline = Date.now() + STUCK_MS;
    let delivered = running.ledger.list({ limit: 1000 }).filter((item) => item.to === "service:post" && item.kind === "request" && item.word === "deliver");
    while (Date.now() < deadline && (!host.calls.some((item) => item.path === "/present") ||
      delivered.length !== 1 || !running.ledger.responseTo(delivered[0].id))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      delivered = running.ledger.list({ limit: 1000 }).filter((item) => item.to === "service:post" && item.kind === "request" && item.word === "deliver");
    }
    host.assertCall("/present", { id: source.id, kind: "due", title: "Due", text: "synthetic due notification" });
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].body.message_id, source.id);
    const response = running.ledger.responseTo(delivered[0].id);
    assert.deepEqual(response?.body, { ok: true, result: { channel: "notification" } });
  } finally { await running?.close(); await host.close(); rmSync(dir, { recursive: true, force: true }); }
});
