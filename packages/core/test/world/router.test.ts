import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import type { WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-login", member: "person:owner", local: true, remote: false, ownerProxy: false };
const agent: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false };
const phone: TrustedRouteContext = { transport: "phone", transportPrincipal: "paired-phone", member: "device:phone", pairedDeviceId: "paired-phone", local: false, remote: true, ownerProxy: true };
const screen: TrustedRouteContext = { transport: "web_ui", transportPrincipal: "owner-login", member: "person:owner", local: false, remote: true, ownerProxy: true, screenId: "screen:tab_a", screenLabel: "Tab A" };
const spec = (word: string, risk: WordSpec["risk"] = "none", timeout_ms = 500): WordSpec => ({ word, kind: "request", description: "Synthetic test word", risk, timeout_ms,
  input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
  result_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } });
const request = (to = "device:fake", word = "run", n = 1) => ({ to, kind: "request" as const, word, body: { n } });
const code = (code: string) => (error: unknown) => error instanceof RouterError && error.code === code;
async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "ash-router-")), "ash.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  return { file, ledger, router };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test("request/reply, stable client retry, and atomic one-response pairing", async () => {
  const { ledger, router } = await setup();
  try {
    let calls = 0;
    router.register({ member: "device:fake", spec: spec("run"), handle: async () => { calls++; return { ok: true, result: { value: 7 } }; } });
    const sent = await router.send(owner, { ...request(), wait: true, client_id: "one" });
    assert.equal(sent.reply?.body.ok, true);
    assert.equal(sent.reply?.reply_to, sent.id);
    assert.equal(sent.reply?.from, "device:fake");
    assert.equal(sent.reply?.to, "person:owner");
    const again = await router.send(owner, { ...request(), wait: true, client_id: "one" });
    assert.equal(again.id, sent.id);
    assert.equal(again.reply?.id, sent.reply?.id);
    assert.equal(calls, 1);
    assert.equal(ledger.trackedRequests().length, 0);
    await assert.rejects(router.send(owner, { ...request("device:fake", "run", 2), client_id: "one" }), code("bad_request"));
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 1);
  } finally { ledger.close(); }
});

test("response ACK loss retries the same durable answer after restart without a second terminal", async () => {
  const { file, ledger, router } = await setup();
  const ask = wordContract("person:owner", "ask")!;
  const question = { to: "person:owner", kind: "request" as const, word: "ask", body: { title: "Approve?", detail: "Synthetic", options: [{ id: "once", label: "Only now" }, { id: "deny", label: "No" }], expires_at: Date.now() + 60_000, source: { word: "run", to: "device:fake", body_preview: "Synthetic" } } };
  const answer = { to: "agent:main", kind: "response" as const, word: "ask", body: { ok: true, result: { choice: "once" } }, client_id: "approval-ack-lost", reply_to: "" };
  let received: { id: string; seq: number };
  try {
    router.register({ member: "person:owner", spec: ask, handle: () => undefined });
    const sent = await router.send(agent, question);
    answer.reply_to = sent.id;
    received = await router.send(screen, answer);
    assert.equal(ledger.responseTo(sent.id)?.id, received.id);
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 1);
  } finally { ledger.close(); }
  const reopened = await Ledger.open(file);
  const restarted = new WorldRouter(reopened, async () => true);
  try {
    // The lost HTTP acknowledgement must not become a second approval or a false rejection.
    assert.deepEqual(await restarted.send(screen, { ...answer, body: { ok: true, result: { choice: "once" } } }), received);
    await assert.rejects(restarted.send(screen, { ...answer, body: { ok: true, result: { choice: "deny" } } }), code("bad_request"));
    await assert.rejects(restarted.send(screen, { ...answer, client_id: "new-attempt" }), code("bad_request"));
    await assert.rejects(restarted.send(screen, { ...answer, client_id: undefined }), code("bad_request"));
    await assert.rejects(restarted.send(owner, answer), code("forbidden"));
    await assert.rejects(restarted.send({ ...screen, transportPrincipal: "revoked-other-principal" }, answer), code("bad_request"));
    assert.equal(reopened.list().filter((m) => m.kind === "response").length, 1);
  } finally { reopened.close(); }
});

