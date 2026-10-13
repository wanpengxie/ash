import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceControlRuntime, loadControlRuntimeConfig, parseControlRuntimeConfig, parseUnixListenerPid, controlRuntimePath } from "../src/collaboration/control-runtime";
import { controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
import { OperationStore } from "../src/collaboration/operation-store";
const work = { node_id: "node", endpoint_id: "endpoint", kind: "conversation" as const, native_id: "thread" };
const config = { version: 1 as const, endpoint_id: "endpoint", socket: "/fake.sock", executable: "/fake/codex", supportedVersions: ["1.2.3"] };
const grant = { version: 1, endpoint_id: "endpoint", owner_id: "owner", authorization_generation: 1, allowed_actions: ["send_input"], scope: { kind: "exact_cwd", cwd: "/project" } };
class Socket extends EventEmitter {
  calls: any[] = []; closed = false;
  constructor(private fixture: { mode: string; cwd: string; delayMs?: number; onCall?: (call: any) => void }) { super(); }
  send(data: string) {
    const call = JSON.parse(data); this.calls.push(call); this.fixture.onCall?.(call);
    if (!call.id || this.fixture.mode === "hang" || this.fixture.mode === "hang-turn" && call.method === "turn/start") return;
    const result = call.method === "initialize" ? { userAgent: this.fixture.mode === "bad-init" ? "codex 9.9.9" : "codex 1.2.3" } : call.method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread", cwd: this.fixture.cwd, status: { type: "idle" } } };
    const respond = () => this.emit("message", Buffer.from(JSON.stringify({ id: call.id, result })));
    if (this.fixture.delayMs) setTimeout(respond, this.fixture.delayMs); else queueMicrotask(respond);
  }
  close() { this.closed = true; }
}
function fixture(options: { configured?: boolean; granted?: boolean; deadlineMs?: number; watchThrows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ash-control-runtime-"));
  if (options.configured !== false) writeFileSync(controlRuntimePath(dir), JSON.stringify(config));
  if (options.granted !== false) writeFileSync(join(dir, "collaboration-control.json"), JSON.stringify(grant));
  const sockets: Socket[] = [], source = { mode: "normal", cwd: "/project", delayMs: 0, evidenceVersion: "1.2.3", listenerError: false, onCall: undefined as ((call: any) => void) | undefined, connectHook: undefined as (() => Promise<void>) | undefined };
  let identity = "one", owner: string | null = "owner", invalidate = () => {}, watchError = () => {}, watchClosed = false;
  const runtime = createDeviceControlRuntime({ stateDir: dir, nodeId: "node", endpointId: "endpoint", pinnedOwnerId: () => owner, deadlineMs: options.deadlineMs,
    testing: { listener: () => { if (source.listenerError) throw new Error("listener/executable cannot be proven"); return { socket: config.socket, executable: config.executable, pid: 123, version: source.evidenceVersion, identity }; }, connectSocket: async () => { await source.connectHook?.(); const socket = new Socket(source); sockets.push(socket); return socket; },
      watch: (_paths, changed, error) => { if (options.watchThrows) throw new Error(); invalidate = changed; watchError = error; return () => { watchClosed = true; }; } } });
  const envelope = { version: 1, endpoint_id: "endpoint", authorization_revision: controlAuthorizationSnapshot(grant, "endpoint").authorization_revision!, work, action: "send_input" as const };
  const context = { transportOwnerId: "owner", isCurrent: () => true };
  return { runtime, dir, sockets, source, envelope, context, invalidate: () => invalidate(), watchError: () => watchError(), changeIdentity: () => { identity = "two"; }, revoke: () => { owner = null; }, get watchClosed() { return watchClosed; }, close: () => { runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test("strict bounded regular local configuration is required, independently of grant", async () => {
  const f = fixture({ configured: false });
  assert.deepEqual(f.runtime.status(), { state: "config_required", grant_state: "ready" });
  assert.equal(f.sockets.length, 0); f.runtime.manifest(); assert.equal(f.sockets.length, 0);
  await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /offline/);
  writeFileSync(controlRuntimePath(f.dir), "x".repeat(20000)); assert.equal(loadControlRuntimeConfig(f.dir, "endpoint").state, "invalid_configuration");
  rmSync(controlRuntimePath(f.dir)); symlinkSync(join(f.dir, "collaboration-control.json"), controlRuntimePath(f.dir)); assert.equal(loadControlRuntimeConfig(f.dir, "endpoint").state, "invalid_configuration"); f.close();
});
test("runtime configuration rejects extra fields, PID, relative paths, endpoint drift and versions", () => {
  for (const bad of [{ ...config, pid: 99 }, { ...config, endpoint_id: "other" }, { ...config, socket: "relative" }, { ...config, executable: "relative" }, { ...config, socket: "/bad?socket" }, { ...config, supportedVersions: [] }, { ...config, supportedVersions: ["latest"] }, { ...config, supportedVersions: ["1.2.3", "1.2.3"] }]) assert.throws(() => parseControlRuntimeConfig(bad, "endpoint"));
});
test("selected Unix socket requires exactly one current owner", () => {
  const canonical = (p: string) => p === "/alias" ? "/socket" : p;
  assert.equal(parseUnixListenerPid("p101\nf12\ntunix\nn/alias\nf14\ntunix\nn/socket\np999\nf13\ntunix\nn->0xb298adc513a09dd0", "/socket", canonical), 101);
  for (const output of ["", "p0\nn/socket", "p101\nn/socket\np102\nn/socket", "p101\nn/other"]) assert.throws(() => parseUnixListenerPid(output, "/socket", canonical), /offline/);
});
test("owner and grant deny before any source connection; grant and runtime states are separate", async () => {
  const f = fixture({ granted: false });
  assert.equal(f.runtime.status().grant_state, "grant_required");
  await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /permission_denied/); assert.equal(f.sockets.length, 0);
  writeFileSync(join(f.dir, "collaboration-control.json"), JSON.stringify(grant)); f.revoke();
  await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /permission_denied/); assert.equal(f.sockets.length, 0); f.close();
});
test("query metadata shares one private read-only channel, queries each time and closes on runtime shutdown", async () => {
  const f = fixture();
  const response = await f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context);
  assert.deepEqual(response, { fact: null }); assert.equal(f.sockets.length, 1);
  assert.ok(f.sockets[0].calls.filter(call => call.method === "thread/read").length >= 3);
  assert.equal(f.sockets[0].closed, false);
  for (const socket of f.sockets) {
    for (const call of socket.calls) {
      assert.ok(["initialize", "initialized", "thread/read"].includes(call.method));
      if (call.method === "thread/read") assert.deepEqual(call.params, { threadId: "thread", includeTurns: false });
    }
  }
  assert.equal(f.runtime.busy, false); await f.runtime.close();
  assert.ok(f.sockets.every(socket => socket.closed)); f.close();
});
test("state shares epoch across calls and apply binds authorization without metadata recursion", async () => {
  const f = fixture();
  const a = await f.runtime.execute("state", f.envelope, f.context) as any;
  const b = await f.runtime.execute("state", f.envelope, f.context) as any;
  assert.equal(a.connector_epoch, b.connector_epoch);
  const request = { request_id: "request", operation_id: "operation", work, action: "send_input", input: { text: "hello" }, expires_at: Date.now() + 10000 };
  const { action: _action, ...target } = f.envelope;
  const body = { ...target, expected_connector_epoch: a.connector_epoch, request };
  const result = await f.runtime.execute("apply", body, f.context) as any;
  assert.equal(result.fact.delivery_status, "accepted");
  await f.runtime.execute("apply", body, f.context);
  assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "turn/start").length, 1);
  assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "turn/steer").length, 0);
  assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "thread/resume").length, 1);
  f.close(); assert.equal(f.watchClosed, true); assert.ok(f.sockets.every(s => s.closed));
});
test("listener identity replacement, metadata cwd drift, revoke and ABA suppress results", async () => {
  for (const mode of ["identity", "cwd", "revoke", "aba"]) {
    const f = fixture(); let triggered = false;
    f.source.onCall = call => { if (!triggered && call.method === "thread/read") { triggered = true; if (mode === "identity") f.changeIdentity(); if (mode === "cwd") f.source.cwd = "/elsewhere"; if (mode === "revoke") f.revoke(); if (mode === "aba") f.invalidate(); } };
    await assert.rejects(f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context), /permission_denied/);
    assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method.startsWith("turn/")).length, 0); f.close();
  }
});
test("metadata handshake failure and timeout release sockets; watcher errors fail closed", async () => {
  for (const mode of ["bad-init", "hang"]) {
    const f = fixture({ deadlineMs: 30 }); f.source.mode = mode;
    await assert.rejects(f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context));
    await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(f.runtime.busy, false); assert.ok(f.sockets.every(s => s.closed)); f.close();
  }
  const f = fixture(); f.watchError(); assert.equal(f.runtime.status().state, "watcher_failed");
  await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /offline/); f.close(); f.runtime.close();
  const g = fixture({ watchThrows: true }); assert.equal(g.runtime.status().state, "watcher_failed"); g.close();
});

