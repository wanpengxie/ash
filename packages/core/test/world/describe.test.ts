import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { WordSpec } from "../../../sdk/src/api";
import { DeviceMember } from "../../src/members/device";
import { Ledger } from "../../src/world/ledger";
import { type Member, WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type DeviceCapability, type TrustedRouteContext } from "../../src/world/router";
import { checkRepository, checkTree } from "../arch/checks";
import { wordContract } from "../../../sdk/src/words";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: false };
const agent: TrustedRouteContext = { transport: "agent", transportPrincipal: "main", member: "agent:main", local: true, remote: false, ownerProxy: false };
const schema = { type: "object" as const, properties: { n: { type: "integer" as const } }, required: ["n"], additionalProperties: false };
const word = (name: string, audience: WordSpec["audience"] = "all"): WordSpec => ({ word: name, kind: "request", description: `Use ${name} for a synthetic task.`, input_schema: structuredClone(schema), result_schema: { type: "object", additionalProperties: true }, audience });
const capability = (name: string): DeviceCapability => ({ name, description: `Use ${name} on the test device.`, label: "Testing device", risk: "none", input_schema: structuredClone(schema) });
const request = (to: string, name: string, n = 1) => ({ to, kind: "request" as const, word: name, body: { n }, wait: true });
const isNotFound = (error: unknown) => error instanceof RouterError && error.code === "not_found";

async function fixture() {
  const ledger = await Ledger.open(join(mkdtempSync(join(tmpdir(), "ash-members-")), "ledger.db"));
  const router = new WorldRouter(ledger, async () => true);
  return { ledger, router, members: new WorldMembers(router) };
}

test("describe uses exact audience filters, including hidden-only indistinguishable from unknown", async () => {
  const { ledger, router, members } = await fixture();
  try {
    const specs = [word("shared"), word("owner_only", "owner"), word("agent_only", "agent")];
    const member: Member = { id: "service:test", kind: "service", name: "Test service", online: true, words: () => specs, handle: () => ({ ok: true, result: {} }) };
    members.register(member);
    members.register({ id: "service:secret", kind: "service", name: "Secret service", words: () => [word("hidden", "owner")], handle: () => ({ ok: true }) });
    specs[0].description = "MUTATED";
    member.name = "MUTATED";
    assert.deepEqual(members.describe("agent").members.map((m) => [m.id, m.words]), [["service:test", ["agent_only", "shared"]]]);
    assert.deepEqual(members.describe("owner").members.map((m) => m.id), ["service:secret", "service:test"]);
    const detail = members.describe("agent", "service:test").members[0];
    assert.equal(detail.name, "Test service");
    assert.deepEqual(detail.words.map((w) => w.word), ["shared", "agent_only"]);
    assert.equal(JSON.stringify(detail).includes("owner_only"), false);
    detail.words[0].description = "MUTATED RETURN";
    detail.name = "MUTATED RETURN";
    assert.equal(members.describe("agent", "service:test").members[0].words[0].description, "Use shared for a synthetic task.");
    for (const id of ["service:secret", "service:unknown"]) assert.throws(() => members.describe("agent", id), isNotFound);
    // Visibility is not authorization: a hidden word is still subject to router policy, not this view filter.
    const sent = await router.send(agent, request("service:test", "owner_only"));
    assert.equal(sent.reply?.body.ok, true);
  } finally { ledger.close(); }
});

test("static batch preflight rejects invalid second schema and duplicate without publishing first", async () => {
  const { ledger, router, members } = await fixture();
  try {
    const malformed = word("bad");
    malformed.input_schema = { type: "object", properties: { optional: { type: "string", ...({ minLength: -1 } as object) } } };
    assert.throws(() => members.register({ id: "service:bad", kind: "service", name: "Bad", words: () => [word("first"), malformed], handle: () => ({ ok: true }) }), /schema|length|integer|minimum/i);
    assert.throws(() => members.describe("owner", "service:bad"), isNotFound);
    await assert.rejects(router.send(owner, request("service:bad", "first")), isNotFound);
    assert.equal(ledger.lastSeq(), 0);
    assert.throws(() => members.register({ id: "service:duplicate", kind: "service", name: "Duplicate", words: () => [word("same"), word("same")], handle: () => ({ ok: true }) }), /duplicate/);
    assert.throws(() => members.describe("owner", "service:duplicate"), isNotFound);
    members.register({ id: "service:existing", kind: "service", name: "Existing", words: () => [word("same")], handle: () => ({ ok: true, result: { source: "original" } }) });
    assert.throws(() => members.register({ id: "service:existing", kind: "service", name: "Replacement", words: () => [word("new")], handle: () => ({ ok: true }) }), /duplicate/);
    const sent = await router.send(owner, request("service:existing", "same"));
    assert.deepEqual(sent.reply?.body.result, { source: "original" });
    await assert.rejects(router.send(owner, request("service:existing", "new")), isNotFound);
  } finally { ledger.close(); }
});

