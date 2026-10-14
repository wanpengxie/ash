import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AGENT, call, dataOf, installFixtureFolder, OWNER, until, world, type World } from "./helpers";

async function installed(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world(options);
  await w.apps.start();
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return w;
}
const heard = async (w: World) => dataOf(await call(w, "app:fixture", "fixture.list")).events as { word: string; body: unknown; from: string; at: number }[];

test("install by an agent: the one approval card carries everything the app asks for; approved, the app runs as member app:<id>", async () => {
  const w = world();
  await w.apps.start();
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null, "nothing runs before the owner approves");
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" }, AGENT);
  const info = dataOf(reply);
  assert.equal(info.running, true);
  assert.equal(info.granted, true);
  assert.equal(w.router.cards.length, 1, "one card, from the gate; the app edge asks nobody itself");
  assert.equal(w.router.sent.filter((s) => s.msg.word === "ask").length, 0);
  const card = w.router.cards[0]!;
  assert.equal(card.word, "apps.install");
  assert.match(card.detail!, /Fixture 1\.0\.0/);
  assert.match(card.detail!, /device:\*：location\.get/, "the need is on the card");
  assert.match(card.detail!, /sense\.\*/, "what it listens to is on the card");
  assert.match(card.detail!, /fixture\.alert/, "what wakes an agent is on the card");
  const described = w.registry.describe("app:fixture")!;
  assert.equal(described.info.kind, "app");
  assert.deepEqual(w.registry.members.get("app:fixture")!.listens, ["sense.*"]);
  assert.ok(!described.words.some((word) => word.word === "ash.on_event"), "the reserved tool is not a word");
  const events = described.words.filter((word) => word.kind === "event").map((word) => [word.word, word.direction, word.record]);
  assert.deepEqual(events, [["fixture.ping", "out", true], ["fixture.alert", "out", true]]);
  assert.ok(existsSync(join(w.root, "fixture", "data")), "the data_dir exists");
});

test("install: the owner says no, or does not answer -> nothing is installed or started", async () => {
  const w = world();
  await w.apps.start();
  w.router.ownerChoice = "deny";
  const denied = await call(w, "service:apps", "apps.install", { id: "fixture" }, AGENT);
  assert.equal(denied.ok === false && denied.error.code, "denied");
  w.router.ownerChoice = undefined;
  const silent = await call(w, "service:apps", "apps.install", { id: "fixture" }, AGENT);
  assert.equal(silent.ok === false && silent.error.code, "timeout");
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
  assert.equal(dataOf(await call(w, "service:apps", "apps.describe", { id: "fixture" })).granted, false);
});

test("install: an app.json that fails the schema is refused with its problems, before any card", async () => {
  const w = world({ fixture: (app) => { delete app.summary; app.surprise = true; app.wake_events = ["fixture.other"]; } });
  await w.apps.start();
  const pre = await w.apps.service.precheck!({ seq: 1, id: "m", ts: 1, from: "agent:main", to: "service:apps", kind: "request", word: "apps.install", body: { id: "fixture" } });
  assert.ok(pre && !pre.ok);
  assert.equal(pre.error.code, "failed");
  const problems = (pre.error.detail as { problems: { where: string; problem: string }[] }).problems;
  assert.ok(problems.some((p) => /summary/.test(p.problem)), JSON.stringify(problems));
  assert.ok(problems.some((p) => /surprise/.test(p.problem)));
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" }, AGENT);
  assert.equal(reply.ok, false);
  assert.equal(w.router.cards.length, 0);
});

test("install: a wake event that is not a declared event is a schema-level problem", async () => {
  const w = world({ fixture: (app) => { app.wake_events = ["fixture.other"]; } });
  await w.apps.start();
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" });
  assert.equal(reply.ok, false);
  assert.match(JSON.stringify(reply), /wake_events/);
});

