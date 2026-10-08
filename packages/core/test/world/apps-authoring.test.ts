// Writing apps (contract ash-app/1): the contract an agent reads, the skeleton it starts from, the check that says what
// is wrong, an install that refuses a broken app before the owner is asked, and an agent-written app on the owner's card.
// Also what an app gets when the phone cannot answer: a plain sentence for the owner and what ash already recorded.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { wordContract } from "../../../sdk/src/words";
import { ownerText } from "../../src/apps/bridge";
import { installAppDocs } from "../../src/apps/builtin";
import { checkManifest } from "../../src/apps/check";
import { APP_CONTRACT_DOC, HELLO_EXAMPLE, HELLO_EXAMPLE_BINARY } from "../../src/apps/contract.generated";
import { recentFacts } from "../../src/apps/recent";
import { AppRuntime, type AppLauncher } from "../../src/apps/runtime";
import { APP_SCHEMA } from "../../src/apps/schema";
import { APP_CSS, APP_JS, scaffoldFiles } from "../../src/apps/templates";
import { DeviceMember } from "../../src/members/device";
import { OwnerMember } from "../../src/members/owner";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal", local: true, remote: false, ownerProxy: true,
  screenId: "screen:approved", screenLabel: "Test screen" };
const until = async (condition: () => boolean, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(`${label} did not happen`);
};

/** A world with one fake phone whose senses helper can be "away" (as after Android killed it). */
async function world(recent?: ReturnType<typeof recentFacts>) {
  const dir = mkdtempSync(join(tmpdir(), "ash-apps-author-"));
  const root = join(dir, "apps");
  mkdirSync(root);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  const phone = { helper: true, reads: 0 };
  members.registerDevice(new DeviceMember("device:phone", "Fake", [
    { name: "look", description: "Look", label: "看一眼", risk: "none", input_schema: { type: "object", additionalProperties: true } },
    { name: "health.read", description: "Health rows", label: "读健康数据", risk: "none", input_schema: { type: "object", additionalProperties: true } },
  ], (message) => {
    if (message.word === "look") return { ok: true, result: { seen: true } };
    phone.reads++;
    return phone.helper ? { ok: true, result: { rows: [] } } : { ok: false, error: { code: "failed", message: "the phone has no capability health.read" } };
  }));
  router.register({ member: "agent:main", spec: wordContract("agent:main", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  router.enableDurableGate();
  const launcher: AppLauncher = { root: () => root, agentRoot: "/root/apps", spawn: (app, appDir, env) => ({ command: app.server.command === "node" ? process.execPath : app.server.command,
    args: app.server.args ?? [], cwd: appDir, env: { PATH: process.env.PATH ?? "", ...env, ASH_APP_DIR: appDir } }) };
  const runtime = new AppRuntime({ launcher, stateDir: join(dir, "state"), world: router, members, backoffMs: () => 50, bridgeWaitMs: 2000, trialMs: 10_000,
    ...(recent ? { recent } : {}) });
  members.register(runtime.member());
  await runtime.start();
  const call = async (word: string, body: Record<string, unknown>, from: TrustedRouteContext = agent) => {
    const sent = await router.send(from, { to: "service:apps", kind: "request", word, body, wait: true });
    return sent.reply!.body as { ok: boolean; result?: any; error?: { code: string; message: string; detail?: any } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const close = async () => { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); await runtime.close(); ledger.close(); };
  return { dir, root, ledger, router, members, runtime, call, close, phone };
}

/** An agent asks to install; the owner answers the card. */
async function install(w: Awaited<ReturnType<typeof world>>, id: string) {
  const sent = await w.router.send(agent, { to: "service:apps", kind: "request", word: "apps.install", body: { id } });
  await until(() => Boolean(w.ledger.gateCase(sent.id) || w.ledger.responseTo(sent.id)), "install card or refusal");
  const gate = w.ledger.gateCase(sent.id);
  if (!gate) return { ask: null, reply: w.ledger.responseTo(sent.id)! };
  const ask = w.ledger.byId(gate.askId)!;
  await w.router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId, body: { ok: true, result: { choice: "once" } } });
  await until(() => Boolean(w.ledger.responseTo(sent.id)), "install result", 20000);
  return { ask, reply: w.ledger.responseTo(sent.id)! };
}

const write = (dir: string, files: Record<string, string>) => { for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); } };