test("device batch is atomic; online changes only runtime state, and offline sends settle in ledger", async () => {
  const { ledger, router, members } = await fixture();
  try {
    let effects = 0;
    const execute = () => { effects++; return { ok: true as const, result: { n: effects } }; };
    const bad = capability("bad");
    bad.input_schema = { type: "object", properties: { n: { $ref: "https://example.invalid/remote" } } };
    const broken = new DeviceMember("device:broken", "Broken", [capability("first"), bad], execute);
    assert.throws(() => members.registerDevice(broken), /resolve reference/);
    assert.throws(() => members.describe("owner", "device:broken"), isNotFound);
    await assert.rejects(router.send(owner, request("device:broken", "first")), isNotFound);
    const duplicate = new DeviceMember("device:duplicate", "Duplicate", [capability("same"), capability("same")], execute);
    assert.throws(() => members.registerDevice(duplicate), /duplicate/);
    assert.throws(() => members.describe("owner", "device:duplicate"), isNotFound);
    const initial = capability("run");
    const device = new DeviceMember("device:test", "Test device", [initial], execute);
    members.registerDevice(device);
    initial.description = "MUTATED";
    assert.equal(members.describe("agent", "device:test").members[0].words[0].description, "Use run on the test device.");
    assert.equal(members.describe("agent", "device:test").members[0].online, true);
    const first = await router.send(owner, request("device:test", "run"));
    assert.equal(first.reply?.body.ok, true);
    device.setOnline(false);
    assert.equal(members.describe("agent", "device:test").members[0].online, false);
    assert.deepEqual(members.describe("agent").members.find((m) => m.id === "device:test")?.words, ["run"]);
    const offline = await router.send(owner, request("device:test", "run"));
    assert.equal(offline.reply?.body.ok, false);
    assert.equal((offline.reply?.body.error as { code: string }).code, "offline");
    assert.equal(offline.reply?.reply_to, offline.id);
    assert.equal(effects, 1);
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 2);
    device.setOnline(true);
    const resumed = await router.send(owner, request("device:test", "run"));
    assert.equal(resumed.reply?.body.ok, true);
    assert.equal(effects, 2);
  } finally { ledger.close(); }
});

test("router batch snapshots cannot be changed through source or returned specifications", async () => {
  const { ledger, router } = await fixture();
  try {
    const original = word("one");
    const exposed = router.registerBatch([{ member: "service:snapshot", spec: original, handle: () => ({ ok: true, result: {} }) }]);
    original.description = "Changed source";
    exposed[0].description = "Changed return";
    (exposed[0].input_schema as { required: string[] }).required.push("impossible");
    const sent = await router.send(owner, request("service:snapshot", "one"));
    assert.equal(sent.reply?.body.ok, true);
    assert.throws(() => router.registerBatch([
      { member: "service:other", spec: word("first"), handle: () => ({ ok: true }) },
      { member: "service:snapshot", spec: word("one"), handle: () => ({ ok: true }) },
    ]), /duplicate/);
    await assert.rejects(router.send(owner, request("service:other", "first")), isNotFound);
    const cap = capability("run");
    const deviceSpecs = router.registerDeviceBatch("device:snapshot", [cap], () => ({ ok: true, result: {} }));
    cap.description = "Changed source";
    deviceSpecs[0].description = "Changed return";
    (deviceSpecs[0].input_schema as { required: string[] }).required.push("impossible");
    const device = await router.send(owner, request("device:snapshot", "run"));
    assert.equal(device.reply?.body.ok, true);
  } finally { ledger.close(); }
});

test("an outbound status contract cannot become an inbound member word", async () => {
  const { ledger, router, members } = await fixture();
  try {
    const status = wordContract("agent:main", "status")!;
    assert.equal(status.direction, "out");
    assert.throws(() => members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [word("first"), status], handle: () => ({ ok: true }) }), /outbound/);
    assert.throws(() => members.describe("owner", "agent:main"), isNotFound);
    await assert.rejects(router.send(owner, request("agent:main", "first")), isNotFound);
    assert.equal(ledger.lastSeq(), 0);
    // Direct router registration also preserves the contract's declared outbound direction.
    router.register({ member: "agent:main", spec: status, handle: () => ({ ok: true }) });
    await assert.rejects(router.send(owner, { to: "agent:main", kind: "event", word: "status", body: { state: "idle", text: "" } }), (error: unknown) => error instanceof RouterError && error.code === "forbidden");
    assert.equal(ledger.lastSeq(), 0);
  } finally { ledger.close(); }
});

test("AR1 examines the real device adapter and rejects cross-member imports", () => {
  const root = resolve(import.meta.dirname, "../../../..");
  assert.deepEqual(checkRepository(root).filter((f) => f.rule === "AR1"), []);
  const violation = { "packages/core/src/members/device.ts": 'import "./self";', "packages/core/src/members/self.ts": "export const self = true;" };
  assert.equal(checkTree(violation).filter((f) => f.rule === "AR1").length, 1);
});
