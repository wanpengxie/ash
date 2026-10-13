import test from "node:test";
import assert from "node:assert/strict";
import { CollaborationCreateError, type CreateLease, type CreateProjectsLease, type CreateStageFact, type CreateWorkFact, type CreateWorkRequest } from "../src/collaboration/create-types";
import { assertCreateSourceScope, createLeaseReadContext, createPayloadHash, parseCreateEnvelope, parseCreateWorkRequest, toCreateFactDto, validateCreateResponse } from "../src/collaboration/create-protocol";

const target = { node_id: "node:one", endpoint_id: "codex", project_id: "project-real", cwd: "/work/中文/é" };
const request: CreateWorkRequest = { version: 1, request_id: "request", operation_id: "operation", authorization_revision: "a".repeat(64), target, title: "制作视频", input: { text: "明确的第一条要求" }, expires_at: 1000 };
const apply = { version: 1, request, expected_connector_epoch: "connector" };
const query = { version: 1 as const, target, authorization_revision: request.authorization_revision, operation_id: request.operation_id };
const work = { node_id: target.node_id, endpoint_id: target.endpoint_id, kind: "conversation" as const, native_id: "thread-real" };
function idle(): CreateStageFact { return { status: "not_started", attempt_id: null, owner_epoch: null, connector_epoch: null, native_interface_version: null, started_at: null, observed_at: 1, receipt: null, error_code: null }; }
function fact(): CreateWorkFact { return { version: 1, principal_id: "private-owner", request_id: request.request_id, operation_id: request.operation_id, authorization_revision: request.authorization_revision, target, payload_hash: createPayloadHash(request), expires_at: request.expires_at, status: "recorded", create: idle(), name: idle(), first_input: idle(), work: null, native_client_message_id: null, reconciliation: null, error_code: null, observed_at: 10 }; }
function accepted(stage: "create" | "name" | "first_input"): CreateStageFact {
  return { status: "accepted", attempt_id: `attempt-${stage}`, owner_epoch: "private-process", connector_epoch: "connector", native_interface_version: "v1", started_at: 2, observed_at: 3, error_code: null, receipt: stage === "first_input" ? { stage, accepted_by: "native", work, native_turn_id: "turn", native_message_id: "item", correlation: "stable_message_id" } : { stage, accepted_by: "native", work } };
}
function completed(): CreateWorkFact { return { ...fact(), work, create: accepted("create"), name: accepted("name"), first_input: accepted("first_input"), native_client_message_id: "client" }; }
function invalid(fn: () => unknown, code = "invalid") { assert.throws(fn, (e: unknown) => e instanceof CollaborationCreateError && e.code === code); }
test("strict create requests separate target from work and trusted principal", () => {
  assert.deepEqual(parseCreateEnvelope("apply", apply), apply);
  for (const patch of [{ principal: "owner" }, { caller: "owner" }, { method: "thread/start" }, { work }, { capability: "anything" }]) invalid(() => parseCreateEnvelope("apply", { ...apply, ...patch }));
  for (const patch of [{ principal_id: "owner" }, { ephemeral: true }, { native_id: "fake" }]) invalid(() => parseCreateWorkRequest({ ...request, ...patch }));
  invalid(() => parseCreateWorkRequest({ ...request, input: { text: "text", credential: "secret" } }));
  invalid(() => parseCreateWorkRequest({ ...request, target: { ...target, project_id: "" } }));
  invalid(() => parseCreateWorkRequest({ ...request, authorization_revision: "old" }));
  invalid(() => parseCreateEnvelope("apply", { ...apply, device_id: "device:one" }));
  assert.equal((parseCreateEnvelope("apply", { ...apply, device_id: "device:one" }, true) as { device_id: string }).device_id, "device:one");
  invalid(() => parseCreateEnvelope("apply", { ...apply, device_id: "one" }, true));
});
test("cwd normalization matches lexical grant rule and preserves Unicode identity", () => {
  assert.equal(parseCreateWorkRequest({ ...request, target: { ...target, cwd: "/work/a/../中文/é/" } }).target.cwd, target.cwd);
  assert.notEqual(createPayloadHash(request), createPayloadHash({ ...request, target: { ...target, cwd: "/work/中文/é" } }));
  for (const cwd of ["work/中文", "/work\u0000secret", "/work\nsecret"]) invalid(() => parseCreateWorkRequest({ ...request, target: { ...target, cwd } }));
});
test("title and total encoded envelope limits use UTF-8 bytes", () => {
  assert.equal(parseCreateWorkRequest({ ...request, title: "é".repeat(128) }).title.length, 128);
  invalid(() => parseCreateWorkRequest({ ...request, title: "é".repeat(129) }), "too_large");
  invalid(() => parseCreateWorkRequest({ ...request, title: "   " }));
  invalid(() => parseCreateEnvelope("apply", { ...apply, request: { ...request, input: { text: "x".repeat(64 * 1024) } } }), "too_large");
});
test("canonical digest binds every execution field with no text folding", () => {
  assert.equal(createPayloadHash(request), createPayloadHash({ ...request, target: { ...target, cwd: `${target.cwd}/` } }));
  for (const patch of [{ title: "other" }, { input: { text: `${request.input.text} ` } }, { expires_at: 1001 }, { authorization_revision: "b".repeat(64) }, { target: { ...target, project_id: "other" } }, { target: { ...target, cwd: "/other" } }, { request_id: "other" }]) assert.notEqual(createPayloadHash(request), createPayloadHash({ ...request, ...patch }));
});
test("query and reconcile require no pre-existing work and return no hidden fields", () => {
  for (const op of ["query", "reconcile"] as const) { assert.deepEqual(parseCreateEnvelope(op, query), query); assert.deepEqual(validateCreateResponse(op, { fact: null }, query), { fact: null }); }
  invalid(() => validateCreateResponse("apply", { fact: null }, apply as never));
  const dto = toCreateFactDto(fact()); const encoded = JSON.stringify(dto);
  for (const field of ["private-owner", "private-process", '"principal_id"', '"owner_epoch"', '"payload_hash"', '"input"', '"title"']) assert.equal(encoded.includes(field), false);
  invalid(() => validateCreateResponse("query", { fact: { ...dto, principal_id: "leak" } }, query));
  invalid(() => validateCreateResponse("query", { fact: { ...dto, create: { ...dto.create, owner_epoch: "leak" } } }, query));
});
test("stage order and durable identity forbid fabricated work or replayable unknown", () => {
  const dto = toCreateFactDto(completed()); assert.equal(dto.first_input.status, "accepted");
  invalid(() => toCreateFactDto({ ...fact(), work }));
  invalid(() => toCreateFactDto({ ...fact(), name: accepted("name") }));
  invalid(() => toCreateFactDto({ ...completed(), name: idle() }));
  invalid(() => toCreateFactDto({ ...completed(), create: { ...accepted("create"), receipt: null } }));
  invalid(() => toCreateFactDto({ ...completed(), work: { ...work, endpoint_id: "other" } }));
  invalid(() => toCreateFactDto({ ...completed(), create: accepted("name") }));
  const unknown: CreateStageFact = { ...accepted("name"), status: "unknown", receipt: null, error_code: "result_unknown" };
  const partial = toCreateFactDto({ ...fact(), work, create: accepted("create"), name: unknown }); assert.equal(partial.work?.native_id, "thread-real"); assert.equal(partial.first_input.status, "not_started");
  invalid(() => validateCreateResponse("query", { fact: { ...partial, name: { ...partial.name, error_code: null } } }, query));
  invalid(() => validateCreateResponse("query", { fact: { ...partial, name: { ...partial.name, retryable: true } } }, query));
  invalid(() => validateCreateResponse("query", { fact: { ...partial, name: { ...partial.name, status: "rejected", error_code: "result_unknown" } } }, query));
  invalid(() => toCreateFactDto({ ...completed(), native_client_message_id: null }));
});
test("responses bind operation, request, exact project, revision, and receipts", () => {
  const dto = toCreateFactDto(completed());
  for (const patch of [{ operation_id: "other" }, { authorization_revision: "b".repeat(64) }, { target: { ...target, project_id: "other" } }, { target: { ...target, cwd: `${target.cwd}/` } }]) invalid(() => validateCreateResponse("query", { fact: { ...dto, ...patch } }, query));
  for (const patch of [{ request_id: "other" }, { expires_at: 999 }]) invalid(() => validateCreateResponse("apply", { fact: { ...dto, ...patch } }, apply as never));
  invalid(() => validateCreateResponse("query", { fact: { ...dto, first_input: { ...dto.first_input, receipt: { ...dto.first_input.receipt, native_message_id: null } } } }, query));
});
test("history provenance requires complete WorkRef and stable client/turn/item/version association", () => {
  const f = completed(); f.reconciliation = { source: "codex.saved_history", lookup_scope: "bounded_history_pages", work, pages_observed: 2, history_exhausted: false, connector_epoch: "connector-after-restart", native_interface_version: "v1", observed_at: "2026-10-09T00:00:00Z", native_client_message_id: "client", native_turn_id: "turn", native_message_id: "item" };
  const dto = toCreateFactDto(f); assert.equal(dto.reconciliation?.pages_observed, 2);
  for (const patch of [{ native_client_message_id: "other" }, { native_turn_id: "other" }, { native_message_id: "other" }, { native_interface_version: "v2" }, { pages_observed: 5 }, { work: { ...work, native_id: "other" } }, { error: "secret" }]) invalid(() => validateCreateResponse("reconcile", { fact: { ...dto, reconciliation: { ...dto.reconciliation, ...patch } } }, query));
});
test("project discovery refuses incomplete, duplicate, outside-cwd and foreign responses", () => {
  const envelope = { version: 1 as const, node_id: target.node_id, endpoint_id: target.endpoint_id, cwd: target.cwd, authorization_revision: request.authorization_revision };
  const response = { target: { node_id: target.node_id, endpoint_id: target.endpoint_id, cwd: target.cwd }, authorization_revision: request.authorization_revision, connector_epoch: "connector", native_interface_version: "v1", projects: [{ project_id: "real", cwd: target.cwd }], complete: true };
  assert.deepEqual(validateCreateResponse("projects", response, envelope), response);
  for (const patch of [{ complete: false }, { projects: [...response.projects, ...response.projects] }, { projects: [{ project_id: "other", cwd: "/other" }] }, { target: { ...response.target, node_id: "other" } }, { raw: "secret" }]) invalid(() => validateCreateResponse("projects", { ...response, ...patch }, envelope));
  invalid(() => parseCreateEnvelope("projects", { ...envelope, project_id: "fake" }));
});
test("source proof binds current trusted exact grant scope, not stable foreign metadata", () => {
  const scope = { node_id: target.node_id, endpoint_id: target.endpoint_id, cwd: target.cwd };
  assertCreateSourceScope(scope, { ...scope, cwd: `${scope.cwd}/` });
  for (const patch of [{ node_id: "other" }, { endpoint_id: "other" }, { cwd: "/foreign/stable" }, { cwd: `${scope.cwd}/child` }, { cwd: "/work/中文/é" }]) {
    const stableNativeMetadata = { ...scope, ...patch };
    invalid(() => assertCreateSourceScope(scope, stableNativeMetadata), "permission_denied");
  }
});
test("lease context captures frozen grant coordinates and rechecks them across async authorization", async () => {
  const grant = { node_id: target.node_id, endpoint_id: target.endpoint_id, cwd: target.cwd };
  const lease: CreateLease = { principal: { principal_id: "trusted" }, target: { ...target }, authorized_scope: grant, authorization_revision: request.authorization_revision, connector_epoch: "connector", native_interface_version: "v1", authorize: async () => true, run: async (_purpose, fn) => fn() };
  const context = createLeaseReadContext(lease, 1000, "query");
  assert.equal(Object.isFrozen(context.authorized_scope), true);
  assert.notEqual(context.authorized_scope, grant);
  assert.equal(await context.authorize(), true);
  // A selected target is insufficient when its real grant points somewhere else.
  invalid(() => createLeaseReadContext({ ...lease, authorized_scope: { ...grant, cwd: "/foreign" } }, 1000, "query"), "permission_denied");
  grant.cwd = "/revoked-and-switched";
  await assert.rejects(context.authorize(), (e: unknown) => e instanceof CollaborationCreateError && e.code === "permission_denied");
  grant.cwd = target.cwd;
  const drifting = createLeaseReadContext({ ...lease, authorize: async () => { grant.cwd = "/changed-during-wait"; return true; } }, 1000, "query");
  await assert.rejects(drifting.authorize(), (e: unknown) => e instanceof CollaborationCreateError && e.code === "permission_denied");
});
test("discovery lease context contains no project stand-in and honors current deny", async () => {
  const scope = { node_id: target.node_id, endpoint_id: target.endpoint_id, cwd: target.cwd };
  const lease: CreateProjectsLease = { principal: { principal_id: "trusted" }, scope, authorized_scope: { ...scope }, authorization_revision: request.authorization_revision, connector_epoch: "connector", native_interface_version: "v1", authorize: async () => false, run: async fn => fn() };
  const context = createLeaseReadContext(lease, 1000, "query");
  assert.equal(Object.hasOwn(context.authorized_scope, "project_id"), false);
  assert.equal(await context.authorize(), false);
  invalid(() => createLeaseReadContext({ ...lease, scope: { ...scope, cwd: "/foreign" } }, 1000, "query"), "permission_denied");
});

