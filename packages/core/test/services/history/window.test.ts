import assert from "node:assert/strict";
import test from "node:test";
import { projectRecords, safeRecord } from "../../../../sdk/src/conversation";
import { createHistoryService } from "../../../src/services/history";
import { WINDOW_BYTES } from "../../../src/services/history/window";
import { Ledger } from "../../../src/kernel/ledger";
import { openLedger } from "../../kernel/ledger/helpers";
import { call, code, owner, agent } from "../support";

const say = (text: string, from = "agent:main") => ({ from, to: from === "person:owner" ? "agent:main" : "person:owner", kind: "request" as const, word: "say", body: { text } });
const turn = (id: string, word = "turn.started", extra = {}) => ({ from: "agent:main", to: null, kind: "event" as const, word, body: { turn: id, lane: "front", ids: [], ...extra } });
const reply = (id: string, word: string, body: unknown) => ({ from: "person:owner", to: "agent:main", kind: "response" as const, word, reply_to: id, body });
const stripSize = (x: any) => { const { byte_size, reactions_more, ...rest } = x; return JSON.parse(JSON.stringify(rest)); };

test("windows hydrate distant answers, first valid options, reads and reactions at a stable snapshot", async () => {
  const { ledger } = openLedger();
  const mine = ledger.append(say("给她的消息", "person:owner"));
  const ask = ledger.append({ ...say(""), word: "ask", body: { title: "选哪一个", detail: "详情", options: [{ id: "a", label: "A" }], allow_custom: true } });
  const card = ledger.append({ ...say(""), word: "show", body: { card: { type: "options", options: [{ id: "a", text: "A" }], allow_custom: true } } });
  const old = card.seq;
  ledger.tx(() => { for (let i = 0; i < 1200; i++) ledger.append({ from: "service:test", to: null, kind: "event", word: "unrelated", body: { password: "must-not-leak" } }); });
  ledger.append(turn("t_read", "turn.started", { ids: [mine.id] }));
  ledger.append(reply(ask.id, "ask", { ok: true, result: { data: { choice: "a", text: "A" } } }));
  ledger.append(reply(ask.id, "ask", { ok: false, error: { code: "timeout" } }));
  ledger.append({ ...say("wrong", "person:owner"), body: { text: "wrong", in_reply_to: card.id, option_id: "a" } });
  ledger.append({ ...say("A", "person:owner"), body: { text: "A", in_reply_to: card.id, option_id: "a" } });
  for (let i = 0; i < 3; i++) ledger.append({ ...say(""), word: "react", body: { message_id: card.id, emoji: "👍" } });
  const service = createHistoryService({ ledger });
  const result = await call(service, owner, "window", { after: 0, limit: 3 });
  assert.equal(result.items[0].delivery, "read");
  assert.equal(result.items[1].ask.state, "answered");
  assert.equal(result.items[1].ask.answer_text, "A");
  assert.equal(result.items[2].selected_option_id, "a");
  assert.equal(result.items[2].locked, true);
  assert.deepEqual(result.items[2].reactions.map((r: any) => [r.emoji, r.count]), [["👍", 3]]);
  assert.equal(result.next.id, ledger.page({ word: "say", from: "person:owner", after: old, limit: 1 })[0]!.id);
  const before = await call(service, owner, "window", { after: 0, limit: 3, snapshot_seq: old });
  assert.equal(before.items[0].delivery, "sent");
  assert.equal(before.items[1].ask.state, "pending");
  assert.equal(before.items[2].locked, false);
  assert.deepEqual(before.items[2].reactions, []);
  assert.ok(!JSON.stringify(result).includes("must-not-leak"));
});

