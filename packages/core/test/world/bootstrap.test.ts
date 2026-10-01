import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import { AgentInbox } from "../../src/world/agent-inbox";
import { Ledger } from "../../src/world/ledger";

test("production DSH configuration fails before migration rather than falling back to echo", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-v2-boot-"));
  const stateDir = join(root, "state");
  await assert.rejects(startOwner({ stateDir, agents: [{ id: "agent:main", runtime: "dsh" }] }), /ASH-206/);
  assert.equal(existsSync(stateDir), false);
});

test("real production main serves only v2 routes with explicit echo and one durable inbox", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-v2-boot-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const auth = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${auth}`, "content-type": "application/json" };
    const old = await fetch(`${running.url}/api/agents`, { headers });
    assert.equal(old.status, 404);
    const describe = await fetch(`${running.url}/api/describe?member=agent:main`, { headers });
    assert.equal(describe.status, 200);
    assert.equal(((await describe.json()) as { members: { words: { word: string }[] }[] }).members[0].words.some((word) => word.word === "say"), true);
    const request = { to: "agent:main", kind: "request", word: "say", body: { text: "controlled echo input" }, client_id: "boot-say" };
    const accepted = await fetch(`${running.url}/api/send`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(accepted.status, 200);
    const first = await accepted.json() as { id: string; seq: number };
    const retry = await fetch(`${running.url}/api/send`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { id: string }).id, first.id);
    assert.equal(running.ledger.list().filter((message) => message.id === first.id).length, 1);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !running.ledger.list().some((message) => message.from === "agent:main" && message.word === "say")) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(running.ledger.list().some((message) => message.from === "agent:main" && message.word === "say"), true);
    assert.equal(existsSync(join(stateDir, "ash.db")), true);
    assert.equal(existsSync(join(stateDir, "agent-main", "agent-inbox.db")), true);
  } finally { await running.close(); }
});

test("production recovery rechecks a stable local token digest and fails closed after revocation", async () => {
  for (const active of [true, false]) {
    const stateDir = mkdtempSync(join(tmpdir(), "ash-v2-recovery-"));
    const oldToken = "controlled-old-high-entropy-token";
    const currentToken = active ? oldToken : "controlled-new-high-entropy-token";
    writeFileSync(join(stateDir, "tokens.json"), JSON.stringify({ api: { [currentToken]: "person:owner" }, mcp: {} }), { mode: 0o600 });
    const ledger = await Ledger.open(join(stateDir, "ash.db"));
    const request = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "controlled recovery" } }, undefined,
      { deadlineAt: Date.now() + 30_000, context: { member: "person:owner", local: true, remote: false, ownerProxy: true,
        transportPrincipal: `token:${createHash("sha256").update(oldToken).digest("hex")}` } }).message;
    ledger.close();
    const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !running.ledger.responseTo(request.id)) await new Promise((resolve) => setTimeout(resolve, 10));
      const response = running.ledger.responseTo(request.id);
      assert.ok(response);
      assert.equal(response.body.ok, active);
      if (!active) {
        assert.equal((response.body.error as { code: string }).code, "forbidden");
        assert.equal(running.ledger.list().some((message) => message.from === "agent:main" && message.kind === "request" && message.word === "say"), false);
      }
    } finally { await running.close(); }
  }
});

test("production bootstrap registers real self only for a configured home", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-v2-self-boot-"));
  const home = join(root, "home"); mkdirSync(home);
  const running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const described = await fetch(`${running.url}/api/describe?member=service:self`, { headers });
    assert.equal(described.status, 200);
    assert.equal(((await described.json()) as { members: { words: { word: string }[] }[] }).members[0].words.some((item) => item.word === "write"), true);
    const written = await fetch(`${running.url}/api/send`, { method: "POST", headers, body: JSON.stringify({ to: "service:self", kind: "request", word: "write", body: { path: "MEMORY.md", content: "synthetic\n", why: "test", expected_hash: null }, wait: true }) });
    assert.equal(written.status, 200);
    assert.equal(((await written.json()) as { reply: { body: { ok: boolean } } }).reply.body.ok, true);
    assert.equal(readFileSync(join(home, "MEMORY.md"), "utf8"), "synthetic\n");
    assert.equal(existsSync(join(root, "state", "self", "self-operations.db")), true);
  } finally { await running.close(); }
});

test("production bootstrap settles a durable stop intent before router recovery", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-v2-stop-recovery-"));
  const ledger = await Ledger.open(join(stateDir, "ash.db"));
  const inbox = new AgentInbox(join(stateDir, "agent-main"));
  const inbound = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "before stop" } }).message;
  inbox.accept(inbound);
  const turn = inbox.claim([inbound.id]);
  assert.ok(turn);
  const pending = ledger.append({ from: "agent:main", to: "device:probe", kind: "request", word: "hold", body: {}, turn: turn.id }, undefined,
    { deadlineAt: Date.now() + 30_000, context: { member: "agent:main", local: true, remote: false, ownerProxy: false,
      transportPrincipal: "agent:main" } }).message;
  assert.equal(inbox.recordCancel("stop-once", "stop before replay", "service:reflex", "Prior tool outcome may be unknown").cancelled, true);
  inbox.close();
  ledger.close();

  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const response = running.ledger.responseTo(pending.id);
    assert.equal((response?.body.error as { code?: string } | undefined)?.code, "cancelled");
    assert.equal(running.ledger.trackedRequests().some((item) => item.message.id === pending.id), false);
    const ends = running.ledger.list().filter((message) => message.word === "turn.end" && message.body.turn === turn.id);
    assert.equal(ends.length, 1);
    assert.equal(ends[0].body.reason, "cancelled");
    assert.deepEqual(running.ledger.list().filter((message) => message.from === "agent:main" && message.kind === "request" && message.word === "say"), []);
  } finally { await running.close(); }
});
