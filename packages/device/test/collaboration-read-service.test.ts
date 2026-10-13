import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { observeAuthorizationWrites } from "./fixtures/authorization-events";
import { CodexReadAdapter } from "../src/collaboration/codex-read";
import { CollaborationReadService, type HistoryReader, type ReadServiceOptions } from "../src/collaboration/read-service";
import { DeviceKey } from "ash-gateway/client/client";
import { deviceIdForKey } from "ash-gateway/src/protocol";
import { readAuthorizationPath } from "../src/collaboration/authorization";
import { COLLABORATION_LIST, COLLABORATION_READ } from "../src/collaboration/capabilities";
import { CollaborationReadError, type ReadPage, type WorkSummary } from "../src/collaboration/types";

const page = (): ReadPage<WorkSummary> => ({ items: [], next_cursor: "next", observed_at: new Date().toISOString(), completeness: "source_page", source: "codex.saved_history", runtime_state: "unknown" });
const ownerKey = (await DeviceKey.generate()).publicKey;
const ownerId = await deviceIdForKey(ownerKey);
const context = { transportOwnerId: ownerId, isCurrent: () => true };
const envelope = (service: CollaborationReadService) => ({ version: 1, endpoint_id: "node", authorization_revision: service.manifest().collaboration.authorization_revision });
const code = (result: { data?: unknown }) => (result.data as { code: string }).code;
function fixture(pairInitially = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-read-service-"));
  const pair = () => writeFileSync(join(stateDir, "paired.json"), JSON.stringify({ owner_key: ownerKey }));
  if (pairInitially) pair();
  const scope = (allowedCwds: string[] = ["/tmp/allowed"], generation = 1) => writeFileSync(readAuthorizationPath(stateDir), JSON.stringify({ version: 3, source_id: "fixture-source", binding_revision: "a".repeat(64), owner_id: ownerId, endpoint_id: "node", authorization_generation: generation, allowedCwds }));
  return { stateDir, pair, scope, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}
// Explicit isolated mock port. It never waives v3 binding or paired transport.
function makeService(options: ReadServiceOptions): CollaborationReadService {
  const {factory,...rest}=options;
  return new CollaborationReadService({...rest,testing:{factory,source:{
    capture:()=>Object.freeze({source_id:"fixture-source",source_revision:"a".repeat(64),version:"fixture"}),
    current:()=>undefined,drained:async()=>{},release:()=>undefined,
  }}});
}
test("read service timeout configuration is bounded", () => {
  for (const timeoutMs of [NaN, -1, 0, 0.1, 60_001, Infinity]) assert.throws(() => makeService({ stateDir: "/unused", nodeId: "node", timeoutMs }), /Invalid read timeout/);
});
test("fixed service dispatch uses exact cwd authorization; similarly named source paths remain outside scope", async () => {
  const f = fixture(false);
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: options => new CodexReadAdapter({ ...options, source: undefined, testing: { command: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/codex-read-cli.mjs", import.meta.url)), "normal", join(f.stateDir, "calls.jsonl"), "/approved-neighbor"] } } }) });
  try {
    await observeAuthorizationWrites(f.stateDir, ["paired.json", "collaboration-read.json"], () => { f.pair(); f.scope(["/approved"]); });
    const result = await service.call(COLLABORATION_LIST, envelope(service), undefined, context);
    assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual((result.data as ReadPage<WorkSummary>).items, []);
    const direct = await service.call(COLLABORATION_READ, { ...envelope(service), work: { node_id: "node", endpoint_id: "node", kind: "conversation", native_id: "work-1" } }, undefined, context);
    assert.equal(code(direct), "permission_denied");
  } finally { await service.close(); f.cleanup(); }
});
test("manifest offers saved read only with explicit scopes and fixed dispatch rejects arbitrary methods/refs", async () => {
  const f = fixture(); let calls = 0;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: options => {
    assert.deepEqual(options.allowedCwds, ["/tmp/allowed"]);
    return { listWork: async () => { calls++; return page(); }, readWork: async () => { calls++; return { ...page(), items: [] }; }, close: async () => {} };
  } });
  try {
    assert.equal(service.manifest().collaboration.authorization_state, "scope_required"); assert.equal(service.manifest().collaboration.runtime_availability, "unknown"); assert.deepEqual(service.manifest().capabilities, []);
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, context)), "permission_denied");
    f.scope(); assert.deepEqual(service.manifest().capabilities.map(c => c.name), [COLLABORATION_LIST, COLLABORATION_READ]);
    assert.equal(service.manifest().collaboration.control, "unsupported");
    assert.equal(code(await service.call(COLLABORATION_LIST, { version: 1, endpoint_id: "node" }, undefined, context)), "permission_denied");
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service))), "permission_denied");
    assert.equal(code(await service.call("collaboration.send_input", envelope(service), undefined, context)), "unsupported");
    assert.equal(code(await service.call(COLLABORATION_LIST, { ...envelope(service), method: "turn/start" }, undefined, context)), "invalid");
    assert.equal(code(await service.call(COLLABORATION_READ, { ...envelope(service), work: { node_id: "wrong", endpoint_id: "node", kind: "conversation", native_id: "thread" } }, undefined, context)), "permission_denied");
    assert.equal(calls, 0);
    assert.equal((await service.call(COLLABORATION_LIST, { ...envelope(service), page: { cursor: "next", limit: 2 } }, undefined, context)).ok, true);
    assert.equal(calls, 1);
  } finally { await service.close(); f.cleanup(); }
});