test("runtime config replacement during metadata and shutdown reject late responses", async () => {
  for (const mode of ["config", "close", "watch"]) {
    const f = fixture(); let changed = false;
    f.source.onCall = call => { if (!changed && call.method === "thread/read") {
      changed = true;
      if (mode === "config") writeFileSync(controlRuntimePath(f.dir), JSON.stringify({ ...config, socket: "/different.sock" }));
      if (mode === "close") f.runtime.close();
      if (mode === "watch") f.watchError();
    } };
    await assert.rejects(f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context));
    assert.ok(f.sockets.every(s => s.closed)); assert.equal(f.runtime.busy, false); f.close();
  }
});

test("busy remains set while an invoked native request outlives the service deadline", async () => {
  const f = fixture({ deadlineMs: 200 });
  const state = await f.runtime.execute("state", f.envelope, f.context) as any;
  f.source.mode = "hang-turn"; f.source.delayMs = 5;
  const { action: _action, ...target } = f.envelope;
  const body = { ...target, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work, action: "send_input", input: { text: "hello" }, expires_at: Date.now() + 5000 } };
  await assert.rejects(f.runtime.execute("apply", body, f.context), /result_unknown/);
  assert.equal(f.runtime.busy, true);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(f.runtime.busy, false);
  assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "turn/start").length, 1); f.close();
});