test("the contract an agent reads is the published doc, with the schema and a hello example that is the scaffold's own pieces", async () => {
  assert.equal(APP_CONTRACT_DOC, readFileSync(join(repo, "docs/APP-CONTRACT.md"), "utf8"), "contract.generated.ts is current (npm run gen:apps)");
  assert.equal(HELLO_EXAMPLE["server.mjs"], readFileSync(join(repo, "docs/examples/hello/server.mjs"), "utf8"));
  assert.equal(HELLO_EXAMPLE["ui/app.js"], APP_JS, "the example's page script is the scaffold's");
  assert.equal(HELLO_EXAMPLE["ui/app.css"], APP_CSS);
  assert.ok(HELLO_EXAMPLE_BINARY["icon.png"]);
  for (const part of ["## 2. 服务", "stdin 收、stdout 发", "## 3. 工具", "## 4. 页面", "ui/initialize", "## 5. `needs`", "## 6. 事件", "owner_text", "## 9. 最小例子"])
    assert.ok(APP_CONTRACT_DOC.includes(part), part);
  const docs = mkdtempSync(join(tmpdir(), "ash-app-docs-"));
  installAppDocs(docs);
  assert.equal(readFileSync(join(docs, "APP-CONTRACT.md"), "utf8"), APP_CONTRACT_DOC);
  assert.ok(readFileSync(join(docs, "_examples/hello/icon.png")).subarray(1, 4).toString() === "PNG");
  const w = await world();
  try {
    const contract = await w.call("apps.contract", {});
    assert.equal(contract.ok, true);
    assert.deepEqual([contract.result.contract, contract.result.doc_path, contract.result.example.path], ["ash-app/1", "/root/apps/APP-CONTRACT.md", "/root/apps/_examples/hello"]);
    assert.deepEqual(contract.result.schema, JSON.parse(JSON.stringify(APP_SCHEMA)));
    assert.ok(JSON.stringify(contract.result).length < 60_000, "small enough to read in one go");
    // The example folder next to the apps is not itself an app.
    installAppDocs(w.root);
    await w.call("apps.refresh", {});
    assert.deepEqual(w.runtime.list().map((app) => app.id), []);
  } finally { await w.close(); }
});