test("same-generation scope replacement changes revision and rejects old requests before any history read", async () => {
  const f = fixture(); f.scope(["/tmp/scope-a"], 7); let reads = 0;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: options => ({
    listWork: async () => { reads++; assert.deepEqual(options.allowedCwds, ["/tmp/scope-b"]); return page(); },
    readWork: async () => ({ ...page(), items: [] }), close: async () => {},
  }) });
  try {
    const old = envelope(service), oldManifest = service.manifest().collaboration;
    assert.match(old.authorization_revision, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(service.manifest()), /\/tmp\/scope-a/);
    // Models competing local writers that observed the same previous counter.
    f.scope(["/tmp/scope-b"], 7);
    const current = envelope(service), newManifest = service.manifest().collaboration;
    assert.equal(newManifest.authorization_generation, oldManifest.authorization_generation);
    assert.notEqual(current.authorization_revision, old.authorization_revision);
    assert.equal(code(await service.call(COLLABORATION_LIST, old, undefined, context)), "permission_denied");
    assert.equal(reads, 0);
    assert.equal((await service.call(COLLABORATION_LIST, current, undefined, context)).ok, true);
    assert.equal(reads, 1);
  } finally { await service.close(); f.cleanup(); }
});

test("same-generation scope change during a history response rejects old private content", async () => {
  const f = fixture(); f.scope(["/tmp/scope-a"], 4); let release!: (value: ReadPage<WorkSummary>) => void;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: () => ({ listWork: () => new Promise(resolve => { release = resolve; }), readWork: async () => ({ ...page(), items: [] }), close: async () => {} }) });
  try {
    const pending = service.call(COLLABORATION_LIST, envelope(service), undefined, context);
    f.scope(["/tmp/scope-b"], 4);
    release({ ...page(), items: [{ work: { node_id: "node", endpoint_id: "node", kind: "conversation", native_id: "old-work" }, cwd: "/tmp/scope-a", title: "private old scope history", updated_at: null, runtime_state: "unknown" }] });
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(code(result), "permission_denied");
    assert.doesNotMatch(JSON.stringify(result), /private old scope history/);
  } finally { await service.close(); f.cleanup(); }
});

test("scope change during a page aborts the old generation, closes it, and recreates using new scopes", async () => {
  const f = fixture(); f.scope(); let resolveOld!: (value: ReadPage<WorkSummary>) => void; let closed = 0, factories = 0, oldSignal: AbortSignal | undefined;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: options => {
    const index = factories++; if (index) assert.deepEqual(options.allowedCwds, ["/tmp/new"]);
    return { listWork: async input => { if (index) return page(); oldSignal = input?.signal; return new Promise(resolve => { resolveOld = resolve; }); }, readWork: async () => ({ ...page(), items: [] }), close: async () => { closed++; } };
  } });
  try {
    const old = service.call(COLLABORATION_LIST, { ...envelope(service), page: { cursor: "old-page" } }, undefined, context);
    assert.equal(service.busy, true); f.scope(["/tmp/new"], 2);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(code(await old), "cancelled"); assert.equal(oldSignal?.aborted, true); assert.equal(closed, 1);
    resolveOld(page());
    assert.equal((await service.call(COLLABORATION_LIST, envelope(service), undefined, context)).ok, true); assert.equal(factories, 2);
  } finally { await service.close(); f.cleanup(); }
});

