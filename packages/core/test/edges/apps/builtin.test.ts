// Built-in apps follow the release: a newer release replaces a folder nobody changed, keeps (and says so) one the agent
// changed, and the grants follow the app.json in the folder.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BUILTIN_MARKER, installBuiltinOrgans, newBuiltinReport, RELEASE_DIR } from "../../../src/edges/apps";
import { call, dataOf, installFixtureFolder, stubMember, tempDir, until, world } from "./helpers";

/** A release folder with one app "fixture" at `version` (its server.mjs ends with a line saying which release it is). */
function release(version: string, edit?: (app: Record<string, any>) => void): string {
  const source = tempDir("release-");
  const dir = installFixtureFolder(source, (app) => { app.version = version; edit?.(app); });
  writeFileSync(join(dir, "server.mjs"), `${readFileSync(join(dir, "server.mjs"), "utf8")}\n// release ${version}\n`);
  return source;
}
const marker = (root: string) => JSON.parse(readFileSync(join(root, "fixture", BUILTIN_MARKER), "utf8"));
const text = (root: string, file: string) => readFileSync(join(root, "fixture", file), "utf8");

test("first copy: the folder arrives with a record of what the release brought", () => {
  const root = tempDir();
  const report = newBuiltinReport();
  assert.deepEqual(installBuiltinOrgans(release("1.0.0"), root, report), ["fixture"]);
  assert.deepEqual(report.kept, []);
  const record = marker(root);
  assert.equal(record.version, "1.0.0");
  assert.match(record.sha256, /^[0-9a-f]{64}$/);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.0.0\n"));
});

test("a newer release replaces a folder nobody changed, and keeps the app's data", () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.0.0"), root);
  mkdirSync(join(root, "fixture", "data"), { recursive: true });
  writeFileSync(join(root, "fixture", "data", "state.json"), "{\"mine\":1}");
  const report = newBuiltinReport();
  installBuiltinOrgans(release("1.1.0"), root, report);
  assert.deepEqual(report.kept, []);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.1.0\n"));
  assert.equal(JSON.parse(text(root, "app.json")).version, "1.1.0");
  assert.equal(marker(root).version, "1.1.0");
  assert.equal(text(root, "data/state.json"), "{\"mine\":1}", "the owner's data is not part of the release");
  assert.ok(!existsSync(join(root, ".new-fixture")) && !existsSync(join(root, ".old-fixture")));
  // The data does not change the record: a later release still replaces.
  installBuiltinOrgans(release("1.2.0"), root, report);
  assert.ok(text(root, "server.mjs").endsWith("// release 1.2.0\n"));
});

test("a newer release does not overwrite what the agent changed: the old app stays, the main agent is told once", async () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.0.0"), root);
  writeFileSync(join(root, "fixture", "server.mjs"), `${text(root, "server.mjs")}// the agent was here\n`);

  const report = newBuiltinReport();
  const source = release("1.1.0");
  const builtinApps = installBuiltinOrgans(source, root, report);
  assert.deepEqual(report.kept, [{ id: "fixture", shipped: "1.1.0", current: "1.0.0" }]);
  assert.ok(text(root, "server.mjs").includes("the agent was here"));
  assert.equal(marker(root).version, "1.0.0", "the record still says what was brought before");
  assert.ok(existsSync(join(root, RELEASE_DIR, "fixture", "app.json")), "the new release is left where the agent can read it");

  const w = world({ root, fixture: false, builtinApps, builtinKept: report.kept, builtinExact: report.exact });
  const agent = stubMember("agent:main", "agent", [{ word: "tell", callers: ["owner", "agent", "app"] }]);
  w.registry.add(agent);
  await w.apps.start();
  const told = await until(() => agent.received[0], "the tell to the main agent");
  assert.equal(told.word, "tell");
  assert.equal(told.from, "service:apps");
  assert.match(String((told.body as { text: string }).text), /fixture.*1\.1\.0.*你改过/s);
  await until(() => marker(root).notified === "1.1.0", "the tell is recorded");

  // The next start does not tell again.
  const again = newBuiltinReport();
  installBuiltinOrgans(source, root, again);
  assert.deepEqual(again.kept, []);
  // A still newer release does.
  const newer = newBuiltinReport();
  installBuiltinOrgans(release("1.2.0"), root, newer);
  assert.deepEqual(newer.kept.map((item) => item.shipped), ["1.2.0"]);
});

