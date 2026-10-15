import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryService } from "../../../src/services/history";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, owner } from "../support";

test("team exchanges pair questions and answers, page stably and keep the owner's main conversation out", async () => {
  const { ledger } = openLedger();
  const append = (from: string, to: string, word: string, body: unknown) => ledger.append({ from, to, word, body, kind: "request" });
  const q = append("agent:main", "service:agents", "ask", { agent: "agent:research", text: "查一下" });
  ledger.append({ from: "service:agents", to: "agent:main", word: "ask", kind: "response", reply_to: q.id, body: { ok: true, result: { data: { agent: "agent:research", answer: "查到了" } } } });
  append("person:owner", "agent:main", "say", { text: "主对话" });
  append("agent:main", "person:owner", "say", { text: "前台回答" });
  append("agent:main", "service:clock", "tell", { text: "不是团队" });
  const note = append("person:owner", "service:agents", "tell", { agent: "agent:research", text: "注意这个" });
  const service = createHistoryService({ ledger });
  const first = await call(service, owner, "exchanges", { limit: 1 });
  assert.equal(first.items[0].id, note.id);
  assert.equal(first.items[0].state, "waiting"); // no delivery acknowledgement yet
  const older = await call(service, owner, "exchanges", { before: first.next_before, limit: 1 });
  assert.equal(older.items[0].id, q.id);
  assert.equal(older.items[0].to, "agent:research");
  assert.equal(older.items[0].answer.text, "查到了");
  assert.equal(older.items[0].state, "answered");
  assert.deepEqual((await call(service, agent(), "exchanges", { agent: "agent:research" })).items.map((x: any) => x.id), [note.id, q.id]);
  assert.deepEqual((await call(service, owner, "exchanges", { agent: "agent:other" })).items, []);
});

test("direct asks, failed replies, spawn recipient filtering and original long message references", async () => {
  const { ledger } = openLedger();
  const spawned = ledger.append({ from: "agent:main", to: "service:agents", kind: "request", word: "spawn", body: { task: "帮我查" } });
  ledger.append({ from: "service:agents", to: "agent:main", kind: "response", word: "spawn", reply_to: spawned.id, body: { ok: true, result: { data: { agent: "agent:w-one", answer: "结果" } } } });
  const q = ledger.append({ from: "person:owner", to: "agent:helper", kind: "request", word: "ask", body: { text: "长文".repeat(6000) } });
  ledger.append({ from: "agent:helper", to: "person:owner", kind: "response", word: "ask", reply_to: q.id, body: { ok: false, error: { code: "offline", message: "已停下" } } });
  const service = createHistoryService({ ledger });
  const items = (await call(service, owner, "exchanges")).items;
  assert.equal(items[0].state, "failed");
  assert.equal(items[0].answer.error, "已停下");
  assert.ok(items[0].text.startsWith("长文"));
  const raw = await call(service, owner, "read", { from_seq: items[0].seq, to_seq: items[0].seq });
  assert.ok(raw.messages[0].body.text.$blob); // expansion can use the existing blobs.read word
  assert.equal((await call(service, owner, "exchanges", { agent: "agent:w-one" })).items[0].id, spawned.id);
});

test("a later tell answer is attached to the original news, without a duplicate root row", async () => {
  const { ledger } = openLedger();
  const note = ledger.append({ from: "agent:main", to: "service:agents", kind: "request", word: "tell", body: { agent: "agent:h", text: "留意价格" } });
  ledger.append({ from: "service:agents", to: "agent:main", kind: "response", word: "tell", reply_to: note.id, body: { ok: true, result: { data: { sent: true, message_id: note.id } } } });
  const answer = ledger.append({ from: "agent:h", to: "agent:main", kind: "request", word: "tell", reply_to: note.id, body: { text: "价格降了" } });
  const service = createHistoryService({ ledger });
  const page = await call(service, owner, "exchanges");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, note.id);
  assert.equal(page.items[0].state, "answered");
  assert.equal(page.items[0].answer.text, "价格降了");
  assert.equal(page.items[0].answer.seq, answer.seq);
  assert.equal((await call(service, owner, "exchanges", { agent: "agent:h" })).items.length, 1);
});
