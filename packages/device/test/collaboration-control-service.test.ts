import test from "node:test";
import { EventEmitter } from "node:events";
import { CodexControlAdapter } from "../src/collaboration/codex-control";
import { CodexTransport } from "../src/collaboration/codex-transport";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceControlService, type ControlNativeScope, type ScopedControlNative } from "../src/collaboration/control-service";
import { ControlAuthorization, controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
import { OperationStore } from "../src/collaboration/operation-store";
import { parseControlEnvelope } from "../src/collaboration/control-protocol";
import type { Invocation } from "../src/collaboration/control-types";
const work = { node_id: "device:mac", endpoint_id: "desktop", kind: "conversation" as const, native_id: "thread" };
function fixture(deadlineMs?: number, nativeFactory?: (scope: ControlNativeScope) => ScopedControlNative) {
  const dir = mkdtempSync(join(tmpdir(), "ash-s4-control-")), store = new OperationStore(join(dir, "journal.db"));
  let grant = controlAuthorizationSnapshot({ version: 1, owner_id: "person:owner", endpoint_id: "desktop", authorization_generation: 1, allowed_actions: ["send_input", "steer"], scope: { kind: "exact_cwd", cwd: "/project" } }, "desktop");
  let paired: string | null = "person:owner", current = true, epoch = "epoch1", metadataCwd = "/project";
  let invokes = 0, observes = 0, histories = 0, closed = 0, outcomeUnknown = false;
  let last: Invocation | undefined;
  let metadataHook: (() => Promise<void>) | undefined, invokeHook: (() => Promise<void>) | undefined, historyHook: (() => Promise<void>) | undefined;
  const authorization = new ControlAuthorization({ nodeId: work.node_id, endpointId: work.endpoint_id, pinnedOwnerId: () => paired, authorization: () => grant, metadata: async target => { await metadataHook?.(); return { work: target, cwd: metadataCwd }; } });
  const service = new DeviceControlService({ deadlineMs, node_id: work.node_id, endpoint_id: work.endpoint_id, store, authorization, grant: () => grant, native: nativeFactory ?? ((scope: ControlNativeScope) => ({
    get connector_epoch() { return epoch; }, native_interface_version: "v1",
    async observe(target) { assert.equal(await scope.allowSubscription(target), true); observes++; },
    snapshot(target) { return { work: target, state: "unknown", revision: 1, connector_epoch: epoch, source: "codex.live", identity_provenance: "none", observed_at: null }; },
    async invoke(invocation) { assert.equal(await scope.authorize(invocation.principal, invocation.request.work, invocation.request.action, "invoke"), true); invokes++; last = invocation; await invokeHook?.(); if (outcomeUnknown) throw new Error("secret source error"); return { status: "accepted", receipt: { accepted_by: "native", native_turn_id: "turn", correlation: "uncertain" } }; },
    async readHistoryPage(input) { assert.equal(input.limit, 25); assert.equal(await scope.allowHistory(input.work), true); histories++; await historyHook?.(); return { work: input.work, native_interface_version: "v1", connector_epoch: epoch, source: "codex.saved_history", observed_at: new Date().toISOString(), next_cursor: null, items: [{ source_client_message_id: last!.native_client_message_id, native_turn_id: "turn", native_message_id: "message" }] }; },
    close() { closed++; },
  })) });
  const context = { transportOwnerId: "person:owner", isCurrent: () => current };
  const base = () => ({ version: 1, endpoint_id: work.endpoint_id, authorization_revision: grant.authorization_revision, work });
  const state = () => ({ ...base(), action: "send_input" });
  const query = (action = "send_input", operation = "operation") => ({ ...base(), action, operation_id: operation });
  const apply = () => ({ ...base(), expected_connector_epoch: epoch, request: { request_id: "request", operation_id: "operation", work, action: "send_input", input: { text: "private input" }, expires_at: Date.now() + 60_000 } });
  return { path: join(dir, "journal.db"), authorization, grant: () => grant, store, service, context, base, state, query, apply, stats: () => ({ invokes, observes, histories, closed, last }), setEpoch: (v: string) => epoch = v, revoke: () => { grant = controlAuthorizationSnapshot(null, "desktop"); }, unpair: () => paired = null, staleContext: () => current = false, wrongCwd: () => metadataCwd = "/other", unknown: () => outcomeUnknown = true, metadataHook: (v: () => Promise<void>) => metadataHook = v, invokeHook: (v: () => Promise<void>) => invokeHook = v, historyHook: (v: () => Promise<void>) => historyHook = v, finish: () => { service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const denied = (promise: Promise<unknown>, code = "permission_denied") => assert.rejects(promise, (e: any) => e.code === code && !e.message.includes("private"));
test("state reuses observation without writes; query null including steer does not observe", async () => { const f = fixture(); try { await f.service.execute("state", f.state(), f.context); await f.service.execute("state", f.state(), f.context); assert.deepEqual(await f.service.execute("query", f.query("steer"), f.context), { fact: null }); assert.deepEqual(f.stats(), { invokes: 0, observes: 1, histories: 0, closed: 0, last: undefined }); f.setEpoch("epoch2"); await f.service.execute("state", f.state(), f.context); assert.equal(f.stats().observes, 2); } finally { f.finish(); } });
test("apply concurrent duplicate uses one durable ID and body-free fact; query epoch independent", async () => { const f = fixture(); try { const input = f.apply(); const results = await Promise.all([f.service.execute("apply", input, f.context), f.service.execute("apply", input, f.context)]); assert.equal(f.stats().invokes, 1); assert.ok(f.stats().last!.native_client_message_id); assert.ok(results.every(v => !JSON.stringify(v).includes("private input"))); f.setEpoch("epoch2"); const result: any = await f.service.execute("query", f.query(), f.context); assert.equal(result.fact.native_client_message_id, f.stats().last!.native_client_message_id); assert.equal(result.fact.connector_epoch, "epoch1"); await denied(f.service.execute("query", f.query("steer"), f.context)); } finally { f.finish(); } });
test("unknown is never replayed; explicit reconcile restores stable mapping without observing", async () => { const f = fixture(); try { f.unknown(); const input = f.apply(); const result: any = await f.service.execute("apply", input, f.context); assert.equal(result.fact.delivery_status, "unknown"); await f.service.execute("apply", input, f.context); f.setEpoch("epoch2"); const restored: any = await f.service.execute("reconcile", f.query(), f.context); assert.equal(restored.fact.delivery_status, "accepted"); assert.equal(restored.fact.reconciliation.lookup_scope, "bounded_history_pages"); assert.equal(restored.fact.reconciliation.pages_observed, 1); assert.equal(restored.fact.receipt.native_message_id, "message"); assert.equal(f.stats().invokes, 1); assert.equal(f.stats().observes, 0); assert.equal(f.stats().histories, 1); } finally { f.finish(); } });
test("target, metadata, owner, stale epoch and unknown body keys fail closed", async () => { const f = fixture(); try { await denied(f.service.execute("state", f.state(), { transportOwnerId: "person:other", isCurrent: () => true })); await denied(f.service.execute("state", { ...f.state(), caller: "person:owner" }, f.context), "invalid"); await denied(f.service.execute("state", { ...f.state(), work: { ...work, node_id: "device:other" } }, f.context)); const input = f.apply(); f.setEpoch("epoch2"); await denied(f.service.execute("apply", input, f.context), "stale_precondition"); f.wrongCwd(); await denied(f.service.execute("query", f.query(), f.context)); assert.equal(f.stats().invokes, 0); } finally { f.finish(); } });
test("grant revoked after native acceptance suppresses fact but persists receipt", async () => { const f = fixture(); try { f.invokeHook(async () => { f.revoke(); f.service.invalidate(); }); await denied(f.service.execute("apply", f.apply(), f.context)); assert.equal(f.store.get("person:owner", "operation")!.delivery_status, "accepted"); assert.equal(f.stats().invokes, 1); } finally { f.finish(); } });
test("watch invalidation rejects same revision ABA after metadata await", async () => { const f = fixture(); try { let called = false; f.metadataHook(async () => { if (!called) { called = true; f.service.invalidate(); } }); await denied(f.service.execute("state", f.state(), f.context)); assert.equal(f.stats().observes, 0); } finally { f.finish(); } });
test("reconcile authorization changes before return cannot leak saved mapping", async () => { const f = fixture(); try { f.unknown(); await f.service.execute("apply", f.apply(), f.context); f.historyHook(async () => { f.unpair(); f.service.invalidate(); }); await denied(f.service.execute("reconcile", f.query(), f.context)); assert.equal(f.stats().invokes, 1); } finally { f.finish(); } });
test("whole request 64 KiB bound and strict nested input", () => { const f = fixture(); try { assert.throws(() => parseControlEnvelope("apply", { ...f.apply(), principal: "spoof" })); const input = f.apply(); input.request.input.text = "x".repeat(64 * 1024); assert.throws(() => parseControlEnvelope("apply", input), (e: any) => e.code === "too_large"); } finally { f.finish(); } });

test("SQLite reopen preserves unknown operation and complete mapping under current grant", async () => { const f = fixture(); let reopened: OperationStore | undefined; let service: DeviceControlService | undefined; try { f.unknown(); await f.service.execute("apply", f.apply(), f.context); const nativeId = f.stats().last!.native_client_message_id; f.service.close(); f.store.close(); reopened = new OperationStore(f.path); service = new DeviceControlService({ node_id: work.node_id, endpoint_id: work.endpoint_id, store: reopened, authorization: f.authorization, grant: f.grant, native: () => { throw new Error("query must not connect"); } }); const result: any = await service.execute("query", f.query(), f.context); assert.equal(result.fact.delivery_status, "unknown"); assert.equal(result.fact.native_client_message_id, nativeId); assert.equal(result.fact.request_id, "request"); assert.equal(result.fact.native_interface_version, "v1"); } finally { service?.close(); reopened?.close(); f.finish(); } });
test("concurrent owner/scope requests do not borrow callback authorization", async () => { const f = fixture(); try { const a = f.apply(), b = f.apply(); b.work = { ...work, native_id: "other" }; b.request.work = b.work; b.request.operation_id = "otheroperation"; b.request.request_id = "otherrequest"; await Promise.all([f.service.execute("apply", a, f.context), f.service.execute("apply", b, f.context)]); assert.equal(f.stats().invokes, 2); const wrong = { ...f.query(), work: b.work }; await denied(f.service.execute("query", wrong, f.context)); } finally { f.finish(); } });
test("query final asynchronous authorization recheck rejects changed pairing", async () => { const f = fixture(); try { await f.service.execute("apply", f.apply(), f.context); let checks = 0; f.metadataHook(async () => { checks++; if (checks === 3) f.unpair(); }); await denied(f.service.execute("query", f.query(), f.context)); } finally { f.finish(); } });

test("scope registry is bounded and reports busy without extra subscriptions", async () => { const f = fixture(); try { for (let i = 0; i < 128; i++) await f.service.execute("state", { ...f.state(), work: { ...work, native_id: `thread${i}` } }, f.context); await denied(f.service.execute("state", { ...f.state(), work: { ...work, native_id: "overflow" } }, f.context), "busy"); assert.equal(f.stats().observes, 128); assert.equal(f.stats().invokes, 0); } finally { f.finish(); } });
test("deadline includes metadata admission and expired background admission never invokes", async () => { const f = fixture(10); let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); try { f.metadataHook(() => gate); await denied(f.service.execute("apply", f.apply(), f.context), "result_unknown"); release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.stats().invokes, 0); assert.equal(f.store.get("person:owner", "operation"), null); } finally { release(); f.finish(); } });

function realNative(scope: ControlNativeScope, counts: { initializes: number; resumes: number; starts: number; connects: number; closes: number; nativeId?: string; event?: (frame: object) => void }, fail = false): ScopedControlNative {
  const transport = new CodexTransport({ socket: "/fake.sock", executable: "/fake-codex", pid: 1, supportedVersions: ["1.2.3"], verifyListener: () => ({ socket: "/fake.sock", executable: "/fake-codex", pid: 1, version: "1.2.3", identity: "fake-listener" }), connectSocket: async () => {
    counts.connects++; await new Promise(resolve => setImmediate(resolve)); if (fail) throw new Error("secret connection failure");
    const socket = new EventEmitter() as EventEmitter & { send(data: string): void; close(): void };
    socket.close = () => { counts.closes++; socket.emit("close"); };
    counts.event = frame => socket.emit("message", Buffer.from(JSON.stringify(frame)));
    socket.send = raw => { const frame = JSON.parse(raw); if (frame.id === undefined) return; let result: unknown;
      if (frame.method === "initialize") { counts.initializes++; result = { userAgent: "codex 1.2.3" }; }
      else if (frame.method === "thread/read" || frame.method === "thread/resume") { if (frame.method === "thread/resume") counts.resumes++; result = { thread: { id: frame.params.threadId, cwd: "/project", status: { type: "idle" } } }; }
      else if (frame.method === "turn/start") { counts.starts++; counts.nativeId = frame.params.clientUserMessageId; result = { turn: { id: "turn" } }; }
      else throw new Error("Unexpected fake method");
      queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({ id: frame.id, result }))));
    }; return socket;
  } });
  const adapter = new CodexControlAdapter({ node_id: work.node_id, endpoint_id: work.endpoint_id, transport, allowSubscription: scope.allowSubscription, validateHistoryMetadata: target => scope.allowHistory(target), validateMetadata: invocation => scope.authorize(invocation.principal, invocation.request.work, invocation.request.action, "invoke") });
  return adapter;
}
test("real adapter state→state→apply preserves native epoch and durable ID", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0, nativeId: undefined as string | undefined }; const f = fixture(undefined, scope => realNative(scope, counts)); try {
  const first: any = await f.service.execute("state", f.state(), f.context); const second: any = await f.service.execute("state", f.state(), f.context); assert.equal(second.connector_epoch, first.connector_epoch);
  const input = f.apply(); input.expected_connector_epoch = second.connector_epoch; const receipt: any = await f.service.execute("apply", input, f.context);
  assert.equal(receipt.fact.delivery_status, "accepted"); assert.equal(receipt.fact.connector_epoch, first.connector_epoch); assert.equal(receipt.fact.native_client_message_id, counts.nativeId); assert.equal(counts.initializes, 1); assert.equal(counts.resumes, 1); assert.equal(counts.starts, 1); assert.equal(counts.connects, 1);
} finally { f.finish(); } });
test("real adapter concurrent state admission shares one handshake and subscription", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0 }; const f = fixture(undefined, scope => realNative(scope, counts)); try {
  const states: any[] = await Promise.all(Array.from({ length: 8 }, () => f.service.execute("state", f.state(), f.context))); assert.ok(states.every(s => s.connector_epoch === states[0].connector_epoch)); assert.equal(counts.connects, 1); assert.equal(counts.initializes, 1); assert.equal(counts.resumes, 1);
} finally { f.finish(); } });
test("failed real adapter connection retires scopes instead of consuming registry capacity", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0 }; let closeCalls = 0; let fail = true; const f = fixture(undefined, scope => { const native = realNative(scope, counts, fail), close = native.close.bind(native); native.close = () => { closeCalls++; close(); }; return native; }); try {
  for (let i = 0; i < 130; i++) await denied(f.service.execute("state", { ...f.state(), work: { ...work, native_id: `failed${i}` } }, f.context), "offline"); assert.equal(closeCalls, 130); fail = false;
  const state: any = await f.service.execute("state", f.state(), f.context); assert.equal(state.snapshot.state, "idle"); assert.equal(counts.resumes, 1);
} finally { f.finish(); } });
test("concurrent failed handshake closes once then permits fresh admission", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0 }; let closeCalls = 0, fail = true; const f = fixture(undefined, scope => { const native = realNative(scope, counts, fail), close = native.close.bind(native); native.close = () => { closeCalls++; close(); }; return native; }); try {
  const failures = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.execute("state", f.state(), f.context))); assert.ok(failures.every(f => f.status === "rejected" && f.reason.code === "offline")); assert.equal(closeCalls, 1); assert.equal(counts.connects, 1); fail = false; await f.service.execute("state", f.state(), f.context); assert.equal(counts.connects, 2); assert.equal(counts.resumes, 1);
} finally { f.finish(); } });
test("disconnected real adapter reestablishes observation with a new epoch", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0 }; let native!: ScopedControlNative; const f = fixture(undefined, scope => native = realNative(scope, counts)); try {
  const first: any = await f.service.execute("state", f.state(), f.context); native.close(); const second: any = await f.service.execute("state", f.state(), f.context); assert.notEqual(second.connector_epoch, first.connector_epoch); assert.equal(counts.initializes, 2); assert.equal(counts.resumes, 2); const input = f.apply(); input.expected_connector_epoch = first.connector_epoch; await denied(f.service.execute("apply", input, f.context), "stale_precondition"); assert.equal(counts.starts, 0);
} finally { f.finish(); } });

