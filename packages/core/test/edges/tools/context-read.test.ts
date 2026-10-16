import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { WordError, type Message, type WordResult } from "../../../../sdk/src/message";
import { wordsOf } from "../../../../sdk/src/words";
import { createHostService } from "../../../src/edges/host/service";
import type { Ledger } from "../../../src/kernel/ledger";
import { agent, fake, flush, owner, word, world } from "../../kernel/router/world";
import { deferred, MAIN, startRig } from "./helpers";

const SENTINEL = "SYNTHETIC_CTX_PRIVATE_SENTINEL";
const request = { day: "2026-10-15", file: "screens", offset: 0, limit: 262144 };
const contract = wordsOf("service:host").find((c) => c.word === "ctx.read")!;
const result = (text: string, offset = 0): WordResult => ({
  data: { day: request.day, file: request.file, offset, next_offset: offset + Buffer.byteLength(text), size: 262144, eof: false, text },
  content: [{ type: "text", text }],
});
const send = (w: ReturnType<typeof world>, caller = agent(), body = request) =>
  w.router.send({ to: "service:host", kind: "request", word: "ctx.read", body }, caller);

/** Check rows, indexes' source columns, raw SQLite/WAL bytes, and every attachment file, not just summaries. */
function assertPrivate(ledger: Ledger, observed: Message[]): void {
  assert.ok(!JSON.stringify(observed).includes(SENTINEL), "control subscribers must not see raw text");
  const tables = ledger.db().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  for (const { name } of tables) {
    const rows = ledger.db().prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    assert.ok(!JSON.stringify(rows).includes(SENTINEL), `${name} must not store raw text`);
  }
  const database = ledger.db().prepare("PRAGMA database_list").get() as { file: string };
  const inspect = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) inspect(path);
      else assert.ok(!readFileSync(path).includes(Buffer.from(SENTINEL)), "raw DB/WAL/attachment bytes must not contain text");
    }
  };
  inspect(dirname(database.file));
  assert.equal(ledger.db().prepare("SELECT count(*) AS n FROM blobs").get()!.n, 0, "probe text must never be externalized");
  assert.equal(ledger.db().prepare("SELECT count(*) AS n FROM message_blobs").get()!.n, 0);
}

for (const caller of [owner, agent()]) test(`ctx.read keeps only one access audit for ${caller.via}, including continuation and content mirrors`, async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  const text = JSON.stringify({ text: `${SENTINEL} 中文🙂${"x".repeat(70000)}` }) + "\n";
  const first = result(text);
  const second = result(`${SENTINEL} continuation\n`, Buffer.byteLength(text));
  // Host-reported metadata is not trusted for the audit, even when it is malformed and carries text.
  Object.assign(first.data as object, { day: SENTINEL, file: SENTINEL, offset: SENTINEL, extra: SENTINEL });
  const snapshot = structuredClone(first);
  Object.freeze(first.data); Object.freeze(first.content![0]); Object.freeze(first.content); Object.freeze(first);
  const host = fake("service:host", [contract], () => host.calls.length === 1 ? first : second);
  w.registry.add(host);
  const a = await send(w, caller);
  assert.ok(a.ok); assert.strictEqual(a.result, first); assert.deepEqual(first, snapshot);
  const next = Buffer.byteLength(text);
  const b = await send(w, caller, { ...request, offset: next });
  assert.ok(b.ok); assert.strictEqual(b.result, second);
  const rows = w.ledger.page({ word: "ctx.read", limit: 20 });
  assert.equal(rows.length, 4, "one normal request/response pair per read, no second raw audit");
  assert.equal(rows[0]!.from, caller.member);
  assert.deepEqual(rows[0]!.body, request);
  assert.deepEqual(rows[1]!.body, { ok: true, result: { data: { status: "ok", bytes: Buffer.byteLength(text, "utf8") } } });
  assert.deepEqual(rows[2]!.body, { ...request, offset: next });
  assert.equal(w.ledger.request(rows[0]!.id)?.state, "done");
  assert.equal(observed.length, 4);
  assertPrivate(w.ledger, observed);
});

