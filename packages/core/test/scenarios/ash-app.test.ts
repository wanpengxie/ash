import assert from "node:assert/strict";
import test from "node:test";
import { bodyOf, dataOf, MAIN, startScenario } from "./harness";
import { eventually } from "../fixtures/wait";

// Real hub + human link + agent MCP tools + body workspace. Only the agent's decision is scripted, not its routing or writes.
test("Ash app: a meeting correction wakes the back lane, corrects real memory and diary, and replies on the original note", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const call = async (word: string, body: Record<string, unknown>) => {
    const reply = await owner.call("service:persona", word, body); assert.ok(reply.ok, JSON.stringify(reply)); return dataOf(reply);
  };
  await call("memory.set", { file: "USER.md", content: "# 安排\n- 会议周二\n- 爱喝美式\n" });
  await call("diary.set", { date: "2026-10-15", content: "# 今天\n## 安排\n- 会议周二\n" });
  const observed: string[] = [];
  s.driver.scriptFor(MAIN, async (turn) => {
    const wake = turn.messages.find(m => m.word === "wake" && m.text.startsWith("Wake · owner_note\n"));
    if (!wake) return;
    const context = JSON.parse(wake.text.slice(wake.text.indexOf("\n") + 1));
    assert.equal(turn.key, "back"); assert.equal(context.note, "meeting-correction");
    const memory = await turn.call("service:persona", "memory.get", { file: "USER.md" });
    assert.equal(memory.isError, false, memory.text);
    const content = memory.data.files[0].content as string;
    observed.push(content);
    const saved = await turn.call("service:persona", "memory.set", { file: "USER.md", content: content.replace("会议周二", "会议周三") });
    assert.equal(saved.isError, false, saved.text);
    const diary = await turn.call("service:persona", "diary.get", { date: "2026-10-15" });
    const written = await turn.call("service:persona", "diary.set", { date: "2026-10-15", content: diary.data.content.replace("会议周二", "会议周三") });
    assert.equal(written.isError, false, written.text);
    const answered = await turn.call("service:persona", "note.reply", { id: context.note, text: "我把记忆和日记里的会议改成周三了，咖啡偏好保留。" });
    assert.equal(answered.isError, false, answered.text);
  });
  const note = await call("note", { id: "meeting-correction", about: "memory:USER.md", text: "会议周三，不是周二；日记也请改正" });
  assert.equal(note.told, true);
  await eventually(async () => (await call("notes.list", { about: "memory:USER.md" })).notes.find((n: any) => n.id === note.id && n.reply), "the reply on the original note");
  const memory = await call("memory.get", { file: "USER.md" });
  const diary = await call("diary.get", { date: "2026-10-15" });
  assert.equal(memory.files[0].content.trimEnd(), "# 安排\n- 会议周三\n- 爱喝美式");
  assert.match(diary.content, /会议周三/);
  assert.deepEqual(observed.map(text => text.trimEnd()), ["# 安排\n- 会议周二\n- 爱喝美式"]);
  const answered = (await call("notes.list", { about: "memory:USER.md" })).notes[0];
  assert.equal(answered.id, "meeting-correction"); assert.equal(answered.replied_by, MAIN);
  const ledger = await owner.ledger();
  assert.ok(ledger.some(m => m.word === "persona.changed" && bodyOf(m).part === "memory" && bodyOf(m).by === MAIN));
  assert.ok(ledger.some(m => m.word === "persona.changed" && bodyOf(m).part === "diary" && bodyOf(m).by === MAIN));
  assert.ok(ledger.some(m => m.word === "persona.changed" && bodyOf(m).part === "notes" && bodyOf(m).by === MAIN));
  const original = ledger.find(m => m.from === "person:owner" && m.word === "note" && bodyOf(m).id === "meeting-correction")!;
  assert.ok(original);
  assert.ok(!owner.messages.some(m => m.seq > original.seq && m.kind === "request" && m.from === MAIN && m.word === "say"), "background response stays by the note, not the front conversation");
});

test("Ash app: retrying an undelivered note notifies once and reports the actual delivery state", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  await owner.call("service:agents", "stop", { agent: MAIN });
  const payload = { id: "retry-note", about: "now", text: "会议是周三" };
  const first = await owner.call("service:persona", "note", payload);
  assert.ok(first.ok); assert.equal(dataOf(first).told, false);
  const started = await owner.call("service:agents", "start", { agent: MAIN }); assert.ok(started.ok);
  const retry = await owner.call("service:persona", "note", payload);
  assert.ok(retry.ok); assert.equal(dataOf(retry).told, true);
  const replay = await owner.call("service:persona", "note", payload);
  assert.ok(replay.ok); assert.equal(dataOf(replay).told, true);
  const notes = await owner.call("service:persona", "notes.list", { about: "now" });
  assert.equal(dataOf(notes).notes.filter((n: any) => n.id === payload.id).length, 1);
  await eventually(() => s.driver.turns.find(r => r.key === "back" && r.messages.some(m => m.text.includes("retry-note"))), "the retried background notification");
  assert.equal(s.driver.turns.filter(r => r.key === "back" && r.messages.some(m => m.text.includes("retry-note"))).length, 1);
});