test("unknown word and malformed device schema/body fail before ledger or device", async () => {
  const { ledger, router } = await setup();
  try {
    let calls = 0;
    router.registerDevice("device:fake", { name: "run", description: "Synthetic", label: "Testing", risk: "none", input_schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { when: { type: "string", format: "date-time" }, value: { oneOf: [{ type: "integer", minimum: 2 }, { type: "string", minLength: 3 }] } }, required: ["when", "value"], additionalProperties: false }, result_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } }, () => { calls++; return { ok: true, result: { ok: true } }; });
    await assert.rejects(router.send(owner, request("device:missing")), code("not_found"));
    await assert.rejects(router.send(owner, { ...request(), body: { when: "bad", value: 1 } }), code("bad_request"));
    await assert.rejects(router.send(owner, { ...request(), body: { when: "2026-10-01T00:00:00Z", value: "x" } }), code("bad_request"));
    assert.equal(calls, 0); assert.equal(ledger.lastSeq(), 0);
    const good = await router.send(owner, { ...request(), body: { when: "2026-10-01T00:00:00Z", value: 2 }, wait: true });
    assert.equal(good.reply?.body.ok, true); assert.equal(calls, 1);
    assert.throws(() => router.registerDevice("device:other", { name: "bad", description: "Synthetic", label: "Testing", risk: "none", input_schema: { $schema: "https://evil.example/schema", type: "object" } }, () => undefined), /dialect/);
    assert.throws(() => router.registerDevice("device:other", { name: "bad", description: "Synthetic", label: "Testing", risk: "none", input_schema: { type: "object", properties: { x: { $ref: "https://evil.example/schema" } } } }, () => undefined), /resolve reference/);
  } finally { ledger.close(); }
});

test("timeout and cancellation settle immediately; ignored abort cannot publish late success", async () => {
  const { ledger, router } = await setup();
  try {
    let release!: (value: { ok: true; result: { value: number } }) => void;
    let cancelled = 0;
    const notices: string[] = [];
    router.subscribe((m) => notices.push(`${m.kind}:${m.word}:${m.body.ok ?? ""}`));
    router.register({ member: "device:fake", spec: spec("run", "none", 5000), handle: () => new Promise((resolve) => { release = resolve; }), cancel: () => { cancelled++; } });
    const sent = await router.send(owner, request());
    assert.equal(typeof release, "function", "cancellation exercise must have an in-flight device effect");
    const start = performance.now();
    const cancelledMessages = router.cancel([sent.id, sent.id]);
    assert.ok(performance.now() - start < 1000);
    assert.equal(cancelledMessages.length, 1);
    assert.equal(cancelledMessages[0].body.ok, false);
    assert.equal((cancelledMessages[0].body.error as { code: string }).code, "cancelled");
    assert.equal(cancelled, 1);
    release({ ok: true, result: { value: 9 } });
    await tick();
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 1);
    assert.equal(notices.filter((n) => n.startsWith("response:")).length, 1);
    let timeoutRelease!: (value: { ok: true; result: { value: number } }) => void;
    let markEntered!: () => void;
    const handlerEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    router.register({ member: "device:fake", spec: spec("slow", "none", 2000), handle: () => new Promise((resolve) => { timeoutRelease = resolve; markEntered(); }) });
    const timedReply = router.send(owner, { ...request("device:fake", "slow"), wait: true });
    const first = await Promise.race([handlerEntered.then(() => "handler"), timedReply.then(() => "timeout-before-handler")]);
    assert.equal(first, "handler", "late-result exercise requires a dispatched in-flight request");
    const timed = await timedReply;
    assert.equal((timed.reply?.body.error as { code: string }).code, "timeout");
    timeoutRelease({ ok: true, result: { value: 2 } });
    await tick();
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 2);
    assert.equal(notices.filter((n) => n.startsWith("response:")).length, 2);
  } finally { ledger.close(); }
});

test("gate sees durable request first; denial never dispatches and is journaled", async () => {
  const { ledger, router } = await setup();
  try {
    let calls = 0;
    router.register({ member: "device:fake", spec: spec("run", "outward"), handle: () => { calls++; return { ok: true, result: { value: 1 } }; } });
    router.setGate(async (message) => { assert.equal(ledger.byId(message.id)?.kind, "request"); return { allow: false, by: "rule" }; });
    const sent = await router.send(agent, { ...request(), wait: true });
    assert.equal(calls, 0);
    assert.equal((sent.reply?.body.error as { code: string }).code, "denied");
    assert.deepEqual(ledger.list().map((m) => m.word), ["run", "gate.asked", "gate.denied", "run"]);
  } finally { ledger.close(); }
});

