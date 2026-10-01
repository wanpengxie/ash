import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("production HTTP registered screen reads managed Markdown; stale editor write cannot overwrite background update", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-self-ui-http-"));
  const home = join(root, "home"); mkdirSync(home);
  writeFileSync(join(home, "SOUL.md"), "original\n");
  const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "echo" }] });
  const owner = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
  const auth = { authorization: `Bearer ${owner}`, "content-type": "application/json" };
  const controller = new AbortController();
  try {
    const stream = await fetch(`${running.url}/api/stream?follow=true&label=Self%20editor`, { headers: auth, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let frame = "";
    while (!frame.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      frame += decoder.decode(chunk.value);
    }
    const registration = JSON.parse(/^event: screen\.registered\ndata: (.+)\n\n/.exec(frame)![1]) as { token: string; screen: string };
    assert.match(registration.screen, /^screen:/);
    const send = async (word: string, body: object, client_id: string) => {
      const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { ...auth, "Ash-Screen": registration.token },
        body: JSON.stringify({ to: "service:self", kind: "request", word, body, wait: true, client_id }) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ reply: { body: { ok: boolean; result?: { content: string; hash: string }; error?: { code: string; message: string } } } }>;
    };
    const read = await send("read", { path: "SOUL.md" }, "read-1");
    assert.equal(read.reply.body.ok, true);
    assert.equal(read.reply.body.result?.content, "original\n");
    const baseline = read.reply.body.result?.hash;
    assert.equal(baseline, digest("original\n"));
    const background = await send("write", { path: "SOUL.md", content: "background\n", why: "synthetic", expected_hash: baseline }, "background-1");
    assert.equal(background.reply.body.ok, true);
    const stale = await send("write", { path: "SOUL.md", content: "owner draft\n", why: "synthetic", expected_hash: baseline }, "editor-1");
    assert.equal(stale.reply.body.ok, false);
    assert.deepEqual(stale.reply.body.error, { code: "bad_request", message: "stale" });
    assert.equal(readFileSync(join(home, "SOUL.md"), "utf8"), "background\n");
    assert.equal(running.ledger.list().filter((message) => message.word === "self.changed").length, 1);
    await reader.cancel();
  } finally { controller.abort(); await running.close(); }
});
