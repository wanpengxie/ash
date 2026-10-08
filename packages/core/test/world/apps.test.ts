// Independent apps (contract ash-app/1): app.json validation, discovery, install approval and grants, app:<id>
// capabilities and their risk, the app's calls and events back into ash, and the shell app's HTTP routes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Message } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { installBuiltinApps } from "../../src/apps/builtin";
import { BUILTIN_APPS } from "../../src/apps/builtin.generated";
import { AppRuntime, appCapabilities, type AppLauncher } from "../../src/apps/runtime";
import { APP_SCHEMA, compareVersions, validateManifest } from "../../src/apps/schema";
import { DeviceMember } from "../../src/members/device";
import { OwnerMember } from "../../src/members/owner";
import { EdgeRouter, type EdgeCaller } from "../../src/server";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const fixtureServer = join(here, "fixtures/fake-app-server.mjs");
const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal", local: true, remote: false, ownerProxy: true,
  screenId: "screen:approved", screenLabel: "Test screen" };
const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "owner", transport: "api", ownerProxy: true, local: true, remote: false };
const until = async (condition: () => boolean, label: string, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(`${label} did not happen`);
};

function fixtureManifest(id = "fixture", extra: Record<string, unknown> = {}) {
  return { contract: "ash-app/1", id, name: "测试应用", version: "1.0.0", icon: "icon.svg", summary: "A fixture", publisher: "tests",
    server: { command: process.execPath, args: [fixtureServer] },
    surfaces: [{ id: "home", title: "首页", resource: "ui://fixture/home" }], events: ["fixture.alert"],
    needs: [{ member: "device:fake", words: ["look"], why: "看一眼" }, { card: true, why: "入口卡片" }, { notify: true, why: "提醒" }], ...extra };
}