test("scaffold → validate → install (the owner sees an app written by ash) → the agent calls its tool and its page is served", async () => {
  const w = await world();
  try {
    const made = await w.call("apps.scaffold", { id: "notes", name: "笔记", summary: "记几句话", surfaces: [{ id: "home", title: "全部" }, { id: "new", title: "新建" }],
      tools: [{ name: "notes.list", title: "看笔记", read_only: true }, { name: "notes.add", title: "记一条" }] });
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.equal(made.result.path, "/root/apps/notes");
    assert.deepEqual(made.result.files, ["app.json", "icon.png", "server.mjs", "ui/app.css", "ui/app.js", "ui/home.html", "ui/new.html"]);
    const manifest = JSON.parse(readFileSync(join(w.root, "notes/app.json"), "utf8"));
    assert.equal(manifest.publisher, "agent:main");
    assert.equal(manifest.role, "记几句话", "role starts as the summary");
    assert.equal((await w.call("apps.scaffold", { id: "notes", name: "又一个" })).error?.code, "bad_request", "never overwrites an app");

    const report = await w.call("apps.validate", { id: "notes" });
    assert.equal(report.ok, true);
    assert.equal(report.result.ok, true, JSON.stringify(report.result.problems));
    assert.deepEqual([report.result.tools, report.result.surfaces], [["notes.list", "notes.add"], ["home", "new"]]);
    assert.deepEqual(report.result.problems.filter((item: { level: string }) => item.level === "error"), []);
    assert.equal((await w.call("apps.validate", { path: "/root/apps/notes/" })).result.ok, true, "the same folder by its container path");

    const listed = w.runtime.info("notes")!;
    assert.deepEqual([listed.origin, listed.path, listed.granted], ["agent", "/root/apps/notes", false]);
    const { ask, reply } = await install(w, "notes");
    assert.equal(ask!.body.title, "安装 Ash 写的应用「笔记」");
    assert.match(String(ask!.body.detail), /Ash 自己写的，没有发布过/);
    assert.match(String(ask!.body.detail), /不需要用 Ash 的其他东西/);
    assert.match(String(ask!.body.detail), /\/root\/apps\/notes\//);
    assert.equal(reply.body.ok, true, JSON.stringify(reply.body));
    const read = await w.router.send(agent, { to: "app:notes", kind: "request", word: "notes.list", body: {}, wait: true });
    const result = read.reply!.body as { ok: boolean; result: { structuredContent: { text: string } } };
    assert.equal(result.ok, true);
    assert.match(result.result.structuredContent.text, /「看笔记」还没写好/);
    const page = await w.runtime.surface("notes", "new");
    assert.match(page!.html, /^<!doctype html>/);
    assert.match(page!.html, /ui\/initialize/);
    assert.match(page!.html, /在 ui\/new\.html 里写它/);
  } finally { await w.close(); }
});

test("the hello example installs as it is, and its server reaches ash with the scaffold's dependency-free client", async () => {
  const w = await world();
  try {
    cpSync(join(repo, "docs/examples/hello"), join(w.root, "hello"), { recursive: true });
    assert.equal((await w.call("apps.validate", { id: "hello" })).result.ok, true);
    const { ask, reply } = await install(w, "hello");
    assert.equal(ask!.body.title, "安装「你好」");
    assert.match(String(ask!.body.detail), /发布者写的是「example」，Ash 无法核实/);
    assert.equal(reply.body.ok, true);
    const greeted = await w.router.send(agent, { to: "app:hello", kind: "request", word: "hello.greet", body: { who: "皮皮" }, wait: true });
    assert.match((greeted.reply!.body as { result: { structuredContent: { text: string } } }).result.structuredContent.text, /^你好，皮皮！/);
    const failed = await w.router.send(agent, { to: "app:hello", kind: "request", word: "hello.greet", body: { who: "错误" }, wait: true });
    assert.deepEqual(failed.reply!.body, { ok: false, error: { code: "failed", message: "这是一个故意的错误：页面会把这句话显示出来" } });

    // An app of its own that calls back into ash through the template's ash() helper (raw HTTP, no SDK).
    const files = scaffoldFiles({ id: "peek", name: "看看", publisher: "agent:main", tools: [{ name: "peek.look", title: "看一眼", read_only: true }] });
    const server = String(files["server.mjs"]).replace(/case "peek\.look":\n.*\n.*\n/, `case "peek.look": return await ash("capability_call", { member: "device:phone", word: "look", body: {} });\n`);
    assert.notEqual(server, files["server.mjs"]);
    const manifest = JSON.parse(String(files["app.json"]));
    manifest.needs = [{ member: "device:phone", words: ["look"], why: "看一眼" }];
    write(join(w.root, "peek"), { ...Object.fromEntries(Object.entries(files).filter(([, value]) => typeof value === "string")) as Record<string, string>,
      "server.mjs": server, "app.json": JSON.stringify(manifest) });
    assert.equal((await install(w, "peek")).reply.body.ok, true);
    const looked = await w.router.send(agent, { to: "app:peek", kind: "request", word: "peek.look", body: {}, wait: true });
    assert.deepEqual((looked.reply!.body as { result: { structuredContent: unknown } }).result.structuredContent, { ok: true, result: { seen: true } });
  } finally { await w.close(); }
});

test("an install grants exactly the needs its card showed: needs changed while the owner looked refuse the install", async () => {
  const w = await world();
  try {
    assert.equal((await w.call("apps.scaffold", { id: "sneaky", name: "悄悄" })).ok, true);
    const sent = await w.router.send(agent, { to: "service:apps", kind: "request", word: "apps.install", body: { id: "sneaky" } });
    await until(() => Boolean(w.ledger.gateCase(sent.id)), "install card");
    const file = join(w.root, "sneaky/app.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), needs: [{ member: "device:phone", words: ["look"], why: "看一眼" }] }));
    await w.router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: w.ledger.gateCase(sent.id)!.askId, body: { ok: true, result: { choice: "once" } } });
    await until(() => Boolean(w.ledger.responseTo(sent.id)), "install result");
    const body = w.ledger.responseTo(sent.id)!.body as { ok: boolean; error: { message: string } };
    assert.equal(body.ok, false);
    assert.match(body.error.message, /needs 在主人看卡片之后改了/);
    assert.equal(w.runtime.grants.get("sneaky"), null);
  } finally { await w.close(); }
});