test("page cursors count visible entities, give both neighbours, and around does not replay intervening rows; an agent reads the same pages", async () => {
  const { ledger } = openLedger();
  const ids: string[] = [];
  ledger.tx(() => { for (let i = 0; i < 100; i++) { ids.push(ledger.append(say(String(i))).id); ledger.append({ from: "service:test", to: null, word: "noise", kind: "event", body: {} }); } });
  const service = createHistoryService({ ledger });
  const tail = await call(service, owner, "window", { limit: 10 });
  assert.deepEqual(tail.items.map((x: any) => x.id), ids.slice(-10));
  assert.equal(tail.has_more_after, false); assert.equal(tail.has_more_before, true);
  const older = await call(service, owner, "window", { before: tail.before, limit: 10, snapshot_seq: tail.snapshot_seq });
  assert.deepEqual(older.items.map((x: any) => x.id), ids.slice(-20, -10));
  assert.equal(older.next.id, tail.items[0].id); assert.equal(tail.previous.id, older.items.at(-1).id);
  const next = await call(service, owner, "window", { after: older.after, limit: 10 });
  assert.deepEqual(next.items, tail.items);
  const around = await call(service, owner, "window", { around_id: ids[40], limit: 5 });
  assert.deepEqual(around.items.map((x: any) => x.id), ids.slice(38, 43));
  assert.equal(await code(call(service, owner, "window", { before: 10, after: 0 })), "bad_request");
  assert.equal(await code(call(service, owner, "window", { around_id: "not_here" })), "not_found");
  assert.equal(await code(call(service, owner, "window", { snapshot_seq: 999999 })), "bad_request");
  assert.deepEqual((await call(service, agent(), "window", { limit: 10 })).items, tail.items, "an agent reads the same window the owner does");
});

test("safe DTO is the existing projector's output; private tool arguments and raw results never escape", async () => {
  const { ledger } = openLedger();
  ledger.append(say("你好"));
  ledger.append(say("谢谢", "person:owner"));
  ledger.append({ ...say(""), word: "ask", body: { human_kind: "confirmation", title: "确认吗", source: { body_full: "not-from-gate" }, secret: "sensitive" } });
  ledger.append({ from: "agent:main", to: "service:test", kind: "request", word: "run", body: { purpose: "用途", secret: "sensitive" }, turn: "t" });
  const oracle = projectRecords(ledger.page({ limit: 100 }).map(safeRecord).filter((x): x is NonNullable<typeof x> => !!x)).conversation;
  const service = createHistoryService({ ledger });
  const page = await call(service, owner, "window");
  assert.deepEqual(page.items.map(stripSize), JSON.parse(JSON.stringify(oracle)));
  assert.ok(!JSON.stringify(page).includes("sensitive")); assert.ok(!JSON.stringify(page).includes("not-from-gate"));
});

test("UTF-8 budget yields finite pages and an oversized legitimate item alone without clipping", async () => {
  const { ledger } = openLedger();
  // Store inline safe display fields to exercise transport budgeting, independently of blob externalization.
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const m = ledger.append(say("中文")); ids.push(m.id);
    ledger.db().prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ text: "中".repeat(6000) }), m.id);
  }
  const service = createHistoryService({ ledger });
  const page = await call(service, owner, "window", { limit: 200 });
  assert.ok(page.items.length < 30); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= WINDOW_BYTES);
  const huge = "中".repeat(100000);
  ledger.db().prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ text: huge }), ids[0]!);
  const around = await call(service, owner, "window", { around_id: ids[0], limit: 40 });
  assert.equal(around.oversized, true); assert.equal(around.items.length, 1); assert.equal(around.items[0].text, huge);
  assert.ok(around.items[0].byte_size >= Buffer.byteLength(huge));
});

