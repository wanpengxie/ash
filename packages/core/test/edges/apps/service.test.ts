import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DEFAULT_APP_ICON } from "../../../src/edges/apps/runtime";
import { join } from "node:path";
import test from "node:test";
import { wordsOf } from "../../../../sdk/src/words";
import { AGENT, call, dataOf, installFixtureFolder, stubMember, until, world, type World } from "./helpers";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
async function installed(options: Parameters<typeof world>[0] = {}): Promise<World> {
  const w = world({ contract: { doc: "# Contract doc for tests", docPath: "/root/apps/APP-CONTRACT.md" }, ...options });
  await w.apps.start();
  const reply = await call(w, "service:apps", "apps.install", { id: "fixture" });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return w;
}
const words = (w: World, word: string, body: unknown = {}, caller?: Parameters<typeof call>[4]) => call(w, "service:apps", word, body, caller);

test("service:apps speaks every word its contract lists, and no word more", async () => {
  const w = await installed();
  const names = wordsOf("service:apps").map((word) => word.word);
  assert.equal(names.length, 19);
  assert.ok(["apps.list", "apps.describe", "apps.install", "apps.enable", "apps.disable", "apps.revoke", "apps.refresh", "apps.sleep", "apps.wake", "apps.restart", "apps.logs", "apps.reset",
    "apps.remove", "apps.contract", "apps.scaffold", "apps.validate", "apps.surface", "apps.icon", "apps.badge"].every((name) => names.includes(name)));
  assert.deepEqual(w.apps.service.words().map((word) => word.word), names);
  for (const word of names) {
    const reply = await words(w, word, { id: "no-such-app", surface: "home", name: "x" });
    if (!reply.ok) assert.notEqual(reply.error.message, `service:apps has no word ${word}`, word);
  }
  const unknown = await words(w, "apps.nothing");
  assert.equal(unknown.ok === false && unknown.error.code, "not_found");
});

test("list, describe, refresh: what is in the folder and what the owner installed", async () => {
  const w = await installed();
  const listed = dataOf(await words(w, "apps.list")).apps;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "fixture");
  assert.equal(listed[0].running, true);
  assert.deepEqual(listed[0].tools.sort(), ["fixture.add", "fixture.ash", "fixture.await", "fixture.emit", "fixture.exit", "fixture.list"]);
  assert.equal(listed[0].origin, "other");
  assert.equal(listed[0].path, `${w.root}/fixture`);
  const described = dataOf(await words(w, "apps.describe", { id: "fixture" }));
  assert.deepEqual(described.events, ["fixture.ping", "fixture.alert"]);
  assert.equal(described.needs[0].member, "device:*");
  const missing = await words(w, "apps.describe", { id: "nope" });
  assert.equal(missing.ok === false && missing.error.code, "not_found");
  installFixtureFolder(w.root, (app) => { app.id = "second"; }, "second");
  const refreshed = dataOf(await words(w, "apps.refresh")).apps;
  assert.deepEqual(refreshed.map((app: { id: string; running: boolean }) => [app.id, app.running]), [["fixture", true], ["second", false]]);
});

test("an app whose app.json is broken is listed with what kind of trouble it is, for a screen that must not show the raw line", async () => {
  const w = await installed();
  installFixtureFolder(w.root, () => {}, "broken");
  writeFileSync(join(w.root, "broken", "app.json"), "{ not json");
  const listed = dataOf(await words(w, "apps.refresh")).apps as { id: string; granted: boolean; error?: string; problem?: string }[];
  const broken = listed.find((app) => app.id === "broken")!;
  assert.equal(broken.granted, false);
  assert.match(broken.error ?? "", /app\.json/);
  assert.equal(broken.problem, "manifest");
  assert.equal(listed.find((app) => app.id === "fixture")!.problem, undefined, "a healthy app has none");
});

test("disable stops the app and keeps its grants; enable starts it again; revoke narrows, revoking everything stops it", async () => {
  const w = await installed();
  const off = dataOf(await words(w, "apps.disable", { id: "fixture" }));
  assert.deepEqual([off.enabled, off.granted, off.running], [false, true, false]);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  const on = dataOf(await words(w, "apps.enable", { id: "fixture" }));
  assert.deepEqual([on.enabled, on.running], [true, true]);
  const narrowed = dataOf(await words(w, "apps.revoke", { id: "fixture", need: "device:*" }));
  assert.deepEqual(narrowed.needs, []);
  assert.equal(narrowed.running, true);
  const gone = dataOf(await words(w, "apps.revoke", { id: "fixture" }));
  assert.deepEqual([gone.granted, gone.running], [false, false]);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  const enable = await words(w, "apps.enable", { id: "fixture" });
  assert.equal(enable.ok, false, "a revoked app has to be installed again");
});

