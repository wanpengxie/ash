// An app's own home-screen cards (contract ash-app/1, app.json cards): drawn from the app's data, owned by app:<id>,
// redrawn whenever anyone changes that data (the owner's page, an agent's tool call, a tick on the card), and a tick on
// the card goes to the app itself, reported to the main agent like any change the owner made.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { AppRuntime, type AppLauncher } from "../../src/apps/runtime";
import { scaffoldFiles } from "../../src/apps/templates";
import { OwnerMember } from "../../src/members/owner";
import { WidgetsMember, type WidgetComponent } from "../../src/members/widgets";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic", local: true, remote: false, ownerProxy: true };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal", local: true, remote: false, ownerProxy: true,
  screenId: "screen:approved", screenLabel: "Test screen" };
const until = async (condition: () => boolean, label: string, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(`${label} did not happen`);
};

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "ash-app-cards-"));
  const root = join(dir, "apps");
  mkdirSync(root);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  const said: string[] = [];
  router.register({ member: "agent:main", spec: wordContract("agent:main", "say")!, handle: (message) => { said.push(String(message.body.text)); return { ok: true, result: { accepted: true } }; } });
  router.enableDurableGate();
  const widgets = new WidgetsMember({ router, file: join(dir, "widgets.json") });
  members.register(widgets);
  const launcher: AppLauncher = { root: () => root, agentRoot: "/root/apps", spawn: (app, appDir, env) => ({ command: app.server.command === "node" ? process.execPath : app.server.command,
    args: app.server.args ?? [], cwd: appDir, env: { PATH: process.env.PATH ?? "", ...env, ASH_APP_DIR: appDir } }) };
  const runtime = new AppRuntime({ launcher, stateDir: join(dir, "state"), world: router, members, backoffMs: () => 50, bridgeWaitMs: 2000, trialMs: 10_000 });
  members.register(runtime.member());
  runtime.attachCards(widgets);
  await runtime.start();
  const send = async (ctx: TrustedRouteContext, to: string, word: string, body: Record<string, unknown>) =>
    (await router.send(ctx, { to, kind: "request", word, body, wait: true })).reply!.body as { ok: boolean; result?: any; error?: { code: string; message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const install = async (id: string) => {
    const sent = await router.send(agent, { to: "service:apps", kind: "request", word: "apps.install", body: { id } });
    await until(() => Boolean(ledger.gateCase(sent.id) || ledger.responseTo(sent.id)), "install card");
    const gate = ledger.gateCase(sent.id);
    const ask = gate ? ledger.byId(gate.askId)! : null;
    if (gate) await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId, body: { ok: true, result: { choice: "once" } } });
    await until(() => Boolean(ledger.responseTo(sent.id)), "install result", 20000);
    return { ask, reply: ledger.responseTo(sent.id)!.body as { ok: boolean } };
  };
  /** The card as the phone gets it: its resolved components. */
  const drawn = (id: string): WidgetComponent[] | null => widgets.snapshot().cards.find((card) => card.id === id)?.a2ui.components ?? null;
  const close = async () => { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); widgets.close(); await runtime.close(); ledger.close(); };
  return { dir, root, ledger, router, members, runtime, widgets, send, install, drawn, said, close };
}

const rows = (components: WidgetComponent[] | null) => (components ?? []).filter((c) => c.component === "CheckBox").map((c) => `${c.label}:${c.checked ?? c.value}`);