test("risk gate also runs for owner requests and records approval before device effect", async () => {
  const { ledger, router } = await setup();
  try {
    router.register({ member: "device:fake", spec: spec("run", "structure"), handle: () => {
      assert.deepEqual(ledger.list().map((m) => m.word), ["run", "gate.asked", "gate.passed"]);
      return { ok: true, result: { value: 2 } };
    } });
    router.setGate(async () => ({ allow: true, by: "rule" }));
    const sent = await router.send(owner, { ...request(), wait: true });
    assert.equal(sent.reply?.body.ok, true);
    assert.deepEqual(ledger.list().map((m) => m.word), ["run", "gate.asked", "gate.passed", "run"]);
  } finally { ledger.close(); }
});

test("trusted sender stamping, local-only guard and broadcast authorization", async () => {
  const { ledger, router } = await setup();
  try {
    router.register({ member: "agent:main", spec: spec("say"), handle: () => ({ ok: true, result: { value: 1 } }) });
    const said = await router.send(screen, { ...request("agent:main", "say"), wait: true });
    assert.equal(ledger.byId(said.id)?.from, "person:owner");
    assert.deepEqual(ledger.byId(said.id)?.origin, { screen: "screen:tab_a", label: "Tab A" });
    const phoneSay = await router.send(phone, request("agent:main", "say"));
    assert.equal(ledger.byId(phoneSay.id)?.from, "person:owner");
    await assert.rejects(router.send(screen, request("service:self", "write")), code("forbidden"));
    await assert.rejects(router.send(screen, { ...request(), from: "service:admin" } as never), code("bad_request"));
    await assert.rejects(router.send(screen, { to: null, kind: "event", word: "sense.bad", body: {} }), code("forbidden"));
    const event = await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: "" } });
    assert.equal(ledger.byId(event.id)?.to, null);
    assert.equal(ledger.byId(event.id)?.from, "agent:main");
    await assert.rejects(router.send(agent, { to: null, kind: "event", word: "gate.passed", body: { by: "rule" } }), code("not_found"));
  } finally { ledger.close(); }
});

test("recovery never replays uncertain side effects, but explicit durable inbox opt-in deduplicates by id", async () => {
  const { file, ledger, router } = await setup();
  let second: Ledger | undefined;
  try {
    const retained = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { n: 1 } }, undefined,
      { deadlineAt: Date.now() + 5000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false } }).message;
    const inboxAccepted = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { n: 1 } }, undefined,
      { deadlineAt: Date.now() + 5000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false } }).message;
    assert.equal(ledger.advanceRequest(inboxAccepted.id, "accepted", "dispatching"), true);
    const uncertain = ledger.append({ from: "person:owner", to: "device:fake", kind: "request", word: "run", body: { n: 1 } }, undefined,
      { deadlineAt: Date.now() + 5000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false } }).message;
    assert.equal(ledger.advanceRequest(uncertain.id, "accepted", "dispatching"), true);
    ledger.close();
    second = await Ledger.open(file);
    const intakeCalls = new Map<string, number>();
    const durableInbox = new Set<string>([inboxAccepted.id]);
    let intakeEffects = 0;
    const recovered = new WorldRouter(second, async () => true);
    recovered.register({ member: "agent:main", spec: spec("say"), idempotentRecovery: true, handle: (message) => {
      intakeCalls.set(message.id, (intakeCalls.get(message.id) ?? 0) + 1);
      if (!durableInbox.has(message.id)) { durableInbox.add(message.id); intakeEffects++; }
      return { ok: true, result: { value: 1 } };
    } });
    let deviceCalls = 0;
    recovered.register({ member: "device:fake", spec: spec("run"), handle: () => { deviceCalls++; return { ok: true, result: { value: 1 } }; } });
    await recovered.recover();
    await tick();
    assert.equal(intakeCalls.get(retained.id), 1);
    assert.equal(intakeCalls.get(inboxAccepted.id), 1);
    assert.equal(durableInbox.size, 2, "recovered dispatching say retains one durable intake per message id");
    assert.equal(intakeEffects, 1, "already accepted say does not repeat its durable inbox effect");
    await recovered.recover();
    assert.equal(intakeCalls.get(inboxAccepted.id), 1, "settled requests are never redelivered");
    assert.equal(deviceCalls, 0);
    assert.equal((second.responseTo(uncertain.id)?.body.error as { code: string }).code, "failed");
    assert.equal(second.trackedRequests().length, 0);
  } finally { second?.close(); }
});

