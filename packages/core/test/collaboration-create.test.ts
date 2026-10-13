import assert from "node:assert/strict";
import test from "node:test";
import {
  CREATE_CAPABILITIES, CREATE_INPUT_BYTES, CREATE_OUTPUT_BYTES, CoreCreateError, FixedCreateTransport,
  createOperation, executeCreateRoute, handleCreateRoute, normalizeCreateTarget, parseCreateInput,
  type CoreCreateSession, type CreateOperation,
} from "../src/services/collaboration/create-service";

const revision = "a".repeat(64);
const target = { node_id: "desktop", endpoint_id: "desktop", project_id: "project-1", cwd: "/workspace/project" };
const work = { node_id: "desktop", endpoint_id: "desktop", kind: "conversation" as const, native_id: "thread-1" };
const query = { version: 1, device_id: "device:desktop", authorization_revision: revision, target, operation_id: "operation-1" };
const apply = { version: 1, device_id: "device:desktop", expected_connector_epoch: "current-epoch", request: { version: 1, request_id: "request-1", operation_id: "operation-1", authorization_revision: revision, target, title: "Explicit title", input: { text: "Explicit owner submission" }, expires_at: 1000 } };
const projectsInput = { version: 1, device_id: "device:desktop", node_id: "desktop", endpoint_id: "desktop", authorization_revision: revision, cwd: target.cwd };
const limitations = { native_readiness: "unknown", cancel: false, automatic_replay: false, execution_completion: "unknown" };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const request = (operation: CreateOperation, body: unknown = operation === "projects" ? projectsInput : operation === "apply" ? apply : query) => ({ method: "POST", url: new URL(`http://ash/api/collaboration/create/${operation}`), body: bytes(body) });
const code = (expected: string) => (error: unknown) => error instanceof CoreCreateError && error.code === expected;
function phase(stage: "create" | "name" | "first_input", status: "accepted" | "not_started" | "unknown" | "rejected" = "accepted") {
  const idle = status === "not_started";
  return { status, attempt_id: idle ? null : `attempt-${stage}`, connector_epoch: idle ? null : "old-epoch", native_interface_version: idle ? null : "native-v1", started_at: idle ? null : 10, observed_at: 20,
    receipt: status !== "accepted" ? null : { stage, accepted_by: "native", work, ...(stage === "first_input" ? { native_turn_id: "turn-1", native_message_id: "item-1", correlation: "stable_message_id" } : {}) },
    error_code: status === "unknown" ? "result_unknown" : status === "rejected" ? "offline" : null };
}
function fact() {
  return { version: 1, request_id: "request-1", operation_id: "operation-1", authorization_revision: revision, target, expires_at: 1000, status: "recorded", create: phase("create"), name: phase("name"), first_input: phase("first_input"), work, native_client_message_id: "client-1", reconciliation: null, error_code: null, observed_at: 30 };
}
function projects() {
  return { target: { node_id: "desktop", endpoint_id: "desktop", cwd: target.cwd }, authorization_revision: revision, connector_epoch: "current-epoch", native_interface_version: "native-v1", projects: [{ project_id: target.project_id, cwd: target.cwd }], complete: true };
}
/** Deliberately fake transport only; no real daemon, gateway or runtime setup. */
function fixture() {
  let connection = 1;
  const device = { id: "desktop", name: "Mac", online: true, revoked: false, permissions: ["expose_capability"], manifest: {
    protocol: "ash-dev/1", collaboration: { read: "unsupported" }, collaboration_control: { grant_state: "grant_required" },
    collaboration_create: { version: 1, endpoint_id: "desktop", grant_state: "ready", authorization_revision: revision, actions: ["projects", "apply", "query", "reconcile"], scope: { kind: "exact_cwd", cwd: target.cwd }, limitations },
    capabilities: Object.entries(CREATE_CAPABILITIES).map(([operation, name]) => ({ name, risk: operation === "apply" ? "outward" : "none" })),
  } };
  const calls: Parameters<CoreCreateSession["exchange"]>[1][] = [];
  const f = {
    device, calls, response: { ok: true, content: [], data: { fact: fact() } } as any,
    afterExchange: undefined as (() => void) | undefined, beforeInspect: undefined as (() => Promise<void>) | undefined,
    exchangeFailure: undefined as (() => never) | undefined, inspections: 0, trusted: true, checks: 0,
    changeConnection: () => { connection++; },
    authorize: async (_signal: AbortSignal) => { f.checks++; if (!f.trusted) throw new CoreCreateError("permission_denied"); },
    current: () => { if (!f.trusted) throw new CoreCreateError("permission_denied"); },
    transport: undefined as unknown as FixedCreateTransport,
  };
  f.transport = new FixedCreateTransport(() => {
    const epoch = connection;
    return {
      current: () => { if (epoch !== connection) throw new CoreCreateError("offline"); },
      inspect: async () => { f.inspections++; await f.beforeInspect?.(); return structuredClone(device); },
      exchange: async (id, call) => {
        assert.equal(id, "desktop"); calls.push(call); f.afterExchange?.(); f.exchangeFailure?.();
        return { status: 200, body: bytes(f.response) };
      },
    };
  });
  return f;
}