test("a scaffolded app's card is drawn from its data and follows every change: the agent's, the owner's page, and a tick on the card", async () => {
  const w = await world();
  try {
    assert.equal((await w.send(agent, "service:apps", "apps.scaffold", { id: "todo", name: "待办", summary: "主人和 Ash 的待办" })).ok, true);
    const manifest = JSON.parse(readFileSync(join(w.root, "todo/app.json"), "utf8"));
    assert.deepEqual(manifest.cards, [{ id: "main", title: "待办", size: "4x4", tool: "todo.card", action: "todo.card.tap" }]);
    const report = await w.send(agent, "service:apps", "apps.validate", { id: "todo" });
    assert.equal(report.result.ok, true, JSON.stringify(report.result.problems));
    const { ask, reply } = await w.install("todo");
    assert.equal(reply.ok, true);
    assert.match(String(ask!.body.detail), /桌面卡片 「待办」/);

    // Drawn at once from the (empty) list; it belongs to the app, and the agent sees it with the widget words.
    await until(() => w.drawn("todo.main") !== null, "the card drawn");
    const listed = await w.send(agent, "service:widgets", "widget.list", {});
    assert.deepEqual(listed.result.cards.map((card: { id: string; owner: string; title: string }) => [card.id, card.owner, card.title]), [["todo.main", "app:todo", "待办"]]);
    assert.deepEqual(w.runtime.info("todo")!.cards, [{ id: "main", title: "待办", size: "4x4", card: "todo.main" }]);
    assert.match(w.runtime.context(), /桌面卡片 todo\.main/);

    // The agent writes through the app's tools: the card shows it.
    const added = await w.send(agent, "app:todo", "todo.add", { title: "买牛奶" });
    assert.equal(added.ok, true);
    await w.send(agent, "app:todo", "todo.add", { title: "给物业打电话" });
    await until(() => rows(w.drawn("todo.main")).length === 2, "the agent's items on the card");
    assert.deepEqual(rows(w.drawn("todo.main")), ["买牛奶:false", "给物业打电话:false"]);
    const items = () => JSON.parse(readFileSync(join(w.root, "todo/data/data.json"), "utf8")).items as { id: string; title: string; done: boolean }[];

    // The owner ticks 给物业打电话 on the card: the app's data changes, the card is drawn from it, Ash is told.
    const row = w.drawn("todo.main")!.find((c) => c.label === "给物业打电话")!;
    assert.equal(row.item, items()[1]!.id);
    const tapped = await w.send(owner, "service:widgets", "widget.tap", { card: "todo.main", component: row.id, checked: true });
    assert.equal(tapped.ok, true, JSON.stringify(tapped));
    await until(() => items()[1]!.done === true, "the app's data changed by the tick");
    await until(() => rows(w.drawn("todo.main")).join() === "买牛奶:false,给物业打电话:true", "the card redrawn from the app's data");
    const activity = w.runtime.recentActivity().at(-1)!;
    assert.deepEqual([activity.kind, activity.app, activity.what, activity.summary], ["owner", "todo", "todo.card.tap", "在桌面卡片上勾掉了：给物业打电话"]);
    assert.ok(w.ledger.list({ limit: 1000 }).some((m) => m.word === "app.activity" && m.from === "app:todo" && m.to === "agent:main"));
    assert.ok(w.ledger.list({ limit: 1000 }).some((m) => m.word === "widget.action" && m.body.owner === "app:todo"));
    assert.deepEqual(w.said, [], "an app's card tap is the app's business, not a message to the agent");

    // The owner's page (a tool call as the owner) moves the card too.
    assert.equal((await w.send(screen, "app:todo", "todo.done", { item: items()[0]!.id, done: true })).ok, true);
    await until(() => rows(w.drawn("todo.main")).join() === "买牛奶:true,给物业打电话:true", "the owner's page change on the card");

    // Nobody else may overwrite the app's card; the agent places it with widget.bind.
    const copy = await w.send(agent, "service:widgets", "widget.card.put", { id: "todo.main", title: "待办", size: "4x4", a2ui: { components: [{ id: "root", component: "Text", text: "x" }] } });
    assert.equal(copy.error?.code, "forbidden");
    await w.send(owner, "service:widgets", "widget.placed", { widgets: [{ id: "5", type: "card" }] });
    assert.deepEqual((await w.send(agent, "service:widgets", "widget.bind", { widget: "5", card: "todo.main" })).result, { widget: "5", card: "todo.main" });

    // Taken away with the app.
    await w.send(owner, "service:apps", "apps.revoke", { id: "todo" });
    assert.equal(w.drawn("todo.main"), null);
  } finally { await w.close(); }
});

test("validate draws each card once: a missing tool or a card the phone cannot draw is an error, with the reason", async () => {
  const w = await world();
  try {
    const files = scaffoldFiles({ id: "bad", name: "坏卡片", publisher: "agent:main" });
    const write = (name: string, text: string | Buffer) => { mkdirSync(join(w.root, "bad", name, ".."), { recursive: true }); writeFileSync(join(w.root, "bad", name), text); };
    for (const [name, text] of Object.entries(files)) write(name, text);
    const manifest = JSON.parse(String(files["app.json"]));
    write("app.json", JSON.stringify({ ...manifest, cards: [...manifest.cards, { id: "ghost", title: "没有", size: "2x2", tool: "bad.nothing" }] }));
    write("server.mjs", String(files["server.mjs"]).replace('{ id: "root", component: "Column"', '{ id: "root", component: "WebView"'));
    const report = (await w.send(agent, "service:apps", "apps.validate", { id: "bad" })).result;
    assert.equal(report.ok, false);
    const problems = report.problems.filter((item: { level: string }) => item.level === "error").map((item: { where: string; problem: string }) => `${item.where}: ${item.problem}`);
    assert.ok(problems.some((text: string) => /^卡片 main: 手机画不出这张卡片：WebView "root" cannot be drawn/.test(text)), problems.join("\n"));
    assert.ok(problems.some((text: string) => /^卡片 ghost: tool 写的是 bad\.nothing/.test(text)), problems.join("\n"));
  } finally { await w.close(); }
});

