import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { OperationStore } from "../src/collaboration/operation-store";
import { DeliveryJournal, type DeliveryOptions } from "../src/collaboration/delivery";
import { CollaborationControlError, type ControlRequest, type NativeOutcome } from "../src/collaboration/control-types";

const worker = fileURLToPath(new URL("./fixtures/collaboration-delivery-worker.mjs", import.meta.url));
const owner = { principal_id: "owner-1" };
const request: ControlRequest = {
  request_id: "request-1", operation_id: "operation-1",
  work: { node_id: "node-1", endpoint_id: "endpoint-1", kind: "conversation", native_id: "thread-1" },
  action: "steer", input: { text: "private-text token-secret" }, expected_turn_id: "active-turn-1", expires_at: 4102444800000,
};
const accepted: NativeOutcome = { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "active-turn-1", correlation: "uncertain" } };
const errorCode = (expected: string) => (error: unknown) => error instanceof CollaborationControlError && error.code === expected;
async function folder(t: any) {
  const path = await mkdtemp(join(tmpdir(), "ash-delivery-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, database: join(path, "operations.db"), calls: join(path, "native.calls"), release: join(path, "release") };
}
function journal(store: OperationStore, extra: Partial<DeliveryOptions> = {}) {
  return new DeliveryJournal({ store, node_id: request.work.node_id, endpoint_id: request.work.endpoint_id,
    authorize: () => true, adapter: { native_interface_version: "fake-native-v1", connector_epoch: "fake-epoch", invoke: async () => accepted }, ...extra });
}
function child(database: string, calls: string, mode: string, window = "none", release = "none") {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", worker, database, calls, mode, window, release], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  process.stdout.on("data", chunk => { stdout += chunk; }); process.stderr.on("data", chunk => { stderr += chunk; });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    process.on("error", reject); process.on("exit", code => resolve({ code, stdout, stderr }));
  });
  return { process, done, async invoking() {
    if (stdout.includes("invoking\n")) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { process.kill(); reject(new Error("fake worker did not invoke")); }, 5000);
      const listen = () => { if (stdout.includes("invoking\n")) { clearTimeout(timer); process.stdout.off("data", listen); resolve(); } };
      process.stdout.on("data", listen);
    });
  } };
}
async function countCalls(file: string): Promise<number> {
  try { return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).length; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

test("cross-process crash windows preserve intent and never replay invoking/unknown", async t => {
  for (const [window, status, initialCalls, afterCalls] of [
    ["before_record", null, 0, 1], ["after_record", "recorded", 0, 1], ["before_invoking", "recorded", 0, 1],
    ["after_invoking", "unknown", 0, 0], ["after_native", "unknown", 1, 1], ["after_saved", "accepted", 1, 1],
  ] as const) await t.test(window, async sub => {
    const f = await folder(sub);
    const crashed = await child(f.database, f.calls, "crash", window).done;
    assert.equal(crashed.code, 70, crashed.stderr);
    assert.equal(await countCalls(f.calls), initialCalls);
    const store = new OperationStore(f.database);
    assert.equal(store.get(owner.principal_id, request.operation_id)?.delivery_status ?? null, status);
    store.close();
    // A further process resends the same operation, including the original envelope.
    const replay = await child(f.database, f.calls, "normal").done;
    assert.equal(replay.code, 0, replay.stderr);
    const fact = JSON.parse(replay.stdout.trim());
    assert.equal(fact.delivery_status, status === "unknown" ? "unknown" : "accepted");
    assert.equal(await countCalls(f.calls), afterCalls);
    if (status === "unknown") { assert.equal(fact.receipt, null); assert.equal(fact.error_code, "result_unknown"); }
  });
});

test("live owner survives another process opening the DB; concurrent retries invoke once", async t => {
  const f = await folder(t);
  const first = child(f.database, f.calls, "hold", "none", f.release);
  t.after(() => first.process.kill());
  await first.invoking();
  const retry = await child(f.database, f.calls, "normal").done;
  assert.equal(retry.code, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout.trim()).delivery_status, "invoking");
  const other = new OperationStore(f.database);
  assert.equal(other.get(owner.principal_id, request.operation_id)?.delivery_status, "invoking");
  other.recoverAbandoned();
  assert.equal(other.get(owner.principal_id, request.operation_id)?.delivery_status, "invoking");
  other.close();
  await writeFile(f.release, "go");
  const result = await first.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)!).delivery_status, "accepted");
  assert.equal(await countCalls(f.calls), 1);
});

