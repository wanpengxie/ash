import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WORKSPACE_CAPABILITIES } from "../src/workspace";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "ash-workspace-test-"));
  const workspace = new Workspace(dir, join(dir, ".state"));
  t.after(async () => { await workspace.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await workspace.call(`workspace.${name}`, args); assert.equal(result.ok, true, result.error); return result.data as any;
  };
  return { workspace, dir, call };
}
test("workspace writes, paginates reads, lists and finds files", async t => {
  const { call } = await fixture(t);
  await call("write", { path: "report.md", content: "one\ntwo\nthree\n" });
  const read = await call("read", { path: "report.md", offset: 2, limit: 1 });
  assert.equal(read.text, "two"); assert.equal(read.next_offset, 3); assert.equal(read.truncated, true);
  assert.equal((await call("find", { pattern: "*.md" })).paths.length, 1);
  assert.equal((await call("ls", {})).entries[0].name, "report.md");
});
test("edit is all-or-nothing when a later replacement is ambiguous", async t => {
  const { call, workspace, dir } = await fixture(t);
  await call("write", { path: "x", content: "start x x" });
  const failed = await workspace.call("workspace.edit", { path: "x", edits: [{ oldText: "start", newText: "changed" }, { oldText: "x", newText: "y" }] });
  assert.equal(failed.ok, false); assert.equal(await readFile(join(dir, "x"), "utf8"), "start x x");
  await call("edit", { path: "x", edits: [{ oldText: "start", newText: "changed" }] });
  assert.equal(await readFile(join(dir, "x"), "utf8"), "changed x x");
});
test("schema prevents input through read-only poll; unknown receipts do not recommend retry", async t => {
  const { workspace } = await fixture(t);
  assert.equal((await workspace.call("workspace.poll", { process: "none", input: "do things" })).ok, false);
  const missing = await workspace.call("workspace.poll", { process: "none" });
  assert.equal((missing.data as any).code, "unknown_process");
  assert.match(missing.error!, /do not rerun/);
  assert.equal(WORKSPACE_CAPABILITIES.find(c => c.name === "workspace.poll")?.risk, "none");
  assert.equal(WORKSPACE_CAPABILITIES.find(c => c.name === "workspace.signal")?.effect, "act");
});
test("long-running command yields a process and poll reads only new output", async t => {
  const { call } = await fixture(t);
  const first = await call("bash", { command: "printf one; sleep 0.2; printf two", yield_ms: 30 });
  assert.equal(first.running, true);
  const last = await call("poll", { process: first.process, yield_ms: 1000 });
  assert.equal(last.running, false); assert.equal(first.output + last.output, "onetwo");
  assert.equal((await call("poll", { process: first.process })).output, "");
});
test("large command output keeps a readable full file", async t => {
  const { call } = await fixture(t);
  const result = await call("bash", { command: "head -c 80000 /dev/zero | tr '\\0' x", yield_ms: 1000 });
  assert.equal(result.truncated, true); assert.equal((await readFile(result.path, "utf8")).length, 80000);
  const full = await call("read", { path: result.path }); assert.equal(full.text.length, 80000);
});
test("signal terminates the command group and poll remains readable", async t => {
  const { call } = await fixture(t);
  const job = await call("bash", { command: "sleep 30 & wait", yield_ms: 20 });
  await call("signal", { process: job.process, signal: "TERM" });
  assert.equal((await call("poll", { process: job.process, yield_ms: 1000 })).running, false);
});

test("cancelling a poll stops waiting, not the underlying command", async t => {
  const { call, workspace } = await fixture(t);
  const job = await call("bash", { command: "sleep 0.3; printf survived", yield_ms: 0 });
  const cancelled = await workspace.call("workspace.poll", { process: job.process, yield_ms: 1000 }, AbortSignal.timeout(10));
  assert.equal(cancelled.ok, false);
  const result = await call("poll", { process: job.process, yield_ms: 1000 });
  assert.equal(result.output, "survived"); assert.equal(result.exit_code, 0);
});
test("search preserves literal patterns and context", async t => {
  const { call } = await fixture(t);
  await call("write", { path: "x.txt", content: "before\na.b\naXb\nafter\n" });
  const result = await call("grep", { path: "x.txt", pattern: "a.b", literal: true, context: 1 });
  assert.ok(result.matches.some((m: any) => m.line === 2));
  assert.ok(result.matches.some((m: any) => m.line === 1));
  assert.ok(!result.matches.some((m: any) => m.line === 3 && !m.context));
});
test("missing file, oversized writes and image reads have explicit outcomes", async t => {
  const { workspace, dir } = await fixture(t);
  assert.equal((await workspace.call("workspace.read", { path: "missing" })).ok, false);
  assert.equal((await workspace.call("workspace.write", { path: "huge", content: "x".repeat(4 * 1024 * 1024 + 1) })).ok, false);
  await writeFile(join(dir, "tiny.png"), Buffer.from([1, 2, 3]));
  const image = await workspace.call("workspace.read", { path: "tiny.png" });
  assert.equal(image.content[0].type, "image");
});

test("text results redact common credentials without changing files", async t => {
  const { call, dir } = await fixture(t);
  const original = 'api_key="fixture-secret-value"\nAuthorization: Bearer fixture-bearer-value\nnormal text';
  await call("write", { path: "config.txt", content: original });
  const result = await call("read", { path: "config.txt" });
  assert.equal(result.redacted, true); assert.doesNotMatch(result.text, /fixture-secret-value|fixture-bearer-value/);
  assert.match(result.text, /normal text/); assert.equal(await readFile(join(dir, "config.txt"), "utf8"), original);
});