test("external response must match active request target, sender, word, schema, and first answer wins", async () => {
  const { ledger, router } = await setup();
  try {
    router.register({ member: "device:fake", spec: spec("run"), handle: () => new Promise(() => {}) });
    const sent = await router.send(owner, request());
    const device: TrustedRouteContext = { transport: "device", transportPrincipal: "paired-fake", member: "device:fake", local: true, remote: false, ownerProxy: false };
    const response = { to: "person:owner", kind: "response" as const, word: "run", reply_to: sent.id, body: { ok: true, result: { value: 2 } } };
    await assert.rejects(router.send(agent, response), code("bad_request"));
    await assert.rejects(router.send(device, { ...response, word: "other" }), code("bad_request"));
    await assert.rejects(router.send(device, { ...response, body: { ok: true, result: { value: "wrong" } } }), code("bad_request"));
    const accepted = await router.send(device, response);
    assert.equal(ledger.byId(accepted.id)?.reply_to, sent.id);
    await assert.rejects(router.send(device, response), code("bad_request"));
    assert.equal(ledger.list().filter((m) => m.kind === "response").length, 1);
  } finally { ledger.close(); }
});

test("recovery rechecks current authority and never resumes a stranded gate decision", async () => {
  const { file, ledger } = await setup();
  const snapshot = { member: "agent:main", local: true, remote: false, ownerProxy: false };
  const denied = ledger.append({ from: "agent:main", to: "device:fake", kind: "request", word: "run", body: { n: 1 } }, undefined, { deadlineAt: Date.now() + 5000, context: snapshot }).message;
  const waiting = ledger.append({ from: "agent:main", to: "device:fake", kind: "request", word: "run", body: { n: 2 } }, undefined, { deadlineAt: Date.now() + 5000, context: snapshot }).message;
  assert.equal(ledger.advanceRequest(waiting.id, "accepted", "gate_waiting"), true);
  ledger.close();
  const reopened = await Ledger.open(file);
  try {
    const checks: string[] = [];
    const router = new WorldRouter(reopened, async (message, context) => { checks.push(message.id); assert.deepEqual(context, snapshot); return message.id !== denied.id; });
    let dispatched = 0;
    router.register({ member: "device:fake", spec: spec("run", "outward"), handle: () => { dispatched++; return { ok: true, result: { value: 1 } }; } });
    router.setGate(async () => { throw new Error("must not reask orphaned gate"); });
    await router.recover();
    assert.deepEqual(new Set(checks), new Set([denied.id, waiting.id]));
    assert.equal(dispatched, 0);
    assert.equal((reopened.responseTo(denied.id)?.body.error as { code: string }).code, "forbidden");
    assert.equal((reopened.responseTo(waiting.id)?.body.error as { code: string }).code, "failed");
  } finally { reopened.close(); }
});

test("stream replay boundary emits every persisted event once in sequence", async () => {
  const { ledger, router } = await setup();
  try {
    for (let i = 0; i < 3; i++) await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: String(i) } });
    const seen: number[] = [];
    const stop = router.subscribeFrom(1, (message) => { seen.push(message.seq); });
    await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: "3" } });
    stop();
    await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: "4" } });
    assert.deepEqual(seen, [2, 3, 4]);
  } finally { ledger.close(); }
});

test("replay listener cannot rewrite the page cursor or force duplicate history", async () => {
  const { ledger, router } = await setup();
  try {
    for (let i = 0; i < 3; i++) await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: String(i) } });
    const seen: string[] = [];
    const stop = router.subscribeFrom(0, (message) => {
      seen.push(message.id);
      message.seq = 0;
      if (seen.length > 5) throw new Error("replay loop after observer mutation");
    });
    stop();
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen).size, 3);
    assert.deepEqual(ledger.list().map((message) => message.seq), [1, 2, 3]);
  } finally { ledger.close(); }
});