test("restart: edits to the server take effect; a wider app.json is refused until it is installed again", async () => {
  const w = await installed();
  const server = join(w.root, "fixture", "server.mjs");
  writeFileSync(server, readFileSync(server, "utf8").replace('{ name: "fixture.exit"', '{ name: "fixture.extra", title: "Extra", description: "Added by an edit.", inputSchema: object(), annotations: { readOnlyHint: true } },\n  { name: "fixture.exit"')
    .replace('case "fixture.exit"', 'case "fixture.extra": return { extra: true };\n    case "fixture.exit"'));
  assert.equal(w.registry.find("app:fixture", "fixture.extra"), null);
  const restarted = dataOf(await words(w, "apps.restart", { id: "fixture" }));
  assert.equal(restarted.running, true);
  assert.deepEqual(dataOf(await call(w, "app:fixture", "fixture.extra")), { extra: true });
  const file = join(w.root, "fixture", "app.json");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.needs.push({ notify: true, why: "to remind you" });
  writeFileSync(file, JSON.stringify(app));
  const refused = await words(w, "apps.restart", { id: "fixture" });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused), /apps\.install/);
  const broken = await words(w, "apps.restart", { id: "nope" });
  assert.equal(broken.ok === false && broken.error.code, "not_found");
});

test("logs: the starts, stderr and exits; reset empties the data folder and restarts; remove deletes (or keeps the data)", async () => {
  const w = await installed();
  const logs = dataOf(await words(w, "apps.logs", { id: "fixture", lines: 50 }));
  assert.equal(logs.running, true);
  assert.ok(logs.lines.some((line: string) => /启动 1\.0\.0/.test(line)));
  await call(w, "app:fixture", "fixture.add", { text: "milk" });
  const cleared = dataOf(await words(w, "apps.reset", { id: "fixture" }));
  assert.equal(cleared.cleared, `${w.root}/fixture/data`);
  assert.deepEqual(dataOf(await call(w, "app:fixture", "fixture.list")).notes, []);
  assert.equal(dataOf(await words(w, "apps.describe", { id: "fixture" })).running, true);
  const kept = dataOf(await words(w, "apps.remove", { id: "fixture", keep_data: true }));
  assert.deepEqual([kept.removed, kept.kept], [true, `${w.root}/fixture`]);
  assert.ok(existsSync(join(w.root, "fixture")));
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
  assert.equal(w.apps.runtime.grants.get("fixture"), null);
  const removed = dataOf(await words(w, "apps.remove", { id: "fixture" }));
  assert.deepEqual([removed.removed, removed.kept], [true, null]);
  assert.ok(!existsSync(join(w.root, "fixture")));
});

/** A stand-in for service:clock that records `cancel.owner`; `fails` makes it refuse. */
function withClock(w: World, fails = false) {
  const clock = stubMember("service:clock", "service", [{ word: "cancel.owner", callers: ["kernel"] }], {
    "cancel.owner": () => { if (fails) throw new Error("clock down"); return { data: { cancelled: 1 } }; },
  });
  w.registry.add(clock);
  return clock;
}

test("the app's timers in service:clock are taken back when it is no longer installed (remove, or every grant revoked); disable and a narrower grant keep them", async () => {
  const w = await installed();
  const clock = withClock(w);
  const cleared = () => clock.received.map((m) => [m.word, m.body, m.from]);

  await words(w, "apps.disable", { id: "fixture" });
  await words(w, "apps.enable", { id: "fixture" });
  await words(w, "apps.revoke", { id: "fixture", need: "device:*" });
  assert.deepEqual(cleared(), [], "disabling, enabling and narrowing leave the timers");

  await words(w, "apps.revoke", { id: "fixture" });
  assert.deepEqual(cleared(), [["cancel.owner", { member: "app:fixture" }, "service:apps"]]);

  await call(w, "service:apps", "apps.install", { id: "fixture" });
  await words(w, "apps.remove", { id: "fixture", keep_data: true });
  assert.equal(clock.received.length, 2);
  assert.deepEqual(clock.received[1]!.body, { member: "app:fixture" });
});

