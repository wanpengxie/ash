import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexReadAdapter } from "../src/collaboration/codex-read";
import { CollaborationReadError, type WorkRef } from "../src/collaboration/types";

const fixture = fileURLToPath(new URL("./fixtures/codex-read-cli.mjs", import.meta.url));
const work: WorkRef = { node_id: "node-1", endpoint_id: "codex-desktop", kind: "conversation", native_id: "work-1" };
async function reader(t: any, mode = "normal", options: Record<string, unknown> = {}) {
  const folder = await mkdtemp(join(tmpdir(), "ash-codex-read-"));
  const log = join(folder, "calls.ndjson");
  const adapter = new CodexReadAdapter({ node_id: work.node_id, endpoint_id: work.endpoint_id, allowedCwds: ["/approved"], testing: { command: { command: process.execPath, args: [fixture, mode, log, "/approved"] } }, ...options });
  t.after(async () => { await adapter.close(); await rm(folder, { recursive: true, force: true }); });
  return { adapter, calls: async () => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}
const code = (expected: string) => (error: unknown) => error instanceof CollaborationReadError && error.code === expected;

test("saved history pages deduplicate source IDs, retain opaque cursors and never call control methods", async t => {
  const { adapter, calls } = await reader(t);
  const first = await adapter.listWork({ limit: 3 });
  assert.equal(first.items.length, 1); assert.equal(first.items[0].title, "updated title");
  assert.deepEqual(first.items[0].work, work); assert.equal(first.next_cursor, "opaque/+==");
  assert.equal(first.runtime_state, "unknown"); assert.equal(first.source, "codex.saved_history");
  assert.equal(first.completeness, "source_page"); assert.ok(Number.isFinite(Date.parse(first.observed_at)));
  const second = await adapter.listWork({ limit: 3, cursor: first.next_cursor! });
  const cache = new Map([...first.items, ...second.items].map(item => [JSON.stringify(item.work), item]));
  assert.equal(cache.size, 2); assert.equal(cache.get(JSON.stringify(work))!.title, "new title");
  await adapter.readWork(work, { limit: 3 });
  await adapter.readWork(work, { limit: 3, cursor: "older-cursor" });
  const frames = await calls();
  assert.ok(frames.every(frame => ["initialize", "initialized", "thread/list", "thread/read", "thread/turns/list"].includes(frame.method)));
  assert.ok(frames.filter(frame => frame.method === "thread/read").every(frame => frame.params.includeTurns === false));
  const turns = frames.filter(frame => frame.method === "thread/turns/list");
  assert.equal(turns[0].params.itemsView, "full"); assert.equal(turns[0].params.sortDirection, "desc");
  assert.equal(turns[1].params.cursor, "older-cursor");
});

test("same turn and message IDs are reread as replacements; reasoning and tool details stay excluded", async t => {
  const { adapter } = await reader(t);
  const first = await adapter.readWork(work), second = await adapter.readWork(work);
  assert.equal(first.items[0].turn_id, second.items[0].turn_id);
  assert.equal(first.items[0].messages.length, 2);
  assert.deepEqual(first.items[0].messages.map(item => item.role), ["user", "assistant"]);
  assert.equal(first.items[0].messages[1].source_message_id, second.items[0].messages[1].source_message_id);
  assert.equal(first.items[0].messages[1].text, "partial");
  assert.match(second.items[0].messages[1].text, /completed/);
  assert.doesNotMatch(JSON.stringify(second), /fixture-secret|private reasoning|private command|private-image/);
  assert.equal(second.items[0].history_status, "interrupted"); assert.equal(second.runtime_state, "unknown");
  assert.equal(second.items[0].status_source, "codex.saved_history");
});

test("material references preserve native part positions without exporting locators", async t => {
  const { adapter } = await reader(t, "materials");
  const first = await adapter.readWork(work), refreshed = await adapter.readWork(work);
  const [mixed, attachment, invalidClient, assistant] = first.items[0].messages;
  assert.equal(mixed.source_client_message_id, "native-client-1");
  assert.equal(mixed.source_message_id, "u1");
  assert.equal(mixed.text, "question");
  assert.deepEqual(mixed.material_refs, [
    { source_part_index: 1, kind: "image", source_type: "image", availability: "reference_only" },
    { source_part_index: 3, kind: "image", source_type: "localImage", availability: "reference_only" },
    { source_part_index: 4, kind: "audio", source_type: "audio", availability: "reference_only" },
    { source_part_index: 5, kind: "audio", source_type: "localAudio", availability: "reference_only" },
    { source_part_index: 6, kind: "skill", source_type: "skill", availability: "reference_only" },
    { source_part_index: 7, kind: "mention", source_type: "mention", availability: "reference_only" },
    { source_part_index: 9, kind: "image", source_type: "image", availability: "reference_only" },
  ]);
  assert.deepEqual(refreshed.items[0].messages[0].material_refs, mixed.material_refs);
  assert.equal(attachment.text, "");
  assert.deepEqual(attachment.material_refs, [{ source_part_index: 0, kind: "image", source_type: "image", availability: "reference_only" }]);
  assert.equal(attachment.source_client_message_id, undefined);
  assert.equal(invalidClient.source_client_message_id, undefined);
  assert.equal(assistant.source_client_message_id, undefined);
  assert.equal(assistant.material_refs, undefined);
  assert.doesNotMatch(JSON.stringify(first), /private-|fixture-secret|https:|\/private\/|"url"|"path"|"fileId"|"name"/);
});

test("no configured scope denies before starting; source identity and native cwd authorize reads", async t => {
  const { adapter, calls } = await reader(t);
  await assert.rejects(adapter.readWork({ ...work, node_id: "other" }), code("permission_denied"));
  await assert.rejects(adapter.readWork({ ...work, endpoint_id: "managed-runtime" }), code("permission_denied"));
  await assert.rejects(adapter.readWork({ ...work, native_id: "outside" }), code("permission_denied"));
  assert.equal((await calls()).filter(frame => frame.method === "thread/turns/list").length, 0);
  const denied = new CodexReadAdapter({ node_id: "node", endpoint_id: "endpoint", testing: { command: { command: "does-not-exist", args: [] } } });
  t.after(() => denied.close()); await assert.rejects(denied.listWork(), code("permission_denied"));
  assert.throws(() => new CodexReadAdapter({ node_id: "node", endpoint_id: "endpoint", allowedCwds: ["relative"] }), code("invalid"));
});

test("pagination bounds and source cursor cycles fail explicitly", async t => {
  const { adapter } = await reader(t, "loop");
  await assert.rejects(adapter.listWork({ limit: 101 }), code("invalid"));
  await assert.rejects(adapter.listWork({ cursor: "" }), code("invalid"));
  const first = await adapter.listWork();
  await adapter.listWork({ cursor: first.next_cursor! });
  await assert.rejects(adapter.listWork({ cursor: "cursor-b" }), code("invalid"));
  const large = await reader(t, "oversize"); await assert.rejects(large.adapter.listWork(), code("too_large"));
  const summary = await reader(t, "summary"); await assert.rejects(summary.adapter.readWork(work), code("invalid"));
});

test("refresh starts a new cursor traversal when history reorders opaque tokens", async t => {
  const { adapter } = await reader(t, "refresh");
  const first = await adapter.listWork();
  assert.equal(first.next_cursor, "cursor-a");
  assert.equal((await adapter.listWork({ cursor: "cursor-a" })).next_cursor, "cursor-b");
  assert.equal((await adapter.listWork({ cursor: "cursor-b" })).next_cursor, null);
  const refreshed = await adapter.listWork();
  assert.equal(refreshed.next_cursor, "cursor-b");
  assert.equal((await adapter.listWork({ cursor: "cursor-b" })).next_cursor, "cursor-a");
  assert.equal((await adapter.listWork({ cursor: "cursor-a" })).next_cursor, null);
});

test("long cursor rings and acyclic chains fail at the traversal bound without losing evidence", async t => {
  for (const mode of ["long-cycle", "long-chain"]) {
    const { adapter, calls } = await reader(t, mode);
    let page = await adapter.listWork();
    for (let n = 1; n < 128; n++) page = await adapter.listWork({ cursor: page.next_cursor! });
    const count = () => calls().then(frames => frames.filter(frame => frame.method === "thread/list").length);
    assert.equal(await count(), 128);
    for (let attempt = 0; attempt < 4; attempt++) await assert.rejects(adapter.listWork({ cursor: page.next_cursor! }), code("too_large"));
    assert.equal(await count(), 128, "the bound must fail before more source RPCs, with no retry");
    const refreshed = await adapter.listWork();
    assert.equal(refreshed.next_cursor, "cursor-1");
    assert.equal((await adapter.listWork({ cursor: refreshed.next_cursor! })).next_cursor, "cursor-2");
    assert.equal(await count(), 130, "a first-page refresh starts a usable new traversal");
  }
});

test("native invalid parameters and expired cursors are invalid reads, not offline", async t => {
  for (const mode of ["invalid-cursor", "expired-cursor"]) {
    const { adapter } = await reader(t, mode);
    await assert.rejects(adapter.listWork({ cursor: "stale" }), code("invalid"));
  }
});

test("a late earlier page response cannot overwrite a newer cursor traversal", async t => {
  const { adapter } = await reader(t, "refresh-overlap");
  assert.equal((await adapter.listWork()).next_cursor, "cursor-a");
  const previous = adapter.listWork({ cursor: "cursor-a" }), current = adapter.listWork();
  assert.equal((await current).next_cursor, "cursor-b");
  assert.equal((await previous).next_cursor, "cursor-b");
  assert.equal((await adapter.listWork({ cursor: "cursor-b" })).next_cursor, "cursor-a");
  assert.equal((await adapter.listWork({ cursor: "cursor-a" })).next_cursor, null);
});

test("visible page expansion is bounded independently of the parsed source page", async t => {
  const { adapter } = await reader(t, "output-oversize");
  await assert.rejects(adapter.readWork(work), (error: unknown) => error instanceof CollaborationReadError && error.code === "too_large" && error.message === "Visible history page exceeds 1 MiB");
});

test("the 1 MiB output bound includes the complete page envelope", async t => {
  const { adapter } = await reader(t, "envelope-oversize");
  await assert.rejects(adapter.listWork(), (error: unknown) => error instanceof CollaborationReadError && error.code === "too_large" && error.message === "Visible history page exceeds 1 MiB");
});

test("source exit automatically closes surviving descendants without caller cleanup", async t => {
  const { adapter, calls } = await reader(t, "exit-with-child");
  await assert.rejects(adapter.listWork(), code("offline"));
  const pid = (await calls()).find(frame => frame.fixtureChildPid)?.fixtureChildPid;
  assert.ok(Number.isInteger(pid), "fixture spawned a descendant");
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(alive(), false, "source descendants must stop before any explicit adapter.close");
  await assert.rejects(adapter.listWork(), code("offline"));
});

test("unsupported native methods and credential-bearing errors are surfaced safely", async t => {
  const unsupported = await reader(t, "unsupported"); await assert.rejects(unsupported.adapter.listWork(), code("unsupported"));
  const diagnostic = await reader(t, "diagnostic");
  await assert.rejects(diagnostic.adapter.listWork(), (error: unknown) => error instanceof CollaborationReadError && !error.message.includes("fixture-secret"));
});

test("close, timeout and cancellation release the read process and do not trigger retries", async t => {
  const closed = await reader(t); await closed.adapter.listWork({ limit: 3 }); await closed.adapter.close();
  await assert.rejects(closed.adapter.listWork(), code("offline"));
  const timeout = await reader(t, "timeout", { timeoutMs: 100 });
  await assert.rejects(timeout.adapter.listWork(), code("timeout"));
  await assert.rejects(timeout.adapter.listWork(), code("offline"));
  const cancelling = await reader(t, "timeout"); const controller = new AbortController();
  const cancelled = cancelling.adapter.listWork({ signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(cancelled, code("cancelled"));
  const pre = await reader(t); await assert.rejects(pre.adapter.listWork({ signal: AbortSignal.abort() }), code("cancelled"));
});