test("validate says exactly what is wrong, and install refuses a broken app with those problems before anyone is asked", async () => {
  const w = await world();
  try {
    const base = { contract: "ash-app/1", id: "broken", name: "坏的", version: "1.0.0", summary: "x", publisher: "agent:main", server: { command: "node", args: ["server.mjs"] },
      surfaces: [{ id: "home", title: "首页", resource: "ui://broken/home" }] };
    // app.json problems, each by its field.
    const { problems } = checkManifest(JSON.stringify({ ...base, summary: undefined, colour: "red", needs: [{ member: "device:phone", words: ["health.read"] }], events: ["app.card"] }), "broken");
    const said = problems.map((item) => `${item.where}: ${item.problem}`);
    assert.ok(said.includes("app.json /: 缺少必填字段 summary"), said.join("\n"));
    assert.ok(said.includes("app.json /: 不认识的字段 colour（ash-app/1 不允许多余字段）"), said.join("\n"));
    assert.ok(said.includes("app.json /needs/0: 这一项不是合法的 need"), said.join("\n"));
    assert.ok(said.includes("app.json /events/0: app.card、app.activity 是 Ash 内置的事件，不用也不能在 events 里声明"), said.join("\n"));
    assert.equal(said.length, 4, said.join("\n"));
    assert.match(checkManifest("{ nope", "broken").problems[0]!.problem, /不是合法的 JSON/);
    assert.match(checkManifest(JSON.stringify(base), "other").problems[0]!.problem, /id 是 broken，但文件夹叫 other/);

    // A missing server file, then a server that dies at start: the stderr it left is in the problem.
    write(join(w.root, "broken"), { "app.json": JSON.stringify(base) });
    let report = (await w.call("apps.validate", { id: "broken" })).result;
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((item: { problem: string }) => item.problem === "server 要运行 server.mjs，但文件夹里没有这个文件"), JSON.stringify(report.problems));
    write(join(w.root, "broken"), { "server.mjs": "console.error('cannot find module ./db.mjs'); process.exit(1);" });
    report = (await w.call("apps.validate", { id: "broken" })).result;
    const start = report.problems.find((item: { where: string }) => item.where === "server");
    assert.match(start.problem, /服务没有启动起来/);
    assert.match(start.problem, /cannot find module \.\/db\.mjs/);
    // It speaks MCP, but the page is not served.
    const files = scaffoldFiles({ id: "broken", name: "坏的", publisher: "agent:main" });
    write(join(w.root, "broken"), { "server.mjs": String(files["server.mjs"]), "ui/app.js": APP_JS, "ui/app.css": APP_CSS });
    report = (await w.call("apps.validate", { id: "broken" })).result;
    assert.deepEqual(report.problems.filter((item: { level: string }) => item.level === "error").map((item: { where: string }) => item.where), ["页面 home（ui://broken/home）"]);
    assert.match(report.problems.find((item: { where: string }) => item.where.startsWith("页面")).problem, /resources\/read 读不出来/);
    assert.ok(report.problems.some((item: { where: string; problem: string }) => item.where === "app.json /icon" && /没有图标/.test(item.problem)));

    // The agent's install is refused with the problems; no card reaches the owner.
    const asksBefore = w.ledger.list({ limit: 1000 }).filter((message) => message.word === "ask").length;
    const { ask, reply } = await install(w, "broken");
    assert.equal(ask, null);
    const body = reply.body as { ok: false; error: { code: string; message: string; detail: { problems: { where: string }[] } } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "failed");
    assert.match(body.error.message, /^应用 broken 没通过检查，没有安装（1 个问题）：1\) 页面 home（ui:\/\/broken\/home）：resources\/read 读不出来/);
    assert.ok(body.error.detail.problems.length >= 1);
    assert.equal(w.ledger.list({ limit: 1000 }).filter((message) => message.word === "ask").length, asksBefore);
    assert.equal(existsSync(join(w.dir, "state/app-grants.json")), false);
    assert.equal((await w.call("apps.validate", { path: "/etc" })).result.problems[0].where, "path");
    assert.equal((await install(w, "nothing")).reply.body.ok, false);
  } finally { await w.close(); }
});