test("removing an app does not wait on a failing or absent clock", async () => {
  const w = await installed();
  withClock(w, true);
  const removed = dataOf(await words(w, "apps.remove", { id: "fixture" }));
  assert.equal(removed.removed, true);
  assert.ok(!existsSync(join(w.root, "fixture")));

  const w2 = await installed();   // no clock member at all: the router answers offline
  assert.equal(dataOf(await words(w2, "apps.remove", { id: "fixture" })).removed, true);
});

test("reset needs a data_dir", async () => {
  const w = await installed({ fixture: (app) => { delete app.data_dir; } });
  const reply = await words(w, "apps.reset", { id: "fixture" });
  assert.equal(reply.ok === false && reply.error.code, "failed");
  assert.match(JSON.stringify(reply), /data_dir/);
});

test("surface gives the page of a running app; icon gives the file; both say what is wrong", async () => {
  const w = await installed({ fixture: (app) => { app.icon = "icon.png"; } });
  writeFileSync(join(w.root, "fixture", "icon.png"), PNG);
  const page = dataOf(await words(w, "apps.surface", { id: "fixture", surface: "home" }));
  assert.equal(page.mime, "text/html;profile=mcp-app");
  assert.match(page.html, /<h1>Fixture<\/h1>/);
  assert.deepEqual(page.csp, { connectDomains: ["https://api.example"], resourceDomains: [] });
  assert.equal((await words(w, "apps.surface", { id: "fixture", surface: "other" })).ok, false);
  const icon = dataOf(await words(w, "apps.icon", { id: "fixture" }));
  assert.equal(icon.mime, "image/png");
  assert.deepEqual(Buffer.from(icon.data, "base64"), PNG);
  await words(w, "apps.disable", { id: "fixture" });
  const down = await words(w, "apps.surface", { id: "fixture", surface: "home" });
  assert.equal(down.ok === false && down.error.code, "offline");
  // an icon file that is gone, like an app that names none, gets the default icon
  rmSync(join(w.root, "fixture", "icon.png"));
  assert.deepEqual(dataOf(await words(w, "apps.icon", { id: "fixture" })), { id: "fixture", ...DEFAULT_APP_ICON });
  const unknown = await words(w, "apps.icon", { id: "nothing-here" });
  assert.equal(unknown.ok === false && unknown.error.code, "not_found"); // an app that is not there is still not found
});

test("validate: a good app is ok with warnings; a bad server is an error with the last stderr; a path works as well as an id", async () => {
  const w = world({ contract: { doc: "d" } });
  await w.apps.start();
  const ok = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.deepEqual(ok.surfaces, ["home"]);
  assert.ok(ok.tools.includes("fixture.list"));
  assert.ok(!ok.tools.includes("ash.on_event"));
  assert.ok(ok.problems.every((problem: { level: string }) => problem.level === "warning"));
  assert.ok(ok.problems.some((problem: { where: string }) => /icon/.test(problem.where)));
  const byPath = dataOf(await words(w, "apps.validate", { path: `${w.root}/fixture` }));
  assert.equal(byPath.ok, true);
  const outside = dataOf(await words(w, "apps.validate", { path: "/etc" }));
  assert.equal(outside.ok, false);
  writeFileSync(join(w.root, "fixture", "server.mjs"), 'console.error("boom: cannot start");\nprocess.exit(1);\n');
  const bad = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(bad.ok, false);
  assert.match(bad.problems.find((problem: { level: string }) => problem.level === "error").problem, /boom: cannot start/);
  const neither = await words(w, "apps.validate", {});
  assert.equal(neither.ok === false && neither.error.code, "bad_request");
});

test("validate: listens without the reserved tool ash.on_event is an error", async () => {
  const w = world();
  await w.apps.start();
  const server = join(w.root, "fixture", "server.mjs");
  writeFileSync(server, readFileSync(server, "utf8").replace('"ash.on_event"', '"ash.other"'));
  const report = dataOf(await words(w, "apps.validate", { id: "fixture" }));
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.problems), /ash\.on_event/);
});

test("contract: the document, the schema and a runnable example", async () => {
  const w = world({ contract: { doc: "# Contract doc for tests", docPath: "/root/apps/APP-CONTRACT.md" } });
  const out = dataOf(await words(w, "apps.contract"));
  assert.equal(out.contract, "ash-app/1");
  assert.equal(out.doc, "# Contract doc for tests");
  assert.equal(out.doc_path, "/root/apps/APP-CONTRACT.md");
  assert.equal(out.schema.title, "Ash app description (ash-app/1)");
  assert.ok("app.json" in out.example.files && "server.mjs" in out.example.files);
  assert.equal(out.example.path, undefined, "the example is its files; there is no folder for it in the apps folder");
});