test("scoped source error can safely rearm observation in the same connector epoch", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0, event: undefined as ((frame: object) => void) | undefined }; const f = fixture(undefined, scope => realNative(scope, counts)); try {
  const first: any = await f.service.execute("state", f.state(), f.context); counts.event!({ method: "error", params: { threadId: work.native_id, turnId: "oldturn", willRetry: false } });
  const next: any = await f.service.execute("state", f.state(), f.context); assert.equal(next.snapshot.state, "idle"); assert.equal(next.connector_epoch, first.connector_epoch); assert.equal(counts.resumes, 2); assert.equal(counts.connects, 1); assert.equal(counts.starts, 0);
} finally { f.finish(); } });
test("unobserved turn/start acknowledgement remains unknown and cannot be rearmed as idle", async () => { const counts = { initializes: 0, resumes: 0, starts: 0, connects: 0, closes: 0 }; const f = fixture(undefined, scope => realNative(scope, counts)); try {
  const first: any = await f.service.execute("state", f.state(), f.context); const input = f.apply(); input.expected_connector_epoch = first.connector_epoch; const applied: any = await f.service.execute("apply", input, f.context); assert.equal(applied.fact.delivery_status, "accepted");
  const next: any = await f.service.execute("state", f.state(), f.context); assert.equal(next.snapshot.state, "unknown"); assert.equal(counts.resumes, 1); input.request.operation_id = "newoperation"; input.request.request_id = "newrequest"; const again: any = await f.service.execute("apply", input, f.context); assert.equal(again.fact.delivery_status, "rejected"); assert.equal(again.fact.error_code, "stale_precondition"); assert.equal(counts.starts, 1); assert.equal(counts.resumes, 1);
} finally { f.finish(); } });

