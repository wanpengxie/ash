import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceCreateRuntime } from "../src/collaboration/create-runtime";
import { controlAuthorizationSnapshot } from "../src/collaboration/control-authorization";
import { controlRuntimePath } from "../src/collaboration/control-runtime";
import { CreateOperationStore } from "../src/collaboration/create-operation-store";
import { FakeCreateSocket } from "./fixtures/codex-create-socket";

function fixture(deadlineMs = 100) {
  const dir = mkdtempSync(join(tmpdir(), "ash-create-runtime-"));
  const config = { version: 1, endpoint_id: "endpoint", socket: "/fake.sock", executable: "/fake/codex", supportedVersions: ["1.2.3"] };
  const grant = { version: 1, endpoint_id: "endpoint", owner_id: "owner", authorization_generation: 1, allowed_actions: ["create_work"], scope: { kind: "exact_cwd", cwd: "/project" } };
  writeFileSync(controlRuntimePath(dir), JSON.stringify(config)); writeFileSync(join(dir, "collaboration-control.json"), JSON.stringify(grant));
  const sockets: (FakeCreateSocket & { closed: boolean })[] = [];
  let changed = () => {}, watchError = () => {}, watched: readonly string[] = [], stopped = false, owner: string | null = "owner", identity = "one", version = "1.2.3";
  let connectHook: (() => Promise<void>) | undefined, socketHook: ((s: FakeCreateSocket) => void) | undefined;
  const runtime = createDeviceCreateRuntime({ stateDir: dir, nodeId: "node", endpointId: "endpoint", pinnedOwnerId: () => owner, deadlineMs,
    testing: { listener: () => ({ ...config, pid: 123, identity, version }), connectSocket: async () => {
      await connectHook?.(); const socket = Object.assign(new FakeCreateSocket(), { closed: false }); socket.close = () => { socket.closed = true; }; socketHook?.(socket); sockets.push(socket); return socket;
    }, watch: (paths, invalidate, error) => { watched = paths; changed = invalidate; watchError = error; return () => { stopped = true; }; } } });
  const target = { node_id: "node", endpoint_id: "endpoint", project_id: "project", cwd: "/project" };
  const revision = controlAuthorizationSnapshot(grant, "endpoint").authorization_revision!;
  const projects = { version: 1, node_id: "node", endpoint_id: "endpoint", cwd: "/project", authorization_revision: revision };
  const query = { version: 1, target, operation_id: "operation", authorization_revision: revision };
  const request = { version: 1 as const, target, request_id: "request", operation_id: "operation", authorization_revision: revision, title: "Title", input: { text: "private body" }, expires_at: Date.now() + 5000 };
  const context = { transportOwnerId: "owner", isCurrent: () => true };
  return { dir, runtime, sockets, projects, query, request, context, changed: () => changed(), watchError: () => watchError(), setOwner: (v: string | null) => { owner = v; }, setIdentity: () => { identity = "two"; }, setVersion: () => { version = "9.9.9"; },
    setConnectHook: (v: typeof connectHook) => { connectHook = v; }, setSocketHook: (v: typeof socketHook) => { socketHook = v; }, get watched() { return watched; }, get stopped() { return stopped; },
    close: async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const writes = (f: ReturnType<typeof fixture>) => f.sockets.flatMap(s => s.calls).filter(c => ["thread/start", "thread/name/set", "turn/start"].includes(c.method));
test("contextual manifest is exact cwd only; missing owner/grant denies before source", async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.manifest().grant_state, "grant_required"); assert.equal(f.runtime.manifest().scope, null);
    assert.deepEqual(f.runtime.manifest(f.context).scope, { kind: "exact_cwd", cwd: "/project" }); assert.equal(f.sockets.length, 0);
    assert.deepEqual(f.watched.map(p => p.split("/").at(-1)), ["collaboration-control-runtime.json", "collaboration-control.json", "paired.json"]);
    await assert.rejects(f.runtime.execute("projects", f.projects), /permission_denied/);
    f.setOwner(null); await assert.rejects(f.runtime.execute("projects", f.projects, f.context), /permission_denied/); assert.equal(f.sockets.length, 0);
  } finally { await f.close(); }
});
test("production runtime journals exact create/name/input once and queries saved fact without native config", async () => {
  const f = fixture(1000);
  try {
    const projects = await f.runtime.execute("projects", f.projects, f.context) as any;
    const body = { version: 1, request: f.request, expected_connector_epoch: projects.connector_epoch };
    const result = await f.runtime.execute("apply", body, f.context) as any;
    assert.equal(f.runtime.changeSafety().reason,"native_unknown");
    assert.equal(result.fact.first_input.status, "accepted"); assert.equal(result.fact.work.native_id, "thread");
    assert.deepEqual(writes(f).map(c => c.method), ["thread/start", "thread/name/set", "turn/start"]);
    assert.deepEqual(writes(f)[0].params, { cwd: "/project", projectId: "project", ephemeral: false });
    assert.equal(writes(f)[2].params.clientUserMessageId, result.fact.native_client_message_id);
    await f.runtime.execute("apply", body, f.context); assert.equal(writes(f).length, 3);
    rmSync(controlRuntimePath(f.dir)); f.changed();
    const sockets = f.sockets.length;
    const saved = await f.runtime.execute("query", f.query, f.context) as any;
    assert.deepEqual(saved.fact, result.fact); assert.equal(f.sockets.length, sockets);
    assert.doesNotMatch(JSON.stringify(saved), /private body|principal_id|payload_hash/);
    f.setOwner(null); await assert.rejects(f.runtime.execute("query", f.query, f.context), /permission_denied/);
  } finally { await f.close(); assert.ok(f.sockets.every(s => s.closed)); assert.equal(f.stopped, true); }
});
test("selected listener version/config failures prevent writes while source-free query remains usable", async () => {
  const f = fixture();
  try {
    f.setVersion(); await assert.rejects(f.runtime.execute("projects", f.projects, f.context), /offline/); assert.equal(f.sockets.length, 0);
    writeFileSync(controlRuntimePath(f.dir), JSON.stringify({ endpoint_id: "wrong" }));
    assert.deepEqual(await f.runtime.execute("query", f.query, f.context), { fact: null });
    await assert.rejects(f.runtime.execute("projects", f.projects, f.context), /offline/); assert.equal(writes(f).length, 0);
  } finally { await f.close(); }
});
test("identity replacement, cwd drift and watch ABA invalidate native results before writes", async () => {
  for (const mode of ["identity", "cwd", "aba", "watch-error"] as const) {
    const f = fixture(1000);
    try {
      const projects = await f.runtime.execute("projects", f.projects, f.context) as any;
      const socket = f.sockets[0]; let triggered = false;
      socket.hook = c => { if (!triggered && c.method === "project/list") { triggered = true; if (mode === "identity") f.setIdentity(); if (mode === "cwd") socket.projects = { data: [{ id: "project", roots: [{ path: "/other" }] }], nextCursor: null }; if (mode === "aba") { f.changed(); f.changed(); } if (mode === "watch-error") f.watchError(); } };
      await assert.rejects(f.runtime.execute("apply", { version: 1, request: f.request, expected_connector_epoch: projects.connector_epoch }, f.context));
      assert.equal(writes(f).length, 0);
      if (mode === "watch-error") { assert.equal(f.runtime.status().state, "watcher_failed"); assert.equal(f.runtime.manifest(f.context).scope, null); }
    } finally { await f.close(); }
  }
});
test("unknown create receipt cannot replay and is queryable after reopening without native config", async () => {
  const f = fixture(40);
  try {
    const projects = await f.runtime.execute("projects", f.projects, f.context) as any; f.sockets[0].fault = "thread/start";
    const body = { version: 1, request: f.request, expected_connector_epoch: projects.connector_epoch };
    await f.runtime.execute("apply", body, f.context).catch(() => {});
    await new Promise(r => setTimeout(r, 30)); await f.runtime.close();
    rmSync(controlRuntimePath(f.dir));
    const reopened = createDeviceCreateRuntime({ stateDir: f.dir, nodeId: "node", endpointId: "endpoint", pinnedOwnerId: () => "owner", testing: { watch: () => () => {} } });
    try { const result = await reopened.execute("query", f.query, f.context) as any; assert.equal(result.fact.create.status, "unknown"); assert.equal(result.fact.work, null); await reopened.execute("apply", body, f.context); assert.equal(writes(f).length, 1); }
    finally { await reopened.close(); }
  } finally { await f.close(); }
});
test("unsettled socket factory keeps busy and journal open until retryable shutdown drain", async () => {
  const f = fixture(25); let release!: () => void;
  f.setConnectHook(() => new Promise<void>(r => { release = r; }));
  try {
    await assert.rejects(f.runtime.execute("projects", f.projects, f.context), /offline/);
    assert.equal(f.runtime.busy, true); assert.equal(f.runtime.changeSafety().reason,"raw_pending"); await assert.rejects(f.runtime.close(), /busy/);
    release(); await new Promise(r => setTimeout(r, 5)); await f.runtime.close(); assert.equal(f.runtime.busy, false); assert.ok(f.sockets.every(s => s.closed));
  } finally { release?.(); await f.close(); }
});