test("the same release, or an older one, leaves the folder alone", () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.1.0"), root);
  const before = text(root, "server.mjs");
  writeFileSync(join(root, "fixture", "server.mjs"), `${before}// the agent was here\n`);
  const report = newBuiltinReport();
  installBuiltinOrgans(release("1.1.0"), root, report);
  installBuiltinOrgans(release("1.0.0"), root, report);
  assert.deepEqual(report.kept, []);
  assert.ok(text(root, "server.mjs").includes("the agent was here"));
  assert.equal(marker(root).version, "1.1.0");
});

test("a folder from before the record counts as changed: kept, not overwritten", () => {
  const root = tempDir();
  installFixtureFolder(root, (app) => { app.version = "1.0.0"; });
  const report = newBuiltinReport();
  installBuiltinOrgans(release("1.1.0"), root, report);
  assert.equal(report.kept.length, 1);
  assert.equal(JSON.parse(text(root, "app.json")).version, "1.0.0");
});

/** A world over `root` that starts the built-in apps of `source`, like the hub does. */
function start(root: string, dbPath: string, source: string) {
  const report = newBuiltinReport();
  const builtinApps = installBuiltinOrgans(source, root, report);
  return world({ root, dbPath, fixture: false, builtinApps, builtinKept: report.kept, builtinExact: report.exact });
}
const describe = async (w: ReturnType<typeof world>) => dataOf(await call(w, "service:apps", "apps.describe", { id: "fixture" }));
const members = (info: { needs: { member: string }[] }) => info.needs.map((n) => n.member).sort();

test("grants follow the built-in app while it is exactly the release: a changed version or needs are granted again without a card", async () => {
  const root = tempDir();
  const dbPath = join(tempDir(), "ash.db");
  const first = start(root, dbPath, release("1.0.0"));
  await first.apps.start();
  let info = await describe(first);
  assert.equal(info.version, "1.0.0");
  assert.deepEqual(members(info), ["device:*"]);
  await first.apps.stopAll(Date.now() + 3000);
  first.ledger.close();

  const wider = release("1.1.0", (app) => { app.needs = [...app.needs, { member: "service:senses", words: ["query"], why: "Look at recent records." }]; });
  const second = start(root, dbPath, wider);
  await second.apps.start();
  info = await describe(second);
  assert.equal(info.version, "1.1.0");
  assert.deepEqual(members(info), ["device:*", "service:senses"]);
  assert.equal(info.origin, "builtin");
  assert.equal(second.router.cards.length, 0, "no card: the release decides");

  // Same version and needs: the grant is not rewritten; and a disabled app stays disabled when it is granted again.
  const at = second.apps.runtime.grants.get("fixture")!.granted_at;
  second.apps.runtime.seedBuiltin("fixture");
  assert.equal(second.apps.runtime.grants.get("fixture")!.granted_at, at);
});

test("what the agent writes into a built-in app never widens its grants, however often the hub restarts", async () => {
  const root = tempDir();
  const dbPath = join(tempDir(), "ash.db");
  const source = release("1.0.0");
  const first = start(root, dbPath, source);
  await first.apps.start();
  await first.apps.stopAll(Date.now() + 3000);
  first.ledger.close();

  // The agent adds a need (and a version) to its own copy; the release is the same.
  const file = join(root, "fixture", "app.json");
  const app = JSON.parse(readFileSync(file, "utf8"));
  app.version = "1.0.1";
  app.needs.push({ member: "service:vault", words: ["use"], why: "Take whatever it likes." });
  writeFileSync(file, JSON.stringify(app, null, 2));
  for (const source_ of [source, release("1.1.0")]) {
    const w = start(root, dbPath, source_);
    await w.apps.start();
    const grant = w.apps.runtime.grants.get("fixture")!;
    assert.equal(grant.version, "1.0.0", "the grant is the one from the release");
    assert.deepEqual(grant.needs.map((n) => ("member" in n ? n.member : "")), ["device:*"]);
    assert.equal(w.router.cards.length, 0);
    await w.apps.stopAll(Date.now() + 3000);
    w.ledger.close();
  }
});