test("current questions are separately bounded and authority never follows the browsing window", async () => {
  const { ledger } = openLedger();
  const asks: string[] = [];
  ledger.tx(() => { for (let i = 0; i < 260; i++) asks.push(ledger.append({ ...say(""), word: "ask", body: { title: String(i), options: [{ id: "x", label: "X" }] } }).id); });
  ledger.append(reply(asks[0]!, "ask", { ok: true, result: { data: { choice: "x" } } }));
  ledger.append(turn("running"));
  const tool = ledger.append(turn("running", "agent.tool", { name: "read", phase: "start", summary: "在看文件" }));
  const service = createHistoryService({ ledger });
  const current = await call(service, owner, "current", { limit: 20 });
  assert.equal(current.total_count, 259); assert.equal(current.items.length, 20); assert.equal(current.presence.state, "working");
  assert.equal(current.progress.id, "running"); assert.equal(current.progress.steps[0].id, tool.id);
  const older = await call(service, owner, "current", { before: current.before, limit: 20, snapshot_seq: current.snapshot_seq });
  assert.equal(older.total_count, 259); assert.equal(older.items.length, 20); assert.equal(older.has_more_after, true);
  ledger.append(turn("running", "agent.tool", { name: "read", phase: "end", summary: "看完文件", ok: true }));
  assert.equal((await call(service, owner, "current")).presence.state, "thinking");
  ledger.append(turn("running", "turn.ended", { outcome: "completed" }));
  assert.equal((await call(service, owner, "current")).presence.state, "waiting_you");
  assert.equal((await call(service, owner, "window", { after: 0, limit: 5 })).items.length, 5);
  assert.ok((await call(service, owner, "current")).progress.ended);
});

test("failed cards use global later-owner suppression, snapshot and exact existing retry rules", async () => {
  const { ledger } = openLedger(); const time = Date.now();
  ledger.append({ ...say("重试这个", "person:owner"), ts: time - 1000 });
  ledger.append({ ...turn("failed"), ts: time - 800 });
  const ended = ledger.append({ ...turn("failed", "turn.ended", { outcome: "error" }), ts: time - 500 });
  ledger.append(say("另外一条"));
  let clock = time;
  const service = createHistoryService({ ledger, now: () => clock });
  const old = await call(service, owner, "window", { around_id: "failed", limit: 1 });
  assert.equal(old.items[0].id, "failed"); assert.equal(old.items[0].seq, ended.seq);
  assert.deepEqual(old.items[0].retry, { text: "重试这个", to: "agent:main" });
  ledger.append({ ...say("后来的消息", "person:owner"), ts: time + 1 });
  assert.equal(await code(call(service, owner, "window", { around_id: "failed" })), "not_found");
  assert.ok((await call(service, owner, "window", { around_id: "failed", snapshot_seq: ended.seq })).items.some((x: any) => x.id === "failed"));
  clock = time + 86400000;
  assert.equal(await code(call(service, owner, "window", { around_id: "failed", snapshot_seq: ended.seq })), "not_found");
});

test("intro requires true history start and the original <=8, no-owner prefix semantics", async () => {
  const { ledger } = openLedger(); const service = createHistoryService({ ledger });
  for (let i = 0; i < 8; i++) ledger.append(say("你好"));
  assert.equal((await call(service, owner, "window", { after: 0, limit: 6 })).intro, true);
  ledger.append(say("第九条"));
  assert.equal((await call(service, owner, "window", { after: 0, limit: 6 })).intro, false);
  assert.equal((await call(service, owner, "window", { limit: 6 })).intro, false);
});

