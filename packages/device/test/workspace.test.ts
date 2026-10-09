import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
test("writes inside the work directory declare no risk; outside, links out, commands and deletes keep theirs", async t => {
  const base = await mkdtemp(join(tmpdir(), "ash-workspace-risk-"));
  const shared = join(base, "shared"), outside = join(base, "elsewhere");
  await mkdir(shared); await mkdir(outside); await writeFile(join(shared, "notes.md"), "old");
  await symlink(outside, join(shared, "escape"));
  const workspace = new Workspace(shared, join(base, "state"));
  t.after(async () => { await workspace.close(); await rm(base, { recursive: true, force: true }); });
  const free = { risk: "none", effect: "write" }, asks = { risk: "structure", effect: "write" };
  for (const name of ["workspace.write", "workspace.edit"]) assert.equal(WORKSPACE_CAPABILITIES.find(c => c.name === name)?.per_call_risk, true);
  assert.deepEqual(await workspace.assess("workspace.write", { path: "brief.md", content: "x" }), free);
  assert.deepEqual(await workspace.assess("workspace.write", { path: join(shared, "tasks/new/brief.md"), content: "x" }), free, "new folders inside count as inside");
  assert.deepEqual(await workspace.assess("workspace.edit", { path: "notes.md", edits: [{ oldText: "old", newText: "new" }] }), free);
  assert.deepEqual(await workspace.assess("workspace.write", { path: "../elsewhere/x.md", content: "x" }), asks);
  assert.deepEqual(await workspace.assess("workspace.write", { path: "x.md", workdir: outside, content: "x" }), asks);
  assert.deepEqual(await workspace.assess("workspace.write", { path: "escape/x.md", content: "x" }), asks, "a link out of the folder is outside");
  assert.deepEqual(await workspace.assess("workspace.write", { path: "/etc/hosts", content: "x" }), asks);
  assert.deepEqual(await workspace.assess("workspace.bash", { command: "rm -rf notes.md" }), { risk: "structure", effect: "execute" });
  assert.deepEqual(await workspace.assess("workspace.signal", { process: "p", signal: "INT" }), { risk: "structure", effect: "act" });
  assert.deepEqual(await workspace.assess("workspace.read", { path: "notes.md" }), { risk: "none", effect: "read" });
  // Let through on "none", a write that now lands outside is refused; inside it runs.
  const refused = await workspace.call("workspace.write", { path: "escape/x.md", content: "x" }, undefined, "none");
  assert.equal(refused.ok, false); assert.equal((refused.data as any).code, "forbidden");
  await assert.rejects(readFile(join(outside, "x.md")));
  assert.equal((await workspace.call("workspace.write", { path: "brief.md", content: "brief" }, undefined, "none")).ok, true);
  assert.equal(await readFile(join(shared, "brief.md"), "utf8"), "brief");
  // Without that mark (the owner approved it) the same outside write goes ahead.
  assert.equal((await workspace.call("workspace.write", { path: "escape/x.md", content: "x" })).ok, true);
});
test("a work directory that is the home folder or holds the device state lends no free writes", async t => {
  const base = await mkdtemp(join(tmpdir(), "ash-workspace-guard-"));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const holdsState = new Workspace(base, join(base, ".state"));
  assert.equal((await holdsState.assess("workspace.write", { path: "x.md", content: "x" }))?.risk, "structure");
  const home = new Workspace("~", join(base, "state"));
  assert.equal((await home.assess("workspace.write", { path: "x.md", content: "x" }))?.risk, "structure");
});
test("the device answers a call's risk over the link and passes the phone's mark to the call", async () => {
  const { ClientLink } = await import("../src/link");
  const seen: unknown[] = [];
  const link = new ClientLink("http://127.0.0.1:1", { id: "x", publicKey: "synthetic", sign: async () => "" }, {
    manifest: async () => ({ name: "Mac", kind: "laptop", capabilities: WORKSPACE_CAPABILITIES }),
    call: async (_name, _args, _caller, _signal, declared) => { seen.push(declared); return { ok: true, content: [] }; },
    assess: async (name) => name === "workspace.write" ? { risk: "none", effect: "write" } : null,
  }, () => {});
  const replies: { status: number; body: string }[] = [];
  (link as unknown as { reply(sid: string, result: { status: number; body?: string }): void }).reply = (_sid, result) => { replies.push({ status: result.status, body: String(result.body ?? "") }); };
  const serve = (path: string, body: unknown) => (link as unknown as { serve(sid: string, inbound: object, signal: AbortSignal): Promise<void> })
    .serve("s", { method: path === "/ash/manifest" ? "GET" : "POST", path, headers: [], body: [Buffer.from(JSON.stringify(body))] }, new AbortController().signal);
  await serve("/ash/manifest", {});
  const manifest = JSON.parse(replies[0].body) as { capabilities: { name: string; per_call_risk?: boolean }[] };
  assert.equal(manifest.capabilities.find(c => c.name === "workspace.write")?.per_call_risk, true);
  await serve("/ash/assess", { capability: "workspace.write", args: { path: "a", content: "b" } });
  assert.deepEqual(JSON.parse(replies[1].body), { risk: "none", effect: "write" });
  await serve("/ash/assess", { capability: "workspace.bash", args: { command: "ls" } });
  assert.equal(replies[2].status, 404);
  await serve("/ash/call", { capability: "workspace.write", args: {}, caller: "agent:main", declared_risk: "none" });
  await serve("/ash/call", { capability: "workspace.write", args: {}, caller: "agent:main", declared_risk: "anything" });
  assert.deepEqual(seen, ["none", undefined]);
});