test("unprovable executable/listener and unsupported version never connect", async () => {
  for (const mode of ["listener", "version"]) {
    const f = fixture();
    if (mode === "listener") f.source.listenerError = true; else f.source.evidenceVersion = "9.9.9";
    await assert.rejects(f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context), /permission_denied/);
    assert.equal(f.sockets.length, 0); assert.equal(f.runtime.busy, false); f.close();
  }
});

test("revokeAt8 without a watcher event cannot write after the independent metadata await", async () => {
  for (const mode of ["revoke", "cwd", "config", "single-work-cwd", "final-cwd"]) {
    const f = fixture();
    if (mode === "single-work-cwd") {
      const single = { ...grant, scope: { kind: "single_work", work } };
      writeFileSync(join(f.dir, "collaboration-control.json"), JSON.stringify(single));
      f.envelope.authorization_revision = controlAuthorizationSnapshot(single, "endpoint").authorization_revision!;
    }
    const state = await f.runtime.execute("state", f.envelope, f.context) as any;
    let reads = 0;
    const trigger = mode === "final-cwd" ? 9 : 8;
    f.source.onCall = call => {
      if (call.method !== "thread/read" || ++reads !== trigger) return;
      if (mode === "revoke") f.revoke();
      else if (mode === "config") writeFileSync(controlRuntimePath(f.dir), JSON.stringify({ ...config, socket: "/replacement.sock" }));
      else f.source.cwd = "/changed-after-authorize";
    };
    const { action: _action, ...target } = f.envelope;
    const body = { ...target, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work, action: "send_input", input: { text: "hello" }, expires_at: Date.now() + 5000 } };
    // Some denied native attempts return a persisted rejected fact; later owner
    // revocation suppresses the whole response. Both must have zero writes.
    try { await f.runtime.execute("apply", body, f.context); } catch {}
    assert.ok(reads >= trigger, mode);
    assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "turn/start" || c.method === "turn/steer").length, 0, mode);
    assert.equal(f.runtime.busy, false); f.close();
  }
});

