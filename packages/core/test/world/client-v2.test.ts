import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AshClient } from "../../../sdk/src/client";
import { AshApiError, type Message } from "../../../sdk/src/api";
import { startOwner } from "../../src/main";

test("v2 SDK follows real HTTP/SSE and echo's durable inbox across disconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-client-v2-"));
  const running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")?.[0];
  assert.ok(token);
  const client = new AshClient(running.url, token, { retryMs: 10 });
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const timeout = setTimeout(() => { firstAbort.abort(); secondAbort.abort(); }, 10_000);
  try {
    const described = await client.describe("agent:main");
    assert.equal(described.members[0].id, "agent:main");
    assert.equal(described.members[0].words.some((word) => typeof word === "object" && word.word === "say"), true);
    const first = client.stream({ after: 0, signal: firstAbort.signal });
    const registration = await first.next();
    assert.equal(registration.value?.type, "screen");
    const accepted = await client.send({ to: "agent:main", kind: "request", word: "say", body: { text: "one" }, client_id: "echo-one", wait: true });
    assert.equal(accepted.reply?.body.ok, true);
    assert.equal(running.ledger.byId(accepted.id)?.origin?.screen, client.screen?.screen, "registered proof stamps the real screen origin");
    const messages: Message[] = [];
    for await (const frame of first) {
      if (frame.type === "message" && !("summary" in frame.message)) {
        messages.push(frame.message);
        if (frame.message.from === "agent:main" && frame.message.word === "turn.end") break;
      }
    }
    firstAbort.abort();
    assert.equal(messages.some((m) => m.from === "agent:main" && m.word === "received"), true);
    assert.equal(messages.some((m) => m.from === "agent:main" && m.word === "read"), true);
    assert.equal(messages.some((m) => m.from === "agent:main" && m.word === "turn.start"), true);
    assert.equal(messages.some((m) => m.from === "agent:main" && m.to === "person:owner" && m.word === "say" && String(m.body.text).includes("one")), true);
    const last = client.lastSeq;
    assert.ok(last > accepted.seq);
    const acceptedAgain = await client.send({ to: "agent:main", kind: "request", word: "say", body: { text: "one" }, client_id: "echo-one", wait: true });
    assert.equal(acceptedAgain.id, accepted.id);
    assert.equal(acceptedAgain.seq, accepted.seq);
    assert.equal(running.ledger.list({ limit: 1000 }).filter((m) => m.id === accepted.id).length, 1);
    const secondSend = await client.send({ to: "agent:main", kind: "request", word: "say", body: { text: "two" }, client_id: "echo-two", wait: true });
    assert.equal(secondSend.reply?.body.ok, true);
    const resumed = client.stream({ after: last, authScope: client.authScope ?? undefined, signal: secondAbort.signal });
    const newRegistration = await resumed.next();
    assert.equal(newRegistration.value?.type, "screen");
    const replay: Message[] = [];
    for await (const frame of resumed) {
      if (frame.type === "message" && !("summary" in frame.message)) {
        replay.push(frame.message);
        if (frame.message.from === "agent:main" && frame.message.word === "turn.end") break;
      }
    }
    secondAbort.abort();
    assert.ok(replay.length > 0);
    assert.equal(replay.every((m) => m.seq > last), true);
    assert.equal(replay.some((m) => m.id === accepted.id), false);
    assert.equal(replay.some((m) => m.id === secondSend.id), true);
    const ownerSays = running.ledger.list({ limit: 1000 }).filter((m) => m.kind === "request" && m.from === "person:owner" && m.to === "agent:main" && m.word === "say");
    assert.equal(ownerSays.length, 2);
    await assert.rejects(client.send({ to: "agent:missing", kind: "request", word: "say", body: { text: "not found" }, wait: true }),
      (error: unknown) => error instanceof AshApiError && error.status === 404 && error.code === "not_found");
    const beforeInvalid = running.ledger.list({ limit: 1000 }).length;
    await assert.rejects(client.send({ to: "agent:main", kind: "request", word: "say", body: { unexpected: true }, wait: true }),
      (error: unknown) => error instanceof AshApiError && error.code === "bad_request");
    assert.equal(running.ledger.list({ limit: 1000 }).length, beforeInvalid, "invalid input never reaches the inbox or ledger");
  } finally {
    clearTimeout(timeout); firstAbort.abort(); secondAbort.abort();
    await running.close(); rmSync(dir, { recursive: true, force: true });
  }
});