test("close waits beyond response deadline for metadata admission and rejects new requests", async () => {
  const f = fixture(20); let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  try {
    f.metadataHook(() => gate);
    await denied(f.service.execute("apply", f.apply(), f.context), "result_unknown");
    assert.equal(f.service.busy, true);
    const closing = f.service.close(); assert.equal(f.service.close(), closing);
    await denied(f.service.execute("query", f.query(), f.context), "offline");
    await denied(closing, "busy");
    assert.equal(f.service.busy, true); assert.equal(f.store.get("person:owner", "operation"), null);
    release(); await f.service.close(); await f.service.close();
    assert.equal(f.service.busy, false); assert.equal(f.stats().invokes, 0);
  } finally { release(); await f.service.close(); f.finish(); }
});

test("close keeps the store available until accepted invocation saves its unknown outcome", async () => {
  const f = fixture(20); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), invoked = new Promise<void>(resolve => entered = resolve);
  try {
    f.invokeHook(async () => { entered(); await gate; throw new Error("native acceptance cannot be established"); });
    const response = f.service.execute("apply", f.apply(), f.context);
    await invoked; await denied(response, "result_unknown");
    const closing = f.service.close(); assert.equal(f.service.close(), closing);
    assert.equal(f.stats().closed, 1); await denied(closing, "busy");
    assert.equal(f.store.get("person:owner", "operation")!.delivery_status, "invoking");
    release(); await f.service.close();
    assert.equal(f.store.get("person:owner", "operation")!.delivery_status, "unknown");
    assert.equal(f.service.busy, false); await f.service.close(); assert.equal(f.stats().closed, 1);
  } finally { release(); await f.service.close(); f.finish(); }
});