test("when the phone cannot answer, an app gets a plain sentence for the owner and what ash already recorded", async () => {
  const now = Date.now();
  const archive = { lines: (_kind: "health", from: number, to: number) => [
    { ts: now - 3 * 3600_000, metric: "steps", value: 4200, unit: "count", source: "gadgetbridge:watch" },
    { ts: now - 2 * 3600_000, metric: "weight", value: 61.8, unit: "kg", source: "scale" },
    { ts: now - 40 * 86_400_000, metric: "steps", value: 1, unit: "count", source: "old" },
  ].filter((line) => line.ts >= from && line.ts < to) };
  const w = await world(recentFacts(() => archive, () => now));
  try {
    const files = scaffoldFiles({ id: "watcher", name: "看着", publisher: "tests" });
    const manifest = { ...JSON.parse(String(files["app.json"])), needs: [{ member: "device:phone", words: ["health.read"], why: "读健康数据" }] };
    write(join(w.root, "watcher"), { "server.mjs": String(files["server.mjs"]), "app.json": JSON.stringify(manifest) });
    w.runtime.grants.grant("watcher", manifest.version, manifest.needs);
    await w.runtime.refresh();
    assert.equal(w.runtime.isRunning("watcher"), true);
    w.phone.helper = false;
    const away = await w.runtime.bridge.call("watcher", "capability_call", { member: "device:phone", word: "health.read", body: { metrics: ["steps", "weight"], from: new Date(now - 7 * 86_400_000).toISOString() } });
    assert.equal(away.ok, false);
    const error = (away as { error: { code: string; message: string; owner_text: string; recent: { as_of: number; source: string; rows: { metric: string }[] } } }).error;
    assert.equal(error.message, "the phone has no capability health.read");
    assert.equal(error.owner_text, "感知暂时不在线，稍后再试");
    assert.deepEqual(error.recent.rows.map((row) => row.metric), ["steps", "weight"]);
    assert.equal(error.recent.as_of, now - 2 * 3600_000);
    assert.equal(error.recent.source, "Ash 的感知记录");
    // Not granted: no sentence about the phone, no records.
    const refused = await w.runtime.bridge.call("watcher", "capability_call", { member: "device:phone", word: "look", body: {} });
    assert.deepEqual(refused, { ok: false, error: { code: "forbidden", message: "device:phone/look was not granted to this app", owner_text: "安装时没有批准这一项，用不了" } });
    w.phone.helper = true;
    assert.equal((await w.runtime.bridge.call("watcher", "capability_call", { member: "device:phone", word: "health.read", body: {} })).ok, true);
  } finally { await w.close(); }
  assert.equal(ownerText("device:phone", "health.read", "offline", "device offline"), "手机暂时没连上 Ash，稍后再试");
  assert.equal(ownerText("device:phone", "health.read", "failed", "health.read is not available right now (a permission or service is off on the phone)"), "感知现在用不了：手机上相关的权限或服务可能没打开");
  assert.equal(ownerText("device:phone", "screen.tap", "failed", "the phone has no capability screen.tap"), "手机上的这项功能暂时不在线，稍后再试");
  assert.equal(ownerText("app:notes", "notes.add", "offline", "笔记 is not running"), "这个应用暂时不在线，稍后再试");
  assert.equal(ownerText("device:phone", "health.read", "pending", "still running"), "还在处理，或在等你在 Ash 里确认");
});

