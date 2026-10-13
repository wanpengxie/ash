import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync, symlinkSync, realpathSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireDescriptorStateLock } from "../src/collaboration/descriptor-lock";
import { AUTHORIZATION_LOCK_FILE } from "../src/collaboration/local-state-transaction";
import { ConnectionSetupService, type ConnectionSetupOptions, type ScopeSelection } from "../src/setup/service";
import { SetupError, SetupScopeStore } from "../src/setup/scope-settings";
import { loadReadAuthorization } from "../src/collaboration/authorization";
import { loadControlAuthorization } from "../src/collaboration/control-authorization";

function fixture(t: { after(fn: () => void): void }, overrides: Partial<ConnectionSetupOptions> = {}) {
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "ash-setup-")));
  writeFileSync(join(stateDir, "paired.json"), JSON.stringify({ owner_key: Buffer.from("owner").toString("base64url") }));
  let epoch = "1", released = 0;
  const options: ConnectionSetupOptions = { stateDir, endpointId: "codex", observationEpoch: () => epoch,
    testing:{allowBooleanVerification:true,readBinding:{source_id:'fixture-source',binding_revision:'a'.repeat(64)}},verification: { verifyScope: async () => true, diagnostics: async () => ({ readCapability: "verified", login: "unknown" }) },
    runtime: { reserveChange: async () => ({ assertCurrent: () => undefined, release: () => { released++; return undefined; } }) }, ...overrides };
  const service = new ConnectionSetupService(options);
  t.after(() => { service.close(); rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, options, service, setEpoch: (value: string) => { epoch = value; }, released: () => released };
}
const read: ScopeSelection = { kind: "read", allowedCwds: ["/project/a"] };
const denied = (code: string) => (error: unknown) => error instanceof SetupError && error.code === code;

