import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_CAPABILITIES, CONTROL_INPUT_BYTES, CONTROL_OUTPUT_BYTES, CoreControlError, FixedControlTransport,
  controlOperation, executeControlRoute, normalizeControlTarget, parseControlInput,
  type CoreControlSession, type CoreControlEnvelope, type ControlOperation,
} from "../src/services/collaboration/control-service";

const work = { node_id: "desktop", endpoint_id: "desktop", kind: "conversation" as const, native_id: "thread-1" };
const revision = "a".repeat(64);
const base = { version: 1, device_id: "device:desktop", endpoint_id: "desktop", authorization_revision: revision, work };
const query = { ...base, action: "send_input", operation_id: "operation-1" };
const apply = { ...base, expected_connector_epoch: "native-1", request: { request_id: "request-1", operation_id: "operation-1", work, action: "send_input", input: { text: "explicit owner submission" }, expires_at: 1000 } };
const limitations = { atomic_idle_start: false, cancel: false, queue: false, runtime_state: "unknown", subscription_state: "unknown" };
function fact() {
  return { request_id: "request-1", operation_id: "operation-1", work, action: "send_input", expires_at: 1000, delivery_status: "accepted", attempt_id: "attempt-1", connector_epoch: "old-native-epoch", native_client_message_id: "client-1", native_interface_version: "native-version", expected_turn_id: null,
    receipt: { accepted_by: "native", native_turn_id: "turn-1", correlation: "uncertain" }, reconciliation: null, error_code: null, observed_at: 2000 };
}
function state() {
  return { target: { endpoint_id: "desktop", work }, authorization_revision: revision, connector_epoch: "native-1", native_interface_version: "native-version",
    snapshot: { work, connector_epoch: "native-1", source: "codex.live", identity_provenance: "none", observed_at: null, revision: 0, state: "unknown" }, allowed_actions: ["send_input", "steer"], limitations };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const request = (operation: ControlOperation, body: unknown = operation === "apply" ? apply : operation === "state" ? { ...base, action: "send_input" } : query) => ({ method: "POST", url: new URL(`http://ash/api/collaboration/control/${operation}`), body: bytes(body) });
const code = (expected: string) => (error: unknown) => error instanceof CoreControlError && error.code === expected;
function fixture() {
  let connection = 1;
  const device = { id: "desktop", name: "Mac", online: true, revoked: false, permissions: ["expose_capability"], manifest: {
    protocol: "ash-dev/1", collaboration: { control: "unsupported", runtime_state: "unknown" },
    collaboration_control: { version: 1, endpoint_id: "desktop", grant_state: "ready", authorization_revision: revision, actions: ["send_input", "steer"], limitations },
    capabilities: Object.entries(CONTROL_CAPABILITIES).map(([operation, name]) => ({ name, risk: operation === "apply" ? "outward" : "none" })),
  } };
  const calls: Parameters<CoreControlSession["exchange"]>[1][] = [];
  const f = {
    device, calls, response: { ok: true, content: [], data: { fact: fact() } } as any,
    afterExchange: undefined as (() => void) | undefined, beforeInspect: undefined as (() => Promise<void>) | undefined,
    exchangeFailure: undefined as (() => never) | undefined, inspections: 0,
    hold: false, aborted: 0, trusted: true, checks: 0,
    changeConnection: () => { connection++; },
    authorize: async (_signal: AbortSignal) => { f.checks++; if (!f.trusted) throw new CoreControlError("permission_denied"); },
    transport: undefined as unknown as FixedControlTransport,
  };
  f.transport = new FixedControlTransport(signal => {
    const epoch = connection;
    return {
      current: () => { if (epoch !== connection) throw new CoreControlError("offline"); },
      inspect: async () => { f.inspections++; await f.beforeInspect?.(); return structuredClone(device); },
      exchange: async (id, call) => {
        assert.equal(id, "desktop"); calls.push(call);
        if (f.hold) return new Promise((_, reject) => signal.addEventListener("abort", () => { f.aborted++; reject(new CoreControlError("cancelled")); }, { once: true }));
        f.afterExchange?.(); f.exchangeFailure?.(); return { status: 200, body: bytes(f.response) };
      },
    };
  });
  return f;
}
test("only four POST routes and strict body fields reach the fixed device capabilities", async () => {
  const f = fixture();
  for (const operation of ["state", "apply", "query", "reconcile"] as const) {
    f.response.data = operation === "state" ? state() : { fact: fact() };
    await executeControlRoute(request(operation), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport);
    const call = f.calls.at(-1)!;
    assert.equal(call.capability, CONTROL_CAPABILITIES[operation]); assert.equal(call.caller, "person:owner");
    assert.equal(Object.hasOwn(call.args, "device_id"), false);
    assert.equal(Object.hasOwn(call.args, "caller"), false);
  }
  for (const method of ["GET", "PUT", "PATCH", "DELETE"]) assert.throws(() => controlOperation(method, request("query").url), code("unsupported"));
  assert.throws(() => controlOperation("POST", new URL("http://ash/api/collaboration/control/native/start")), code("unsupported"));
  assert.throws(() => controlOperation("POST", new URL("http://ash/api/collaboration/control/query?method=start")), code("invalid"));
  for (const key of ["principal", "caller", "method", "capability", "path", "grant", "provider", "model"]) assert.throws(() => parseControlInput("query", bytes({ ...query, [key]: "injected" })), code("invalid"));
  assert.throws(() => parseControlInput("query", bytes({ ...query, expected_connector_epoch: "old" })), code("invalid"));
  assert.throws(() => parseControlInput("apply", bytes({ ...apply, action: "steer" })), code("invalid"));
  assert.throws(() => parseControlInput("query", Buffer.alloc(CONTROL_INPUT_BYTES + 1)), code("too_large"));
});
test("full endpoint/work binding rejects forged targets before any exchange", async () => {
  const f = fixture();
  for (const body of [{ ...query, endpoint_id: "other", work: { ...work, endpoint_id: "other" } }, { ...query, work: { ...work, node_id: "other" } }]) {
    await assert.rejects(executeControlRoute(request("query", body), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("permission_denied"));
  }
  assert.throws(() => parseControlInput("apply", bytes({ ...apply, request: { ...apply.request, work: { ...work, native_id: "other" } } })), code("invalid"));
  assert.throws(() => parseControlInput("query", bytes({ ...query, authorization_revision: "read-revision" })), code("invalid"));
  assert.equal(f.calls.length, 0);
});
test("control metadata is independent of read metadata and runtime readiness", () => {
  const f = fixture(), target = normalizeControlTarget("desktop", "Mac", f.device.manifest)!;
  assert.equal(target.grant_state, "ready"); assert.equal(target.limitations.runtime_state, "unknown");
  assert.deepEqual(f.device.manifest.collaboration, { control: "unsupported", runtime_state: "unknown" });
  assert.equal(normalizeControlTarget("desktop", "Mac", { ...f.device.manifest, collaboration_control: { ...f.device.manifest.collaboration_control, ready: true } }), null);
  assert.equal(normalizeControlTarget("desktop", "Mac", { ...f.device.manifest, collaboration_control: { ...f.device.manifest.collaboration_control, endpoint_id: "other" } }), null);
});
test("current owner/screen authorization guards admission and every successful or error return", async () => {
  const f = fixture(); f.trusted = false;
  await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("permission_denied"));
  assert.equal(f.calls.length, 0);
  for (const errorResult of [false, true]) {
    const f = fixture(); f.afterExchange = () => { f.trusted = false; };
    if (errorResult) f.response = { ok: false, content: [], data: { code: "offline" }, error: "native secret" };
    await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("permission_denied"));
    assert.equal(f.checks, 2);
  }
});
test("fresh pairing, permission, grant revision, manifest and connection changes fence late responses", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.device.revoked = true; },
    (f: ReturnType<typeof fixture>) => { f.device.permissions = []; },
    (f: ReturnType<typeof fixture>) => { f.device.online = false; },
    (f: ReturnType<typeof fixture>) => { f.device.manifest.collaboration_control.authorization_revision = "b".repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.device.manifest.collaboration_control.actions = ["steer"]; },
    (f: ReturnType<typeof fixture>) => { f.device.manifest.collaboration_control.limitations = { ...limitations, runtime_state: "observed" }; },
    (f: ReturnType<typeof fixture>) => { f.device.manifest.capabilities.pop(); },
    (f: ReturnType<typeof fixture>) => { f.changeConnection(); },
  ];
  for (const mutation of mutations) {
    const f = fixture(); f.afterExchange = () => mutation(f);
    await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), error => error instanceof CoreControlError);
  }
});
test("late connection changes while fresh metadata is awaited never start an exchange", async () => {
  const f = fixture(); f.beforeInspect = async () => { await Promise.resolve(); f.changeConnection(); };
  await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("offline"));
  assert.equal(f.calls.length, 0);
});
test("rejected exchanges are fenced by fresh pairing, grants, manifest and connection before returning sanitized errors", async () => {
  const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["permission_denied", f => { f.device.revoked = true; }],
    ["permission_denied", f => { f.device.permissions = []; }],
    ["permission_denied", f => { f.device.manifest.collaboration_control.authorization_revision = "b".repeat(64); }],
    ["permission_denied", f => { f.device.manifest.collaboration_control.actions = ["steer"]; }],
    ["permission_denied", f => { f.device.manifest.collaboration_control.limitations = { ...limitations, runtime_state: "observed" }; }],
    ["unsupported", f => { f.device.manifest.capabilities.pop(); }],
    ["offline", f => { f.changeConnection(); }],
  ];
  for (const operation of ["query", "reconcile"] as const) {
    for (const [expected, mutation] of mutations) {
      const f = fixture(); f.afterExchange = () => mutation(f);
      f.exchangeFailure = () => { throw new Error("too_large"); };
      await assert.rejects(executeControlRoute(request(operation), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code(expected));
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].capability, CONTROL_CAPABILITIES[operation]);
      assert.equal(f.checks, 2);
      if (expected !== "offline") assert.equal(f.inspections, 2);
    }
  }
  for (const [source, expected] of [[new Error("too_large"), "too_large"], [new Error("TOKEN=secret /private/native"), "offline"], [undefined, "offline"]] as const) {
    const f = fixture(); f.exchangeFailure = () => { throw source; };
    await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), error => code(expected)(error) && !/TOKEN|private|secret/.test((error as Error).message));
    assert.equal(f.inspections, 2); assert.equal(f.calls.length, 1);
  }
});
test("rejected exchange final inspection remains fenced during awaits and shares the original deadline", async () => {
  for (const change of ["revocation", "connection", "deadline"] as const) {
    const f = fixture(); f.exchangeFailure = () => { throw new Error("too_large"); };
    f.beforeInspect = async () => {
      if (f.inspections !== 2) return;
      if (change === "deadline") await new Promise(resolve => setTimeout(resolve, 35));
      else {
        await Promise.resolve();
        if (change === "revocation") f.device.revoked = true;
        else f.changeConnection();
      }
    };
    await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport, change === "deadline" ? 10 : 1000), code(change === "revocation" ? "permission_denied" : change === "connection" ? "offline" : "timeout"));
    if (change === "deadline") await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.inspections, 2); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].capability, CONTROL_CAPABILITIES.query);
  }
});
test("query and reconcile return old-epoch persisted facts, retain expiry, and never apply implicitly", async () => {
  const f = fixture();
  for (const operation of ["query", "reconcile"] as const) {
    const result = await executeControlRoute(request(operation), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport);
    assert.deepEqual(result, { fact: fact() });
  }
  assert.deepEqual(f.calls.map(c => c.capability), [CONTROL_CAPABILITIES.query, CONTROL_CAPABILITIES.reconcile]);
  f.response.data = { fact: null };
  assert.deepEqual(await executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), { fact: null });
});
test("receipt, exact operation/request/action/work and material payload injection fail closed", async () => {
  const failures = [
    { ...fact(), operation_id: "other" }, { ...fact(), request_id: "other" }, { ...fact(), action: "steer" },
    { ...fact(), work: { ...work, native_id: "other" } }, { ...fact(), principal_id: "another-owner" },
    { ...fact(), input: { text: "private" } }, { ...fact(), materials: [{ path: "/private/file" }] },
    { ...fact(), receipt: { accepted_by: "native", correlation: "stable_message_id" } },
    { ...fact(), receipt: { ...fact().receipt, locator: "file:///private" } },
    { ...fact(), delivery_status: "completed" }, { ...fact(), receipt: null },
    { ...fact(), delivery_status: "unknown" },
  ];
  for (const invalid of failures) {
    const f = fixture(); f.response.data = { fact: invalid };
    await assert.rejects(executeControlRoute(request("apply"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("invalid"));
  }
});
test("bounded saved-history provenance is preserved and never promoted to execution completion", async () => {
  const f = fixture(), stable = { ...fact(), receipt: { accepted_by: "native", native_turn_id: "turn-1", native_message_id: "item-1", correlation: "stable_message_id" }, reconciliation: {
    source: "codex.saved_history", lookup_scope: "bounded_history_pages", pages_observed: 4, history_exhausted: false, native_interface_version: "native-version", connector_epoch: "current-native-epoch", observed_at: new Date().toISOString(), native_client_message_id: "client-1", native_turn_id: "turn-1", native_message_id: "item-1",
  } };
  f.response.data = { fact: stable };
  assert.deepEqual(await executeControlRoute(request("reconcile"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), { fact: stable });
  for (const update of [{ lookup_scope: "all_history" }, { pages_observed: 5 }, { native_message_id: "other" }, { completed: true }]) {
    f.response.data = { fact: { ...stable, reconciliation: { ...stable.reconciliation, ...update } } };
    await assert.rejects(executeControlRoute(request("reconcile"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("invalid"));
  }
});
test("source failures are sanitized, envelope keys and whole output size are strict", async () => {
  const f = fixture(); f.response = { ok: false, content: [], data: { code: "offline" }, error: "TOKEN=secret /private/native" };
  await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), error => code("offline")(error) && !/TOKEN|private|secret/.test((error as Error).message));
  for (const response of [{ ok: true, content: ["private"], data: { fact: fact() } }, { ok: true, content: [], data: { fact: fact() }, native_error: "private" }, { ok: true, content: [], data: { fact: fact() }, error: "private" }]) {
    f.response = response;
    await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("invalid"));
  }
  f.response = { ok: false, content: [], data: { code: "offline" }, error: "x".repeat(CONTROL_OUTPUT_BYTES) };
  await assert.rejects(executeControlRoute(request("query"), { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport), code("too_large"));
});
test("one deadline includes admission and cancels hung exchanges; late authorization cannot invoke", async () => {
  const f = fixture();
  await assert.rejects(executeControlRoute(request("query"), { authorize: async () => { await new Promise(r => setTimeout(r, 35)); }, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport, 10), code("timeout"));
  await new Promise(r => setTimeout(r, 40)); assert.equal(f.calls.length, 0);
  for (const cancel of [false, true]) {
    const f = fixture(); f.hold = true;
    const controller = new AbortController();
    const pending = executeControlRoute({ ...request("apply"), signal: controller.signal }, { authorize: f.authorize, current: () => { if (!f.trusted) throw new CoreControlError("permission_denied"); } }, f.transport, 30);
    if (cancel) setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, code(cancel ? "cancelled" : "timeout")); assert.equal(f.aborted, 1);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].args.request?.operation_id, "operation-1");
  }
});
