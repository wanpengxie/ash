import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { createSelfMember, type SelfStage } from "../../src/members/self";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-test", member: "person:owner", local: true, remote: false, ownerProxy: true };
const agent: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false };

async function fixture(failpoint?: (stage: SelfStage) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ash-self-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  router.setGate(async () => ({ allow: true, by: "answer" }));
  const members = new WorldMembers(router);
  const self = createSelfMember({ home, stateDir: join(dir, "state"), ledger, router, failpoint });
  members.register(self);
  const send = (word: string, body: Record<string, unknown>, ctx = owner, client_id?: string) => router.send(ctx, { to: "service:self", kind: "request", word, body, wait: true, ...(client_id ? { client_id } : {}) });
  return { dir, home, ledger, router, members, self, send };
}

test("self enforces canonical paths, byte hashes, USER frontmatter and authentic by", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.send("write", { path: "../outside", content: "bad", why: "test", expected_hash: null }), /schema/); // rejected before member
    const created = await f.send("write", { path: "USER.md", content: "Notes\n", why: "test", expected_hash: null }, agent);
    assert.equal(created.reply?.body.ok, true);
    const written = readFileSync(join(f.home, "USER.md"), "utf8");
    assert.match(written, /^---\nversion: 1\nupdated: .*\n---\nNotes\n$/);
    const firstHash = (created.reply?.body.result as { hash: string; version: number }).hash;
    assert.equal((created.reply?.body.result as { version: number }).version, 1);
    const read = await f.send("read", { path: "USER.md" });
    assert.deepEqual((read.reply?.body.result as { content: string; hash: string; version: number }), { content: written, hash: firstHash, version: 1 });
    const stale = await f.send("write", { path: "USER.md", content: "bad", why: "test", expected_hash: "0".repeat(64) });
    assert.equal((stale.reply?.body.error as { message: string }).message, "stale");
    assert.equal(readFileSync(join(f.home, "USER.md"), "utf8"), written);
    const updated = await f.send("write", { path: "USER.md", content: written.replace("Notes", "New"), why: "test", expected_hash: firstHash });
    assert.equal((updated.reply?.body.result as { version: number }).version, 2);
    const changed = f.ledger.list().filter((m) => m.word === "self.changed");
    assert.equal(changed.length, 2);
    assert.equal(changed[0].body.by, "agent:main");
    assert.equal(changed[1].body.by, "person:owner");
    const history = await f.send("history", { path: "USER.md" });
    assert.equal((history.reply?.body.result as { versions: unknown[] }).versions.length, 1);
  } finally { await f.self.close(); f.ledger.close(); }
});

test("self applies all guards against original lines, rejects stale batch and deduplicates append", async () => {
  const f = await fixture();
  try {
    const created = await f.send("write", { path: "MEMORY.md", content: "one\ntwo\nthree\n", why: "test", expected_hash: null });
    const baseline = (created.reply?.body.result as { hash: string }).hash;
    const edits = [
      { op: "replace", start: 1, end: 1, guard: "one", text: "ONE", reason: "correct", evidence: [] },
      { op: "insert_after", start: 3, end: 3, guard: "three", text: "four", reason: "complete", evidence: [] },
    ];
    const bad = await f.send("apply_plan", { path: "MEMORY.md", expected_hash: baseline, edits: [{ ...edits[0], guard: "wrong" }, edits[1]] });
    assert.equal((bad.reply?.body.error as { message: string }).message, "stale");
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "one\ntwo\nthree\n");
    const good = await f.send("apply_plan", { path: "MEMORY.md", expected_hash: baseline, edits });
    assert.equal(good.reply?.body.ok, true);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "ONE\ntwo\nthree\nfour\n");
    const stale = await f.send("apply_plan", { path: "MEMORY.md", expected_hash: baseline, edits });
    assert.equal((stale.reply?.body.error as { message: string }).message, "stale");
    const a = await f.send("append", { path: "memory/2026-10-01.md", text: "first\n" }, agent, "append-a");
    const b = await f.send("append", { path: "memory/2026-10-01.md", text: "first\n" }, agent, "append-a");
    assert.equal(a.id, b.id);
    assert.equal(readFileSync(join(f.home, "memory", "2026-10-01.md"), "utf8"), "first\n");
    assert.equal(f.ledger.list().filter((m) => m.word === "self.changed").length, 3);
    const history = await f.send("history", { path: "MEMORY.md" });
    const ts = (history.reply?.body.result as { versions: { ts: number }[] }).versions[0].ts;
    const rolled = await f.send("rollback", { path: "MEMORY.md", to_ts: ts });
    assert.equal(rolled.reply?.body.ok, true);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "one\ntwo\nthree\n");
  } finally { await f.self.close(); f.ledger.close(); }
});