test("a replacement cut short at any step is done again at the next start, and the owner's data stays", () => {
  const steps: string[] = [];
  const fresh = (): string => {
    const root = tempDir();
    installBuiltinOrgans(release("1.0.0"), root);
    mkdirSync(join(root, "fixture", "data"), { recursive: true });
    writeFileSync(join(root, "fixture", "data", "state.json"), "{\"mine\":1}");
    return root;
  };
  // First learn the steps of a replacement.
  installBuiltinOrgans(release("1.1.0"), fresh(), undefined, undefined, { step: (name) => { steps.push(name); } });
  assert.ok(steps.length >= 4, steps.join(","));
  for (let at = 0; at < steps.length; at++) {
    const root = fresh();
    let n = 0;
    installBuiltinOrgans(release("1.1.0"), root, undefined, undefined, { step: () => { if (n++ === at) throw new Error("the phone died"); } });
    assert.equal(text(root, "data/state.json"), "{\"mine\":1}", `data survives a stop at ${steps[at]}`);
    const report = newBuiltinReport();
    installBuiltinOrgans(release("1.1.0"), root, report);
    assert.deepEqual(report.kept, [], `finished after a stop at ${steps[at]}`);
    assert.ok(report.exact.has("fixture"));
    assert.ok(text(root, "server.mjs").endsWith("// release 1.1.0\n"), steps[at]);
    assert.equal(text(root, "data/state.json"), "{\"mine\":1}");
    assert.equal(marker(root).version, "1.1.0");
    assert.equal(marker(root).upgrading, undefined);
    assert.ok(!existsSync(join(root, ".new-fixture")));
  }
});

test("a first copy cut short leaves no half app behind", () => {
  const root = tempDir();
  installBuiltinOrgans(release("1.0.0"), root, undefined, undefined, { step: () => { throw new Error("the phone died"); } });
  assert.ok(!existsSync(join(root, "fixture")));
  installBuiltinOrgans(release("1.0.0"), root);
  assert.equal(marker(root).version, "1.0.0");
});

test("folders that are not app names (.new-x, _release) are never listed as apps", async () => {
  const root = tempDir();
  const source = release("1.0.0");
  installBuiltinOrgans(source, root);
  cpSync(join(root, "fixture"), join(root, ".new-x"), { recursive: true });
  const w = world({ root, fixture: false });
  await w.apps.start();
  const list = dataOf(await call(w, "service:apps", "apps.list", {})).apps as { id: string }[];
  assert.deepEqual(list.filter((item: any) => item.kind !== "system").map((item) => item.id), ["fixture"]);
});

test("a folder without a record is told about once, not at every start", async () => {
  const root = tempDir();
  const dbPath = join(tempDir(), "ash.db");
  installFixtureFolder(root, (app) => { app.version = "1.0.0"; });
  const source = release("1.1.0");
  for (const round of [1, 2, 3]) {
    const w = start(root, dbPath, source);
    const agent = stubMember("agent:main", "agent", [{ word: "tell", callers: ["owner", "agent", "app"] }]);
    w.registry.add(agent);
    await w.apps.start();
    if (round === 1) await until(() => agent.received.length === 1 && existsSync(join(root, "fixture", BUILTIN_MARKER)) && marker(root).notified === "1.1.0", "the first tell and its record");
    else await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(agent.received.length, round === 1 ? 1 : 0, `start ${round}`);
    await w.apps.stopAll(Date.now() + 3000);
    w.ledger.close();
  }
  assert.deepEqual(marker(root), { version: "0", sha256: "", notified: "1.1.0" });
});