test("four strict POST routes forward fixed capability and trusted owner only", async () => {
  const f = fixture();
  for (const operation of ["projects", "apply", "query", "reconcile"] as const) {
    f.response.data = operation === "projects" ? projects() : { fact: fact() };
    await executeCreateRoute(request(operation), { authorize: f.authorize, current: f.current }, f.transport);
    assert.equal(f.calls.at(-1)?.capability, CREATE_CAPABILITIES[operation]);
    assert.equal(f.calls.at(-1)?.caller, "person:owner");
    assert.equal(Object.hasOwn(f.calls.at(-1)!.args, "device_id"), false);
  }
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) assert.throws(() => createOperation(method, request("apply").url), code("unsupported"));
  assert.throws(() => createOperation("POST", new URL("http://ash/api/collaboration/create/thread/start")), code("unsupported"));
  assert.throws(() => createOperation("POST", new URL("http://ash/api/collaboration/create/apply?model=native")), code("invalid"));
  for (const key of ["principal", "caller", "permission", "method", "path", "capability", "model", "provider", "grant"]) {
    assert.throws(() => parseCreateInput("apply", bytes({ ...apply, [key]: "injected" })), code("invalid"));
    assert.throws(() => parseCreateInput("apply", bytes({ ...apply, request: { ...apply.request, [key]: "injected" } })), code("invalid"));
  }
  assert.throws(() => parseCreateInput("query", bytes({ ...query, expected_connector_epoch: "old" })), code("invalid"));
  assert.throws(() => parseCreateInput("projects", bytes({ ...projectsInput, project_id: "fake-id" })), code("invalid"));
  assert.throws(() => parseCreateInput("projects", bytes({ ...projectsInput, cwd: "relative" })), code("invalid"));
  assert.throws(() => parseCreateInput("apply", Buffer.alloc(CREATE_INPUT_BYTES + 1)), code("too_large"));
});
test("device node endpoint binding rejects forged targets before exchange", async () => {
  const f = fixture();
  for (const badTarget of [{ ...target, node_id: "other" }, { ...target, endpoint_id: "other" }]) {
    await assert.rejects(executeCreateRoute(request("apply", { ...apply, request: { ...apply.request, target: badTarget } }), { authorize: f.authorize, current: f.current }, f.transport), code("permission_denied"));
  }
  assert.equal(f.calls.length, 0);
  // Complete gateway base64url identity alphabet remains supported.
  assert.equal(parseCreateInput("projects", bytes({ ...projectsInput, device_id: "device:_node", node_id: "_node", endpoint_id: "_node" })).device_id, "device:_node");
});
test("create discovery manifest is separate from read and existing work control", async () => {
  const f = fixture(); f.response.data = projects();
  assert.equal(normalizeCreateTarget("desktop", "Mac", f.device.manifest)?.grant_state, "ready");
  const result = await executeCreateRoute(request("projects"), { authorize: f.authorize, current: f.current }, f.transport);
  assert.deepEqual(result, projects());
  const { collaboration_create: _create, ...other } = f.device.manifest;
  assert.equal(normalizeCreateTarget("desktop", "Mac", other), null);
  assert.equal(normalizeCreateTarget("desktop", "Mac", { ...f.device.manifest, collaboration_create: { ...f.device.manifest.collaboration_create, cwd: "/leak" } }), null);
});
test("three accepted stage facts prove native acceptance and retain stable operation", async () => {
  const f = fixture(), result = await executeCreateRoute(request("apply"), { authorize: f.authorize, current: f.current }, f.transport);
  assert.deepEqual(result, { fact: fact() });
  assert.equal("fact" in result && result.fact?.status, "recorded");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].capability, CREATE_CAPABILITIES.apply);
});
test("unknown and created but naming failed retain operation and actual work without implicit writes", async () => {
  const variants = [
    { ...fact(), create: phase("create", "unknown"), name: phase("name", "not_started"), first_input: phase("first_input", "not_started"), work: null, native_client_message_id: null, error_code: "result_unknown" },
    { ...fact(), name: phase("name", "rejected"), first_input: phase("first_input", "not_started"), native_client_message_id: null, error_code: "offline" },
    { ...fact(), first_input: phase("first_input", "unknown"), error_code: "result_unknown" },
  ];
  for (const value of variants) {
    const f = fixture(); f.response.data = { fact: value };
    for (const operation of ["query", "reconcile"] as const) assert.deepEqual(await executeCreateRoute(request(operation), { authorize: f.authorize, current: f.current }, f.transport), { fact: value });
    assert.deepEqual(f.calls.map(call => call.capability), [CREATE_CAPABILITIES.query, CREATE_CAPABILITIES.reconcile]);
  }
});
test("current owner and screen guard admission and every error or success return", async () => {
  const f = fixture(); f.trusted = false;
  await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code("permission_denied"));
  assert.equal(f.calls.length, 0);
  for (const failure of [false, true]) {
    const f = fixture(); f.afterExchange = () => { f.trusted = false; };
    if (failure) f.exchangeFailure = () => { throw new Error("private"); };
    await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code("permission_denied"));
    assert.equal(f.checks, 2);
  }
});
test("fresh pairing expose grant manifest and connection fence even thrown exchanges", async () => {
  const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["permission_denied", f => { f.device.revoked = true; }],
    ["permission_denied", f => { f.device.permissions = []; }],
    ["permission_denied", f => { f.device.manifest.collaboration_create.authorization_revision = "b".repeat(64); }],
    ["unsupported", f => { f.device.manifest.collaboration_create.actions = ["projects"]; }],
    ["unsupported", f => { f.device.manifest.capabilities.pop(); }],
    ["offline", f => { f.changeConnection(); }],
  ];
  for (const failed of [true, false]) for (const [expected, mutation] of mutations) {
    const f = fixture(); f.afterExchange = () => mutation(f);
    if (failed) f.exchangeFailure = () => { throw new Error("too_large"); };
    await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code(expected));
    assert.equal(f.calls.length, 1); assert.equal(f.checks, 2);
    if (expected !== "offline") assert.equal(f.inspections, 2);
  }
});
test("fresh awaits remain fenced before invocation and final responses", async () => {
  for (const inspection of [1, 2]) {
    const f = fixture(); f.beforeInspect = async () => { if (f.inspections === inspection) { await Promise.resolve(); f.changeConnection(); } };
    await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code("offline"));
    assert.equal(f.calls.length, inspection - 1);
  }
});
test("cross project request operation expiry and provenance mismatch fail closed", async () => {
  const stable = { ...fact(), reconciliation: {
    source: "codex.saved_history", lookup_scope: "bounded_history_pages", work, pages_observed: 4, history_exhausted: false, connector_epoch: "current-epoch", native_interface_version: "native-v1", observed_at: new Date().toISOString(), native_client_message_id: "client-1", native_turn_id: "turn-1", native_message_id: "item-1",
  } };
  const f = fixture(); f.response.data = { fact: stable };
  assert.deepEqual(await executeCreateRoute(request("reconcile"), { authorize: f.authorize, current: f.current }, f.transport), { fact: stable });
  for (const bad of [
    { ...fact(), target: { ...target, project_id: "project-2" } }, { ...fact(), target: { ...target, cwd: "/workspace/other" } },
    { ...fact(), operation_id: "other" }, { ...fact(), request_id: "other" }, { ...fact(), expires_at: 2000 },
    { ...fact(), principal_id: "leak" }, { ...fact(), status: "completed" }, { ...fact(), input: { text: "leak" } },
    { ...stable, reconciliation: { ...stable.reconciliation, native_client_message_id: "other" } },
    { ...stable, reconciliation: { ...stable.reconciliation, work: { ...work, native_id: "other" } } },
  ]) {
    f.response.data = { fact: bad };
    await assert.rejects(executeCreateRoute(request("apply"), { authorize: f.authorize, current: f.current }, f.transport), code("invalid"));
  }
  f.response.data = { ...projects(), projects: [{ project_id: "project-1", cwd: "/workspace/other" }] };
  await assert.rejects(executeCreateRoute(request("projects"), { authorize: f.authorize, current: f.current }, f.transport), code("invalid"));
});
test("whole output and envelope are bounded with safe fixed errors and no-store", async () => {
  const f = fixture();
  for (const response of [
    { ok: true, content: ["leak"], data: { fact: fact() } },
    { ok: true, content: [], data: { fact: fact() }, extra: "leak" },
    { ok: false, content: [], data: { code: "offline", extra: "leak" }, error: "secret" },
  ]) { f.response = response; await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code("invalid")); }
  f.response = { ok: false, content: [], data: { code: "offline" }, error: "TOKEN=secret /private/native" };
  const response = await handleCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport);
  assert.equal(response.status, 503); assert.equal(response.headers["cache-control"], "no-store");
  assert.doesNotMatch(response.body.toString(), /TOKEN|private|secret/);
  f.response.error = "x".repeat(CREATE_OUTPUT_BYTES);
  await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport), code("too_large"));
  f.response = { ok: true, content: [], data: { fact: fact() } };
  assert.equal((await handleCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport)).headers["cache-control"], "no-store");
});
test("single deadline includes admission final owner checks and error fresh inspection", async () => {
  const delay = () => new Promise<void>(resolve => setTimeout(resolve, 35));
  for (const slowStep of ["admission", "final_owner", "error_inspection"] as const) {
    const f = fixture();
    if (slowStep === "error_inspection") { f.exchangeFailure = () => { throw new Error("private"); }; f.beforeInspect = async () => { if (f.inspections === 2) await delay(); }; }
    const authorize = async (signal: AbortSignal) => { await f.authorize(signal); if (slowStep === "admission" || slowStep === "final_owner" && f.checks === 2) await delay(); };
    await assert.rejects(executeCreateRoute(request("query"), { authorize, current: f.current }, f.transport, 10), code("timeout"));
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.equal(f.calls.length, slowStep === "admission" ? 0 : 1);
  }
  const f = fixture();
  await assert.rejects(executeCreateRoute({ ...request("query"), deadline: Date.now() - 1 }, { authorize: f.authorize, current: f.current }, f.transport), code("timeout"));
  assert.equal(f.calls.length, 0);
});
test("local grant exact cwd is enforced and elapsed admission cannot start native work", async () => {
  const f = fixture();
  for (const cwd of ["/workspace/project/child", "/workspace/other"]) {
    await assert.rejects(executeCreateRoute(request("projects", { ...projectsInput, cwd }), { authorize: f.authorize, current: f.current }, f.transport), code("permission_denied"));
    await assert.rejects(executeCreateRoute(request("apply", { ...apply, request: { ...apply.request, target: { ...target, cwd } } }), { authorize: f.authorize, current: f.current }, f.transport), code("permission_denied"));
  }
  assert.equal(f.calls.length, 0);
  const block = () => { const end = Date.now() + 25; while (Date.now() < end) { /* simulate sync admission delay */ } };
  await assert.rejects(executeCreateRoute(request("apply"), { authorize: async () => block(), current: f.current }, f.transport, 10), code("timeout"));
  assert.equal(f.calls.length, 0);
});
test("final owner await cannot return facts or prior errors after device fences change", async () => {
  for (const exchangeFails of [false, true]) for (const mutation of ["pairing", "grant", "connection"] as const) {
    const f = fixture();
    if (exchangeFails) f.exchangeFailure = () => { throw new Error("too_large"); };
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const authorize = async (signal: AbortSignal) => { await f.authorize(signal); if (f.checks === 2) { enter(); await held; } };
    const pending = executeCreateRoute(request("query"), { authorize, current: f.current }, f.transport);
    await entered;
    if (mutation === "pairing") f.device.revoked = true;
    else if (mutation === "grant") f.device.manifest.collaboration_create.authorization_revision = "b".repeat(64);
    else f.changeConnection();
    release();
    await assert.rejects(pending, code(mutation === "connection" ? "offline" : "permission_denied"));
    assert.equal(f.calls.length, 1); assert.equal(f.checks, 2);
  }
});
test("synchronous owner screen fence closes final device inspection await on success and error", async () => {
  for (const exchangeFails of [false, true]) {
    const f = fixture();
    if (exchangeFails) f.exchangeFailure = () => { throw new Error("too_large"); };
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    f.beforeInspect = async () => { if (f.inspections === 2) { enter(); await held; } };
    const pending = executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, f.transport);
    await entered; assert.equal(f.checks, 2);
    f.trusted = false; release();
    await assert.rejects(pending, code("permission_denied"));
    assert.equal(f.checks, 2); assert.equal(f.inspections, 2);
  }
});
test("transport return promise boundary retains the synchronous gateway connection fence", async () => {
  for (const exchangeFails of [false, true]) {
    const f = fixture();
    if (exchangeFails) f.exchangeFailure = () => { throw new Error("too_large"); };
    const wrapped = { collaborationCreate: (...args: Parameters<FixedCreateTransport["collaborationCreate"]>) => {
      const pending = f.transport.collaborationCreate(...args);
      // Registered before executeCreateRoute awaits the returned promise.
      pending.then(f.changeConnection, f.changeConnection);
      return pending;
    } };
    await assert.rejects(executeCreateRoute(request("query"), { authorize: f.authorize, current: f.current }, wrapped), code("offline"));
    assert.equal(f.checks, 2); assert.equal(f.calls.length, 1);
  }
});
