import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { checkFolder, trialRun } from "../../src/apps/check";
import { scaffoldFiles } from "../../src/apps/templates";
import { validateCard } from "../../src/members/widgets-card";

// The build-app skill's worked example is a real app: it is laid over what apps.scaffold writes today (shared page script, styles,
// icon), checked the way apps.validate checks, and its tools are called. When the scaffold changes in a way that breaks the
// example, this test says so and the example (packages/ash-skills/skills/build-app/example-reading) needs the same change.
const example = join(import.meta.dirname, "../../../ash-skills/skills/build-app/example-reading");

function assemble(): string {
  const dir = mkdtempSync(join(tmpdir(), "ash-example-app-"));
  const base = scaffoldFiles({ id: "reading", name: "阅读记录", publisher: "agent:main", surfaces: [{ id: "shelf", title: "书架" }, { id: "stats", title: "统计" }] });
  for (const [name, data] of Object.entries(base)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), data); }
  cpSync(example, dir, { recursive: true });
  return dir;
}

test("the build-app example passes the same checks as apps.validate", async () => {
  const dir = assemble();
  try {
    const checked = checkFolder(dir, "reading");
    assert.ok(checked.manifest, JSON.stringify(checked.problems));
    assert.deepEqual(checked.problems.filter((item) => item.level === "error"), []);
    const trial = await trialRun(checked.manifest!, { command: "node", args: ["server.mjs"], cwd: dir, env: { ...process.env as Record<string, string>, ASH_APP_ID: "reading", ASH_APP_DIR: dir, ASH_TRIAL: "1" } }, 20_000);
    assert.deepEqual(trial.problems, [], JSON.stringify(trial.problems));
    assert.deepEqual(trial.surfaces, ["shelf", "stats"]);
    for (const tool of ["reading.list", "reading.add", "reading.progress", "reading.finish", "reading.remove", "reading.stats", "reading.card", "reading.card.tap"])
      assert.ok(trial.tools.includes(tool), `${tool} is registered`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the build-app example's tools do what their descriptions say, and its card follows the data", async () => {
  const dir = assemble();
  const transport = new StdioClientTransport({ command: "node", args: ["server.mjs"], cwd: dir, env: { ...process.env as Record<string, string>, ASH_APP_ID: "reading", ASH_APP_DIR: dir }, stderr: "pipe" });
  const client = new Client({ name: "ash-example-test", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, data: (result.structuredContent ?? {}) as Record<string, any>, text: JSON.stringify(result.content) };
  };
  try {
    await client.connect(transport);
    const empty = await call("reading.card");
    validateCard(empty.data);
    assert.equal(empty.data.data.empty, true);
    const added = await call("reading.add", { title: "三体", pages: 300, status: "reading" });
    assert.match(added.data.activity, /三体/u);
    const dup = await call("reading.add", { title: "三体" });
    assert.equal(dup.error, true);
    assert.match(dup.text, /已经有/u);
    const id = added.data.book.id as string;
    await call("reading.progress", { book: id, page: 120 });
    const card = await call("reading.card");
    validateCard(card.data);
    assert.equal(card.data.data.books[0].page, 120);
    const tapped = await call("reading.card.tap", { card: "main", action: "finish", item: id, checked: true });
    assert.match(tapped.data.activity, /读完了/u);
    assert.equal((await call("reading.stats")).data.done, 1);
    assert.equal((await call("reading.list", { status: "done" })).data.books.length, 1);
    validateCard((await call("reading.card")).data);
    assert.equal((await call("reading.remove", { book: id })).error, false);
    assert.equal((await call("reading.finish", { book: id })).error, true);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "data", "data.json"), "utf8")).books, []);
  } finally { await client.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});