test("activity pages turn summaries and native tool completions with finite step pages", async () => {
  const { ledger } = openLedger();
  const mine = ledger.append(say("测试一轮", "person:owner"));
  ledger.append(turn("one", "turn.started", { ids: [mine.id] }));
  const starts: string[] = [];
  for (let i = 0; i < 20; i++) {
    starts.push(ledger.append(turn("one", "agent.tool", { name: "read", phase: "start", summary: `读取 ${i}` })).id);
    ledger.append(turn("one", "agent.tool", { name: "read", phase: "end", ok: i !== 0 }));
  }
  ledger.append(turn("one", "turn.ended", { outcome: "completed" }));
  ledger.append(turn("two"));
  const service = createHistoryService({ ledger });
  const turns = await call(service, owner, "activity.page", { limit: 1 });
  assert.equal(turns.items[0].id, "two"); assert.equal(turns.has_more_before, true);
  const previous = await call(service, owner, "activity.page", { before: turns.before });
  assert.equal(previous.items[0].title, "测试一轮"); assert.equal(previous.items[0].outcome, "completed");
  const steps = await call(service, owner, "activity.page", { turn: "one", after: 0, limit: 5 });
  assert.deepEqual(steps.items.map((x: any) => x.id), starts.slice(0, 5));
  assert.equal(steps.items[0].state, "failed"); assert.equal(steps.items[1].state, "ok"); assert.equal(steps.has_more_after, true);
});

test("relation writes and derived completion indexes roll back together; dataset id survives reopen", () => {
  const { ledger, path } = openLedger(); const m = ledger.append(say("输入", "person:owner"));
  const dataset = ledger.db().prepare("SELECT value FROM kv WHERE key='dataset_id'").get()!.value;
  assert.throws(() => ledger.tx(() => { ledger.append(turn("rollback", "turn.started", { ids: [m.id] })); throw new Error("rollback"); }));
  assert.equal(ledger.db().prepare("SELECT count(*) AS n FROM message_relations").get()!.n, 0);
  assert.equal(ledger.page({ limit: 10 }).length, 1);
  ledger.close(); const reopened = Ledger.open(path);
  try { assert.equal(reopened.db().prepare("SELECT value FROM kv WHERE key='dataset_id'").get()!.value, dataset); } finally { reopened.close(); }
});

test("bounded confirmation checks evicted outbox ids without replaying or sending messages", async () => {
  const { ledger } = openLedger();
  const mine = ledger.append(say("old", "person:owner"));
  const hers = ledger.append(say("reply"));
  const service = createHistoryService({ ledger });
  const confirmed = await call(service, owner, "confirm", { ids: [mine.id, hers.id, "absent"] });
  assert.deepEqual(confirmed.ids, [mine.id]);
  assert.deepEqual((await call(service, owner, "confirm", { ids: [mine.id], snapshot_seq: 0 })).ids, []);
  assert.equal(ledger.page({ limit: 10 }).length, 2);
});

test("activity receipt completion and older pending steps survive a short current progress window", async () => {
  const { ledger } = openLedger(); ledger.append(turn("live"));
  const pending = ledger.append({ from: "agent:main", to: "service:test", kind: "request", word: "work", body: { purpose: "老的长任务" }, turn: "live" });
  const service = createHistoryService({ ledger });
  for (let i = 0; i < 8; i++) {
    ledger.append(turn("live", "agent.tool", { name: "fast", phase: "start", summary: `短任务 ${i}` }));
    ledger.append(turn("live", "agent.tool", { name: "fast", phase: "end", ok: true }));
  }
  const old = await call(service, owner, "current");
  assert.equal(old.presence.state, "working"); assert.equal(old.presence.text, "老的长任务"); assert.equal(old.progress.steps_more, true);
  ledger.append({ from: "service:test", to: "agent:main", kind: "response", word: "work", reply_to: pending.id, body: { ok: true, result: { data: { status: "accepted", request_id: "job" } } } });
  const accepted = await call(service, owner, "activity.page", { turn: "live", after: 0, limit: 1 });
  assert.equal(accepted.items[0].state, "accepted"); assert.equal(accepted.items[0].ended, undefined);
  ledger.append({ from: "service:test", to: "agent:main", kind: "response", word: "work", reply_to: "job", body: { ok: true, result: { data: { value: "private result" } } } });
  const completed = await call(service, owner, "activity.page", { turn: "live", after: 0, limit: 1 });
  assert.equal(completed.items[0].state, "ok"); assert.ok(completed.items[0].ended);
  assert.equal((await call(service, owner, "current")).presence.state, "thinking");
  assert.equal((await call(service, owner, "current", { snapshot_seq: old.snapshot_seq })).presence.text, "老的长任务");
  assert.ok(!JSON.stringify(completed).includes("private result"));
});

