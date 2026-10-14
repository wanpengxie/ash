import assert from "node:assert/strict";
import test from "node:test";
import { createAdminService } from "../../../src/services/admin";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, code, ctxOf, fakeRouter, msg, owner } from "../support";

function setup(options: { logs?: string[] } = {}) {
  const { ledger } = openLedger();
  const router = fakeRouter((m) => {
    if (m.word === "list") return { ok: true, result: { data: { agents: [{ id: "agent:helper", primary: false }, { id: "agent:main", primary: true }] } } };
    if (m.word === "configure") return { ok: true, result: { data: { config: { model: "x" } } } };
    if (m.word === "plugins") return { ok: true, result: { data: { plugins: [{ name: "p", enabled: true }] } } };
    return { ok: true };
  });
  const service = createAdminService({
    ledger, router, version: "4.0.0", now: () => 10_000, startedAt: 4_000,
    registry: { list: (f) => (f?.kind === "agent" ? [{ id: "agent:main", kind: "agent", name: "main" }] : f?.kind === "device" ? [{ id: "device:phone", kind: "device", name: "p" }, { id: "device:pc", kind: "device", name: "c" }] : []) },
    readLogs: options.logs ? ({ lines }) => options.logs!.slice(-lines) : undefined, log: () => {},
  });
  return { ledger, router, service };
}
const settle = () => new Promise((r) => setImmediate(r));
const events = (s: ReturnType<typeof setup>) => s.router.sent.filter((x) => x.msg.kind === "event").map((x) => x.msg);

test("contracts: pause, resume and logs are the owner's and an agent's alike, from anywhere (nothing is local-only)", () => {
  const w = (n: string) => setup().service.words().find((x) => x.word === n)!;
  for (const n of ["pause", "resume", "logs"]) { assert.deepEqual(w(n).callers, ["owner", "agent"], n); assert.ok(!w(n).local_only, n); }
  for (const n of ["settings.get", "settings.set", "status", "model.set", "plugins.list", "plugins.op", "settings.changed"]) assert.ok(w(n), n);
});

test("pause and resume keep the state, say so with settings.changed, and do not interrupt anyone themselves", async () => {
  const s = setup();
  assert.equal((await call(s.service, agent(), "status")).paused, false);
  assert.deepEqual(await call(s.service, owner, "pause", { by: "m_42" }), { paused: true });
  assert.equal((await call(s.service, agent(), "status")).paused, true);
  await settle();
  assert.deepEqual(events(s), [{ to: null, kind: "event", word: "settings.changed", body: { keys: ["paused"], by: "m_42" } }]);
  assert.deepEqual(s.router.sent.filter((x) => x.msg.kind === "request"), [], "no session.interrupt from admin");

  assert.deepEqual(await call(s.service, owner, "resume", { confirmed: true }), { paused: false });
  assert.equal((await call(s.service, agent(), "status")).paused, false);
  await settle();
  assert.deepEqual(events(s).at(-1)!.body, { keys: ["paused"], by: "person:owner" });
});

test("the pause survives a restart (it is in kv)", async () => {
  const s = setup();
  await call(s.service, owner, "pause");
  const again = createAdminService({ ledger: s.ledger, router: s.router, registry: { list: () => [] } });
  assert.equal((await call(again, agent(), "status")).paused, true);
});

test("settings are plain key-value; set announces the keys, never the values; null removes", async () => {
  const s = setup();
  const set = await call(s.service, owner, "settings.set", { "delivery.quiet_hours": "23:00-07:00", "semantic.reload_time": "04:00", flag: true });
  assert.equal(set.flag, true);
  assert.deepEqual((await call(s.service, agent(), "settings.get")).settings, { "delivery.quiet_hours": "23:00-07:00", flag: true, "semantic.reload_time": "04:00" });
  assert.deepEqual((await call(s.service, agent(), "settings.get", { keys: ["flag", "nope"] })).settings, { flag: true });
  await settle();
  const ev = events(s)[0]!;
  assert.deepEqual(ev.body, { keys: ["delivery.quiet_hours", "semantic.reload_time", "flag"], by: "person:owner" });
  assert.ok(!JSON.stringify(ev).includes("23:00"));

  assert.deepEqual(s.service.settings(), { "delivery.quiet_hours": "23:00-07:00", flag: true, "semantic.reload_time": "04:00" }, "other modules read the same settings through the method");
  await call(s.service, owner, "settings.set", { flag: null });
  assert.equal((await call(s.service, owner, "settings.get")).settings.flag, undefined);
  assert.equal(await code(call(s.service, owner, "settings.set", { "Bad Key": 1 })), "bad_request");
  assert.equal(await code(call(s.service, owner, "settings.set", {})), "bad_request");
  // read straight from kv, as the delivery rules would
  assert.deepEqual(JSON.parse((s.ledger.db().prepare("SELECT value FROM kv WHERE key=?").get("setting.delivery.quiet_hours") as { value: string }).value), "23:00-07:00");
});