test("the agent runs its apps itself: restart after an edit, read the logs, reset the data, remove the app", async () => {
  const w = await world();
  try {
    const apps = (word: string, body: Record<string, unknown>) => w.send(agent, "service:apps", word, body);
    assert.equal((await apps("apps.scaffold", { id: "notes", name: "笔记", tools: [{ name: "notes.crash", title: "崩一下" }] })).ok, true);
    assert.equal((await w.install("notes")).reply.ok, true);
    const server = join(w.root, "notes/server.mjs");
    const original = readFileSync(server, "utf8");

    // An edit takes effect on restart, which checks the app first; what the server says is in its logs.
    writeFileSync(server, original.replace('console.log = (...args) => console.error(...args);', 'console.log = (...args) => console.error(...args);\nconsole.error("笔记 第二版 启动了");'));
    const restarted = await apps("apps.restart", { id: "notes" });
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    assert.equal(restarted.result.running, true);
    await until(() => w.runtime.logs("notes").lines.some((line) => line.endsWith("笔记 第二版 启动了")), "the server's stderr in its logs");
    const logs = await apps("apps.logs", { id: "notes", lines: 50 });
    assert.ok(logs.result.lines.some((line: string) => line.includes("[Ash] 启动 0.1.0")), logs.result.lines.join("\n"));

    // A broken edit is not restarted: the problems come back and the running version stays.
    writeFileSync(server, "this is not javascript (");
    const refused = await apps("apps.restart", { id: "notes" });
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /没通过检查/);
    assert.equal(w.runtime.isRunning("notes"), true);
    writeFileSync(server, original.replace(/case "notes\.crash":\n.*\n.*\n/, 'case "notes.crash": process.exit(3);\n'));
    assert.equal((await apps("apps.restart", { id: "notes" })).ok, true);

    // A crash: how it ended is in the logs, and it comes back.
    await w.send(agent, "app:notes", "notes.crash", {});
    await until(() => w.runtime.logs("notes").last_exit?.code === 3, "the exit recorded");
    assert.equal((await apps("apps.logs", { id: "notes" })).result.last_exit.reason, "出错退出（退出码 3）");
    await until(() => w.runtime.isRunning("notes"), "restarted after the crash");

    // Reset empties data_dir only; the card is drawn from the empty data.
    await w.send(agent, "app:notes", "notes.add", { title: "一条" });
    await until(() => rows(w.drawn("notes.main")).length === 1, "the item on the card");
    const reset = await apps("apps.reset", { id: "notes" });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.result.cleared, "/root/apps/notes/data");
    assert.equal((await w.send(agent, "app:notes", "notes.list", {})).result.structuredContent.items.length, 0);
    await until(() => rows(w.drawn("notes.main")).length === 0, "the card emptied");
    assert.ok(existsSync(join(w.root, "notes/server.mjs")));

    // Remove: keep_data leaves the folder (not installed), otherwise it is gone with its cards. Ash's own apps stay.
    const kept = await apps("apps.remove", { id: "notes", keep_data: true });
    assert.deepEqual(kept.result, { id: "notes", removed: true, kept: "/root/apps/notes" });
    assert.deepEqual([w.runtime.info("notes")!.granted, w.runtime.isRunning("notes"), w.drawn("notes.main")], [false, false, null]);
    assert.equal((await apps("apps.remove", { id: "notes" })).ok, true);
    assert.equal(existsSync(join(w.root, "notes")), false);
    assert.equal((await apps("apps.list", {})).result.apps.length, 0);
    mkdirSync(join(w.root, "health"));
    writeFileSync(join(w.root, "health/app.json"), JSON.stringify({ contract: "ash-app/1", id: "health", name: "健康", version: "9.0.0", summary: "x", publisher: "ash", server: { command: "node" } }));
    await apps("apps.refresh", {});
    assert.match((await apps("apps.remove", { id: "health" })).error!.message, /Ash 自带的应用.*apps\.disable/);
    assert.match((await apps("apps.reset", { id: "health" })).error!.message, /没写 data_dir/);
  } finally { await w.close(); }
});