test("the actual Host service result reaches owner and agent intact without storing JSONL", async () => {
  const w = world();
  const raw = result(`${SENTINEL} actual host\n`).data;
  const seen: unknown[] = [];
  const host = createHostService({
    client: { has: () => false, ctxRead: async (req: unknown) => { seen.push(req); return { supported: true, result: raw }; } } as never,
    router: w.router, registry: w.registry, virtual: { subscribe: () => () => {} } as never, onStop() {},
  });
  w.registry.add(host.member);
  for (const caller of [owner, agent()]) {
    const reply = await send(w, caller);
    assert.ok(reply.ok); assert.strictEqual(reply.result!.data, raw);
  }
  assert.deepEqual(seen, [request, request]);
  assertPrivate(w.ledger, []);
});

for (const caller of [owner, agent()]) test(`ctx.read errors preserve the ${caller.via} reply but cannot echo into control storage`, async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  const error = new WordError("failed", SENTINEL, { detail: { text: SENTINEL }, recovery_hint: SENTINEL });
  w.registry.add(fake("service:host", [contract], () => { throw error; }));
  const reply = await send(w, caller);
  assert.ok(!reply.ok);
  assert.equal(reply.error.message, SENTINEL); assert.deepEqual(reply.error.detail, { text: SENTINEL });
  assert.equal(reply.error.recovery_hint, SENTINEL);
  const rows = w.ledger.page({ word: "ctx.read", limit: 10 });
  assert.equal(rows.length, 2);
  assert.deepEqual((rows[1]!.body as any).error.code, "failed");
  assertPrivate(w.ledger, observed);
});

test("ctx.read can be parked and redeemed without putting results in the approval store", async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  w.registry.add(fake("service:host", [contract], () => result(SENTINEL)));
  // A read normally passes the gate. Force the existing approval branch to exercise its persistence boundary.
  const decide = w.gate.decide.bind(w.gate);
  w.gate.decide = async (msg, ...args) => msg.to === "service:host" && msg.word === "ctx.read"
    ? { verdict: "ask", by: "test", offer_always: false } : decide(msg, ...args);
  const body = { file: "screens", day: request.day } as typeof request;
  const parked = await send(w, agent(), body);
  assert.ok(parked.ok);
  const id = (parked.result!.data as any).pending_id;
  assert.ok(id); assert.deepEqual(w.store.getPending(id)!.body, body);
  assert.ok(w.store.setState(id, ["waiting"], "approved"));
  const reply = await w.router.redeem(id, owner);
  assert.ok(reply.ok); assert.equal((reply.result!.data as any).text, SENTINEL);
  assertPrivate(w.ledger, observed);
});

test("ordinary agent reads still record their normal results", async () => {
  const w = world();
  w.registry.add(fake("service:ordinary", [word("service:ordinary", "read")], () => ({ data: { text: "ordinary audited result" } })));
  await w.router.send({ to: "service:ordinary", kind: "request", word: "read", body: {} }, agent());
  const rows = w.ledger.page({ word: "read", limit: 10 });
  assert.equal(rows.length, 2); assert.deepEqual((rows[1]!.body as any).result.data, { text: "ordinary audited result" });
});

test("MCP ctx.read carries a full bounded chunk and keeps async results, wake and restart storage private", async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  const waiting: ReturnType<typeof deferred<WordResult>>[] = [];
  w.registry.add(fake("service:host", [contract], () => { const d = deferred<WordResult>(); waiting.push(d); return d.promise; }));
  const rig = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger, settleMs: 1 });
  const client = await rig.client();
  const receipt = await client.call("capability_call", { member: "service:host", word: "ctx.read", body: request, wait: false });
  assert.equal(receipt.data.status, "accepted");
  const text = `${SENTINEL} 中文🙂${"x".repeat(100000)}\n`;
  waiting[0]!.resolve(result(text));
  await flush();
  assertPrivate(w.ledger, observed);
  const answer = await client.call("await_result", { request_id: receipt.data.request_id });
  assert.equal(answer.data.text, text, "no preview-only response for a chunk with no persisted raw attachment");
  assert.deepEqual(answer.content, [{ type: "text", text }]);

  const next = await client.call("capability_call", { member: "service:host", word: "ctx.read", body: { ...request, offset: 1024 }, wait: false });
  rig.turns.set(MAIN, null);
  waiting[1]!.resolve(result(SENTINEL));
  await flush();
  const wakes = observed.filter((m) => m.word === "wake" && m.kind === "request");
  assert.equal(wakes.length, 1); assert.ok(!JSON.stringify(wakes).includes(SENTINEL));
  assertPrivate(w.ledger, observed);

  rig.edge.close();
  const restarted = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger });
  const lost = await (await restarted.client()).call("await_result", { request_id: next.data.request_id });
  assert.equal(lost.data.error.code, "result_unknown");
  assert.match(lost.data.error.recovery_hint, /ctx.read/);
  assertPrivate(w.ledger, observed);
});

