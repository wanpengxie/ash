import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eventually, STUCK_MS } from "../fixtures/wait";
import type { Message } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { DEFAULT_TURN_TEXT_BUDGET, TurnTextBudgetError, renderTurnBatch } from "../../src/members/agent-render";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-api", member: "person:owner", local: true, remote: false, ownerProxy: false };
const screen = (label: string, id: string): TrustedRouteContext => ({ transport: "web_ui", transportPrincipal: id, member: "person:owner", local: true,
  remote: false, ownerProxy: true, screenId: `screen:${id}`, screenLabel: label });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Fails only a stuck test: a signal that must come is waited for this long, however loaded the machine is. */
const stuck = (what: string) => new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(what)), STUCK_MS).unref(); });

async function fixture(runner: AgentTurnRunner) {
  const dir = mkdtempSync(join(tmpdir(), "agent-inbox-"));
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const router = new WorldRouter(ledger, async () => true);
  const member = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner });
  const members = new WorldMembers(router);
  members.register(member);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  member.prepareRecovery();
  const messages = (): Message[] => {
    const all: Message[] = [];
    let after = 0;
    while (true) {
      const page = ledger.list({ after, limit: 1000 });
      all.push(...page);
      if (page.length < 1000) break;
      after = page.at(-1)!.seq;
    }
    return all;
  };
  const waitFor = (predicate: (rows: Message[]) => boolean) => eventually(() => { const rows = messages(); return predicate(rows) && rows; }, "message sequence did not appear");
  return { dir, ledger, router, member, members, messages, waitFor, async close() { await member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const inbound = (index: number, text = `message ${index}`): Message => ({ seq: index, id: `m_${String(index).padStart(12, "0")}`, ts: Date.UTC(2026, 9, 1, 0, 0, index),
  from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text }, origin: { screen: "screen:phone", label: "Phone" } });

test("one say is durably accepted before ACK and yields ordered received/read/start/reply/end", async () => {
  const seen: AgentTurnInput[] = [];
  const f = await fixture({ async runTurn(input, emit) { seen.push(input); await emit({ id: "answer-1", text: "Hello" }); return { reason: "completed" }; } });
  try {
    await f.member.start();
    const sent = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "Hi" }, wait: true });
    assert.equal(sent.reply?.body.ok, true);
    assert.deepEqual(sent.reply?.body.result, { accepted: true });
    assert.equal(f.member.counts().pending + f.member.counts().read, 1);
    const rows = await f.waitFor((list) => list.some((m) => m.word === "turn.end"));
    const names = rows.filter((m) => (m.from === "agent:main" && m.word !== "status" &&
      (m.kind === "event" || (m.kind === "request" && m.to === "person:owner")))).map((m) => m.word);
    assert.deepEqual(names, ["received", "read", "turn.start", "say", "turn.end"]);
    assert.deepEqual((rows.find((m) => m.word === "read")?.body.ids as string[]), [sent.id]);
    assert.equal(seen[0].messages[0].id, sent.id);
    assert.match(seen[0].rendered, /Hi/);
  } finally { await f.close(); }
});

test("three messages arriving during an active turn form one next batch in seq order with source stamps", async () => {
  let entered!: () => void; let release!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const batches: AgentTurnInput[] = [];
  const f = await fixture({ async runTurn(input) { batches.push(input); if (batches.length === 1) { entered(); await gate; } return { reason: "completed" }; } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await active;
    for (const [index, label] of ["Phone", "Mac", "Tablet"].entries()) {
      await f.router.send(screen(label, `tab${index}`), { to: "agent:main", kind: "request", word: "say", body: { text: `later ${index}` }, wait: true });
    }
    assert.equal(f.member.counts().pending, 3);
    release();
    await f.waitFor((rows) => rows.filter((m) => m.word === "turn.end").length === 2);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1].messages.map((m) => m.body.text), ["later 0", "later 1", "later 2"]);
    assert.deepEqual(batches[1].messages.map((m) => m.origin?.label), ["Phone", "Mac", "Tablet"]);
    assert.deepEqual(batches[1].messages.map((m) => m.seq), [...batches[1].messages.map((m) => m.seq)].sort((a, b) => a - b));
    for (const label of ["Phone", "Mac", "Tablet"]) assert.match(batches[1].rendered, new RegExp(label));
  } finally { release(); await f.close(); }
});