test("activity pairs one wrapper and its dispatch within a turn; late transport success cannot erase failure", async () => {
  const { ledger } = openLedger(); const service = createHistoryService({ ledger });
  const args = { purpose: "读取文件", path: "note.md", private: "do-not-show" };
  for (const order of ["wrapper", "dispatch"]) {
    ledger.append(turn(order));
    const wrapper = { from: "agent:main", to: "service:dsh-tool", kind: "request" as const, word: "mcp__ash__capability_call", turn: order,
      body: { arguments: JSON.stringify({ member: "device:phone", word: "read", body: args }) } };
    const dispatch = { from: "agent:main", to: "device:phone", kind: "request" as const, word: "read", turn: order, body: args };
    const first = ledger.append(order === "wrapper" ? wrapper : dispatch);
    const second = ledger.append(order === "wrapper" ? dispatch : wrapper);
    const w = order === "wrapper" ? first : second, d = order === "wrapper" ? second : first;
    ledger.append({ from: "device:phone", to: "agent:main", kind: "response", word: "read", reply_to: d.id, body: { ok: false, error: { code: "failed" } } });
    ledger.append({ from: "service:dsh-tool", to: "agent:main", kind: "response", word: wrapper.word, reply_to: w.id, body: { ok: true, result: { data: { status: "accepted", request_id: d.id } } } });
    const page = await call(service, owner, "activity.page", { turn: order, limit: 1 });
    assert.equal(page.items.length, 1); assert.equal(page.items[0].id, first.id); assert.equal(page.items[0].requestId, w.id);
    assert.equal(page.items[0].state, "failed"); assert.equal(page.has_more_before, false); assert.equal(page.has_more_after, false);
    assert.ok(!JSON.stringify(page).includes("do-not-show"));
    assert.equal((await call(service, owner, "current")).presence.state, "thinking");
  }
});

test("normal polling stays hidden, failed polling is visible, and old snapshots do not see future failures", async () => {
  const { ledger } = openLedger(); ledger.append(turn("poll"));
  const poll = ledger.append({ from: "agent:main", to: "service:dsh-tool", kind: "request", word: "mcp__ash__await_result", turn: "poll", body: { arguments: "{}" } });
  const service = createHistoryService({ ledger });
  const before = await call(service, owner, "activity.page", { turn: "poll" });
  assert.deepEqual(before.items, []); assert.equal(before.before, poll.seq);
  assert.equal((await call(service, owner, "current")).presence.state, "thinking");
  ledger.append({ from: "service:dsh-tool", to: "agent:main", kind: "response", word: poll.word, reply_to: poll.id, body: { ok: false, error: { code: "failed" } } });
  const after = await call(service, owner, "activity.page", { turn: "poll" });
  assert.equal(after.items[0].state, "failed");
  assert.deepEqual((await call(service, owner, "activity.page", { turn: "poll", snapshot_seq: before.snapshot_seq })).items, []);
  assert.equal((await call(service, owner, "activity.page")).items[0].step_count, 1);
  assert.equal((await call(service, owner, "activity.page", { snapshot_seq: before.snapshot_seq })).items[0].step_count, 0);
});

test("a replacement turn overtakes a dead front turn rather than resurrecting it after completion", async () => {
  const { ledger } = openLedger(); ledger.append(turn("dead"));
  const service = createHistoryService({ ledger }); const old = await call(service, owner, "current");
  ledger.append(turn("replacement")); ledger.append(turn("replacement", "turn.ended", { outcome: "completed" }));
  assert.ok((await call(service, owner, "current")).progress.ended);
  assert.equal((await call(service, owner, "current")).presence.state, "idle");
  assert.equal((await call(service, owner, "current", { snapshot_seq: old.snapshot_seq })).progress.id, "dead");
});