test("MCP async ctx.read error echoes stay live only, including the durable receipt and wake", async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  const pending = deferred<WordResult>();
  w.registry.add(fake("service:host", [contract], () => pending.promise));
  const rig = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger, settleMs: 1 });
  const client = await rig.client();
  const receipt = await client.call("capability_call", { member: "service:host", word: "ctx.read", body: request, wait: false });
  assert.equal(receipt.data.status, "accepted");
  rig.turns.set(MAIN, null);
  pending.reject(new WordError("failed", SENTINEL, { detail: { text: SENTINEL }, recovery_hint: SENTINEL }));
  await flush();
  assert.equal(observed.filter((m) => m.word === "wake" && m.kind === "request").length, 1);
  assertPrivate(w.ledger, observed);
  const answer = await client.call("await_result", { request_id: receipt.data.request_id });
  assert.equal(answer.isError, true);
  assert.equal(answer.data.error.message, SENTINEL);
  assert.deepEqual(answer.data.error.detail, { text: SENTINEL });
  assert.equal(answer.data.error.recovery_hint, SENTINEL);
  assertPrivate(w.ledger, observed);
});

test("MCP parked ctx.read preserves its safe approval receipt after restart", async () => {
  const w = world();
  const observed: Message[] = [];
  w.router.subscribe({}, (m) => observed.push(m));
  const decide = w.gate.decide.bind(w.gate);
  w.gate.decide = async (msg, ...args) => msg.to === "service:host" && msg.word === "ctx.read"
    ? { verdict: "ask", by: "test", offer_always: false } : decide(msg, ...args);
  const host = fake("service:host", [contract], () => result(SENTINEL));
  w.registry.add(host);
  const rig = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger });
  const receipt = await (await rig.client()).call("capability_call", { member: "service:host", word: "ctx.read", body: request });
  assert.equal(receipt.data.status, "waiting_owner");
  assert.equal(host.calls.length, 0, "the gate must still block execution");
  rig.edge.close();
  const restarted = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger });
  const answer = await (await restarted.client()).call("await_result", { request_id: receipt.data.request_id });
  assert.equal(answer.isError, false);
  assert.equal(answer.data.status, "waiting_owner");
  assert.equal(answer.data.pending_id, receipt.data.pending_id);
  assert.equal(answer.data.request_id, receipt.data.request_id);
  assert.equal(host.calls.length, 0);
  assertPrivate(w.ledger, observed);
});

test("ordinary async tool results still survive a ToolsEdge restart", async () => {
  const w = world();
  const done = deferred<WordResult>();
  w.registry.add(fake("service:ordinary", [word("service:ordinary", "read")], () => done.promise));
  const rig = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger, settleMs: 1 });
  const receipt = await (await rig.client()).call("capability_call", { member: "service:ordinary", word: "read", wait: false });
  assert.equal(receipt.data.status, "accepted");
  done.resolve({ data: { text: "ordinary persistent result" } });
  await flush(); rig.edge.close();
  const restarted = await startRig({ router: w.router as never, registry: w.registry, ledger: w.ledger });
  const answer = await (await restarted.client()).call("await_result", { request_id: receipt.data.request_id });
  assert.deepEqual(answer.data, { text: "ordinary persistent result" });
});