test("broadcast reaches all subscribers; one broken stream cannot strand an accepted request", async () => {
  const { ledger, router } = await setup();
  try {
    const first: number[] = [];
    const second: number[] = [];
    router.subscribe(() => { throw new Error("disconnected stream"); });
    router.subscribe((message) => first.push(message.seq));
    router.subscribe((message) => second.push(message.seq));
    const notice = await router.send(agent, { to: null, kind: "event", word: "status", body: { state: "idle", text: "ready" } });
    assert.deepEqual(first, [notice.seq]); assert.deepEqual(second, [notice.seq]);
    router.register({ member: "device:fake", spec: spec("run"), handle: () => ({ ok: true, result: { value: 1 } }) });
    const sent = await router.send(owner, { ...request(), wait: true });
    assert.equal(sent.reply?.body.ok, true);
    assert.deepEqual(first, [notice.seq, sent.seq, sent.reply!.seq]);
    assert.deepEqual(second, first);
    assert.equal(ledger.trackedRequests().length, 0);
  } finally { ledger.close(); }
});

test("durable caller snapshot stores minimal authorization facts, never a transport token", async () => {
  const { file, ledger, router } = await setup();
  try {
    router.register({ member: "device:fake", spec: spec("run"), handle: () => new Promise(() => {}) });
    const credentialed = { ...owner, token: "synthetic-token-do-not-persist", cookie: "synthetic-cookie-do-not-persist" };
    const sent = await router.send(credentialed, request());
    const db = new DatabaseSync(file);
    try {
      const rows = db.prepare("SELECT context FROM request_state").all() as { context: string }[];
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(rows[0].context), { member: "person:owner", local: true, remote: false, ownerProxy: false, transportPrincipal: "owner-login" });
      assert.equal(rows[0].context.includes("synthetic-token"), false);
      assert.equal(rows[0].context.includes("synthetic-cookie"), false);
    } finally { db.close(); }
    router.cancel([sent.id]);
  } finally { ledger.close(); }
});

test("observer and handler mutations cannot change the validated request or another observer's view", async () => {
  const { ledger, router } = await setup();
  try {
    const seen: number[] = [];
    router.subscribe((message) => { if (message.kind === "request") { message.body.n = 999; message.id = "forged"; } });
    router.subscribe((message) => { if (message.kind === "request") seen.push(message.body.n as number); });
    router.register({ member: "device:fake", spec: spec("run"), handle: (message) => {
      assert.equal(message.body.n, 1);
      message.body.n = 888;
      message.id = "handler-forged";
      return { ok: true, result: { value: 1 } };
    } });
    const sent = await router.send(owner, { ...request(), wait: true });
    assert.deepEqual(seen, [1]);
    assert.equal(ledger.byId(sent.id)?.body.n, 1);
    assert.equal(sent.reply?.reply_to, sent.id);
  } finally { ledger.close(); }
});

test("recovery rejects stale input schema, changed kind or outgoing direction before any effect", async () => {
  for (const variant of ["schema", "kind", "direction"] as const) {
    const { file, ledger } = await setup();
    const saved = ledger.append({ from: "person:owner", to: "device:fake", kind: "request", word: "run", body: { n: 1 } }, undefined,
      { deadlineAt: Date.now() + 5000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false } }).message;
    ledger.close();
    const reopened = await Ledger.open(file);
    try {
      const router = new WorldRouter(reopened, async () => true);
      let effects = 0;
      const changed = spec("run");
      if (variant === "schema") changed.input_schema = { type: "object", properties: { n: { type: "integer", minimum: 2 } }, required: ["n"], additionalProperties: false };
      if (variant === "kind") changed.kind = "event";
      router.register({ member: "device:fake", spec: changed, ...(variant === "direction" ? { direction: "out" as const } : {}), handle: () => { effects++; return { ok: true, result: { value: 1 } }; } });
      await router.recover();
      assert.equal(effects, 0, variant);
      assert.equal((reopened.responseTo(saved.id)?.body.error as { code: string }).code, "bad_request", variant);
      assert.equal(reopened.trackedRequests().length, 0);
    } finally { reopened.close(); }
  }
});