test("large argument and result blobs retain only safe state metadata, including asynchronous receipt completion", async () => {
  const { ledger } = openLedger(); ledger.append(turn("large"));
  const args = { purpose: "大量数据的任务", rows: Array(12000).fill("private-value") };
  const work = ledger.append({ from: "agent:main", to: "service:test", kind: "request", word: "work", turn: "large", body: args });
  const accepted = ledger.append({ from: "service:test", to: "agent:main", kind: "response", word: "work", reply_to: work.id,
    body: { ok: true, result: { data: { status: "accepted", request_id: "large-job", rows: Array(12000).fill("private-result") } } } });
  assert.ok((accepted.body as any).result.$blob);
  const service = createHistoryService({ ledger });
  const waiting = await call(service, owner, "activity.page", { turn: "large" });
  assert.equal(waiting.items[0].state, "accepted"); assert.equal(waiting.items[0].receipt, "large-job");
  const ended = ledger.append({ from: "service:test", to: "agent:main", kind: "response", word: "work", reply_to: "large-job",
    body: { ok: false, error: { code: "failed", detail: Array(12000).fill("private-error") } } });
  assert.ok((ended.body as any).error.$blob);
  const failed = await call(service, owner, "activity.page", { turn: "large" });
  assert.equal(failed.items[0].state, "failed");
  for (const value of ["private-value", "private-result", "private-error"]) assert.ok(!JSON.stringify(failed).includes(value));
  const metadata = ledger.db().prepare("SELECT state_facts FROM messages WHERE id IN (?,?)").all(work.id, accepted.id);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 1024);
  assert.equal((await call(service, owner, "activity.page", { turn: "large", snapshot_seq: waiting.snapshot_seq })).items[0].state, "accepted");
});

test("answers and delivery survive result fields becoming blobs; long answers retain an owned full reference", async () => {
  const { ledger } = openLedger(); const service = createHistoryService({ ledger });
  const mine = ledger.append(say("输入", "person:owner"));
  ledger.append({ from: "agent:main", to: "person:owner", kind: "response", word: "say", reply_to: mine.id,
    body: { ok: true, result: { data: { accepted: true, rows: Array(12000).fill("private-result") } } } });
  const ask = ledger.append({ ...say(""), word: "ask", body: { title: "选择", options: [{ id: "x", label: "X" }], allow_custom: true } });
  ledger.append(reply(ask.id, "ask", { ok: true, result: { data: { choice: "x", text: "短回答", rows: Array(12000).fill("private-answer") } } }));
  const short = await call(service, owner, "window", { after: 0 });
  assert.equal(short.items[0].delivery, "delivered");
  assert.equal(short.items[1].ask.state, "answered"); assert.equal(short.items[1].ask.answer_text, "短回答");
  const other = ledger.append({ ...say(""), word: "ask", body: { title: "补充", options: [], allow_custom: true } });
  const longText = "中".repeat(12000);
  const answer = ledger.append(reply(other.id, "ask", { ok: true, result: { data: { choice: "__custom", text: longText } } }));
  const long = await call(service, owner, "window", { around_id: other.id, limit: 1 });
  assert.equal(long.items[0].ask.state, "answered");
  assert.ok(long.items[0].ask.answer_text.length < 500); assert.match(long.items[0].ask.answer_full, /^[a-f0-9]{64}$/);
  const full = ledger.blob.get(long.items[0].ask.answer_full)!;
  assert.equal(Buffer.from(full.bytes).toString(), longText);
  assert.ok(ledger.db().prepare("SELECT 1 FROM message_blobs WHERE message_id=? AND hash=?").get(answer.id, long.items[0].ask.answer_full));
  assert.ok(!JSON.stringify(short).includes("private-answer")); assert.ok(!JSON.stringify(short).includes("private-result"));
});

