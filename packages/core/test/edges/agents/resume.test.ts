/**
 * Picking up a cut turn: the classes of its tool calls and the recovery prompt (resume.ts, pure), and the rules of the manager:
 * at most twice, never after the owner stopped it, the owner asked when it is too old, and the background lanes alike.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classify, ownerLine, readCalls, recoveryPrompt, type Call } from "../../../src/edges/agents/resume";
import { MAX_RESUMES, RESUME_WINDOW_MS } from "../../../src/edges/agents/manager";
import { openLedger } from "../../kernel/ledger/helpers";
import { fixture, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);
const texts = (call: unknown[]) => (call[3] as { text: string }[]).map((m) => m.text);
const call = (word: string, effect: Call["effect"], extra: Partial<Call> = {}): Call => ({ id: `id-${word}`, seq: 1, to: "device:phone", word, args: "", effect, ...extra });

test("classify: a reply is done, no reply or result_unknown is unknown, a parked call is waiting", () => {
  const got = classify([
    call("a", "read", { reply: { ok: true, text: "{}" } }),
    call("b", "act", { reply: { ok: false, text: "boom" } }),
    call("c", "act"),
    call("d", "write", { reply: { ok: false, text: "result_unknown" } }),
    call("e", "act", { state: "waiting_owner" }),
  ]);
  assert.deepEqual(got.done.map((c) => c.word), ["a", "b"]);
  assert.deepEqual(got.unknown.map((c) => c.word), ["c", "d"]);
  assert.deepEqual(got.waiting.map((c) => c.word), ["e"]);
});

test("recoveryPrompt: names the cut, the task, what is done (collapsed), what is not known (by effect) and what waits for the owner", () => {
  const done = [...Array(6)].map(() => call("vscreen.tap", "act", { reply: { ok: true, text: "" } }));
  const text = recoveryPrompt({
    at: 0, why: "大脑重启", task: "帮我查一下淘宝的物流状况", clock: () => "00:15:33",
    calls: classify([call("vscreen.create", "act", { reply: { ok: true, text: "" } }), ...done, call("vscreen.see", "read"), call("vscreen.swipe", "act", { args: '{"dy":-300}' }), call("fs.write", "write"), call("pay", "act", { state: "waiting_owner" })]),
  });
  assert.match(text, /^\[ash\] 上一轮在 00:15:33 被中断（大脑重启）。原任务：「帮我查一下淘宝的物流状况」。/);
  assert.match(text, /已完成：device:phone\/vscreen\.create、device:phone\/vscreen\.tap ×6。/);
  assert.match(text, /vscreen\.see（只读，可直接重做）/);
  assert.match(text, /vscreen\.swipe\(\{"dy":-300\}\)（动作类，可能已执行，先核对当前状态）/);
  assert.match(text, /fs\.write（写入类，可能已执行，先读回核对）/);
  assert.match(text, /在等主人批准：device:phone\/pay（不用重发/);
  assert.match(text, /不要重复已完成的动作/);
  assert.equal(ownerLine("大脑重启", "帮我查一下淘宝的物流状况"), "刚才中断了（大脑重启），正在接着做：帮我查一下淘宝的物流状况");
});

test("readCalls: the agent's calls in the cut turns with their replies; a parked call is waiting; the effect comes from the word", () => {
  const { ledger } = openLedger();
  const req = (word: string, turn: string, body: unknown, state: "dispatched" | "waiting_owner" = "dispatched") =>
    ledger.append({ from: M, to: "device:phone", kind: "request", word, body, turn }, { request: { state, deadline: 1 } });
  const reply = (r: { id: string }, word: string, body: unknown) => ledger.append({ from: "device:phone", to: M, kind: "response", word, body, reply_to: r.id });
  const a = req("look", "t1", { what: "x" });
  reply(a, "look", { ok: true, result: { data: { seen: 3 } } });
  const b = req("press", "t1", { key: "ok" });
  reply(b, "press", { ok: false, error: { code: "result_unknown", message: "restarted" } });
  req("pay", "t1", { amount: 1 }, "waiting_owner");
  req("other", "t2", {});
  const effects: Record<string, "read" | "act"> = { look: "read", press: "act" };
  const calls = readCalls(ledger.db(), M, ["t1"], (_to, word) => effects[word]);
  assert.deepEqual(calls.map((c) => [c.word, c.effect]), [["look", "read"], ["press", "act"], ["pay", "act"]]);
  const got = classify(calls);
  assert.deepEqual([got.done.map((c) => c.word), got.unknown.map((c) => c.word), got.waiting.map((c) => c.word)], [["look"], ["press"], ["pay"]]);
  assert.match(got.done[0]!.reply!.text, /seen/);
});

const front = async () => {
  const f = fixture();
  await f.start();
  await f.call(M, "say", { text: "做一件长任务" }, undefined);
  await waitFor(() => sends(f.driver(), "front").length === 1);
  return f;
};

test(`a turn is picked up at most ${MAX_RESUMES} times: the third cut is a failure, with the failure card, and nothing is sent after`, async () => {
  const f = await front();
  const d = f.driver();
  for (let n = 2; n <= MAX_RESUMES + 1; n++) {
    d.die(M, "killed");
    await waitFor(() => { for (const a of f.waiting()) a.fn(); return sends(d, "front").length === n; }); // (the backoff of the manager is the fixture's timers)
    assert.match(texts(sends(d, "front")[n - 1]!)[0]!, /被中断/);
  }
  assert.equal(f.router.to("person:owner", "show").length, 0, "still no card");
  d.die(M, "killed");
  await waitFor(() => { for (const a of f.waiting()) a.fn(); return f.router.to("person:owner", "show").length === 1; });
  await settle();
  assert.equal(sends(d, "front").length, MAX_RESUMES + 1, "nothing more is sent");
  assert.match(f.router.says().at(-1)!.text, /没做成/);
  const states = (f.ledger.db().prepare("SELECT state FROM turn_journal").all() as { state: string }[]).map((r) => r.state);
  assert.ok(states.includes("given_up"), states.join());
});

test("a turn the owner stopped is not picked up", async () => {
  const f = await front();
  const d = f.driver();
  d.finish(M, "front", "cancelled");
  await settle();
  const g = fixture({ from: f });
  await g.start();
  await settle();
  assert.equal(sends(g.driver(), "front").length, 0);
  assert.equal(f.agents.manager.journal.interrupted(M).length, 0);
});

test(`a turn cut off more than ${RESUME_WINDOW_MS / 60_000} minutes ago is not picked up by itself: the owner gets a card, and its button delivers the words again`, async () => {
  const f = await front();
  const turn = f.driver().running.get(`${M}/front`)!.turn;
  f.clock.t += RESUME_WINDOW_MS + 60_000; // the hub was down this long
  const g = fixture({ from: f });
  await g.start();
  await waitFor(() => g.router.to("person:owner", "show").length === 1);
  await settle();
  const d = g.driver();
  assert.equal(sends(d, "front").length, 0, "not by itself");
  const card = (g.router.to("person:owner", "show")[0]!.msg.body as any).card;
  assert.match(card.prompt, /做一件长任务.*被打断了，要不要继续/);
  assert.deepEqual(card.options, [{ id: `retry:${turn}`, text: "继续" }]);
  await g.call(M, "say", { in_reply_to: "card_1", option_id: card.options[0].id, text: "继续" }, undefined);
  await waitFor(() => sends(d, "front").length === 1);
  assert.deepEqual(texts(sends(d, "front")[0]!), ["做一件长任务"]);
});

test("a turn on a background lane is picked up as well, with no word to the owner when the owner did not ask for it", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "wake", { reason: "pulse" }, { member: "service:clock", via: "service", local: true });
  await waitFor(() => sends(d, "back").length === 1);
  d.die(M, "killed");
  await waitFor(() => sends(d, "back").length === 2);
  assert.match(texts(sends(d, "back")[1]!)[0]!, /被中断/);
  assert.deepEqual(f.router.says(), []);
});