test("only owner starts work; only local work service gets its two declared self-writing words", async () => {
  const { ledger, router } = await setup();
  try {
    const work: TrustedRouteContext = { transport: "service", transportPrincipal: "internal-work", member: "service:work", local: true, remote: false, ownerProxy: false };
    const remoteWork: TrustedRouteContext = { ...work, local: false, remote: true };
    const other: TrustedRouteContext = { ...work, transportPrincipal: "internal-clock", member: "service:clock" };
    let runs = 0;
    const writers: string[] = [];
    router.register({ member: "service:work", spec: spec("run"), handle: () => { runs++; return { ok: true, result: { value: 1 } }; } });
    for (const word of ["append", "apply_plan", "write", "rollback"]) router.register({ member: "service:self", spec: spec(word), handle: (message) => { writers.push(`${message.from}/${message.word}`); return { ok: true, result: { value: 1 } }; } });
    await assert.rejects(router.send(agent, request("service:work", "run")), code("forbidden"));
    await assert.rejects(router.send(other, request("service:work", "run")), code("forbidden"));
    const ownerRun = await router.send(screen, { ...request("service:work", "run"), wait: true });
    assert.equal(ownerRun.reply?.body.ok, true); assert.equal(runs, 1);
    for (const word of ["append", "apply_plan"]) {
      const result = await router.send(work, { ...request("service:self", word), wait: true });
      assert.equal(result.reply?.body.ok, true);
    }
    await assert.rejects(router.send(work, request("service:self", "write")), code("forbidden"));
    await assert.rejects(router.send(work, request("service:self", "rollback")), code("forbidden"));
    await assert.rejects(router.send(remoteWork, request("service:self", "append")), code("forbidden"));
    await assert.rejects(router.send(remoteWork, request("service:self", "apply_plan")), code("forbidden"));
    await assert.rejects(router.send(other, request("service:self", "append")), code("forbidden"));
    await assert.rejects(router.send(screen, request("service:self", "append")), code("forbidden"));
    assert.deepEqual(writers, ["service:work/append", "service:work/apply_plan"]);
  } finally { ledger.close(); }
});

test("screen and phone notification replies persist server-stamped origin, never a caller claim", async () => {
  const { ledger, router } = await setup();
  try {
    router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => new Promise(() => {}) });
    const body = { title: "Proceed?", detail: "Synthetic", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: Date.now() + 10_000,
      source: { word: "run", to: "device:fake", body_preview: "Synthetic" } };
    const screenAsk = await router.send(agent, { to: "person:owner", kind: "request", word: "ask", body });
    const screenReply = await router.send(screen, { to: "agent:main", kind: "response", word: "ask", reply_to: screenAsk.id, body: { ok: true, result: { choice: "once" } } });
    assert.deepEqual(ledger.byId(screenReply.id)?.origin, { screen: "screen:tab_a", label: "Tab A" });
    const phoneAsk = await router.send(agent, { to: "person:owner", kind: "request", word: "ask", body });
    const phoneReply = await router.send(phone, { to: "agent:main", kind: "response", word: "ask", reply_to: phoneAsk.id, body: { ok: true, result: { choice: "deny" } } });
    assert.deepEqual(ledger.byId(phoneReply.id)?.origin, { screen: "device:phone", label: "Phone notification" });
    await assert.rejects(router.send(screen, { to: "agent:main", kind: "response", word: "ask", reply_to: phoneAsk.id, body: { ok: true, result: { choice: "once" } }, origin: { screen: "screen:other", label: "Other" } } as never), code("bad_request"));
  } finally { ledger.close(); }
});

test("phone sense broadcast accepts only four declared schemas from the trusted phone", async () => {
  const { ledger, router } = await setup();
  try {
    const seen: string[] = [];
    router.subscribe((message) => seen.push(`${message.from}/${message.word}`));
    const sent = await router.send(phone, { to: null, kind: "event", word: "sense.battery", body: { level: 72 } });
    assert.equal(ledger.byId(sent.id)?.from, "device:phone");
    await assert.rejects(router.send(phone, { to: null, kind: "event", word: "sense.battery", body: { level: 101 } }), code("bad_request"));
    await assert.rejects(router.send(phone, { to: null, kind: "event", word: "sense.unlisted", body: {} }), code("not_found"));
    await assert.rejects(router.send(agent, { to: null, kind: "event", word: "sense.battery", body: { level: 72 } }), code("not_found"));
    assert.deepEqual(seen, ["device:phone/sense.battery"]);
  } finally { ledger.close(); }
});

