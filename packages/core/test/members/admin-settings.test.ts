import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import { eventually } from "../fixtures/wait";

test("local quiet hours and approval mode settings take effect and survive a restart", async () => {
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
      return { status: response.status, reply: (await response.json() as { reply?: { body: { ok: boolean; result?: { delivery?: { quiet?: string }; approval?: { mode?: string } } } } }).reply };
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
    await eventually(() => running!.ledger.list({ limit: 1000 }).some((message) =>
      message.word === "post.delivery" && message.body.message_id === offer.id), "the offer was not classified");
    assert.equal(running.ledger.list({ limit: 1000 }).find((message) =>
      message.word === "post.delivery" && message.body.message_id === offer.id)?.body.state, "held");
    assert.equal((await call("settings.get", {})).reply?.body.result?.approval?.mode, "auto");
    for (const bad of [{ approval: { mode: "never" } }, { approval: { mode: "always", extra: 1 } }, { approval: "always" },
      { approval: { mode: "always" }, delivery: { quiet: "00:00-23:59" } }])
      assert.equal((await call("settings.set", bad)).reply?.body.ok, false, JSON.stringify(bad));
    assert.equal((await call("settings.set", { approval: { mode: "always" } })).reply?.body.result?.approval?.mode, "always");
    // The gate reads the mode on every decision: an agent's outward call now asks even before any reviewer runs.
    running.members.registerDevice({ id: "device:fake", kind: "device", name: "Synthetic device", online: true,
      capabilities: () => [{ name: "open", description: "Open a page", label: "打开网页", risk: "outward", effect: "act",
        input_schema: { type: "object", properties: {}, additionalProperties: false } }], handle: () => ({ ok: true, result: {} }) });
    let reviewed = 0;
    running.world.setReviewer(async () => { reviewed++; return { decision: "allow", reason: "可撤回" }; });
    const opened = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false }, { to: "device:fake", kind: "request", word: "open", body: {} });
    await eventually(() => running!.ledger.gateCase(opened.id), "the gate did not take the call");
    assert.ok(running.ledger.gateCase(opened.id));
    assert.equal(reviewed, 0);
    running.world.cancel([opened.id]);
    await running.close();
    running = null;
    running = await start();
    assert.equal((await call("settings.get", {})).reply?.body.result?.delivery?.quiet, "00:00-23:59");
    assert.equal((await call("settings.get", {})).reply?.body.result?.approval?.mode, "always");
  } finally { await running?.close(); rmSync(stateDir, { recursive: true, force: true }); }
});
