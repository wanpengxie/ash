import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("registered local screen reads and hash-guards PROACTIVE.md; remote screen cannot mutate it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-proactive-settings-"));
  const abort = new AbortController();
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0",
      workspaces: { home: join(dir, "home") }, agents: [{ id: "agent:main", runtime: "echo" }] });
    const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const stream = await fetch(`${running.url}/api/stream?follow=true&label=PreferencesFixture`, {
      headers: { authorization: `Bearer ${ownerToken}` }, signal: abort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    let frames = "";
    while (!frames.includes("event: screen.registered")) {
      const next = await reader.read();
      assert.equal(next.done, false);
      frames += new TextDecoder().decode(next.value);
    }
    const registration = /event: screen\.registered\ndata: ([^\n]+)/.exec(frames);
    assert.ok(registration);
    const screen = (JSON.parse(registration[1]) as { token: string }).token;
    const send = async (word: "read" | "write", body: Record<string, unknown>, client_id: string) => {
      const response = await fetch(`${running!.url}/api/send`, { method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "Ash-Screen": screen, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:self", kind: "request", word, body, client_id, wait: true }) });
      assert.equal(response.status, 200);
      const accepted = await response.json() as { id: string; reply: { reply_to: string; body: { ok: boolean; result?: { hash?: string; content?: string }; error?: { code: string } } } };
      assert.equal(accepted.reply.reply_to, accepted.id);
      return accepted;
    };
    const missing = await send("read", { path: "PROACTIVE.md" }, "missing");
    assert.deepEqual(missing.reply.body.error?.code, "not_found");
    const first = await send("write", { path: "PROACTIVE.md", content: "Only urgent reminders.\n", why: "Owner changed preference", expected_hash: null }, "create");
    assert.equal(first.reply.body.ok, true);
    const hash = first.reply.body.result?.hash;
    assert.match(hash ?? "", /^[0-9a-f]{64}$/);
    const read = await send("read", { path: "PROACTIVE.md" }, "read-first");
    assert.deepEqual(read.reply.body.result, { content: "Only urgent reminders.\n", hash });
    const stale = await send("write", { path: "PROACTIVE.md", content: "wrong\n", why: "Owner changed preference", expected_hash: "0".repeat(64) }, "stale");
    assert.equal(stale.reply.body.error?.code, "bad_request");
    assert.equal(readFileSync(join(dir, "home", "PROACTIVE.md"), "utf8"), "Only urgent reminders.\n");
    const updated = await send("write", { path: "PROACTIVE.md", content: "Pause all nudges.\n", why: "Owner changed preference", expected_hash: hash }, "update");
    assert.equal(updated.reply.body.ok, true);
    assert.notEqual(updated.reply.body.result?.hash, hash);

    const remote = { member: "person:owner", transportPrincipal: "gateway:synthetic", pairedDeviceId: "synthetic",
      local: false, remote: true, ownerProxy: true, transport: "web_ui" as const };
    const before = running.ledger.lastSeq();
    const denied = await running.edge.handle({ method: "POST", url: new URL("/api/send", running.url), headers: {},
      body: Buffer.from(JSON.stringify({ to: "service:self", kind: "request", word: "write", body: {
        path: "PROACTIVE.md", content: "remote\n", why: "synthetic", expected_hash: updated.reply.body.result?.hash }, wait: true })) }, remote);
    assert.equal(denied.status, 403);
    assert.equal(running.ledger.lastSeq(), before);
    assert.equal(readFileSync(join(dir, "home", "PROACTIVE.md"), "utf8"), "Pause all nudges.\n");
  } finally {
    abort.abort();
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