test("install by an agent: app.json asking for more after the owner saw the card -> conflict, nothing installed", async () => {
  const w = world();
  await w.apps.start();
  w.router.onCard = () => {
    const file = join(w.root, "fixture", "app.json");
    const app = JSON.parse(readFileSync(file, "utf8"));
    app.listens.push("calendar.event");
    writeFileSync(file, JSON.stringify(app));
  };
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" }, AGENT);
  assert.equal(reply.ok === false && reply.error.code, "conflict");
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
});

test("install by an agent with no card remembered (the hub restarted since) -> conflict; the owner installing by hand needs no card", async () => {
  const w = world();
  await w.apps.start();
  await assert.rejects(w.apps.runtime.install("fixture", AGENT, "m_lost"), (error: { code: string; message: string }) => error.code === "conflict" && /没有经过主人的审批卡/.test(error.message));
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
  const by_hand = await call(w, "service:apps", "apps.install", { id: "fixture" }, OWNER);
  assert.equal(by_hand.ok, true);
  assert.equal(w.router.cards.length, 0, "no card: doing it by hand is the approval");
  assert.equal(dataOf(by_hand).running, true);
});

test("two install cards waiting for the same app do not overwrite each other: each request is judged against its own card", async () => {
  const w = world();
  await w.apps.start();
  const file = join(w.root, "fixture", "app.json");
  w.apps.runtime.cardDetail("fixture", "m_first");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.listens.push("calendar.event");
  writeFileSync(file, JSON.stringify(app));
  w.apps.runtime.cardDetail("fixture", "m_second");
  await assert.rejects(w.apps.runtime.install("fixture", AGENT, "m_first"), (error: { code: string; message: string }) => error.code === "conflict" && /批准之后/.test(error.message), "the first card showed the old listens");
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
  const info = await w.apps.runtime.install("fixture", AGENT, "m_second");
  assert.deepEqual(info.listens, ["sense.*", "calendar.event"]);
});

test("tools: a read tool and a write tool become words with the risk of their MCP annotations (SPEC-02 5.3)", async () => {
  const w = await installed();
  const byWord = Object.fromEntries(w.registry.describe("app:fixture")!.words.filter((word) => word.kind === "request").map((word) => [word.word, [word.effect, word.risk]]));
  assert.deepEqual(byWord["fixture.list"], ["read", "none"]);
  assert.deepEqual(byWord["fixture.add"], ["write", "none"], "declared harmless");
  assert.deepEqual(byWord["fixture.emit"], ["write", "structure"], "no annotations: needs approval");
  const added = await call(w, "app:fixture", "fixture.add", { text: "milk" }, AGENT);
  assert.deepEqual(dataOf(added), { count: 1 });
  assert.deepEqual(dataOf(await call(w, "app:fixture", "fixture.list")).notes, ["milk"]);
  const missing = await call(w, "app:fixture", "fixture.nope", {});
  assert.equal(missing.ok === false && missing.error.code, "not_found");
});

test("tools: a tool that reports isError becomes a failed error carrying its text", async () => {
  const w = await installed();
  writeFileSync(join(w.root, "fixture", "data", "data.json"), "{}"); // a data file this tool cannot work with: it throws
  const reply = await call(w, "app:fixture", "fixture.add", {}); // text is missing: the tool throws
  assert.equal(reply.ok, false);
  assert.equal(reply.ok === false && reply.error.code, "failed");
});

test("listens: an event the owner approved is delivered to ash.on_event {word, body, from, at}; others are not", async () => {
  const w = await installed();
  await w.router.send({ to: null, kind: "event", word: "sense.location", body: { lat: 1, lng: 2 } }, { member: "device:phone", via: "hand", local: false });
  await w.router.send({ to: null, kind: "event", word: "calendar.event", body: { x: 1 } }, { member: "device:phone", via: "hand", local: false });
  await w.router.send({ to: null, kind: "event", word: "sense.battery", body: { level: 5 } }, { member: "device:phone", via: "hand", local: false });
  const events = await until(async () => { const list = await heard(w); return list.length >= 2 ? list : null; }, "two events");
  assert.deepEqual(events.map((event) => event.word), ["sense.location", "sense.battery"], "in order, and only sense.*");
  assert.deepEqual(events[0]!.body, { lat: 1, lng: 2 });
  assert.equal(events[0]!.from, "device:phone");
  assert.equal(typeof events[0]!.at, "number");
});