async function world(options: { apps?: Record<string, unknown>; builtins?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ash-apps-"));
  const root = join(dir, "apps");
  mkdirSync(root);
  for (const [id, manifest] of Object.entries(options.apps ?? { fixture: fixtureManifest() })) {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "app.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    writeFileSync(join(root, id, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  }
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  let looks = 0, pokes = 0;
  members.registerDevice(new DeviceMember("device:fake", "Fake", [
    { name: "look", description: "Look", label: "看一眼", risk: "none", input_schema: { type: "object", additionalProperties: true } },
    { name: "poke", description: "Poke", label: "戳一下", risk: "outward", input_schema: { type: "object", additionalProperties: true } },
  ], (message) => { if (message.word === "look") { looks++; return { ok: true, result: { seen: true } }; } pokes++; return { ok: true, result: { poked: true } }; }));
  members.registerDevice(new DeviceMember("device:phone", "Phone", [
    { name: "health.read", description: "Read health data", label: "读健康数据", risk: "none", input_schema: { type: "object", additionalProperties: true } },
  ], () => ({ ok: true, result: { rows: [] } })));
  router.register({ member: "agent:main", spec: wordContract("agent:main", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  router.enableDurableGate();
  const launcher: AppLauncher = { root: () => root, spawn: (app, appDir, env) => ({ command: app.server.command, args: app.server.args ?? [], cwd: appDir,
    env: { PATH: process.env.PATH ?? "", ...env, ASH_APP_DIR: appDir } }) };
  const runtime = new AppRuntime({ launcher, stateDir: join(dir, "state"), world: router, members, backoffMs: () => 50, bridgeWaitMs: 2000,
    ...(options.builtins ? { builtins: (at: string) => { installBuiltinApps(at); } } : {}) });
  members.register(runtime.member());
  await runtime.start();
  const close = async () => { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); await runtime.close(); ledger.close(); };
  return { dir, root, ledger, router, members, runtime, close, looks: () => looks, pokes: () => pokes };
}

/** An agent asks to install; the owner answers the gate card on a screen. */
async function install(w: Awaited<ReturnType<typeof world>>, id: string, choice: "once" | "deny" = "once") {
  const sent = await w.router.send(agent, { to: "service:apps", kind: "request", word: "apps.install", body: { id } });
  await until(() => Boolean(w.ledger.gateCase(sent.id)), "install card");
  const gate = w.ledger.gateCase(sent.id)!;
  const ask = w.ledger.byId(gate.askId)!;
  await w.router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId, body: { ok: true, result: { choice } } });
  await until(() => Boolean(w.ledger.responseTo(sent.id)), "install result", 15000);
  return { ask, reply: w.ledger.responseTo(sent.id)! };
}

test("app.json: the published schema is the one ash validates with, and invalid descriptions say why", () => {
  assert.deepEqual(JSON.parse(readFileSync(join(repo, "docs/app.schema.json"), "utf8")), JSON.parse(JSON.stringify(APP_SCHEMA)));
  const health = JSON.parse(readFileSync(join(repo, "packages/apps/health/app.json"), "utf8"));
  assert.equal(validateManifest(health).ok, true);
  assert.equal(validateManifest(fixtureManifest()).ok, true);
  const bad = (change: Record<string, unknown>) => validateManifest({ ...fixtureManifest(), ...change });
  assert.match((bad({ id: "Fixture" }) as { error: string }).error, /id/);
  assert.match((bad({ contract: "ash-app/2" }) as { error: string }).error, /contract/);
  assert.equal(bad({ server: { command: "node", env: { ASH_MCP_TOKEN: "x" } } }).ok, false, "an app cannot set ash's variables");
  assert.equal(bad({ surfaces: [{ id: "home", title: "x", resource: "https://example.com" }] }).ok, false, "surfaces are ui:// resources");
  assert.equal(bad({ events: ["app.card"] }).ok, false);
  assert.equal(bad({ needs: [{ member: "service:gate", words: ["rules.set"], why: "x" }] }).ok, false, "only device and app members can be needed");
  assert.equal(bad({ needs: [{ card: true, why: "a" }, { card: true, why: "b" }] }).ok, false);
  assert.equal(bad({ unknown: 1 }).ok, false);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0 && compareVersions("1.0.0", "1.0.0") === 0 && compareVersions("0.9.0", "1.0.0") < 0);
});

test("discovery lists valid apps, skips invalid ones with a reason, and starts nothing before the owner installs", async () => {
  const w = await world({ apps: { fixture: fixtureManifest(), broken: "{not json", other: fixtureManifest("someone-else") } });
  try {
    const list = w.runtime.list();
    assert.deepEqual(list.map((app) => app.id), ["broken", "fixture", "other"]);
    assert.match(list[0]!.error!, /not JSON/);
    assert.match(list[2]!.error!, /does not match its folder/);
    assert.deepEqual([list[1]!.granted, list[1]!.running], [false, false]);
    assert.throws(() => w.members.describe("agent", "app:fixture"), RouterError);
  } finally { await w.close(); }
});

test("built-in apps are installed when missing or older and never overwrite a same or newer version", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-builtin-"));
  const health = BUILTIN_APPS.find((app) => app.id === "health")!;
  assert.ok(health && health.files["server.mjs"]!.length > 1000 && health.files["icon.svg"]);
  assert.deepEqual(installBuiltinApps(root), BUILTIN_APPS.map((app) => app.id));
  assert.equal(JSON.parse(readFileSync(join(root, "health/app.json"), "utf8")).version, health.version);
  writeFileSync(join(root, "health/data.json"), "{\"goals\":{\"steps\":8000}}");
  assert.deepEqual(installBuiltinApps(root), [], "same version: untouched");
  writeFileSync(join(root, "health/app.json"), JSON.stringify({ version: "0.0.1" }));
  assert.deepEqual(installBuiltinApps(root), ["health"], "older version: replaced");
  assert.equal(readFileSync(join(root, "health/data.json"), "utf8"), "{\"goals\":{\"steps\":8000}}", "the app's own data stays");
  writeFileSync(join(root, "health/app.json"), JSON.stringify({ version: "9.0.0" }));
  assert.deepEqual(installBuiltinApps(root), [], "newer (changed by the owner) stays");
});