test("every app is an organ: pages without tools do not install; read-only tools or data kept in the page are warned about", async () => {
  const w = await world();
  try {
    const where = (report: { problems: { level: string; where: string; problem: string }[] }) => report.problems.map((item) => `${item.level} ${item.where}: ${item.problem}`);
    // Pages only: the agent could do nothing with the app's data. That is an error, and install refuses it.
    const files = scaffoldFiles({ id: "pageonly", name: "只有页面", publisher: "agent:main" });
    write(join(w.root, "pageonly"), { ...Object.fromEntries(Object.entries(files).filter(([, text]) => typeof text === "string")) as Record<string, string>,
      "server.mjs": String(files["server.mjs"]).replace(/const TOOLS = \[[\s\S]*?\n\];/, "const TOOLS = [];") });
    let report = (await w.call("apps.validate", { id: "pageonly" })).result;
    assert.equal(report.ok, false);
    assert.ok(where(report).includes("error server tools/list: 只有页面、没有可用的工具：Agent 没法通过 app:pageonly 看或改它的数据"), where(report).join("\n"));
    const refused = await install(w, "pageonly");
    assert.equal(refused.ask, null, "the owner is never asked");
    assert.match(String((refused.reply.body as { error: { message: string } }).error.message), /只有页面、没有可用的工具/);

    // Read-only tools behind pages that can change things, and the owner's data kept in the page: warnings.
    const viewer = scaffoldFiles({ id: "viewer", name: "只能看", publisher: "agent:main", tools: [{ name: "viewer.list", title: "看", read_only: true }] });
    write(join(w.root, "viewer"), { ...Object.fromEntries(Object.entries(viewer).filter(([, text]) => typeof text === "string")) as Record<string, string>,
      "ui/home.html": `${String(viewer["ui/home.html"])}<script>localStorage.setItem("items", "[]")</script>` });
    report = (await w.call("apps.validate", { id: "viewer" })).result;
    assert.equal(report.ok, true, "warnings do not block");
    assert.ok(where(report).includes("warning server tools/list: 只有只读工具：页面上能改的数据，Agent 改不了"), where(report).join("\n"));
    assert.ok(where(report).some((line) => line.startsWith("warning 页面 home") && line.includes("localStorage")), where(report).join("\n"));

    // A scaffold with a tool that writes is an organ as it is.
    assert.equal((await w.call("apps.scaffold", { id: "todo", name: "待办", summary: "主人和 Ash 的待办", tools: [{ name: "todo.list", title: "看待办", read_only: true }, { name: "todo.add", title: "记一条待办" }] })).ok, true);
    report = (await w.call("apps.validate", { id: "todo" })).result;
    assert.deepEqual(where(report).filter((line) => line.includes("tools/list") || line.includes("role")), []);
  } finally { await w.close(); }
});