test("shutdown drains pending metadata and bootstrap sockets with no late subscription", async () => {
  for (const phase of ["metadata", "bootstrap"]) {
    const f = fixture({ deadlineMs: 100 }); let entered!: () => void;
    const started = new Promise<void>(resolve => entered = resolve);
    f.source.onCall = call => {
      if (phase === "metadata" && call.method === "thread/read" || phase === "bootstrap" && call.method === "thread/resume") {
        f.source.mode = "hang"; entered();
      }
    };
    try {
      const response = f.runtime.execute("state", f.envelope, f.context);
      const failure = assert.rejects(response);
      await started;
      const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing);
      await closing; await failure;
      assert.equal(f.runtime.busy, false); assert.equal(f.watchClosed, true);
      assert.ok(f.sockets.every(s => s.closed)); await f.runtime.close();
      await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /offline/);
      assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method.startsWith("turn/")).length, 0);
    } finally { await f.runtime.close(); f.close(); }
  }
});

test("unresolved factory gives bounded retryable shutdown and closes its late socket", async () => {
  const f = fixture({ deadlineMs: 20 }); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve);
  f.source.connectHook = async () => { entered(); await gate; };
  try {
    const response = f.runtime.execute("query", { ...f.envelope, operation_id: "operation" }, f.context);
    const failure = assert.rejects(response);
    await started;
    const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing);
    await assert.rejects(closing, /busy/); await failure;
    assert.equal(f.runtime.busy, true); assert.equal(f.watchClosed, true);
    await assert.rejects(f.runtime.execute("state", f.envelope, f.context), /offline/);
    release(); await f.runtime.close();
    assert.equal(f.runtime.busy, false); assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].closed, true);
    assert.equal(f.sockets[0].calls.length, 0); await f.runtime.close();
  } finally { release(); await f.runtime.close(); f.close(); }
});

test("shutdown of timed-out native invoke persists unknown and reopening never resends", async () => {
  const f = fixture({ deadlineMs: 100 }); let reopened: ReturnType<typeof createDeviceControlRuntime> | undefined;
  try {
    const state = await f.runtime.execute("state", f.envelope, f.context) as any;
    f.source.mode = "hang-turn"; f.source.delayMs = 1;
    const { action: _action, ...target } = f.envelope;
    const body = { ...target, expected_connector_epoch: state.connector_epoch, request: { request_id: "request", operation_id: "operation", work, action: "send_input", input: { text: "hello" }, expires_at: Date.now() + 5000 } };
    await assert.rejects(f.runtime.execute("apply", body, f.context), /result_unknown/);
    assert.equal(f.runtime.busy, true);
    const closing = f.runtime.close(); assert.equal(f.runtime.close(), closing); await closing;
    assert.equal(f.runtime.busy, false); assert.ok(f.sockets.every(s => s.closed));
    const store = new OperationStore(join(f.dir, "collaboration-control.sqlite"));
    const fact = store.get("owner", "operation")!; assert.equal(fact.delivery_status, "unknown"); store.close();
    f.source.mode = "normal"; f.source.delayMs = 0;
    reopened = createDeviceControlRuntime({ stateDir: f.dir, nodeId: "node", endpointId: "endpoint", pinnedOwnerId: () => "owner", deadlineMs: 100,
      testing: { listener: () => ({ socket: config.socket, executable: config.executable, pid: 123, version: "1.2.3", identity: "one" }), connectSocket: async () => { const socket = new Socket(f.source); f.sockets.push(socket); return socket; }, watch: () => () => {} } });
    const next = await reopened.execute("state", f.envelope, f.context) as any;
    const result = await reopened.execute("apply", { ...body, expected_connector_epoch: next.connector_epoch }, f.context) as any;
    assert.equal(result.fact.delivery_status, "unknown"); assert.equal(result.fact.native_client_message_id, fact.native_client_message_id);
    assert.equal(f.sockets.flatMap(s => s.calls).filter(c => c.method === "turn/start").length, 1);
  } finally { await reopened?.close(); await f.runtime.close(); assert.ok(f.sockets.every(s => s.closed)); f.close(); }
});