test("an app's tools become capabilities with an honest effect, no risk of their own, and ash's label", () => {
  const caps = appCapabilities("健康", [
    { name: "health.today", title: "看今日健康", description: "Today", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "health.log", description: "Log", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    { name: "health.wipe", description: "Wipe", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "health.bare", inputSchema: { type: "object" } },
    { name: "Not Valid", inputSchema: { type: "object" } },
  ]);
  // The effect stays honest; the risk is none: an app's own tools are its organ's, approved with the app at install.
  assert.deepEqual(caps.map((cap) => [cap.name, cap.risk, cap.effect]), [["health.today", "none", "read"], ["health.log", "none", "write"],
    ["health.wipe", "none", "write"], ["health.bare", "none", "write"]]);
  assert.equal(caps[0]!.label, "在健康里看今日健康");
  assert.equal(caps[1]!.label, "在健康里health.log");
});

test("install asks the owner on the gate card listing every need; approval stores the grants and starts app:<id>", async () => {
  const w = await world();
  try {
    // An agent's install is never auto-approved: no reviewer runs, the card names what the app needs.
    const denied = await install(w, "fixture", "deny");
    assert.equal(denied.ask.body.title, "安装「测试应用」");
    assert.match(String(denied.ask.body.detail), /看一眼（device:fake：look）/);
    assert.match(String(denied.ask.body.detail), /入口卡片/);
    assert.deepEqual((denied.ask.body.options as { id: string }[]).map((option) => option.id), ["once", "deny"], "no 'always' for widening an app");
    assert.equal(denied.reply.body.ok, false);
    assert.equal(existsSync(join(w.dir, "state/app-grants.json")), false);

    const { reply } = await install(w, "fixture");
    assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
    const grants = JSON.parse(readFileSync(join(w.dir, "state/app-grants.json"), "utf8"));
    assert.equal(grants.apps.fixture.enabled, true);
    assert.deepEqual(grants.apps.fixture.needs.map((need: { member?: string }) => need.member ?? "kind"), ["device:fake", "kind", "kind"]);
    const described = w.members.describe("agent", "app:fixture").members[0]!;
    assert.equal(described.kind, "app");
    const words = Object.fromEntries(described.words.map((word) => [word.word, word]));
    assert.deepEqual(Object.keys(words).sort(), ["fixture.crash", "fixture.fail", "fixture.pay", "fixture.read", "fixture.wipe", "fixture.write"]);
    assert.deepEqual([words["fixture.read"]!.effect, words["fixture.write"]!.effect, words["fixture.wipe"]!.effect], ["read", "write", "write"]);
    assert.deepEqual([words["fixture.read"]!.risk, words["fixture.write"]!.risk, words["fixture.wipe"]!.risk], ["none", "none", "none"]);
    assert.equal(words["fixture.write"]!.label, "在测试应用里改数据");

    // Agents use it as an organ of ash: reads and writes alike run at once, no card (see "no card" below).
    const read = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.read", body: { n: 1 }, wait: true });
    const result = read.reply!.body as { ok: boolean; result: { structuredContent: Record<string, unknown> } };
    assert.equal(result.ok, true);
    assert.equal(result.result.structuredContent.app, "fixture");
    assert.equal(result.result.structuredContent.has_token, true);
    assert.match(String(result.result.structuredContent.url), /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const failed = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.fail", body: {}, wait: true });
    assert.deepEqual(failed.reply!.body, { ok: false, error: { code: "failed", message: "nope" } });
  } finally { await w.close(); }
});

test("an app reaches ash only within its grants and its events are recorded, rate limited", async () => {
  const w = await world();
  try {
    await install(w, "fixture");
    const bridge = w.runtime.bridge;
    assert.deepEqual(await bridge.call("fixture", "capability_call", { member: "device:fake", word: "look", body: {} }), { ok: true, result: { seen: true } });
    assert.equal(w.looks(), 1);
    const refused = await bridge.call("fixture", "capability_call", { member: "device:fake", word: "poke", body: {} });
    assert.equal(refused.ok, false);
    assert.equal(w.pokes(), 0);
    // The router refuses it too, even with the app's own transport.
    const app: TrustedRouteContext = { transport: "app", member: "app:fixture", transportPrincipal: "app:fixture", local: true, remote: false, ownerProxy: false };
    await assert.rejects(w.router.send(app, { to: "device:fake", kind: "request", word: "poke", body: {} }), /granted/);
    await assert.rejects(w.router.send(app, { to: "agent:main", kind: "request", word: "say", body: { text: "hi" } }), /granted/);
    await assert.rejects(w.router.send(app, { to: "app:fixture", kind: "request", word: "fixture.read", body: {} }), /granted/);
    // The same over the real loopback MCP endpoint, as the health app's client speaks it; a wrong token gets nothing.
    const { ashClient } = await import(join(repo, "packages/apps/health/src/ash.mjs") as string) as { ashClient: (url: string, token: string) => { call: (m: string, w: string, b: object) => Promise<unknown> } };
    const token = bridge.bind("fixture");
    assert.deepEqual(await ashClient(bridge.url, token).call("device:fake", "look", {}), { seen: true });
    await assert.rejects(ashClient(bridge.url, token).call("device:fake", "poke", {}), /forbidden/);
    await assert.rejects(ashClient(bridge.url, "wrong").call("device:fake", "look", {}));
    const listed = await bridge.call("fixture", "capability_list", {}) as { ok: true; result: { members: { id: string; capabilities: { word: string }[] }[] } };
    assert.deepEqual(listed.result.members.map((member) => [member.id, member.capabilities.map((item) => item.word)]), [["device:fake", ["look"]]]);

    const events: Message[] = [];
    const stop = w.router.subscribe((message) => { if (message.from === "app:fixture" && message.kind === "event") events.push(message); });
    assert.deepEqual(await bridge.call("fixture", "ash_event", { name: "app.card", body: { title: "本周小结", text: "走了很多路" } }), { ok: true, result: { recorded: true } });
    assert.equal((await bridge.call("fixture", "ash_event", { name: "app.card", body: { title: "又一张" } })).ok, false, "one card a day");
    assert.equal((await bridge.call("fixture", "ash_event", { name: "fixture.unknown", body: {} })).ok, false, "undeclared events are refused");
    assert.equal((await bridge.call("fixture", "ash_event", { name: "fixture.alert", body: { text: "注意" } })).ok, true);
    assert.equal((await bridge.call("fixture", "ash_event", { name: "fixture.alert", body: { level: 1 } })).ok, true);
    stop();
    assert.deepEqual(events.map((event) => [event.word, event.to]), [["app.card", "person:owner"], ["fixture.alert", "person:owner"], ["fixture.alert", null]]);
    assert.deepEqual(events[0]!.body, { app: "fixture", name: "测试应用", title: "本周小结", text: "走了很多路" });

    // Revoking the card need narrows at once; revoking everything stops the app.
    await w.router.send(screen, { to: "service:apps", kind: "request", word: "apps.revoke", body: { id: "fixture", need: "device:fake" }, wait: true });
    assert.equal((await bridge.call("fixture", "capability_call", { member: "device:fake", word: "look", body: {} })).ok, false);
    await w.router.send(screen, { to: "service:apps", kind: "request", word: "apps.revoke", body: { id: "fixture" }, wait: true });
    assert.equal(w.runtime.isRunning("fixture"), false);
    assert.throws(() => w.members.describe("agent", "app:fixture"), RouterError);
  } finally { await w.close(); }
});

test("a crashed app comes back; disable stops it; enable by an agent asks the owner", async () => {
  const w = await world();
  try {
    await install(w, "fixture");
    const first = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.read", body: {}, wait: true });
    const pid = (first.reply!.body as { result: { structuredContent: { pid: number } } }).result.structuredContent.pid;
    await w.router.send(screen, { to: "app:fixture", kind: "request", word: "fixture.crash", body: {} });
    await until(() => !w.runtime.isRunning("fixture"), "crash noticed");
    await until(() => w.runtime.isRunning("fixture"), "restart");
    const again = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.read", body: {}, wait: true });
    assert.notEqual((again.reply!.body as { result: { structuredContent: { pid: number } } }).result.structuredContent.pid, pid);

    await w.router.send(agent, { to: "service:apps", kind: "request", word: "apps.disable", body: { id: "fixture" }, wait: true });
    assert.equal(w.runtime.isRunning("fixture"), false);
    const enable = await w.router.send(agent, { to: "service:apps", kind: "request", word: "apps.enable", body: { id: "fixture" } });
    await until(() => Boolean(w.ledger.gateCase(enable.id)), "enable card");
    assert.equal(w.ledger.byId(w.ledger.gateCase(enable.id)!.askId)!.body.title, "重新打开「测试应用」");
  } finally { await w.close(); }
});

test("the shell app's owner routes: list, icon, surface, call and message", async () => {
  const w = await world();
  const edge = new EdgeRouter(w.ledger, w.router, w.members, { api: {}, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1), waitMs: 5000 });
  edge.attachApps(w.runtime);
  const http = async (method: string, path: string, body?: unknown, caller: EdgeCaller = owner) => {
    const response = await edge.handle({ method, url: new URL(path, "http://ash"), headers: {}, body: body === undefined ? null : Buffer.from(JSON.stringify(body)) }, caller);
    return { status: response.status, headers: "headers" in response ? response.headers ?? {} : {},
      body: "body" in response ? response.body : undefined, json: () => JSON.parse(String("body" in response ? response.body : "")) };
  };
  try {
    let list = await http("GET", "/api/apps");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json(), [{ id: "fixture", name: "测试应用", version: "1.0.0", summary: "A fixture", icon: "/api/apps/fixture/icon",
      surfaces: [{ id: "home", title: "首页" }], enabled: false, granted: false }]);
    assert.equal((await http("GET", "/api/apps/fixture/surfaces/home")).status, 503, "not running before install");
    const agentCaller: EdgeCaller = { member: "agent:main", transportPrincipal: "agent:main", transport: "agent", ownerProxy: false, local: true, remote: false };
    assert.equal((await http("GET", "/api/apps", undefined, agentCaller)).status, 403, "owner only");

    await install(w, "fixture");
    list = await http("GET", "/api/apps");
    assert.deepEqual([list.json()[0].enabled, list.json()[0].granted], [true, true]);
    const icon = await http("GET", "/api/apps/fixture/icon");
    assert.equal(icon.status, 200);
    assert.equal(icon.headers["content-type"], "image/svg+xml");
    const surface = await http("GET", "/api/apps/fixture/surfaces/home");
    assert.deepEqual(surface.json(), { html: "<!doctype html><p>fixture</p>", csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] } });
    assert.equal((await http("GET", "/api/apps/fixture/surfaces/none")).status, 404);

    const call = await http("POST", "/api/apps/fixture/call", { tool: "fixture.write", arguments: { v: "from the shell" } });
    assert.equal(call.status, 200);
    const result = call.json();
    assert.equal(result.structuredContent.tool, "fixture.write", "the owner's own call needs no approval");
    assert.ok(Array.isArray(result.content));
    assert.ok(w.ledger.list({ limit: 500 }).some((message) => message.from === "person:owner" && message.to === "app:fixture" && message.word === "fixture.write"), "recorded in the ledger");
    assert.deepEqual((await http("POST", "/api/apps/fixture/call", { tool: "fixture.fail" })).json(), { content: [{ type: "text", text: "nope" }], isError: true });
    assert.equal((await http("POST", "/api/apps/fixture/call", { tool: "fixture.none" })).status, 404);

    const message = await http("POST", "/api/apps/fixture/message", { text: "帮我看看" });
    assert.equal(message.status, 200);
    const said = w.ledger.byId(message.json().id)!;
    assert.deepEqual([said.from, said.to, said.word, said.body.text], ["person:owner", "agent:main", "say", "[来自「测试应用」] 帮我看看"]);
    assert.equal((await http("GET", "/api/apps/nothing/icon")).status, 404);
  } finally { await w.close(); }
});