test("model.set goes to the primary agent's configure and is stored nowhere in the hub", async () => {
  const s = setup();
  const before = s.ledger.db().prepare("SELECT key,value FROM kv ORDER BY key").all();
  const result = await call(s.service, owner, "model.set", { provider: "deepseek", model: "deepseek-chat" });
  assert.deepEqual(result, { provider: "deepseek", model: "deepseek-chat", restart_required: false });
  const configure = s.router.sent.find((x) => x.msg.word === "configure")!;
  assert.deepEqual(configure.msg, { to: "service:agents", kind: "request", word: "configure", body: { agent: "agent:main", config: { model: JSON.stringify(["deepseek", "deepseek-chat"]) } } });
  assert.deepEqual(s.ledger.db().prepare("SELECT key,value FROM kv ORDER BY key").all(), before);
  assert.deepEqual((await call(s.service, owner, "settings.get")).settings, {});
});

test("plugins are forwarded to the primary agent's runtime", async () => {
  const s = setup();
  assert.equal((await call(s.service, owner, "plugins.list")).plugins[0].name, "p");
  await call(s.service, owner, "plugins.op", { op: "enable", name: "p" });
  await call(s.service, owner, "plugins.op", { op: "plugin", id: "q", enabled: false });
  const sent = s.router.sent.filter((x) => x.msg.word === "plugins").map((x) => x.msg.body);
  assert.deepEqual(sent, [{ op: "list", agent: "agent:main" }, { op: "enable", name: "p", agent: "agent:main" }, { op: "disable", name: "q", agent: "agent:main" }]);
});

test("status and logs", async () => {
  const s = setup({ logs: ["a", "b", "c"] });
  const status = await call(s.service, agent(), "status");
  assert.deepEqual({ ...status, time_zone: undefined }, { now: 10_000, time_zone: undefined, paused: false, version: "4.0.0", uptime_ms: 6_000, agents: 1, hands_online: 2 });
  assert.deepEqual((await call(s.service, owner, "logs", { lines: 2 })).lines, ["b", "c"]);
  assert.equal(await code(call(setup().service, owner, "logs")), "unavailable");
  assert.equal(await code(setup().service.handle(msg("service:admin", "nope", {}), ctxOf(owner)) as Promise<unknown>), "not_found");
});

test("checkup: a hand's summary is kept and read back; before one has come, known is false; only a hand's report counts", async () => {
  const s = setup();
  assert.deepEqual(await call(s.service, owner, "checkup"), { known: false });
  const summary = { todo: 1, groups: [{ id: "brain", title: "大脑", todo: 0, optional: false, text: "在运行" }, { id: "alarm", title: "闹钟", todo: 1, optional: false, text: "可能晚几分钟" }] };
  const report = (from: string) => s.service.handle(msg("service:admin", "checkup.changed", summary, from, "event"), ctxOf({ member: from, via: "hand", local: false }, summary));
  await report("service:clock");
  assert.deepEqual(await call(s.service, owner, "checkup"), { known: false }, "a service's report is not the phone's");
  await report("device:AAAAAAAAAAAAAAAAAAAAAA");
  const got = await call(s.service, agent(), "checkup");
  assert.deepEqual({ ...got, at: 0 }, { known: true, ...summary, at: 0, device: "device:AAAAAAAAAAAAAAAAAAAAAA" });
  assert.equal(got.at, 10_000);
});
