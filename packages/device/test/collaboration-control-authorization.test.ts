import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlAuthorization, controlAuthorizationPath, controlAuthorizationSnapshot, loadControlAuthorization, parseControlAuthorization, type ControlAuthorizationConfig } from "../src/collaboration/control-authorization";
import { CollaborationControlError } from "../src/collaboration/control-types";
import type { WorkRef } from "../src/collaboration/types";
const target: WorkRef = { node_id: "node", endpoint_id: "endpoint", kind: "conversation", native_id: "thread" };
const grant = (): ControlAuthorizationConfig => ({ version: 1, owner_id: "owner", endpoint_id: "endpoint", authorization_generation: 1, allowed_actions: ["send_input", "steer"], scope: { kind: "exact_cwd", cwd: "/projects/team" }, expires_at: 2000 });
const denied = (e: unknown) => e instanceof CollaborationControlError && e.code === "permission_denied";
function fixture() {
  let config: unknown = grant(); let owner: string | null = "owner"; let paired = true; let now = 1000;
  let metadata = { work: { ...target }, cwd: "/projects/team" };
  let lookup = async () => metadata;
  const auth = new ControlAuthorization({ nodeId: "node", endpointId: "endpoint", pinnedOwnerId: () => owner, authorization: () => controlAuthorizationSnapshot(config, "endpoint"), now: () => now, metadata: () => lookup() });
  const context = { transportOwnerId: "owner", isCurrent: () => paired };
  const binding = () => ({ endpoint_id: "endpoint", authorization_revision: controlAuthorizationSnapshot(config, "endpoint").authorization_revision!, work: { ...target }, action: "send_input" as const });
  return { auth, context, binding, setConfig: (v: unknown) => { config = v; }, setOwner: (v: string | null) => { owner = v; }, unpair: () => { paired = false; }, setTime: (v: number) => { now = v; }, setMetadata: (v: typeof metadata) => { metadata = v; }, setLookup: (v: typeof lookup) => { lookup = v; } };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test("strict schema and canonical revision include every control permission", () => {
  const g = grant(); const a = controlAuthorizationSnapshot(g, "endpoint");
  const b = controlAuthorizationSnapshot({ ...g, allowed_actions: ["steer", "send_input"], scope: { cwd: "/projects/team/../team", kind: "exact_cwd" } }, "endpoint");
  assert.equal(a.authorization_revision, b.authorization_revision);
  for (const changed of [{ owner_id: "other" }, { allowed_actions: ["steer"] }, { expires_at: 3000 }, { authorization_generation: 2 }, { scope: { kind: "exact_cwd", cwd: "/other/team" } }]) assert.notEqual(controlAuthorizationSnapshot({ ...g, ...changed }, "endpoint").authorization_revision, a.authorization_revision);
  for (const changed of [{ version: 2 }, { endpoint_id: "other" }, { owner_id: "" }, { allowed_actions: ["arbitrary"] }, { allowed_actions: ["steer", "steer"] }, { expires_at: 1.2 }, { scope: { kind: "exact_cwd", cwd: "/projects/team", extra: true } }, { scope: { kind: "exact_cwd", cwd: "team" } }, { caller: "owner" }]) assert.throws(() => parseControlAuthorization({ ...g, ...changed }, "endpoint"));
  assert.equal(controlAuthorizationSnapshot({ version: 1, endpoint_id: "endpoint", authorization_generation: 1, allowedCwds: ["/projects/team"] }, "endpoint").state, "invalid_configuration");
});
test("default deny and read scope cannot install control permission", async () => {
  const f = fixture(); const binding = f.binding();
  f.setConfig(null); await assert.rejects(f.auth.begin(f.context, binding), denied);
  f.setConfig({ version: 1, endpoint_id: "endpoint", authorization_generation: 1, allowedCwds: ["/projects/team"] }); await assert.rejects(f.auth.begin(f.context, binding), denied);
});
test("fixed pinned owner, endpoint and full native WorkRef are required", async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => f.setOwner("other"), (f: ReturnType<typeof fixture>) => f.unpair(), (f: ReturnType<typeof fixture>) => f.setConfig({ ...grant(), owner_id: "other" })]) {
    const f = fixture(); mutate(f); await assert.rejects(f.auth.begin(f.context, f.binding()), denied);
  }
  const f = fixture(); await assert.rejects(f.auth.begin(undefined, f.binding()), denied);
  await assert.rejects(f.auth.begin({ ...f.context, transportOwnerId: "other" }, f.binding()), denied);
  for (const work of [{ ...target, node_id: "other" }, { ...target, endpoint_id: "other" }]) await assert.rejects(f.auth.begin(f.context, { ...f.binding(), work }), denied);
  await assert.rejects(f.auth.begin(f.context, { ...f.binding(), endpoint_id: "other" }), denied);
  f.setMetadata({ work: { ...target, native_id: "other" }, cwd: "/projects/team" }); await assert.rejects(f.auth.begin(f.context, f.binding()), denied);
});
test("native cwd recheck rejects same-name, child, similar and moved directories", async () => {
  const f = fixture(); const lease = await f.auth.begin(f.context, f.binding());
  for (const cwd of ["/other/team", "/projects/team/child", "/projects/teams", "team"]) { f.setMetadata({ work: target, cwd }); assert.equal(await lease.check("invoke"), false); }
  f.setMetadata({ work: target, cwd: "/projects/team" }); assert.equal(await lease.check("invoke"), true);
});
test("single work grant binds all four identity fields, never just thread ID", async () => {
  const f = fixture(); f.setConfig({ ...grant(), scope: { kind: "single_work", work: target } });
  assert.equal(await (await f.auth.begin(f.context, f.binding())).check("query"), true);
  for (const changed of [{ node_id: "other" }, { endpoint_id: "other" }, { native_id: "other" }]) await assert.rejects(f.auth.begin(f.context, { ...f.binding(), work: { ...target, ...changed } }), denied);
  assert.equal(controlAuthorizationSnapshot({ ...grant(), allowed_actions: ["create_work"], scope: { kind: "single_work", work: target } }, "endpoint").state, "invalid_configuration");
});
test("expiry and reused generation scope changes invalidate old requests", async () => {
  const f = fixture(); const old = f.binding(); const lease = await f.auth.begin(f.context, old);
  f.setConfig({ ...grant(), scope: { kind: "exact_cwd", cwd: "/other/team" } });
  assert.equal(await lease.check("invoke"), false); await assert.rejects(f.auth.begin(f.context, old), denied);
  f.setConfig(grant()); f.setTime(2000); await assert.rejects(f.auth.begin(f.context, old), denied);
});
test("revocation before invoke denies without execution; query never reveals saved receipt", async () => {
  const f = fixture(); const lease = await f.auth.begin(f.context, f.binding()); let calls = 0;
  f.setConfig(null);
  await assert.rejects(lease.run("invoke", async () => { calls++; return "receipt"; }), denied);
  await assert.rejects(lease.run("query", async () => { calls++; return "saved receipt"; }), denied);
  assert.equal(calls, 0);
});
test("revocation after invocation suppresses late receipt, without claiming execution rollback", async () => {
  const f = fixture(); const lease = await f.auth.begin(f.context, f.binding()); const reply = deferred<string>(); const invoked = deferred<void>(); let calls = 0;
  const pending = lease.run("invoke", () => { calls++; invoked.resolve(); return reply.promise; });
  await invoked.promise; f.setConfig(null); reply.resolve("sensitive receipt");
  await assert.rejects(pending, denied); assert.equal(calls, 1);
});
test("hung old reply cannot escape replacement grant; new lease is unaffected", async () => {
  const f = fixture(); const old = await f.auth.begin(f.context, f.binding()); const reply = deferred<string>(); const invoked = deferred<void>();
  const pending = old.run("query", () => { invoked.resolve(); return reply.promise; }); await invoked.promise;
  f.setConfig({ ...grant(), scope: { kind: "exact_cwd", cwd: "/other/team" } }); f.setMetadata({ work: target, cwd: "/other/team" });
  const replacement = await f.auth.begin(f.context, f.binding()); assert.equal(await replacement.run("query", async () => "new receipt"), "new receipt");
  reply.resolve("old receipt"); await assert.rejects(pending, denied); assert.equal(await replacement.check("query"), true);
});
test("transport revoked during metadata, invoke or saved receipt query fails closed", async () => {
  const f = fixture(); const wait = deferred<{ work: WorkRef; cwd: string }>(); f.setLookup(() => wait.promise);
  const pending = f.auth.begin(f.context, f.binding()); f.unpair(); wait.resolve({ work: target, cwd: "/projects/team" }); await assert.rejects(pending, denied);
  const g = fixture(); const lease = await g.auth.begin(g.context, g.binding());
  await assert.rejects(lease.run("query", async () => { g.setOwner("other"); return "private"; }), denied);
});
test("explicit invalidation fences revoke-restore and copying prevents request mutation", async () => {
  const f = fixture(); const binding = f.binding(); const lease = await f.auth.begin(f.context, binding); binding.work.native_id = "other";
  assert.equal(await lease.check("invoke"), true); f.auth.invalidate(); assert.equal(await lease.check("query"), false);
});
test("file loader uses separate control path, bounded bytes and fail-closed configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-control-grant-"));
  try {
    assert.equal(loadControlAuthorization(dir, "endpoint").state, "grant_required");
    writeFileSync(join(dir, "collaboration-read.json"), JSON.stringify(grant())); assert.equal(loadControlAuthorization(dir, "endpoint").state, "grant_required");
    writeFileSync(controlAuthorizationPath(dir), JSON.stringify(grant())); assert.equal(loadControlAuthorization(dir, "endpoint").state, "ready");
    writeFileSync(controlAuthorizationPath(dir), "{"); assert.equal(loadControlAuthorization(dir, "endpoint").state, "invalid_configuration");
    writeFileSync(controlAuthorizationPath(dir), " ".repeat(65 * 1024)); assert.equal(loadControlAuthorization(dir, "endpoint").state, "invalid_configuration");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("J authorize hook rejects cross-principal queries, changed full targets and changed actions", async () => {
  const f = fixture(); const lease = await f.auth.begin(f.context, f.binding());
  assert.equal(await lease.authorize({ principal_id: "owner" }, target, "send_input", "query"), true);
  assert.equal(await lease.authorize({ principal_id: "other" }, target, "send_input", "query"), false);
  for (const changed of [{ node_id: "other" }, { endpoint_id: "other" }, { native_id: "other" }]) assert.equal(await lease.authorize(lease.principal, { ...target, ...changed }, "send_input", "query"), false);
  assert.equal(await lease.authorize(lease.principal, target, "steer", "invoke"), false);
  f.setConfig(null); assert.equal(await lease.authorize(lease.principal, target, "send_input", "query"), false);
});