test("scaffold: writes an app that validates, installs and works; it refuses to overwrite", async () => {
  const w = world({ fixture: false });
  await w.apps.start();
  const made = dataOf(await call(w, "service:apps", "apps.scaffold", { id: "todo", name: "Todo", summary: "A list of things to do.", tools: [{ name: "todo.archive", read_only: false }] }, { member: "agent:main", via: "agent", local: false }));
  assert.equal(made.id, "todo");
  assert.ok(made.files.includes("app.json") && made.files.includes("server.mjs") && made.files.includes("ui/home.html"));
  const manifest = JSON.parse(readFileSync(join(w.root, "todo", "app.json"), "utf8"));
  assert.equal(manifest.publisher, "agent:main", "written by the agent that asked");
  const report = dataOf(await words(w, "apps.validate", { id: "todo" }));
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.ok(report.tools.includes("todo.archive"));
  assert.deepEqual(report.surfaces, ["home"]);
  const info = dataOf(await words(w, "apps.install", { id: "todo" }, AGENT));
  assert.equal(info.running, true);
  assert.match(w.router.cards[0]!.detail!, /Ash 自己写的/);
  await call(w, "app:todo", "todo.add", { text: "buy milk" });
  const items = dataOf(await call(w, "app:todo", "todo.list")).items;
  assert.equal(items[0].text, "buy milk");
  assert.equal((await words(w, "apps.surface", { id: "todo", surface: "home" })).ok, true);
  // no icon of its own: the default one comes back instead of an error
  const own = dataOf(await words(w, "apps.icon", { id: "todo" }));
  assert.equal(own.mime, "image/png");
  assert.deepEqual(Buffer.from(own.data, "base64").subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const again = await words(w, "apps.scaffold", { id: "todo", name: "Todo" });
  assert.equal(again.ok === false && again.error.code, "conflict");
  const dup = await words(w, "apps.scaffold", { id: "dup", name: "Dup", tools: [{ name: "a.b" }, { name: "a.b" }] });
  assert.equal(dup.ok === false && dup.error.code, "bad_request");
});

test("stopAll through the service's runtime leaves nothing registered", async () => {
  const w = await installed();
  await until(() => w.registry.find("app:fixture", "fixture.list"), "running");
  const started = Date.now();
  await w.apps.stopAll(started + 3000);
  assert.ok(Date.now() - started < 3000);
  assert.equal(w.registry.find("app:fixture", "fixture.list"), null);
});

test("installBuiltinOrgans: each organ is copied the first time and never over what the agent has made of it since", async () => {
  const { installBuiltinOrgans } = await import("../../../src/edges/apps");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "organs-"));
  try {
    mkdirSync(join(dir, "src", "b-organ"), { recursive: true });
    mkdirSync(join(dir, "src", "a-organ", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "a-organ", "app.json"), "one");
    writeFileSync(join(dir, "src", "a-organ", "lib", "rules.mjs"), "rules");
    writeFileSync(join(dir, "src", "b-organ", "app.json"), "two");
    writeFileSync(join(dir, "src", "not-a-folder.txt"), "x");
    assert.deepEqual(installBuiltinOrgans(join(dir, "src"), join(dir, "apps")), ["a-organ", "b-organ"]);
    assert.equal(readFileSync(join(dir, "apps", "a-organ", "lib", "rules.mjs"), "utf8"), "rules");
    writeFileSync(join(dir, "apps", "a-organ", "app.json"), "changed by the agent");
    installBuiltinOrgans(join(dir, "src"), join(dir, "apps"));
    assert.equal(readFileSync(join(dir, "apps", "a-organ", "app.json"), "utf8"), "changed by the agent");
    assert.deepEqual(installBuiltinOrgans(join(dir, "nowhere"), join(dir, "apps")), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- T21d: describing while the servers start; an installed app whose folder is gone ----

test("apps.describe answers from the install records while the servers are still starting (running is true only as each comes up)", async () => {
  const first = await installed();
  await first.apps.stopAll(Date.now() + 3000);
  // A server that never speaks MCP: the connect hangs until the hub stops.
  const hang = { root: first.root, spawn: (_app: unknown, dir: string) => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 20000)"], cwd: dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }) };
  const second = world({ dbPath: first.dbPath, root: first.root, fixture: false, launcher: hang as never });
  const before = await words(second, "apps.describe", { id: "fixture" });
  assert.equal(before.ok === false && before.error.code, "unavailable", "before start() has scanned and seeded, the apps module does not guess");

  let done = false;
  const starting = second.apps.start().then(() => { done = true; });
  const described = await until(async () => { const r = await words(second, "apps.describe", { id: "fixture" }); return r.ok ? dataOf(r) : null; }, "apps.describe during the start");
  assert.equal(done, false, "refresh() is still waiting for the server");
  assert.deepEqual([described.granted, described.enabled, described.running, described.tools], [true, true, false, []], "running and tools say the truth: it is not up");
  assert.equal(dataOf(await words(second, "apps.list")).apps[0].running, false);
  const unknown = await words(second, "apps.describe", { id: "nope" });
  assert.equal(unknown.ok === false && unknown.error.code, "not_found", "an app with no record and no folder is really not there");

  await second.apps.stopAll(Date.now() + 3000);
  await starting;
});

test("an installed app whose folder is gone: listed with the reason, removable and revocable (timers cleared), but not enabled or restarted", async () => {
  const w = await installed();
  const clock = withClock(w);
  rmSync(join(w.root, "fixture"), { recursive: true, force: true });
  await words(w, "apps.refresh");
  const listed = dataOf(await words(w, "apps.list")).apps;
  assert.deepEqual(listed.map((app: any) => [app.id, app.granted, app.enabled, app.running]), [["fixture", true, true, false]]);
  assert.match(listed[0].error, /应用文件夹不在了/);

  for (const word of ["apps.enable", "apps.restart"]) {
    const refused = await words(w, word, { id: "fixture" });
    assert.equal(refused.ok === false && refused.error.code, "not_found", word);
    assert.match(refused.ok === false ? refused.error.message : "", /fixture\/ 下没有应用文件夹.*安装记录/, `${word} says the folder is missing`);
  }
  assert.equal(dataOf(await words(w, "apps.disable", { id: "fixture" })).enabled, false);

  const removed = dataOf(await words(w, "apps.remove", { id: "fixture" }));
  assert.deepEqual(removed, { id: "fixture", removed: true, kept: null });
  assert.deepEqual(clock.received.map((m) => [m.word, m.body]), [["cancel.owner", { member: "app:fixture" }]]);
  assert.deepEqual(dataOf(await words(w, "apps.list")).apps, []);
  const again = await words(w, "apps.remove", { id: "fixture" });
  assert.equal(again.ok === false && again.error.code, "not_found", "the record is gone now");

  // revoke does the same for a record without a folder
  installFixtureFolder(w.root);
  assert.equal((await call(w, "service:apps", "apps.install", { id: "fixture" })).ok, true);
  rmSync(join(w.root, "fixture"), { recursive: true, force: true });
  await words(w, "apps.refresh");
  const revoked = dataOf(await words(w, "apps.revoke", { id: "fixture" }));
  assert.deepEqual([revoked.id, revoked.granted, revoked.running], ["fixture", false, false]);
  assert.equal(clock.received.length, 2);
  assert.deepEqual(dataOf(await words(w, "apps.list")).apps, []);
});

test("badge: an app lights the dot of its own icon while it runs; ok takes it away; nobody else can set one", async () => {
  const w = await installed();
  const set = (member: string, tone: string) => w.apps.service.handle({ seq: 1, id: "m1", ts: 1, from: member, to: "service:apps", kind: "request", word: "apps.badge", body: { tone } },
    { signal: new AbortController().signal, caller: { member, via: member.startsWith("app:") ? "app" : "human", local: true } as never, raw: { tone } });
  const badge = async () => dataOf(await words(w, "apps.describe", { id: "fixture" })).badge;
  assert.equal(await badge(), undefined);
  await set("app:fixture", "err");
  assert.equal(await badge(), "err");
  assert.equal(dataOf(await words(w, "apps.list")).apps.find((a: { id: string }) => a.id === "fixture").badge, "err");
  await set("app:fixture", "ok");
  assert.equal(await badge(), undefined);
  await assert.rejects(set("person:owner", "warn"), /own icon/);
  await set("app:fixture", "warn");
  await words(w, "apps.disable", { id: "fixture" });
  assert.equal(await badge(), undefined, "an app that does not run shows no dot");
});