test("gateway node and endpoint prefixes survive create DTO and hash binding without expanding native or request IDs", () => {
  for (const identity of ["_IJ55kaFCTFOGZzOOtezli", "-Mu8OuWwq82b9P1TpI7YNi"]) {
    const prefixed = { ...request, target: { ...target, node_id: identity, endpoint_id: identity } };
    assert.deepEqual(parseCreateWorkRequest(prefixed), prefixed);
    assert.equal((parseCreateEnvelope("apply", { ...apply, request: prefixed, device_id: `device:${identity}` }, true) as { device_id: string }).device_id, `device:${identity}`);
    assert.equal((parseCreateEnvelope("projects", { version: 1, node_id: identity, endpoint_id: identity, cwd: target.cwd, authorization_revision: request.authorization_revision }) as { node_id: string }).node_id, identity);
    assert.notEqual(createPayloadHash(prefixed), createPayloadHash({ ...prefixed, target: { ...prefixed.target, node_id: `${identity}x` } }));
    const complete = completed();
    complete.target = prefixed.target; complete.work = { ...work, node_id: identity, endpoint_id: identity };
    for (const stage of [complete.create, complete.name, complete.first_input]) if (stage.receipt) stage.receipt.work = complete.work;
    const dto = toCreateFactDto(complete); assert.equal(dto.work!.node_id, identity);
    invalid(() => parseCreateWorkRequest({ ...prefixed, request_id: "_request" }));
    invalid(() => parseCreateWorkRequest({ ...prefixed, target: { ...prefixed.target, project_id: "_project" } }));
    complete.work.native_id = "_native"; invalid(() => toCreateFactDto(complete));
    for (const bad of ["", "/node", ":node", "_".repeat(257), "-node\u0000", "_node space"]) invalid(() => parseCreateWorkRequest({ ...prefixed, target: { ...prefixed.target, node_id: bad } }));
  }
});
test("prefixed trusted scope survives factories and native source checks with async exact binding", async () => {
  for (const identity of ["_IJ55kaFCTFOGZzOOtezli", "-Mu8OuWwq82b9P1TpI7YNi"]) {
    const selected = { ...target, node_id: identity, endpoint_id: identity };
    const grant = { node_id: identity, endpoint_id: identity, cwd: target.cwd };
    const lease: CreateLease = { principal: { principal_id: "trusted" }, target: selected, authorized_scope: grant, authorization_revision: request.authorization_revision, connector_epoch: "connector", native_interface_version: "v1", authorize: async () => true, run: async (_purpose, fn) => fn() };
    const context = createLeaseReadContext(lease, 1000, "query");
    assertCreateSourceScope(context.authorized_scope, grant);
    assert.equal(await context.authorize(), true);
    assert.deepEqual(context.authorized_scope, grant);
    assert.equal(Object.isFrozen(context.authorized_scope), true);
    for (const patch of [{ node_id: `${identity}x` }, { endpoint_id: `${identity}x` }, { cwd: "/foreign/stable" }]) invalid(() => assertCreateSourceScope(context.authorized_scope, { ...grant, ...patch }), "permission_denied");
    const discovery: CreateProjectsLease = { principal: lease.principal, scope: { ...grant }, authorized_scope: grant, authorization_revision: lease.authorization_revision, connector_epoch: lease.connector_epoch, native_interface_version: lease.native_interface_version, authorize: async () => true, run: async fn => fn() };
    assert.equal(await createLeaseReadContext(discovery, 1000, "query").authorize(), true);
    const drift = createLeaseReadContext({ ...lease, authorize: async () => { selected.endpoint_id = `${identity}late`; return true; } }, 1000, "query");
    await assert.rejects(drift.authorize(), (e: unknown) => e instanceof CollaborationCreateError && e.code === "permission_denied");
  }
});