test("SIGKILL at every durable self-write boundary recovers one file effect and one event", async () => {
  const child = fileURLToPath(new URL("../fixtures/self-crash-child.ts", import.meta.url));
  for (const stage of ["after-intent", "after-snapshot", "after-temp", "after-rename", "after-event"] as SelfStage[]) {
    const dir = mkdtempSync(join(tmpdir(), `ash-self-kill-${stage}-`));
    const home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "MEMORY.md"), "before\n");
    const killed = spawnSync(process.execPath, ["--import", "tsx", child, dir, stage], { cwd: process.cwd(), timeout: 10_000, encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", `${stage}: ${killed.stderr}`);
    const ledger = await Ledger.open(join(dir, "ash.db"));
    const world = new WorldRouter(ledger, async () => true);
    const members = new WorldMembers(world);
    const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router: world }); members.register(self);
    try {
      await self.prepareRecovery();
      await world.recover();
      const request = ledger.list().find((m) => m.word === "write" && m.to === "service:self");
      assert.ok(request, stage);
      const until = Date.now() + 2_000;
      while (!ledger.responseTo(request.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(ledger.responseTo(request.id)?.body.ok, true, stage);
      assert.equal(readFileSync(join(home, "MEMORY.md"), "utf8"), "after\n", stage);
      assert.equal(ledger.list().filter((m) => m.word === "self.changed").length, 1, stage);
      assert.equal(ledger.list().filter((m) => m.reply_to === request.id).length, 1, stage);
      assert.equal(readdirSync(join(home, ".ash", "versions", "MEMORY.md")).filter((name) => name.endsWith(".md")).length, 1, stage);
      const retry = await world.send(owner, { to: "service:self", kind: "request", word: "write", body: { path: "MEMORY.md", content: "after\n", why: "synthetic crash", expected_hash: createHash("sha256").update("before\n").digest("hex") }, client_id: "crash-write", wait: true });
      assert.equal(retry.id, request.id, stage);
      assert.equal(ledger.list().filter((m) => m.word === "self.changed").length, 1, stage);
    } finally { await self.close(); ledger.close(); }
  }
});

test("append after SIGKILL never repeats bytes, and external tampering resolves as conflict", async () => {
  const child = fileURLToPath(new URL("../fixtures/self-crash-child.ts", import.meta.url));
  for (const conflict of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "ash-self-append-kill-"));
    const home = join(dir, "home"); mkdirSync(join(home, "memory"), { recursive: true });
    const file = join(home, "memory", "2026-10-01.md"); writeFileSync(file, "before\n");
    const stage = conflict ? "after-temp" : "after-rename";
    const killed = spawnSync(process.execPath, ["--import", "tsx", child, dir, stage, "append"], { cwd: process.cwd(), timeout: 10_000, encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    if (conflict) writeFileSync(file, "external\n");
    const ledger = await Ledger.open(join(dir, "ash.db"));
    const world = new WorldRouter(ledger, async () => true);
    const members = new WorldMembers(world);
    const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router: world }); members.register(self);
    try {
      await self.prepareRecovery(); await world.recover();
      const request = ledger.list().find((m) => m.to === "service:self" && m.word === "append")!;
      const until = Date.now() + 2_000;
      while (!ledger.responseTo(request.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(ledger.responseTo(request.id)?.body.ok, !conflict);
      assert.equal(readFileSync(file, "utf8"), conflict ? "external\n" : "before\nafter\n");
      assert.equal(ledger.list().filter((m) => m.word === "self.changed").length, conflict ? 0 : 1);
    } finally { await self.close(); ledger.close(); }
  }
});

test("recovery rechecks authority before an unfinished write but records an already completed effect", async () => {
  const child = fileURLToPath(new URL("../fixtures/self-crash-child.ts", import.meta.url));
  for (const stage of ["after-intent", "after-rename"] as SelfStage[]) {
    const dir = mkdtempSync(join(tmpdir(), "ash-self-revoked-"));
    const home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "MEMORY.md"), "before\n");
    const killed = spawnSync(process.execPath, ["--import", "tsx", child, dir, stage], { cwd: process.cwd(), timeout: 10_000, encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const ledger = await Ledger.open(join(dir, "ash.db"));
    const world = new WorldRouter(ledger, async () => false);
    const members = new WorldMembers(world);
    const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router: world }); members.register(self);
    try {
      await self.prepareRecovery(); await world.recover();
      const request = ledger.list().find((m) => m.to === "service:self" && m.word === "write")!;
      const response = ledger.responseTo(request.id);
      assert.ok(response);
      assert.equal(response.body.ok, stage === "after-rename");
      assert.equal(readFileSync(join(home, "MEMORY.md"), "utf8"), stage === "after-rename" ? "after\n" : "before\n");
      assert.equal(ledger.list().filter((m) => m.word === "self.changed").length, stage === "after-rename" ? 1 : 0);
    } finally { await self.close(); ledger.close(); }
  }
});