test("separate processes race intake and claim from an empty DB with a single native invocation", async t => {
  const f = await folder(t);
  const racers = Array.from({ length: 4 }, () => child(f.database, f.calls, "normal"));
  t.after(() => racers.forEach(racer => racer.process.kill()));
  for (const result of await Promise.all(racers.map(racer => racer.done))) {
    assert.equal(result.code, 0, result.stderr);
    assert.ok(["accepted", "invoking"].includes(JSON.parse(result.stdout.trim()).delivery_status));
  }
  assert.equal(await countCalls(f.calls), 1);
});

test("a surviving journal detects a later owner crash on query without reopening or replaying", async t => {
  const f = await folder(t), store = new OperationStore(f.database), survivor = journal(store);
  t.after(() => store.close());
  const first = child(f.database, f.calls, "hold", "none", f.release);
  t.after(() => first.process.kill());
  await first.invoking();
  assert.equal((await survivor.query(owner, request.operation_id, request.work))?.delivery_status, "invoking");
  first.process.kill("SIGKILL");
  await first.done;
  assert.equal((await survivor.query(owner, request.operation_id, request.work))?.delivery_status, "unknown");
  assert.equal((await survivor.deliver(owner, request)).delivery_status, "unknown");
  assert.equal(await countCalls(f.calls), 1);
});

test("atomic same-process claims and immutable envelopes bind request, scope, precondition and expiry", async t => {
  const f = await folder(t), store = new OperationStore(f.database), other = new OperationStore(f.database);
  t.after(() => { store.close(); other.close(); });
  let calls = 0;
  const adapter = { native_interface_version: "fake-native-v1", connector_epoch: "epoch-1", async invoke() { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return accepted; } };
  const a = journal(store, { adapter }), b = journal(other, { adapter });
  const results = await Promise.all([a.deliver(owner, request), b.deliver(owner, request), a.deliver(owner, request)]);
  assert.equal(calls, 1); assert.ok(results.some(fact => fact.delivery_status === "accepted"));
  const reordered = { ...request, work: { native_id: "thread-1", kind: "conversation" as const, endpoint_id: "endpoint-1", node_id: "node-1" } };
  const saved = await b.deliver(owner, reordered);
  assert.equal(saved.delivery_status, "accepted"); assert.equal(calls, 1);
  for (const change of [ { input: { text: "different" } }, { request_id: "other" }, { expected_turn_id: "other" },
    { work: { ...request.work, native_id: "other" } }, { expires_at: request.expires_at + 1 }, { action: "send_input" as const } ]) {
    await assert.rejects(a.deliver(owner, { ...request, ...change }), errorCode("conflict"));
  }
  assert.equal(saved.receipt?.accepted_by, "native");
  assert.equal(saved.receipt?.native_message_id, undefined); assert.equal(saved.receipt?.correlation, "uncertain");
  assert.ok(saved.attempt_id); assert.equal(saved.connector_epoch, "epoch-1");
});

test("authorization, expiry and native scopes are rechecked for invocation and query", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  let grants = true, time = 100, calls = 0;
  const scoped = journal(store, { now: () => time, authorize: (auth, work) => grants && auth.principal_id === owner.principal_id && work.native_id === "thread-1",
    adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke() { calls++; return accepted; } } });
  await assert.rejects(scoped.deliver({ principal_id: "other" }, request), errorCode("permission_denied"));
  await assert.rejects(scoped.deliver(owner, { ...request, work: { ...request.work, endpoint_id: "other" } }), errorCode("permission_denied"));
  await assert.rejects(scoped.deliver(owner, { ...request, work: { ...request.work, native_id: "other" } }), errorCode("permission_denied"));
  await assert.rejects(scoped.deliver(owner, { ...request, expires_at: time }), errorCode("expired"));
  assert.equal(calls, 0);
  const expiresDuring = journal(store, { now: () => time, failpoint: stage => { if (stage === "after_record") time = 1000; } });
  const expired = await expiresDuring.deliver(owner, { ...request, expires_at: 500 });
  assert.equal(expired.delivery_status, "rejected"); assert.equal(expired.error_code, "expired");
  const revokeDuring = journal(store, { authorize: () => grants, failpoint: stage => { if (stage === "after_record") grants = false; } });
  await assert.rejects(revokeDuring.deliver(owner, { ...request, operation_id: "revoked" }), errorCode("permission_denied"));
  assert.equal(store.get(owner.principal_id, "revoked")?.delivery_status, "rejected");
  grants = true;
  await scoped.deliver(owner, { ...request, operation_id: "accepted", expires_at: 2000 });
  await assert.rejects(scoped.query(owner, "accepted", { ...request.work, native_id: "other" }), errorCode("permission_denied"));
  grants = false;
  await assert.rejects(scoped.query(owner, "accepted", request.work), errorCode("permission_denied"));
  grants = true; time = 2000;
  assert.equal((await scoped.query(owner, "accepted", request.work))?.delivery_status, "accepted");
  assert.equal(calls, 1);
});