test("fifty short messages remain complete; long multibyte text is bounded and explicitly excerpted", () => {
  const short = Array.from({ length: 50 }, (_, index) => inbound(index + 1, `fact-${index + 1}`));
  const full = renderTurnBatch(short);
  assert.ok(Buffer.byteLength(full) <= DEFAULT_TURN_TEXT_BUDGET);
  assert.doesNotMatch(full, /excerpt/);
  for (const message of short) { assert.match(full, new RegExp(message.id)); assert.match(full, new RegExp(String(message.body.text))); }

  const long = short.map((message) => ({ ...message, body: { text: "你好🙂\n".repeat(1000) } }));
  const folded = renderTurnBatch(long);
  assert.ok(Buffer.byteLength(folded) <= DEFAULT_TURN_TEXT_BUDGET);
  assert.equal((folded.match(/\[excerpt; omitted \d+ UTF-8 bytes\]/g) ?? []).length, 50);
  for (const message of long) assert.match(folded, new RegExp(message.id));
  assert.match(folded, /never infer missing facts or authorization/);
});

test("extreme origin metadata is explicitly clipped; insufficient budget leaves the inbox pending", async () => {
  const huge = Array.from({ length: 50 }, (_, index) => ({ ...inbound(index + 1), from: `device:${"x".repeat(6000)}`,
    origin: { screen: `screen:${"z".repeat(6000)}`, label: "界".repeat(3000) } }));
  const rendered = renderTurnBatch(huge);
  assert.ok(Buffer.byteLength(rendered) <= DEFAULT_TURN_TEXT_BUDGET);
  for (const message of huge) assert.match(rendered, new RegExp(message.id));
  assert.match(rendered, /\(\+\d+B\)/);
  assert.throws(() => renderTurnBatch(huge, 512), TurnTextBudgetError);

  const f = await fixture({ renderBudgetBytes: 512, async runTurn() { throw new Error("must not run"); } });
  try {
    for (let index = 0; index < 50; index++) await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: `fact ${index}` }, wait: true });
    await f.member.start();
    await eventually(() => f.member.lastError, "the turn did not fail");
    assert.ok(f.member.lastError instanceof TurnTextBudgetError);
    assert.deepEqual(f.member.counts(), { pending: 50, read: 0, active: 0 });
  } finally { await f.close(); }
});

test("same output id with changed body is rejected rather than creating a second owner say", async () => {
  const f = await fixture({ async runTurn(_input, emit) {
    await emit({ id: "stable", text: "one" });
    await emit({ id: "stable", text: "two" });
    return { reason: "completed" };
  } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "go" }, wait: true });
    const rows = await f.waitFor((list) => list.some((m) => m.word === "turn.end"));
    const said = rows.filter((m) => m.word === "say" && m.kind === "request" && m.from === "agent:main" && m.to === "person:owner").map((m) => m.body.text);
    // The runner's words once, then Ash's one notice that the turn failed.
    assert.deepEqual(said, ["one", "刚才这件事没做成：出了点意外的错误。"]);
    assert.equal(rows.find((m) => m.word === "turn.end")?.body.reason, "error");
  } finally { await f.close(); }
});

test("close during a persisted lifecycle send cannot touch a closed inbox", async () => {
  for (const blockedWord of ["received", "read", "turn.start"] as const) {
    let arrived!: () => void; let release!: () => void;
    const blocked = new Promise<void>((resolve) => { arrived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runnerCalls = 0;
    const f = await fixture({ async runTurn() { runnerCalls++; return { reason: "completed" }; } });
    const original = f.router.send.bind(f.router);
    f.router.send = (async (...args: Parameters<WorldRouter["send"]>) => {
      if (args[1].word === blockedWord) { arrived(); await gate; }
      return original(...args);
    }) as WorldRouter["send"];
    try {
      if (blockedWord === "received") {
        await f.member.start();
        await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "after start" }, wait: true });
      }
      else await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "before start" }, wait: true });
      if (blockedWord !== "received") await f.member.start();
      await Promise.race([blocked, stuck(`did not block ${blockedWord}`)]);
      await f.member.close();
      release();
      await sleep(30);
      assert.equal(f.member.lastError, null, `closed inbox touched after ${blockedWord}`);
      assert.equal(runnerCalls, 0, `runner started after close during ${blockedWord}`);
    } finally { release(); await f.close(); }
  }
});

test("saved emit callback cannot publish after its turn has ended", async () => {
  let savedEmit: ((output: { id: string; text: string }) => Promise<void>) | undefined;
  const f = await fixture({ async runTurn(_input, emit) { savedEmit = emit; return { reason: "completed" }; } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "go" }, wait: true });
    await f.waitFor((rows) => rows.some((message) => message.word === "turn.end"));
    assert.ok(savedEmit);
    await savedEmit({ id: "after-end", text: "must not publish" });
    assert.equal(f.messages().filter((message) => message.kind === "request" && message.from === "agent:main" && message.word === "say").length, 0);
  } finally { await f.close(); }
});