test("an external writer producing the intended bytes is not misattributed to self", async () => {
  const child = fileURLToPath(new URL("../fixtures/self-crash-child.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "ash-self-same-bytes-"));
  const home = join(dir, "home"); mkdirSync(home); writeFileSync(join(home, "MEMORY.md"), "before\n");
  const killed = spawnSync(process.execPath, ["--import", "tsx", child, dir, "after-temp"], { cwd: process.cwd(), timeout: 10_000, encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  writeFileSync(join(home, "MEMORY.md"), "after\n"); // same bytes, but the prepared inode was not renamed
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router: world }); members.register(self);
  try {
    await self.prepareRecovery(); await world.recover();
    const request = ledger.list().find((m) => m.to === "service:self" && m.word === "write")!;
    assert.equal((ledger.responseTo(request.id)?.body.error as { message: string }).message, "conflict");
    assert.equal(ledger.list().filter((m) => m.word === "self.changed").length, 0);
    assert.equal(readFileSync(join(home, "MEMORY.md"), "utf8"), "after\n");
  } finally { await self.close(); ledger.close(); }
});

test("cancellation before rename leaves neither a write nor a misleading snapshot", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  let requestId = "";
  f = await fixture((stage) => { if (stage === "after-temp") f.router.cancel([requestId]); });
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "before\n");
    const stop = f.router.subscribe((message) => { if (message.to === "service:self" && message.word === "write") requestId = message.id; });
    const sent = await f.send("write", { path: "MEMORY.md", content: "after\n", why: "test", expected_hash: createHash("sha256").update("before\n").digest("hex") });
    stop();
    assert.equal((sent.reply?.body.error as { code: string }).code, "cancelled");
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "before\n");
    assert.equal(f.ledger.list().filter((message) => message.word === "self.changed").length, 0);
    const history = await f.send("history", { path: "MEMORY.md" });
    assert.deepEqual((history.reply?.body.result as { versions: unknown[] }).versions, []);
  } finally { await f.self.close(); f.ledger.close(); }
});

test("self rejects symbolic and hard-link aliases and retains only the latest 50 snapshots", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, "SOUL.md"), "protected");
    linkSync(join(f.home, "SOUL.md"), join(f.home, "MEMORY.md"));
    const hard = await f.send("write", { path: "MEMORY.md", content: "bad", why: "test", expected_hash: createHash("sha256").update("protected").digest("hex") });
    assert.equal((hard.reply?.body.error as { code: string }).code, "forbidden");
    assert.equal(readFileSync(join(f.home, "SOUL.md"), "utf8"), "protected");
    const outside = join(f.dir, "elsewhere"); mkdirSync(outside);
    symlinkSync(outside, join(f.home, "memory"));
    const link = await f.send("append", { path: "memory/2026-10-01.md", text: "bad" });
    assert.equal((link.reply?.body.error as { code: string }).code, "forbidden");
    writeFileSync(join(f.home, "IDENTITY.md"), Buffer.from([0xff]));
    const invalid = await f.send("read", { path: "IDENTITY.md" });
    assert.equal((invalid.reply?.body.error as { code: string }).code, "bad_request");
  } finally { await f.self.close(); f.ledger.close(); }
  const g = await fixture();
  try {
    let expected_hash: string | null = null;
    for (let i = 0; i < 52; i++) {
      const reply = await g.send("write", { path: "MEMORY.md", content: `v${i}\n`, why: "test", expected_hash });
      assert.equal(reply.reply?.body.ok, true);
      expected_hash = (reply.reply?.body.result as { hash: string }).hash;
    }
    const history = await g.send("history", { path: "MEMORY.md" });
    assert.equal((history.reply?.body.result as { versions: unknown[] }).versions.length, 50);
    assert.equal(readdirSync(join(g.home, ".ash", "versions", "MEMORY.md")).length, 50);
  } finally { await g.self.close(); g.ledger.close(); }
});
