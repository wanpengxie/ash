import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OperationStore } from "../src/collaboration/operation-store";
import { DeliveryJournal } from "../src/collaboration/delivery";
import { DeliveryReconciler, type ReconciliationPage, type ReconciliationReader } from "../src/collaboration/reconciliation";
import { CollaborationControlError, type ControlRequest, type NativeOutcome } from "../src/collaboration/control-types";
const owner = { principal_id: "owner-1" };
const request: ControlRequest = { request_id: "request-1", operation_id: "operation-1", work: { node_id: "node-1", endpoint_id: "endpoint-1", kind: "conversation", native_id: "thread-1" }, action: "steer", input: { text: "secret-input" }, expected_turn_id: "turn-1", expires_at: 4102444800000 };
const accepted: NativeOutcome = { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "turn-1", correlation: "uncertain" } };
const errorCode = (code: string) => (e: unknown) => e instanceof CollaborationControlError && e.code === code;
async function setup(t: any, outcome: NativeOutcome | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "ash-reconcile-")), file = join(directory, "operations.db"), store = new OperationStore(file);
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  let calls = 0;
  const journal = new DeliveryJournal({ store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true,
    adapter: { connector_epoch: "epoch-original", native_interface_version: "fake-v1", async invoke(invocation) {
      calls++;
      const persisted = new DatabaseSync(file, { readOnly: true });
      const row = persisted.prepare("SELECT * FROM operations").get()!; persisted.close();
      assert.equal(row.native_client_message_id, invocation.native_client_message_id);
      assert.equal(row.native_interface_version, invocation.native_interface_version);
      assert.equal(row.attempt_id, invocation.attempt_id);
      if (outcome) return outcome;
      throw new Error("receipt lost");
    } } });
  const fact = await journal.deliver(owner, request);
  const page: ReconciliationPage = { work: request.work, native_interface_version: "fake-v1", connector_epoch: "epoch-reconnected", source: "codex.saved_history", observed_at: "2026-10-09T00:00:00Z", items: [{ source_client_message_id: fact.native_client_message_id!, native_turn_id: "turn-1", native_message_id: "item-1" }], next_cursor: null };
  const reader: ReconciliationReader = { connector_epoch: "epoch-reconnected", native_interface_version: "fake-v1", readHistoryPage: async () => page };
  const reconciler = (options: any = {}) => new DeliveryReconciler({ store, reader, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true, ...options });
  return { directory, file, store, journal, fact, page, reader, reconciler, calls: () => calls };
}
test("native identity is persisted before send; reconnect history promotes unknown without replay", async t => {
  const f = await setup(t);
  assert.ok(f.fact.native_client_message_id); assert.equal(f.fact.native_interface_version, "fake-v1");
  f.store.close();
  const reopened = new OperationStore(f.file); t.after(() => reopened.close());
  const result = await f.reconciler({ store: reopened }).reconcile(owner, request.operation_id, request.work);
  assert.equal(result?.delivery_status, "accepted"); assert.equal(result?.receipt?.correlation, "stable_message_id");
  assert.equal(result?.receipt?.native_message_id, "item-1"); assert.equal(result?.reconciliation?.connector_epoch, "epoch-reconnected");
  assert.equal(result?.native_client_message_id, f.fact.native_client_message_id);
  assert.equal(result?.connector_epoch, "epoch-original"); assert.equal(f.calls(), 1);
  assert.doesNotMatch(JSON.stringify(result), /secret-input/);
});
test("accepted uncertain receipt is enriched; late failure and conflicting mapping cannot replace stable fact", async t => {
  const f = await setup(t, accepted);
  const stable = await f.reconciler().reconcile(owner, request.operation_id, request.work);
  assert.equal(stable?.delivery_status, "accepted"); assert.equal(stable?.receipt?.correlation, "stable_message_id");
  f.page.items[0]!.native_message_id = "other";
  assert.deepEqual(await f.reconciler().reconcile(owner, request.operation_id, request.work), stable);
  assert.equal((await f.journal.deliver(owner, request)).receipt?.native_message_id, "item-1"); assert.equal(f.calls(), 1);
});
test("missing, multiple, turn conflicts, version/source/target/epoch changes and source failures remain unknown", async t => {
  for (const scenario of ["absent", "multiple", "wrong-turn", "wrong-version", "wrong-source", "wrong-work", "bad-time", "epoch-change", "cycle", "too-large", "failure"]) await t.test(scenario, async sub => {
    const f = await setup(sub); let reads = 0;
    f.reader.readHistoryPage = async () => {
      reads++;
      const page = structuredClone(f.page);
      if (scenario === "absent") page.items = [{ native_turn_id: "turn-1", native_message_id: "same-text-is-not-proof" }];
      if (scenario === "multiple") page.items.push({ ...page.items[0]!, native_message_id: "item-2" });
      if (scenario === "wrong-turn") page.items[0]!.native_turn_id = "turn-2";
      if (scenario === "wrong-version") page.native_interface_version = "fake-v2";
      if (scenario === "wrong-source") (page as any).source = "untrusted";
      if (scenario === "wrong-work") page.work.native_id = "other";
      if (scenario === "bad-time") page.observed_at = "invalid";
      if (scenario === "epoch-change") (f.reader as any).connector_epoch = "other";
      if (scenario === "cycle") page.next_cursor = "cursor";
      if (scenario === "too-large") page.items = Array(26).fill(page.items[0]);
      if (scenario === "failure") throw new Error("source-token-secret");
      return page;
    };
    const result = await f.reconciler().reconcile(owner, request.operation_id, request.work);
    assert.equal(result?.delivery_status, "unknown"); assert.equal(result?.receipt, null); assert.ok(reads <= 4); assert.equal(f.calls(), 1);
  });
});
test("pagination deduplicates exact source references, checks all pages and refuses distinct turn/client conflicts", async t => {
  const f = await setup(t); let reads = 0;
  f.reader.readHistoryPage = async input => { reads++; assert.equal(input.limit, 25); return { ...f.page, next_cursor: input.cursor ? null : "opaque+/cursor==" }; };
  assert.equal((await f.reconciler().reconcile(owner, request.operation_id, request.work))?.receipt?.correlation, "stable_message_id"); assert.equal(reads, 2);
});
test("authorization changes during lookup refuse saved proof and suppress receipts; other owner cannot enumerate", async t => {
  const f = await setup(t); let grants = true, reads = 0;
  f.reader.readHistoryPage = async () => { reads++; grants = false; return f.page; };
  const reconciler = f.reconciler({ authorize: (p: any) => grants && p.principal_id === owner.principal_id });
  await assert.rejects(reconciler.reconcile({ principal_id: "wrong" }, request.operation_id, request.work), errorCode("permission_denied")); assert.equal(reads, 0);
  await assert.rejects(reconciler.reconcile(owner, request.operation_id, request.work), errorCode("permission_denied"));
  assert.equal(f.store.get(owner.principal_id, request.operation_id)?.delivery_status, "unknown");
  grants = true;
  await assert.rejects(reconciler.reconcile(owner, request.operation_id, { ...request.work, native_id: "other" }), errorCode("permission_denied"));
});
test("expiry only limits new invoke, and concurrent reconciliations converge atomically", async t => {
  const f = await setup(t), other = new OperationStore(f.file); t.after(() => other.close());
  const [results, observed] = await Promise.all([
    Promise.all([f.reconciler({ now: () => request.expires_at + 1 }).reconcile(owner, request.operation_id, request.work), f.reconciler({ store: other }).reconcile(owner, request.operation_id, request.work)]),
    f.journal.query(owner, request.operation_id, request.work),
  ]);
  assert.ok(results.every(result => result?.receipt?.native_message_id === "item-1"));
  assert.ok(["unknown", "accepted"].includes(observed!.delivery_status));
  assert.equal((await f.journal.query(owner, request.operation_id, request.work))?.receipt?.native_message_id, "item-1"); assert.equal(f.calls(), 1);
});
test("reconciliation storage lock fails closed then persists proof on explicit readonly retry", async t => {
  const f = await setup(t), blocker = new DatabaseSync(f.file); t.after(() => blocker.close());
  const reconciler = f.reconciler({ failpoint: (stage: string) => { if (stage === "before_reconcile_save") blocker.exec("BEGIN IMMEDIATE"); } });
  await assert.rejects(reconciler.reconcile(owner, request.operation_id, request.work), errorCode("storage_failure"));
  blocker.exec("ROLLBACK");
  assert.equal(f.store.get(owner.principal_id, request.operation_id)?.delivery_status, "unknown");
  assert.equal((await f.reconciler().reconcile(owner, request.operation_id, request.work))?.delivery_status, "accepted"); assert.equal(f.calls(), 1);
});
test("old on-disk schema migrates; legacy unknown attempts never acquire an invented native identity", async t => {
  const directory = await mkdtemp(join(tmpdir(), "ash-legacy-")), file = join(directory, "old.db"); t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE operations (principal TEXT NOT NULL,operation_id TEXT NOT NULL,request_id TEXT NOT NULL,node_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,native_id TEXT NOT NULL,action TEXT NOT NULL,payload_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,attempt_id TEXT,connector_epoch TEXT,owner_pid INTEGER,owner_epoch TEXT,receipt TEXT,error_code TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(principal,operation_id));
    INSERT INTO operations VALUES ('owner-1','operation-1','request-1','node-1','endpoint-1','thread-1','steer','old-hash',1,'unknown','legacy-attempt','legacy-epoch',NULL,NULL,NULL,'result_unknown',1);`); db.close();
  const store = new OperationStore(file); t.after(() => store.close());
  let reads = 0;
  const reader = { connector_epoch: "epoch", native_interface_version: "fake-v1", async readHistoryPage(): Promise<ReconciliationPage> { reads++; throw new Error(); } };
  const result = await new DeliveryReconciler({ store, reader, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true }).reconcile(owner, request.operation_id, request.work);
  assert.equal(result?.delivery_status, "unknown"); assert.equal(result?.native_client_message_id, null); assert.equal(result?.native_interface_version, null); assert.equal(reads, 0);
  const check = new DatabaseSync(file, { readOnly: true }); assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 2); check.close();
});
test("unique native client ID constraint rejects cross-operation aliases", async t => {
  const f = await setup(t); await f.journal.deliver(owner, { ...request, operation_id: "second" });
  const db = new DatabaseSync(f.file); t.after(() => db.close());
  assert.throws(() => db.prepare("UPDATE operations SET native_client_message_id=? WHERE operation_id='second'").run(f.fact.native_client_message_id!));
});
test("actual process exit before/after proof commit preserves monotonic fact and never invokes", async t => {
  for (const stage of ["before_reconcile_save", "after_reconcile_save"]) await t.test(stage, async sub => {
    const f = await setup(sub); f.store.close();
    const worker = new URL("./fixtures/collaboration-reconciliation-worker.mjs", import.meta.url);
    const result = spawnSync(process.execPath, ["--import", "tsx", worker.pathname, f.file, stage], { encoding: "utf8" });
    assert.equal(result.status, 71, result.stderr);
    const reopened = new OperationStore(f.file); sub.after(() => reopened.close());
    assert.equal(reopened.get(owner.principal_id, request.operation_id)?.delivery_status, stage === "before_reconcile_save" ? "unknown" : "accepted");
    const final = await f.reconciler({ store: reopened }).reconcile(owner, request.operation_id, request.work);
    assert.equal(final?.delivery_status, "accepted"); assert.equal(final?.native_client_message_id, f.fact.native_client_message_id); assert.equal(f.calls(), 1);
  });
});
test("S2 original lease rejects same-generation grant mutation, revoked owner and transport staleness during history", async t => {
  const { ControlAuthorization, controlAuthorizationSnapshot } = await import("../src/collaboration/control-authorization");
  for (const scenario of ["grant", "owner", "transport", "invalidate"]) await t.test(scenario, async sub => {
    const f = await setup(sub); let pinned: string | null = owner.principal_id, current = true;
    let snapshot = controlAuthorizationSnapshot({ version: 1, owner_id: owner.principal_id, endpoint_id: "endpoint-1", authorization_generation: 1, allowed_actions: ["steer"], scope: { kind: "exact_cwd", cwd: "/approved" } }, "endpoint-1");
    const authority = new ControlAuthorization({ nodeId: "node-1", endpointId: "endpoint-1", pinnedOwnerId: () => pinned, authorization: () => snapshot, metadata: async () => ({ work: request.work, cwd: "/approved" }) });
    const lease = await authority.begin({ transportOwnerId: owner.principal_id, isCurrent: () => current }, { endpoint_id: "endpoint-1", authorization_revision: snapshot.authorization_revision!, work: request.work, action: request.action });
    f.reader.readHistoryPage = async () => {
      if (scenario === "grant") snapshot = controlAuthorizationSnapshot({ ...snapshot.config!, scope: { kind: "exact_cwd", cwd: "/changed" } }, "endpoint-1");
      if (scenario === "owner") pinned = "new-owner";
      if (scenario === "transport") current = false;
      if (scenario === "invalidate") authority.invalidate();
      return f.page;
    };
    await assert.rejects(f.reconciler({ authorize: lease.authorize }).reconcile(owner, request.operation_id, request.work), errorCode("permission_denied"));
    assert.equal(f.store.get(owner.principal_id, request.operation_id)?.delivery_status, "unknown");
  });
});
test("receipt is saved after native acceptance but revoked authorization cannot return it", async t => {
  const f = await setup(t); let grants = true, calls = 0;
  const journal = new DeliveryJournal({ store: f.store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => grants, adapter: { connector_epoch: "epoch", native_interface_version: "fake-v1", async invoke() { calls++; grants = false; return accepted; } } });
  const operation = { ...request, operation_id: "revoke-after-accept" };
  await assert.rejects(journal.deliver(owner, operation), errorCode("permission_denied"));
  assert.equal(f.store.get(owner.principal_id, operation.operation_id)?.delivery_status, "accepted");
  grants = true; assert.equal((await journal.deliver(owner, operation)).delivery_status, "accepted"); assert.equal(calls, 1);
});
test("connector epoch changes after durable claim suppress native send and preserve original identity as unknown", async t => {
  const f = await setup(t); let calls = 0;
  const adapter = { connector_epoch: "epoch", native_interface_version: "fake-v1", async invoke() { calls++; return accepted; } };
  const journal = new DeliveryJournal({ store: f.store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true, adapter, failpoint: stage => { if (stage === "after_invoking") adapter.connector_epoch = "new-epoch"; } });
  const result = await journal.deliver(owner, { ...request, operation_id: "epoch-change" });
  assert.equal(result.delivery_status, "unknown"); assert.ok(result.native_client_message_id); assert.equal(result.connector_epoch, "epoch"); assert.equal(calls, 0);
  assert.equal((await journal.deliver(owner, { ...request, operation_id: "epoch-change" })).native_client_message_id, result.native_client_message_id); assert.equal(calls, 0);
});
test("legacy recorded envelope can be claimed after migration with its original steer precondition", async t => {
  const f = await setup(t); f.store.close();
  const old = new DatabaseSync(f.file);
  old.exec("DROP INDEX native_client_message_unique; UPDATE operations SET status='recorded',attempt_id=NULL,connector_epoch=NULL,owner_pid=NULL,owner_epoch=NULL; ALTER TABLE operations DROP COLUMN native_client_message_id; ALTER TABLE operations DROP COLUMN native_interface_version; ALTER TABLE operations DROP COLUMN expected_turn_id; ALTER TABLE operations DROP COLUMN reconciliation; PRAGMA user_version=0;"); old.close();
  const store = new OperationStore(f.file); t.after(() => store.close());
  let invoked = 0;
  const j = new DeliveryJournal({ store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true, adapter: { connector_epoch: "epoch", native_interface_version: "fake-v1", async invoke(invocation) {
    invoked++; assert.equal(store.get(owner.principal_id, request.operation_id)?.expected_turn_id, request.expected_turn_id); assert.ok(invocation.native_client_message_id); return accepted;
  } } });
  assert.equal((await j.deliver(owner, request)).delivery_status, "accepted"); assert.equal(invoked, 1);
});
test("unsupported future schema and unavailable native version fail closed before invocation", async t => {
  const f = await setup(t); f.store.close();
  const db = new DatabaseSync(f.file); db.exec("PRAGMA user_version=99"); db.close();
  assert.throws(() => new OperationStore(f.file), errorCode("storage_failure"));
  const reset = new DatabaseSync(f.file); reset.exec("PRAGMA user_version=2"); reset.close();
  const store = new OperationStore(f.file); t.after(() => store.close()); let invoked = 0;
  const j = new DeliveryJournal({ store, node_id: "node-1", endpoint_id: "endpoint-1", authorize: () => true, adapter: { connector_epoch: "epoch", native_interface_version: "", async invoke() { invoked++; return accepted; } } });
  await assert.rejects(j.deliver(owner, { ...request, operation_id: "unready" }), errorCode("invalid")); assert.equal(invoked, 0);
  assert.equal(store.get(owner.principal_id, "unready")?.delivery_status, "recorded");
});
test("confirmed rejection is terminal; saved accepted turn conflicts keep uncertain mapping", async t => {
  const denied = await setup(t, { status: "rejected", code: "stale_precondition" });
  let reads = 0; denied.reader.readHistoryPage = async () => { reads++; return denied.page; };
  assert.equal((await denied.reconciler().reconcile(owner, request.operation_id, request.work))?.delivery_status, "rejected"); assert.equal(reads, 0);
  const f = await setup(t, { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "other-native-turn", correlation: "uncertain" } });
  const result = await f.reconciler().reconcile(owner, request.operation_id, request.work);
  assert.equal(result?.delivery_status, "accepted"); assert.equal(result?.receipt?.correlation, "uncertain"); assert.equal(result?.receipt?.native_turn_id, "other-native-turn");
});

test("unique bounded window match accepts a long history with precise non-exhaustive provenance", async t => {
  const f = await setup(t); let reads = 0;
  f.reader.readHistoryPage = async () => ({ ...f.page, next_cursor: `cursor-${++reads}` });
  const result = await f.reconciler().reconcile(owner, request.operation_id, request.work);
  assert.equal(result?.delivery_status, "accepted"); assert.equal(reads, 4);
  assert.deepEqual(result?.reconciliation, { source: "codex.saved_history", lookup_scope: "bounded_history_pages", pages_observed: 4, history_exhausted: false, native_interface_version: "fake-v1", connector_epoch: "epoch-reconnected", observed_at: "2026-10-09T00:00:00Z", native_client_message_id: f.fact.native_client_message_id, native_turn_id: "turn-1", native_message_id: "item-1" });
  assert.equal(result?.receipt?.correlation, "stable_message_id"); assert.equal(f.calls(), 1);
});