test("expiry blocks new/recorded execution but preserves authorized accepted/unknown facts and conflicts", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  let time = 100, grants = true, calls = 0;
  const adapter = { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke(invocation: { request: ControlRequest }) {
    calls++;
    if (invocation.request.operation_id === "unknown") throw new Error("native result unavailable");
    return accepted;
  } };
  const j = journal(store, { now: () => time, authorize: () => grants, adapter });
  const successful = { ...request, expires_at: 200 };
  const uncertain = { ...successful, operation_id: "unknown" };
  await j.deliver(owner, successful); await j.deliver(owner, uncertain);
  const recorded = { ...successful, operation_id: "recorded" };
  await assert.rejects(journal(store, { now: () => time, failpoint: stage => { if (stage === "after_record") throw new Error("stop before claim"); } }).deliver(owner, recorded), errorCode("storage_failure"));
  time = 300;
  for (const [original, status] of [[successful, "accepted"], [uncertain, "unknown"]] as const) {
    const fact = await j.query(owner, original.operation_id, request.work);
    assert.equal(fact?.delivery_status, status); assert.equal(fact?.expires_at, 200);
    assert.equal((await j.deliver(owner, original)).delivery_status, status);
    await assert.rejects(j.deliver(owner, { ...original, input: { text: "different" } }), errorCode("conflict"));
  }
  const rejected = await j.deliver(owner, recorded);
  assert.equal(rejected.delivery_status, "rejected"); assert.equal(rejected.error_code, "expired");
  assert.equal((await j.query(owner, recorded.operation_id, request.work))?.delivery_status, "rejected");
  await assert.rejects(j.deliver(owner, { ...successful, operation_id: "new" }), errorCode("expired"));
  assert.equal(calls, 2);
  grants = false;
  await assert.rejects(j.query(owner, successful.operation_id, request.work), errorCode("permission_denied"));
  await assert.rejects(j.deliver(owner, uncertain), errorCode("permission_denied"));
});

test("principals have separate keys; query never returns another principal or endpoint's facts", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  const j = journal(store);
  await j.deliver(owner, request);
  assert.equal(await j.query({ principal_id: "other" }, request.operation_id, request.work), null);
  await assert.rejects(j.query(owner, request.operation_id, { ...request.work, endpoint_id: "other" }), errorCode("permission_denied"));
  await assert.rejects(j.query(owner, request.operation_id, { ...request.work, native_id: "other" }), errorCode("permission_denied"));
  const second = await j.deliver({ principal_id: "other" }, request);
  assert.equal(second.principal_id, "other");
});

test("adapter errors/query unavailability retain unknown and redact source secrets; close refuses active calls", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  let calls = 0;
  const j = journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke() {
    calls++; assert.throws(() => store.close(), errorCode("busy"));
    throw new Error("token-secret private-text native-detail");
  } } });
  const fact = await j.deliver(owner, request);
  assert.equal(fact.delivery_status, "unknown"); assert.equal(fact.error_code, "result_unknown");
  assert.equal((await j.query(owner, request.operation_id, request.work))?.delivery_status, "unknown");
  assert.equal((await j.deliver(owner, request)).delivery_status, "unknown"); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(fact), /token-secret|private-text|native-detail/);
  const db = new DatabaseSync(f.database, { readOnly: true });
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM operations").all()), /token-secret|private-text|native-detail/);
  db.close();
  assert.equal((await stat(f.database)).mode & 0o777, 0o600);
});