test("an old scope cancellation cannot close or abort a replacement reader already serving the new scope", async () => {
  const f = fixture(); f.scope();
  const closed: number[] = [];
  const signals: AbortSignal[] = [];
  let factories = 0, resolveNew!: (value: ReadPage<WorkSummary>) => void;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: options => {
    const index = factories++;
    assert.deepEqual(options.allowedCwds, [index === 0 ? "/tmp/allowed" : "/tmp/new"]);
    return { listWork: input => {
      signals[index] = input!.signal!;
      return new Promise(resolve => { if (index === 1) resolveNew = resolve; });
    }, readWork: async () => ({ ...page(), items: [] }), close: async () => { closed.push(index); } };
  } });
  try {
    const old = service.call(COLLABORATION_LIST, envelope(service), undefined, context);
    f.scope(["/tmp/new"], 2);
    // Start the replacement before the old cancellation's catch microtask executes.
    const blocked = service.call(COLLABORATION_LIST, envelope(service), undefined, context);
    assert.equal(code(await blocked), "draining");
    assert.equal(code(await old), "cancelled");
    await new Promise(resolve => setTimeout(resolve, 0));
    const replacement = service.call(COLLABORATION_LIST, envelope(service), undefined, context);
    assert.equal(factories, 2); assert.deepEqual(closed, [0]);
    assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
    resolveNew(page());
    assert.equal((await replacement).ok, true);
    assert.deepEqual(closed, [0]);
  } finally { await service.close(); f.cleanup(); }
});

test("pair revocation and disconnect reject late results; cancellation, timeout, and source exit allow reconstruction", async () => {
  for (const failure of ["pair", "disconnect", "abort", "timeout", "exit"] as const) {
    const f = fixture(); f.scope(); let current = true, closed = 0, factories = 0;
    const service = makeService({ stateDir: f.stateDir, nodeId: "node", timeoutMs: failure === "timeout" ? 10 : 1000, factory: () => {
      const index = factories++;
      return { listWork: async () => {
        if (index) return page();
        if (failure === "exit") throw new CollaborationReadError("offline", "source exited");
        return new Promise(() => {});
      }, readWork: async () => ({ ...page(), items: [] }), close: async () => { closed++; } } satisfies HistoryReader;
    } });
    try {
      const controller = new AbortController();
      const pending = service.call(COLLABORATION_LIST, envelope(service), controller.signal, { transportOwnerId: ownerId, isCurrent: () => current });
      if (failure === "pair") current = false;
      if (failure === "disconnect") service.invalidate();
      if (failure === "abort") controller.abort();
      assert.equal((await pending).ok, false, failure);
      await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(closed, 1, failure);
      current = true;
      assert.equal((await service.call(COLLABORATION_LIST, envelope(service), undefined, context)).ok, true, failure); assert.equal(factories, 2, failure);
    } finally { await service.close(); f.cleanup(); }
  }
});

test("close cancels an uncooperative page and prevents subsequent reads", async () => {
  const f = fixture(); f.scope(); let closed = false;
  const service = makeService({ stateDir: f.stateDir, nodeId: "node", factory: () => ({ listWork: () => new Promise(() => {}), readWork: () => new Promise(() => {}), close: async () => { closed = true; } }) });
  try {
    const pending = service.call(COLLABORATION_LIST, envelope(service), undefined, context); await service.close();
    assert.equal(code(await pending), "cancelled"); assert.equal(closed, true); assert.equal(service.busy, false);
    assert.equal(code(await service.call(COLLABORATION_LIST, envelope(service), undefined, context)), "offline");
  } finally { await service.close(); f.cleanup(); }
});