test("explicit read selection produces compatible private file and no control grant", async t => {
  const f = fixture(t), before = await f.service.status();
  assert.equal(before.diagnostics.readGrant, "missing");
  const after = await f.service.applyScope(read, before.precondition!);
  assert.equal(after.diagnostics.controlGrant, "missing");
  assert.deepEqual(loadReadAuthorization(f.stateDir, "codex").allowedCwds, ["/project/a"]);
  assert.equal(statSync(join(f.stateDir, "collaboration-read.json")).mode & 0o777, 0o600);
  assert.equal(f.released(), 1);
  assert.equal(readdirSync(f.stateDir).some(n => n.includes(".tmp")), false);
});
test("control exact scope is separate; create cannot use a single work", async t => {
  const f = fixture(t), before = await f.service.status();
  await f.service.applyScope({ kind: "control", allowedActions: ["send_input", "create_work"], scope: { kind: "exact_cwd", cwd: "/project/a" } }, before.precondition!);
  const c = loadControlAuthorization(f.stateDir, "codex");
  assert.equal(c.config?.owner_id, before.precondition!.ownerId);
  assert.equal(loadReadAuthorization(f.stateDir, "codex").state, "scope_required");
  const status = await f.service.status();
  await assert.rejects(f.service.previewScope({ kind: "control", allowedActions: ["create_work"], scope: { kind: "single_work", work: { node_id: "node", endpoint_id: "codex", kind: "conversation", native_id: "work" } } }, status.precondition!), denied("invalid"));
});
test("without injected native verification or runtime, setup never grants", async t => {
  const f = fixture(t, { verification: undefined, runtime: undefined });
  const status = await f.service.status();
  assert.equal(status.diagnostics.login, "unknown");
  assert.equal(status.diagnostics.controlCapability, "unknown");
  await assert.rejects(f.service.previewScope(read, status.precondition!), denied("unavailable"));
  await assert.rejects(f.service.applyScope(read, status.precondition!), denied("unavailable"));
  assert.deepEqual(readdirSync(f.stateDir), ["paired.json"]);
});
test("revocation during native await fences result and write", async t => {
  const f = fixture(t);
  f.options.verification!.verifyScope = async () => { writeFileSync(join(f.stateDir, "paired.json"), JSON.stringify({ owner_key: Buffer.from("owner").toString("base64url"), revoked: true })); return true; };
  const before = await f.service.status();
  await assert.rejects(f.service.applyScope(read, before.precondition!), denied("unpaired"));
  assert.equal(f.released(), 1);
  assert.equal(readdirSync(f.stateDir).includes("collaboration-read.json"), false);
});
test("watch epoch prevents owner/grant ABA even when bytes are restored", async t => {
  const f = fixture(t), before = await f.service.status();
  f.options.verification!.verifyScope = async () => { f.setEpoch("3"); return true; };
  await assert.rejects(f.service.applyScope(read, before.precondition!), denied("stale"));
});
test("a stale concurrent form cannot overwrite a new grant", async t => {
  const f = fixture(t), before = await f.service.status();
  await f.service.applyScope(read, before.precondition!);
  await assert.rejects(f.service.applyScope({ kind: "read", allowedCwds: ["/project/b"] }, before.precondition!), denied("stale"));
  assert.deepEqual(loadReadAuthorization(f.stateDir, "codex").allowedCwds, ["/project/a"]);
});
test("symlink configuration and state directory fail closed", async t => {
  const f = fixture(t), target = join(f.stateDir, "target");
  writeFileSync(target, "secret"); symlinkSync(target, join(f.stateDir, "collaboration-read.json"));
  await assert.rejects(f.service.status(), denied("storage"));
  assert.equal(readFileSync(target, "utf8"), "secret");
  const alias = join(f.stateDir, "alias"); symlinkSync(f.stateDir, alias);
  assert.throws(() => new ConnectionSetupService({ ...f.options, stateDir: alias }), denied("storage"));
});
test("lock and runtime busy errors are bounded and do not modify config", async t => {
  const f = fixture(t), before = await f.service.status();
  writeFileSync(join(f.stateDir, AUTHORIZATION_LOCK_FILE), "", { mode: 0o600 });
  const lock = acquireDescriptorStateLock(f.stateDir);
  try { await assert.rejects(f.service.applyScope(read, before.precondition!), denied("busy")); } finally { lock.release(); }
  f.options.runtime = { reserveChange: async () => { throw new Error("token=secret body=chat"); } };
  await assert.rejects(f.service.applyScope(read, before.precondition!), e => denied("busy")(e) && !(e as Error).message.includes("secret"));
});
test("diagnostics whitelist drops credential/body fields, probe failures reveal no details", async t => {
  const f = fixture(t);
  f.options.verification!.diagnostics = async () => ({ installation: "verified", login: "signed_in", readCapability: "verified", token: "secret", body: "chat", allconfig: { key: "secret" } } as never);
  const status = await f.service.status();
  assert.equal(status.diagnostics.controlCapability, "unknown");
  assert.equal(JSON.stringify(status).includes("secret"), false);
  f.options.verification!.diagnostics = async () => { throw new Error("secret"); };
  assert.equal((await f.service.status()).diagnostics.installation, "unknown");
});
test("revoke removes only explicitly chosen grant and invalidates stale form", async t => {
  const f = fixture(t), before = await f.service.status();
  const next = await f.service.applyScope(read, before.precondition!);
  const after = await f.service.revoke("read", next.precondition!);
  assert.equal(after.diagnostics.readGrant, "missing");
  await assert.rejects(f.service.applyScope(read, next.precondition!), denied("stale"));
});
test("oversized configuration is rejected before JSON parsing", t => {
  const f = fixture(t); writeFileSync(join(f.stateDir, "collaboration-control.json"), "x".repeat(65537));
  assert.throws(() => new SetupScopeStore(f.options).snapshot(), denied("storage"));
});
test("caller mutation during reserve cannot retarget selected cwd", async t => {
  const f = fixture(t), selection: ScopeSelection = { kind: "read", allowedCwds: ["/original"] };
  const expected = (await f.service.status()).precondition!;
  f.options.runtime = { reserveChange: async () => {
    selection.allowedCwds[0] = "/retargeted";
    expected.ownerId = "mutated"; expected.epoch = "mutated";
    return { assertCurrent: () => undefined, release: () => undefined };
  } };
  await f.service.applyScope(selection, expected);
  assert.deepEqual(loadReadAuthorization(f.stateDir, "codex").allowedCwds, ["/original"]);
});
test("caller mutation during verification cannot swap current owner/precondition", async t => {
  const f = fixture(t), expected = (await f.service.status()).precondition!;
  f.options.verification!.verifyScope = async () => {
    writeFileSync(join(f.stateDir, "paired.json"), JSON.stringify({ owner_key: Buffer.from("new-owner").toString("base64url") }));
    const next = new SetupScopeStore(f.options).snapshot().precondition!;
    Object.assign(expected, next);
    return true;
  };
  await assert.rejects(f.service.applyScope(read, expected), denied("stale"));
  assert.equal(readdirSync(f.stateDir).includes("collaboration-read.json"), false);
});
test("owner change while runtime reservation awaits cannot be masked by caller mutation", async t => {
  const f = fixture(t), expected = (await f.service.status()).precondition!;
  f.options.runtime = { reserveChange: async () => {
    writeFileSync(join(f.stateDir, "paired.json"), JSON.stringify({ owner_key: Buffer.from("new-owner").toString("base64url") }));
    Object.assign(expected, new SetupScopeStore(f.options).snapshot().precondition!);
    return { assertCurrent: () => undefined, release: () => undefined };
  } };
  await assert.rejects(f.service.applyScope(read, expected), denied("stale"));
});
test("asynchronous or throwing currentness fences fail closed and redact errors", async t => {
  const f = fixture(t), expected = (await f.service.status()).precondition!;
  f.options.runtime = { reserveChange: async () => ({ assertCurrent: (() => Promise.resolve()) as never, release: () => undefined }) };
  await assert.rejects(f.service.applyScope(read, expected), denied("unavailable"));
  f.options.runtime = { reserveChange: async () => ({ assertCurrent: () => { throw new Error("secret"); }, release: () => undefined }) };
  await assert.rejects(f.service.applyScope(read, expected), e => denied("busy")(e) && !(e as Error).message.includes("secret"));
});

test("a boolean verifier is refused without explicit fixture-only opt-in",async t=>{
 const f=fixture(t,{testing:undefined}),status=await f.service.status();
 await assert.rejects(f.service.previewScope(read,status.precondition!),denied('unavailable'));
 await assert.rejects(f.service.applyScope(read,status.precondition!),denied('unavailable'));
 assert.equal(loadReadAuthorization(f.stateDir,'codex').allowedCwds.length,0);assert.equal(f.released(),1);
});
