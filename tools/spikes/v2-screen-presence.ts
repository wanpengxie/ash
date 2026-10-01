import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../packages/core/src/main";
import { SCREEN_TOKEN_HEADER } from "../../packages/sdk/src/api";

const stateDir = mkdtempSync(join(tmpdir(), "ash-screen-presence-"));
const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
const auth = { authorization: `Bearer ${ownerToken}` };
const streamAbort = new AbortController();
try {
  const stream = await fetch(`${running.url}/api/stream?after=0&follow=true&label=Presence%20probe`, { headers: auth, signal: streamAbort.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let first = "";
  while (!first.includes("\n\n")) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); first += decoder.decode(chunk.value);
  }
  const registration = JSON.parse(/^event: screen\.registered\ndata: (.+)\n\n/.exec(first)![1]) as { screen: string; token: string };
  void (async () => { try { while (!(await reader.read()).done) { /* keep live SSE consumed */ } } catch { /* final abort */ } })();
  const visible = async () => {
    const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { ...auth, [SCREEN_TOKEN_HEADER]: registration.token, "content-type": "application/json" },
      body: JSON.stringify({ to: "service:post", kind: "event", word: "visible", body: {} }) });
    assert.equal(response.status, 200);
  };
  await visible();
  assert.equal(running.edge.screens.visible(registration.screen), true);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await visible(); // A new heartbeat renews the foreground window.
  assert.equal(running.edge.screens.visible(registration.screen), true);
  const renewedAt = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 60_250));
  assert.equal(running.edge.screens.visible(registration.screen), false);
  const heartbeats = running.ledger.list().filter((message) => message.from === registration.screen && message.word === "visible");
  assert.equal(heartbeats.length, 2);
  process.stdout.write(JSON.stringify({ real_wait_ms: Date.now() - renewedAt, heartbeats: heartbeats.length, expired: true }) + "\n");
} finally {
  streamAbort.abort();
  await running.close();
  rmSync(stateDir, { recursive: true, force: true });
}