test("create changeSafety exposes only real local raw/journal facts and disabled-empty safety; unknown never clears",async()=>{
  const f=fixture();let store:CreateOperationStore|undefined;
  try {
    assert.equal(f.runtime.changeSafety().state,'safe');
    rmSync(controlRuntimePath(f.dir));
    assert.equal(f.runtime.changeSafety().reason,'config_required');
    store=new CreateOperationStore(join(f.dir,'collaboration-create.sqlite'));
    store.record('owner',f.request,'fixed',Date.now());
    const claim=store.claim('owner','operation','create','epoch',Date.now(),'1.2.3');
    assert.deepEqual(store.changeFacts(),{invoking:1,unknown:0,acceptedInput:0});
    assert.equal(f.runtime.changeSafety().reason,'journal_invoking');
    store.finish(claim.fact,'create',null,Date.now());
    assert.deepEqual(store.changeFacts(),{invoking:0,unknown:1,acceptedInput:0});
    const safety=f.runtime.changeSafety();
    assert.equal(safety.state,'unavailable');assert.equal(safety.reason,'journal_unknown');
    assert.doesNotMatch(JSON.stringify(safety),/private body|principal|payload/);
    assert.equal(store.get('owner','operation')!.create.status,'unknown');
  }finally{store?.close();await f.close();}
});