test("long gate originals retain an owned reference while other publishers cannot supply originals", async () => {
  const { ledger } = openLedger(); const text = "原文".repeat(12000);
  const input = { title: "确认操作", human_kind: "confirmation", source: { body_full: text }, rows: Array(12000).fill("private-unselected") };
  const gate = ledger.append({ from: "service:gate", to: "person:owner", word: "ask", kind: "request", body: input });
  const other = ledger.append({ from: "agent:main", to: "person:owner", word: "ask", kind: "request", body: input });
  const service = createHistoryService({ ledger });
  const page = await call(service, owner, "window", { after: 0 });
  assert.equal(page.items[0].id, gate.id); assert.equal(page.items[1].id, other.id);
  assert.ok(page.items[0].ask.original.length < 500); assert.match(page.items[0].ask.original_full, /^[a-f0-9]{64}$/);
  assert.equal(Buffer.from(ledger.blob.get(page.items[0].ask.original_full)!.bytes).toString(), text);
  assert.equal(page.items[1].ask.original, undefined); assert.equal(page.items[1].ask.original_full, undefined);
  assert.ok(!JSON.stringify(page).includes("private-unselected"));
});

test("completed progress keeps the complete step count for sixty seconds independently of current presence", async () => {
  const { ledger } = openLedger(); let time = 1_800_000_000_000;
  const service = createHistoryService({ ledger, now: () => time });
  ledger.append({ ...turn("finished"), ts: time - 3000 });
  for (let i = 0; i < 12; i++) {
    ledger.append({ ...turn("finished", "agent.tool", { name: "work", phase: "start", summary: String(i) }), ts: time - 2000 });
    ledger.append({ ...turn("finished", "agent.tool", { name: "work", phase: "end", ok: true }), ts: time - 1000 });
  }
  ledger.append({ ...turn("finished", "turn.ended", { outcome: "completed" }), ts: time });
  const done = await call(service, owner, "current");
  assert.equal(done.presence.state, "idle"); assert.equal(done.progress.id, "finished");
  assert.equal(done.progress.step_count, 12); assert.equal(done.progress.steps.length, 5);
  assert.equal(done.next_change_at, time + 60_000);
  time += 59_999; assert.equal((await call(service, owner, "current")).progress.step_count, 12);
  time++; assert.equal((await call(service, owner, "current")).progress, null);
});

test("activity total counts every turn in a day and agent independently of paged items", async () => {
  const { ledger } = openLedger(); const day = 1_800_000_000_000;
  ledger.tx(() => {
    for (let i = 0; i < 250; i++) ledger.append({ ...turn(`today_${i}`), from: i % 2 ? "agent:other" : "agent:main", ts: day + i });
    ledger.append({ ...turn("yesterday"), ts: day - 1 });
    ledger.append({ ...turn("tomorrow"), ts: day + 86_400_000 });
  });
  const service = createHistoryService({ ledger });
  const page = await call(service, owner, "activity.page", { since_ts: day, until_ts: day + 86_400_000, limit: 10 });
  assert.equal(page.items.length, 10); assert.equal(page.total_count, 250); assert.equal(page.has_more_before, true);
  const main = await call(service, owner, "activity.page", { since_ts: day, until_ts: day + 86_400_000, agent: "agent:main", limit: 1 });
  assert.equal(main.total_count, 125); assert.equal(main.items[0].agent, "agent:main");
  const older = await call(service, owner, "activity.page", { since_ts: day, until_ts: day + 86_400_000, agent: "agent:main", before: main.before, limit: 3 });
  assert.equal(older.total_count, 125); assert.equal(older.items.length, 3);
  assert.equal(await code(call(service, owner, "activity.page", { since_ts: day, until_ts: day - 1 })), "bad_request");
});