test("receipt levels, native rejections, and invalid/native-extra replies remain bounded facts", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  const connector = await journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", invoke: async () => ({ status: "accepted", receipt: { accepted_by: "connector", correlation: "uncertain" } }) } }).deliver(owner, request);
  assert.equal(connector.receipt?.accepted_by, "connector");
  const reject = await journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", invoke: async () => ({ status: "rejected", code: "stale_precondition" }) } }).deliver(owner, { ...request, operation_id: "reject" });
  assert.equal(reject.delivery_status, "rejected"); assert.equal(reject.error_code, "stale_precondition");
  const invalid = await journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", invoke: async () => ({ status: "accepted", receipt: { accepted_by: "native", correlation: "stable_message_id" } }) } }).deliver(owner, { ...request, operation_id: "invalid-receipt" });
  assert.equal(invalid.delivery_status, "unknown");
});

test("body authority/unknown fields, text limits and retention capacity fail without native calls", async t => {
  const f = await folder(t), store = new OperationStore(f.database, 1);
  t.after(() => store.close());
  let calls = 0;
  const j = journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke() { calls++; throw new Error("secret"); } } });
  await assert.rejects(j.deliver(owner, { ...request, principal_id: "owner-1" } as ControlRequest), errorCode("invalid"));
  await assert.rejects(j.deliver(owner, { ...request, input: { text: "a".repeat(65537) } }), errorCode("too_large"));
  await assert.rejects(j.deliver(owner, { ...request, expected_turn_id: undefined }), errorCode("invalid"));
  await assert.rejects(j.deliver(owner, { ...request, operation_id: "secret\nvalue" }), errorCode("invalid"));
  assert.equal(calls, 0);
  await j.deliver(owner, request);
  await assert.rejects(j.deliver(owner, { ...request, operation_id: "second" }), errorCode("too_large"));
  assert.equal((await j.deliver(owner, request)).delivery_status, "unknown"); assert.equal(calls, 1);
});

test("authorization and fault exceptions cannot leak source credentials; durable saved receipts survive return errors", async t => {
  const f = await folder(t), store = new OperationStore(f.database);
  t.after(() => store.close());
  await assert.rejects(journal(store, { authorize: () => { throw new Error("token-secret"); } }).deliver(owner, request), errorCode("permission_denied"));
  await assert.rejects(journal(store, { failpoint: stage => { if (stage === "after_saved") throw new Error("token-secret"); } }).deliver(owner, request), errorCode("storage_failure"));
  assert.equal((await journal(store).deliver(owner, request)).delivery_status, "accepted");
});

test("finished native calls recover a failed receipt commit after a same-PID SQLite lock without replay", async t => {
  const f = await folder(t), store = new OperationStore(f.database), blocker = new DatabaseSync(f.database);
  t.after(() => { blocker.close(); store.close(); });
  let calls = 0;
  const j = journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke() {
    calls++; blocker.exec("BEGIN IMMEDIATE"); return accepted;
  } } });
  await assert.rejects(j.deliver(owner, request), errorCode("storage_failure"));
  assert.equal(store.get(owner.principal_id, request.operation_id)?.delivery_status, "invoking");
  blocker.exec("ROLLBACK");
  const fact = await j.query(owner, request.operation_id, request.work);
  assert.equal(fact?.delivery_status, "accepted"); assert.equal(fact?.receipt?.accepted_by, "native");
  assert.equal((await j.deliver(owner, request)).delivery_status, "accepted");
  assert.equal(calls, 1);
  store.close();
});

test("close releases the DB after a failed receipt save; same-process reopen saves only the ended receipt", async t => {
  const f = await folder(t), store = new OperationStore(f.database), blocker = new DatabaseSync(f.database);
  t.after(() => { blocker.close(); store.close(); });
  let calls = 0;
  await assert.rejects(journal(store, { adapter: { native_interface_version: "fake-native-v1", connector_epoch: "epoch", async invoke() {
    calls++; blocker.exec("BEGIN IMMEDIATE"); return accepted;
  } } }).deliver(owner, request), errorCode("storage_failure"));
  await assert.rejects(async () => store.close(), errorCode("storage_failure"));
  assert.throws(() => store.get(owner.principal_id, request.operation_id), errorCode("storage_failure"));
  blocker.exec("ROLLBACK");
  const reopened = new OperationStore(f.database);
  t.after(() => reopened.close());
  assert.equal((await journal(reopened).query(owner, request.operation_id, request.work))?.delivery_status, "accepted");
  assert.equal((await journal(reopened).deliver(owner, request)).delivery_status, "accepted");
  assert.equal(calls, 1);
});
