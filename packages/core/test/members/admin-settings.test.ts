import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("local quiet hours settings affect delivery and survive a restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-admin-quiet-"));
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    const start = () => startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    running = await start();
    const call = async (word: string, body: object) => {
      const token = Object.entries(running!.tokens.api).find(([, member]) => member === "person:owner")![0];
      const response = await fetch(`${running!.url}/api/send`, { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:admin", kind: "request", word, body, wait: true }) });
      return { status: response.status, reply: (await response.json() as { reply?: { body: { ok: boolean; result?: { delivery?: { quiet?: string } } } } }).reply };
    };
    assert.equal((await call("settings.get", {})).reply?.body.result?.delivery?.quiet, "21:30-09:00");
    assert.equal((await call("settings.set", { delivery: { quiet: "00:00-23:59" } })).reply?.body.result?.delivery?.quiet, "00:00-23:59");
    const bad = await call("settings.set", { delivery: { quiet: "25:00-09:00" } });
    assert.equal(bad.reply?.body.ok, false);
    assert.equal((await call("settings.get", {})).reply?.body.result?.delivery?.quiet, "00:00-23:59");
    const remote = await running.world.send({ member: "person:owner", transport: "web_ui", transportPrincipal: "remote-test",
      local: false, remote: true, ownerProxy: true, screenId: "screen:remote", screenLabel: "Remote" },
    { to: "service:admin", kind: "request", word: "settings.set", body: { delivery: { quiet: "09:00-09:00" } } })
      .then(() => "accepted", (error: { code?: string }) => error.code);
    assert.equal(remote, "forbidden");
    const offer = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false }, { to: "person:owner", kind: "request", word: "say",
      body: { kind: "offer", text: "A synthetic offer", dedupe_key: "quiet-test" }, wait: true });
    for (let i = 0; i < 50 && !running.ledger.list({ limit: 1000 }).some((message) =>
      message.word === "post.delivery" && message.body.message_id === offer.id); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(running.ledger.list({ limit: 1000 }).find((message) =>
      message.word === "post.delivery" && message.body.message_id === offer.id)?.body.state, "held");
    await running.close();
    running = null;
    running = await start();
    assert.equal((await call("settings.get", {})).reply?.body.result?.delivery?.quiet, "00:00-23:59");
  } finally { await running?.close(); rmSync(stateDir, { recursive: true, force: true }); }
});