test("close aborts a reply held before its ledger append", async () => {
  let held!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { held = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ async runTurn(_input, emit) { await emit({ id: "held-reply", text: "must not arrive" }); return { reason: "completed" }; } });
  const original = f.router.send.bind(f.router);
  f.router.send = (async (...args: Parameters<WorldRouter["send"]>) => {
    if (args[1].word === "say" && args[0].member === "agent:main" && args[1].to === "person:owner") { held(); await gate; }
    return original(...args);
  }) as WorldRouter["send"];
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "go" }, wait: true });
    await Promise.race([entered, stuck("reply was not held")]);
    await f.member.close();
    release();
    await sleep(30);
    assert.equal(f.messages().filter((message) => message.kind === "request" && message.from === "agent:main" && message.word === "say").length, 0);
  } finally { release(); await f.close(); }
});

test("aborted internal send cannot accept a request or settle a response", async () => {
  const f = await fixture({ async runTurn() { return { reason: "completed" }; } });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "blocked" } }, controller.signal),
      (error: unknown) => error instanceof RouterError && error.code === "cancelled");
    await assert.rejects(f.router.send(owner, { to: "agent:main", kind: "response", word: "say", reply_to: "none", body: { ok: true } }, controller.signal),
      (error: unknown) => error instanceof RouterError && error.code === "cancelled");
    assert.deepEqual(f.messages(), []);
  } finally { await f.close(); }
});

test("a non-cooperative runner cannot emit after close", async () => {
  let entered!: () => void; let release!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ async runTurn(_input, emit) { entered(); await gate; await emit({ id: "late", text: "late output" }); return { reason: "completed" }; } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "go" }, wait: true });
    await active;
    await f.member.close();
    release();
    await sleep(30);
    assert.equal(f.messages().filter((m) => m.kind === "request" && m.from === "agent:main" && m.word === "say").length, 0);
  } finally { release(); await f.close(); }
});

test("SIGKILL leaves read work interrupted but resumes unread inbox exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-kill-"));
  const childFile = join(import.meta.dirname, "agent-kill-child.ts");
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ["--expose-internals", "--import", "tsx", childFile, mode, dir], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let diagnostic = "";
    child.stderr?.on("data", (part: Buffer) => { diagnostic += part.toString(); });
    return { child, get diagnostic() { return diagnostic; } };
  };
  const until = async (child: ReturnType<typeof launch>["child"], phase: string): Promise<Record<string, unknown>> => {
    return Promise.race([
      new Promise<Record<string, unknown>>((resolve, reject) => {
        child.on("message", (value: unknown) => { if (value && typeof value === "object" && (value as Record<string, unknown>).phase === phase) resolve(value as Record<string, unknown>); });
        child.once("exit", (code) => reject(new Error(`child exited before ${phase}: ${code}`)));
      }),
      stuck(`timeout waiting for ${phase}`),
    ]);
  };
  let victim: ReturnType<typeof launch> | undefined;
  let recovery: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    const ready = await until(victim.child, "kill-ready");
    assert.equal((ready.first as string[]).length, 1);
    victim.child.kill("SIGKILL");
    const [victimCode, victimSignal] = await once(victim.child, "exit");
    assert.equal(victimCode, null);
    assert.equal(victimSignal, "SIGKILL");

    recovery = launch("recover");
    const batch = await until(recovery.child, "recovered-batch");
    assert.deepEqual(batch.texts, ["pending 0", "pending 1", "pending 2"]);
    await until(recovery.child, "done");
    const [recoveryCode] = await once(recovery.child, "exit");
    assert.equal(recoveryCode, 0, recovery.diagnostic);

    const ledger = await Ledger.open(join(dir, "ledger.db"));
    try {
      const rows = ledger.list({ after: 0, limit: 1000 });
      const ends = rows.filter((message) => message.word === "turn.end");
      assert.deepEqual(ends.map((message) => message.body.reason), ["error", "completed"]);
      assert.match(String(ends[0].body.error), /Interrupted by process restart/);
      assert.deepEqual(rows.filter((message) => message.kind === "request" && message.from === "agent:main" && message.word === "say").map((message) => message.body.text),
        ["first answer", "刚才那件事做到一半被打断了（Ash 重启）。", "recovered answer"]);
      const received = rows.filter((message) => message.word === "received");
      assert.equal(received.length, 4);
      assert.equal(new Set(received.flatMap((message) => message.body.ids as string[])).size, 4);
      const secondRead = rows.find((message) => message.word === "read" && (message.body.ids as string[]).length === 3);
      assert.ok(secondRead);
      assert.ok(rows.findIndex((message) => message.id === secondRead.id) > rows.findIndex((message) => message.id === ends[0].id));
    } finally { ledger.close(); }
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