test("inline attachment display references retain an on-demand path to exact original bytes", async () => {
  const { ledger } = openLedger(); const data = Buffer.alloc(12000, 37).toString("base64");
  const sent = ledger.append({ ...say("附件"), body: { text: "附件", attachments: [{ name: "sample.bin", mime_type: "application/octet-stream", data }] } });
  const service = createHistoryService({ ledger });
  const window = await call(service, owner, "window");
  const attachment = window.items[0].attachments[0];
  assert.equal(attachment.message_id, sent.id); assert.equal(attachment.index, 0); assert.equal(attachment.size, 12000);
  assert.ok(!JSON.stringify(window).includes(data));
  const raw = await call(service, owner, "read", { from_seq: sent.seq, to_seq: sent.seq });
  const ref = raw.messages[0].body.attachments[attachment.index].data;
  assert.ok(ref.$blob); assert.equal(Buffer.from(ledger.blob.get(ref.$blob)!.bytes).toString(), data);
});

test("current scopes agent presence and complete pending counts without losing owner-wide gate approvals", async () => {
  const { ledger } = openLedger(); const time = Date.now();
  const a = ledger.append(say("给主agent", "person:owner"));
  const b = ledger.append({ ...say("给子agent", "person:owner"), to: "agent:other" });
  ledger.append(turn("main-live", "turn.started", { ids: [a.id] }));
  ledger.append({ ...turn("other-live", "turn.started", { ids: [b.id] }), from: "agent:other" });
  ledger.tx(() => {
    for (let i = 0; i < 70; i++) ledger.append({ ...say(""), from: i < 60 ? "agent:main" : "agent:other", word: "ask", body: { title: String(i), allow_custom: true, expires_at: time + 100_000 } });
    ledger.append({ ...say(""), from: "service:gate", word: "ask", body: { title: "批准", human_kind: "confirmation", expires_at: time + 100_000 } });
  });
  const service = createHistoryService({ ledger, now: () => time });
  const all = await call(service, owner, "current", { limit: 1 }); assert.equal(all.total_count, 71);
  const main = await call(service, owner, "current", { agent: "agent:main", limit: 2 });
  assert.equal(main.total_count, 60); assert.equal(main.items.length, 2); assert.equal(main.progress.id, "main-live");
  assert.equal(main.progress.message_id, a.id); assert.ok(main.items.every((x: any) => x.ask.from === "agent:main"));
  const older = await call(service, owner, "current", { agent: "agent:main", before: main.before, limit: 3 }); assert.equal(older.total_count, 60);
  const other = await call(service, owner, "current", { agent: "agent:other" }); assert.equal(other.total_count, 10); assert.equal(other.progress.message_id, b.id);
  const missing = await call(service, owner, "current", { agent: "agent:missing" }); assert.equal(missing.total_count, 0); assert.equal(missing.progress, null); assert.equal(missing.presence.state, "idle");
});

test("turn summaries locate a visible turn reply when no owner input exists and tool flags preserve display steps", async () => {
  const { ledger } = openLedger(); ledger.append(turn("no-input"));
  const tool = ledger.append(turn("no-input", "agent.tool", { name: "workspace.read", phase: "start" }));
  const work = ledger.append({ from: "agent:main", to: "service:test", kind: "request", word: "read", turn: "no-input", body: { purpose: "读取文件" } });
  const spoken = ledger.append({ ...say("这轮的答复"), turn: "no-input" });
  const service = createHistoryService({ ledger });
  const turns = await call(service, owner, "activity.page"); assert.equal(turns.items[0].message_id, spoken.id);
  const steps = await call(service, owner, "activity.page", { turn: "no-input" }); assert.equal(steps.total_count, 2);
  assert.deepEqual(steps.items.map((x: any) => [x.id, x.tool]), [[tool.id, true], [work.id, true]]);
  assert.equal((await call(service, owner, "window", { around_id: turns.items[0].message_id })).items[0].id, spoken.id);
});
