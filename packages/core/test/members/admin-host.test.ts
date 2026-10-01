import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ResponseBody } from "../../../sdk/src/api";
import { startOwner } from "../../src/main";

test("production pause queues a new owner message until verified local screen confirmation resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-host-"));
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  const streamAbort = new AbortController();
  try {
    running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const send = async (word: string, body: Record<string, unknown>, screen?: string) => fetch(`${running!.url}/api/send`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(screen ? { "Ash-Screen": screen } : {}) },
      body: JSON.stringify({ to: word === "say" ? "agent:main" : "service:admin", kind: "request", word, body, wait: true }),
    });
    const pause = await send("pause", {});
    assert.equal(pause.status, 200);
    assert.deepEqual((await pause.json() as { reply: { body: unknown } }).reply.body, { ok: true, result: { paused: true } });
    const queued = await send("say", { text: "synthetic queued while paused" });
    assert.equal(queued.status, 200);
    const queuedId = (await queued.json() as { id: string }).id;
    const queuedTurnCount = () => running!.ledger.list({ limit: 1000 }).filter((item) =>
      item.word === "turn.start" && Array.isArray(item.body.ids) && item.body.ids.includes(queuedId)).length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(queuedTurnCount(), 0);
    const beforeDenied = running.ledger.lastSeq();
    const apiResume = await send("resume", { confirmed: true });
    assert.equal(apiResume.status, 403);
    assert.equal(running.ledger.lastSeq(), beforeDenied);
    const remoteCaller = { member: "person:owner", transportPrincipal: "gateway:synthetic", pairedDeviceId: "synthetic",
      local: false, remote: true, ownerProxy: true, transport: "web_ui" as const };
    const remoteStream = await running.edge.handle({ method: "GET", url: new URL("/api/stream?after=0&follow=true", running.url), headers: {}, body: null }, remoteCaller);
    assert.equal(remoteStream.status, 200);
    let remoteFrames = "", closeRemote = () => {};
    if ("stream" in remoteStream) remoteStream.stream((chunk) => { remoteFrames += chunk; }, (cleanup) => { closeRemote = cleanup; }, () => {});
    const remoteRegistration = /event: screen\.registered\ndata: ([^\n]+)/.exec(remoteFrames);
    assert.ok(remoteRegistration);
    const remoteToken = (JSON.parse(remoteRegistration[1]) as { token: string }).token;
    const remote = await running.edge.handle({ method: "POST", url: new URL("/api/send", running.url), headers: { "ash-screen": remoteToken },
      body: Buffer.from(JSON.stringify({ to: "service:admin", kind: "request", word: "pause", body: {} })) }, remoteCaller);
    closeRemote();
    assert.equal(remote.status, 403);
    assert.equal(running.ledger.lastSeq(), beforeDenied);
    const stream = await fetch(`${running.url}/api/stream?after=0&follow=true&label=Synthetic`, {
      headers: { authorization: `Bearer ${token}` }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    let frames = "";
    const deadline = Date.now() + 5000;
    while (!frames.includes("event: screen.registered") && Date.now() < deadline) {
      const next = await reader.read();
      if (next.done) break;
      frames += new TextDecoder().decode(next.value);
    }
    const registration = /event: screen\.registered\ndata: ([^\n]+)/.exec(frames);
    assert.ok(registration, "local owner stream must register a screen");
    const screenToken = (JSON.parse(registration[1]) as { token: string }).token;
    const resume = await send("resume", { confirmed: true }, screenToken);
    assert.equal(resume.status, 200);
    assert.deepEqual((await resume.json() as { reply: { body: unknown } }).reply.body, { ok: true, result: { paused: false } });
    const until = Date.now() + 5000;
    while (Date.now() < until && queuedTurnCount() === 0)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(queuedTurnCount(), 1);
  } finally {
    streamAbort.abort();
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const revoke of [false, true]) test(`production recovery ${revoke ? "rejects" : "accepts"} uncommitted reflex pause according to current original owner grant`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-reflex-recover-"));
  const stateDir = join(dir, "state");
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const owner = { member: "person:owner", transport: "api" as const, transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`,
      local: true, remote: false, ownerProxy: true };
    const source = await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic source" }, wait: true });
    const stranded = running.ledger.append({ from: "service:reflex", to: "service:admin", kind: "request", word: "pause", body: { by: source.id } },
      { transportPrincipal: "service:reflex", clientId: "reflex:recovery" },
      { deadlineAt: Date.now() + 30_000, context: { member: "service:reflex", local: true, remote: false, ownerProxy: false, transportPrincipal: "service:reflex" } },
      { byMessageId: source.id }).message;
    await running.close(); running = null;
    if (revoke) {
      const file = join(stateDir, "tokens.json");
      const tokens = JSON.parse(readFileSync(file, "utf8")) as { api: Record<string, string> };
      for (const [key, member] of Object.entries(tokens.api)) if (member === "person:owner") delete tokens.api[key];
      writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
    }
    running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    const until = Date.now() + 5000;
    while (!running.ledger.responseTo(stranded.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = running.ledger.responseTo(stranded.id)?.body as ResponseBody | undefined;
    assert.equal(reply?.ok, !revoke);
    if (revoke) assert.equal(reply?.ok === false ? reply.error.code : null, "forbidden");
    else assert.deepEqual(reply, { ok: true, result: { paused: true } });
    const db = new DatabaseSync(join(stateDir, "ash.db"), { readOnly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_pause_commands").get() as { n: number }).n, revoke ? 0 : 1); }
    finally { db.close(); }
  } finally { await running?.close(); rmSync(dir, { recursive: true, force: true }); }
});