test("recovery authorizer receives detached request and context", async () => {
  const { ledger } = await setup();
  try {
    const saved = ledger.append({ from: "person:owner", to: "device:fake", kind: "request", word: "run", body: { n: 1 } }, undefined,
      { deadlineAt: Date.now() + 5000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false } }).message;
    const recovered = new WorldRouter(ledger, async (message, context) => { message.body.n = 999; context.member = "forged"; return true; });
    recovered.register({ member: "device:fake", spec: spec("run"), handle: (message) => { assert.equal(message.body.n, 1); return { ok: true, result: { value: 1 } }; } });
    await recovered.recover();
    await tick();
    assert.equal(ledger.byId(saved.id)?.body.n, 1);
    assert.equal(ledger.responseTo(saved.id)?.body.ok, true);
    assert.equal(ledger.trackedRequests().length, 0);
  } finally { ledger.close(); }
});

test("ask accepts only an offered, unexpired first choice; invalid choice leaves the slot open", async () => {
  const { ledger, router } = await setup();
  try {
    router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => undefined });
    const body = { title: "Proceed?", detail: "Synthetic approval", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: Date.now() + 10_000,
      source: { word: "run", to: "device:fake", body_preview: "Synthetic" } };
    const asked = await router.send(agent, { to: "person:owner", kind: "request", word: "ask", body });
    const answer = (choice: string) => ({ to: "agent:main", kind: "response" as const, word: "ask", reply_to: asked.id, body: { ok: true, result: { choice } } });
    await assert.rejects(router.send(owner, answer("once")), code("forbidden"));
    await assert.rejects(router.send(screen, answer("always")), code("bad_request"));
    await assert.rejects(router.send(screen, answer("__custom")), code("bad_request"));
    assert.equal(ledger.responseTo(asked.id), null);
    const valid = await router.send(screen, answer("once"));
    assert.equal((ledger.byId(valid.id)?.body.result as { choice: string }).choice, "once");
    await assert.rejects(router.send(phone, answer("deny")), code("bad_request"));
    assert.equal(ledger.list().filter((message) => message.reply_to === asked.id).length, 1);
  } finally { ledger.close(); }
});

test("expired ask auto-denies without presenting; late approval cannot replace it", async () => {
  const { ledger, router } = await setup();
  try {
    let presentations = 0;
    router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => { presentations++; } });
    const body = { title: "Proceed?", detail: "Synthetic approval", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: Date.now() - 1000,
      source: { word: "run", to: "device:fake", body_preview: "Synthetic" } };
    const asked = await router.send(agent, { to: "person:owner", kind: "request", word: "ask", body, wait: true });
    assert.equal((asked.reply?.body.result as { choice: string }).choice, "deny");
    assert.equal(asked.reply?.origin, undefined, "automatic denial is not attributed to a screen click");
    assert.equal(presentations, 0);
    await assert.rejects(router.send(screen, { to: "agent:main", kind: "response", word: "ask", reply_to: asked.id, body: { ok: true, result: { choice: "once" } } }), code("bad_request"));
    assert.equal(ledger.list().filter((message) => message.reply_to === asked.id).length, 1);
  } finally { ledger.close(); }
});

test("restarted expired ask auto-denies without redispatch; endpoint timeout before expiry remains timeout", async () => {
  const { file, ledger } = await setup();
  const body = { title: "Proceed?", detail: "Synthetic approval", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: Date.now() - 1000,
    source: { word: "run", to: "device:fake", body_preview: "Synthetic" } };
  const saved = ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "ask", body }, undefined,
    { deadlineAt: body.expires_at, context: { member: "agent:main", local: true, remote: false, ownerProxy: false } }).message;
  ledger.close();
  const reopened = await Ledger.open(file);
  try {
    const router = new WorldRouter(reopened, async () => true);
    let presentations = 0;
    router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => { presentations++; } });
    await router.recover();
    assert.equal(presentations, 0);
    assert.equal((reopened.responseTo(saved.id)?.body.result as { choice: string }).choice, "deny");
    assert.equal(reopened.trackedRequests().length, 0);
    const short = { ...wordContract("person:owner", "ask")!, timeout_ms: 25 };
    const other = new WorldRouter(reopened, async () => true);
    other.register({ member: "person:owner", spec: short, handle: () => undefined });
    const later = { ...body, expires_at: Date.now() + 5000 };
    const timed = await other.send(agent, { to: "person:owner", kind: "request", word: "ask", body: later, wait: true });
    assert.equal((timed.reply?.body.error as { code: string }).code, "timeout");
  } finally { reopened.close(); }
});