test("an agent uses an installed app's own tools with no card; the app's own reach outside stays within its grants", async () => {
  const w = await world({ apps: { fixture: fixtureManifest(), steps: fixtureManifest("steps", {
    surfaces: [{ id: "home", title: "首页", resource: "ui://steps/home" }],
    needs: [{ member: "device:phone", words: ["health.read"], why: "读步数" }, { member: "device:fake", words: ["poke"], why: "戳一下" }] }) } });
  try {
    await install(w, "fixture");
    // The main agent writes into the app (todo.add on the phone): it runs at once, nothing reaches the gate.
    const write = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.write", body: { v: "明天给物业打电话" }, wait: true });
    assert.equal(write.reply!.body.ok, true, JSON.stringify(write.reply!.body));
    assert.equal(w.ledger.gateCase(write.id), null, "no approval case, no card");
    // The same through capability_call's approval context: still no card, and the normal run time rather than a card's lifetime.
    const viaTool = await w.router.send({ ...agent, approval: { ttlMinutes: 10, purpose: "记一条待办" } },
      { to: "app:fixture", kind: "request", word: "fixture.write", body: { v: "交水费" }, wait: true });
    assert.equal(viaTool.reply!.body.ok, true);
    assert.equal(w.ledger.gateCase(viaTool.id), null);
    assert.equal(w.ledger.humanPendingList().items.length, 0, "nothing waits on the owner");
    // A recognised payment still asks the owner, as everywhere.
    const pay = await w.router.send(agent, { to: "app:fixture", kind: "request", word: "fixture.pay", body: {} });
    await until(() => Boolean(w.ledger.gateCase(pay.id)), "payment card");

    // The app's own call to device:phone health.read needs its grant: fixture was not granted it.
    const app: TrustedRouteContext = { transport: "app", member: "app:fixture", transportPrincipal: "app:fixture", local: true, remote: false, ownerProxy: false };
    await assert.rejects(w.router.send(app, { to: "device:phone", kind: "request", word: "health.read", body: {} }), /granted/);
    const refused = await w.runtime.bridge.call("fixture", "capability_call", { member: "device:phone", word: "health.read", body: {} }) as { ok: boolean; error?: { code: string } };
    assert.deepEqual([refused.ok, refused.error?.code], [false, "forbidden"]);
    // An app granted it reads at once; its granted non-read reach outside still asks the owner on a card.
    await install(w, "steps");
    assert.deepEqual(await w.runtime.bridge.call("steps", "capability_call", { member: "device:phone", word: "health.read", body: {} }), { ok: true, result: { rows: [] } });
    const steps: TrustedRouteContext = { ...app, member: "app:steps", transportPrincipal: "app:steps" };
    const poke = await w.router.send(steps, { to: "device:fake", kind: "request", word: "poke", body: {} });
    await until(() => Boolean(w.ledger.gateCase(poke.id)), "the app's poke asks the owner");
    assert.equal(w.ledger.byId(w.ledger.gateCase(poke.id)!.askId)!.body.title, "「测试应用」需要你确认");
    assert.equal(w.pokes(), 0);
  } finally { await w.close(); }
});