test("listens: only what the owner approved takes effect; revoking it stops delivery", async () => {
  const w = await installed();
  // app.json grows a new listen after the install: the member does not hear it until the owner approves again
  const file = join(w.root, "fixture", "app.json");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.listens.push("calendar.event");
  writeFileSync(file, JSON.stringify(app));
  const restart = await call(w, "service:apps", "apps.restart", { id: "fixture" });
  assert.equal(restart.ok, false, "a wider listens needs a new install");
  assert.match(JSON.stringify(restart), /apps\.install/);
  assert.deepEqual(w.registry.members.get("app:fixture")!.listens, ["sense.*"]);
  const revoked = await call(w, "service:apps", "apps.revoke", { id: "fixture", need: "listens" });
  assert.deepEqual(dataOf(revoked).listens, []);
  assert.deepEqual(w.registry.members.get("app:fixture")!.listens, []);
});

test("an app does not hear its own events", async () => {
  const w = await installed({ fixture: (app) => { app.events.push("sense.fixture"); app.listens = ["sense.*"]; } });
  const reply = await call(w, "app:fixture", "fixture.emit", { name: "sense.fixture", body: {} });
  assert.equal(dataOf(reply).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(await heard(w), []);
});

test("events: a declared event goes out from app:<id> to nobody in particular; an undeclared one is refused", async () => {
  const w = await installed();
  const ok = dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.ping", body: { n: 1 } }));
  assert.deepEqual(ok, { ok: true, result: { recorded: true } });
  const sent = w.router.sent.find((s) => s.msg.kind === "event" && s.msg.word === "fixture.ping")!;
  assert.deepEqual(sent.caller, { member: "app:fixture", via: "app", local: false });
  assert.equal(sent.msg.to, null);
  assert.ok(!w.router.sent.some((s) => s.msg.word === "wake"), "an ordinary event wakes nobody");
  const refused = dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.secret", body: {} }));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "forbidden");
  const big = dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.ping", body: { text: "x".repeat(5000) } }));
  assert.equal(big.error.code, "too_large");
});

test("wake_events: a plain entry wakes the primary agent (its full id), with the app, role, event and body", async () => {
  const w = await installed({ primaryAgent: () => "agent:chief" });
  dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.alert", body: { why: "x" } }));
  const wake = await until(() => w.router.sent.find((s) => s.msg.word === "wake"), "a wake");
  assert.equal(wake.msg.to, "agent:chief");
  assert.equal(wake.msg.kind, "request");
  assert.deepEqual(wake.caller, { member: "service:apps", via: "service", local: false }, "the owner approved it on the install card");
  const body = wake.msg.body as { reason: string; context: Record<string, unknown> };
  assert.equal(body.reason, "app_event");
  assert.deepEqual(body.context, { app: "app:fixture", name: "Fixture", role: "Test organ: keeps notes, hears sense events, reports fixture events.", event: "fixture.alert", body: { why: "x" } });
});

test("wake_events: an entry with an agent wakes that agent, not the primary", async () => {
  const w = await installed({ fixture: (app) => { app.wake_events = [{ event: "fixture.alert", agent: "agent:ash-feishu" }]; } });
  dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.alert", body: {} }));
  const wake = await until(() => w.router.sent.find((s) => s.msg.word === "wake"), "a wake");
  assert.equal(wake.msg.to, "agent:ash-feishu");
  assert.equal(w.router.sent.filter((s) => s.msg.word === "wake").length, 1);
});

test("wake_events: at most three wakes a day per app; the event itself still goes out", async () => {
  const w = await installed();
  for (let i = 0; i < 5; i++) dataOf(await call(w, "app:fixture", "fixture.emit", { name: "fixture.alert", body: { i } }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(w.router.sent.filter((s) => s.msg.word === "wake").length, 3);
  assert.equal(w.router.sent.filter((s) => s.msg.kind === "event" && s.msg.word === "fixture.alert").length, 5);
});

test("a crash: the member leaves the registry, a call is offline, and the app comes back after the backoff", async () => {
  const w = await installed({ backoffMs: () => 400 });
  await call(w, "app:fixture", "fixture.exit");
  await until(() => w.registry.find("app:fixture", "fixture.list") === null, "member removed");
  const offline = await call(w, "app:fixture", "fixture.list");
  assert.equal(offline.ok === false && offline.error.code, "offline");
  assert.equal(dataOf(await call(w, "service:apps", "apps.describe", { id: "fixture" })).running, false);
  const logs = dataOf(await call(w, "service:apps", "apps.logs", { id: "fixture" }));
  assert.equal(logs.last_exit.code, 3);
  assert.ok(logs.lines.some((line: string) => /重启/.test(line)));
  await until(() => w.registry.find("app:fixture", "fixture.list"), "restarted", 6000);
  assert.equal((await call(w, "app:fixture", "fixture.list")).ok, true);
});

test("stopAll ends every app before the deadline, even one that ignores the polite request", async () => {
  const w = await installed();
  // a second app that ignores stdin closing and SIGTERM
  const dir = installFixtureFolder(w.root, (app) => { app.listens = []; app.needs = []; app.wake_events = []; app.events = []; }, "stubborn");
  const server = join(dir, "server.mjs");
  writeFileSync(server, `${readFileSync(server, "utf8")}\nimport { writeFileSync as w2 } from "node:fs";\nw2(new URL("./pid", import.meta.url), String(process.pid));\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
  const tools = readFileSync(server, "utf8").replaceAll('"fixture.', '"stubborn.');
  writeFileSync(server, tools);
  await w.apps.runtime.refresh();
  w.apps.runtime.grants.grant("stubborn", "1.0.0", [], []);
  await w.apps.runtime.refresh();
  await until(() => existsSync(join(dir, "pid")) && w.registry.members.has("app:stubborn"), "stubborn running");
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  const started = Date.now();
  await w.apps.stopAll(started + 1200);
  const took = Date.now() - started;
  assert.ok(took < 1900, `stopAll took ${took} ms`);
  assert.equal(w.registry.members.has("app:fixture"), false);
  assert.equal(w.registry.members.has("app:stubborn"), false);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "the stubborn process killed", 3000);
});

test("builtin organs are installed the first time without a card, and cannot be removed", async () => {
  const w = world({ builtinApps: ["fixture"] });
  await w.apps.start();
  assert.equal(w.router.cards.length, 0);
  const info = dataOf(await call(w, "service:apps", "apps.describe", { id: "fixture" }));
  assert.equal(info.running, true);
  assert.equal(info.origin, "builtin");
  const removed = await call(w, "service:apps", "apps.remove", { id: "fixture" });
  assert.equal(removed.ok, false);
  assert.ok(existsSync(join(w.root, "fixture")));
});

test("what was installed survives a restart of the hub: the same ledger and folder start the app again, without a card", async () => {
  const first = await installed();
  await call(first, "service:apps", "apps.disable", { id: "fixture" });
  await call(first, "service:apps", "apps.enable", { id: "fixture" });
  await first.apps.stopAll(Date.now() + 2000);
  first.ledger.close();
  const second = world({ root: first.root, dbPath: first.dbPath, fixture: false });
  await second.apps.start();
  assert.equal(second.router.cards.length, 0);
  const info = dataOf(await call(second, "service:apps", "apps.describe", { id: "fixture" }));
  assert.equal(info.running, true);
  assert.deepEqual(info.listens, ["sense.*"]);
  assert.deepEqual(second.registry.members.get("app:fixture")!.listens, ["sense.*"]);
});
