import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message, type Outgoing, type Reply, type Caller, type WordResult } from "../../../../sdk/src/message";
import { openLedger } from "../../kernel/ledger/helpers";
import { createJev, createReflexService } from "../../../src/services/reflex";
import { JEV_PATH } from "../../../src/services/reflex/jev";

const ctx = (signal = new AbortController().signal): HandleContext => ({ signal, caller: { member: "service:agents", via: "service", local: true }, raw: null });
const request = (word: string, body: unknown): Message => ({ seq: 0, id: "m_req", ts: 0, from: "person:owner", to: "service:reflex", kind: "request", word, body });

type Answer = unknown | (() => Promise<unknown>);
function setup(jevAnswer?: Answer, replies: Record<string, Reply> = {}, log: (line: string) => void = () => {}) {
  const { ledger } = openLedger();
  const sent: { msg: Outgoing; caller: Caller }[] = [];
  const router = { send: async (msg: Outgoing, caller: Caller): Promise<Reply> => { sent.push({ msg, caller }); return replies[`${msg.to}/${msg.word}`] ?? { ok: true, result: { data: {} } }; } };
  const asked: unknown[] = [];
  const jev = jevAnswer === undefined ? undefined : { evaluate: async (state: unknown, questions: Record<string, unknown>) => {
    asked.push({ state, questions });
    return typeof jevAnswer === "function" ? (jevAnswer as () => Promise<unknown>)() : jevAnswer;
  } };
  const service = createReflexService({ ledger, router, log, ...(jev ? { jev } : {}) });
  const call = async (word: string, body: unknown, c = ctx()): Promise<WordResult> => (await service.handle(request(word, body), c)) as WordResult;
  const owner = (text: string) => ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text } });
  const event = (from: string, word: string, body: unknown, turn?: string) => ledger.append({ from, to: null, kind: "event", word, body, ...(turn ? { turn } : {}) });
  return { ledger, service, call, sent, asked, owner, event };
}
const intent = (choice: string, confidence: number, target: number) => ({ answers: { intent: { choice, confidence }, targets_current: { noul: target }, urgency: { score: 1 } } });
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; } assert.fail("expected a WordError"); };

test("the member is service:reflex with the contract words of the sdk", () => {
  const { service } = setup();
  assert.equal(service.id, "service:reflex");
  assert.deepEqual(service.words().map((w) => w.word).sort(), ["conversation.control", "task.end", "task.outcome", "task.stop"]);
});

// ---- conversation.control ------------------------------------------------------------------------------------

test("a plain stop word interrupts without asking JEV", async () => {
  const f = setup(intent("unrelated", 0.9, 0));
  const m = f.owner("停下");
  assert.deepEqual((await f.call("conversation.control", { message_id: m.id, agent: "agent:main", lane: "front" })).data, { action: "interrupt", confidence: 1, stage: "keyword" });
  assert.equal(f.asked.length, 0);
});

test("the word 暂停 is the pause switch", async () => {
  const f = setup();
  const m = f.owner("暂停");
  assert.equal(((await f.call("conversation.control", { message_id: m.id, agent: "agent:main" })).data as { action: string }).action, "pause");
});

test("JEV: a clear stop interrupts, a redirect on the current task steers, an unrelated message waits", async () => {
  const stop = setup(intent("stop_current", 0.9, 0.8));
  const a = stop.owner("好了好了，不要这个方向，别弄了啊");
  assert.deepEqual((await stop.call("conversation.control", { message_id: a.id, agent: "agent:main" })).data, { action: "interrupt", confidence: 0.8, stage: "jev" });

  const steer = setup(intent("redirect", 0.9, 0.9));
  const b = steer.owner("顺便把标题改成英文");
  assert.deepEqual((await steer.call("conversation.control", { message_id: b.id, agent: "agent:main" })).data, { action: "steer", confidence: 0.9, stage: "jev" });

  const other = setup(intent("unrelated", 0.95, 0.05));
  const c = other.owner("明天天气怎么样");
  assert.deepEqual((await other.call("conversation.control", { message_id: c.id, agent: "agent:main" })).data, { action: "followup", confidence: 0.05, stage: "jev" });

  const weak = setup(intent("stop_all", 0.3, 1));
  const d = weak.owner("嗯……要不先别弄了？");
  assert.equal(((await weak.call("conversation.control", { message_id: d.id, agent: "agent:main" })).data as { action: string }).action, "followup");
});

test("JEV sees the running task: the first thing the turn was given, the new message, and the last two said", async () => {
  const f = setup(intent("unrelated", 0.9, 0));
  const first = f.owner("帮我整理下载文件夹");
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [first.id] });
  const m = f.owner("顺便问下几点了");
  await f.call("conversation.control", { message_id: m.id, agent: "agent:main", lane: "front" });
  const { state } = f.asked[0] as { state: Record<string, unknown> };
  assert.equal(state.current_task, "帮我整理下载文件夹");
  assert.equal(state.latest_user_message, "顺便问下几点了");
  assert.deepEqual(state.recent_messages, ["帮我整理下载文件夹"]);
});

test("a JEV failure, a malformed answer, a timeout, or no JEV at all is followup", async () => {
  const cases: Record<string, ReturnType<typeof setup>> = {
    throws: setup(async () => { throw new Error("JEV unavailable"); }),
    malformed: setup({ answers: { intent: { choice: "stop_all", confidence: 7 } } }),
    never: setup(() => new Promise(() => {})),
    none: setup(),
  };
  for (const [name, f] of Object.entries(cases)) {
    const m = f.owner("先别动，等等看他怎么说吧");
    const controller = new AbortController();
    const running = f.call("conversation.control", { message_id: m.id, agent: "agent:main" }, ctx(controller.signal));
    if (name === "never") setTimeout(() => controller.abort(), 20);
    const data = (await running).data as { action: string; confidence: number };
    assert.equal(data.action, "followup", name);
    assert.equal(data.confidence, 0, name);
  }
});

test("a JEV failure that falls back to keywords is logged: the agent and why, never the message text or a key", async () => {
  const lines: string[] = [];
  const f = setup(async () => { throw new Error("the provider answered HTTP 401"); }, {}, (line) => lines.push(line));
  const m = f.owner("先别动，等等看他怎么说吧 secret-owner-words");
  const data = (await f.call("conversation.control", { message_id: m.id, agent: "agent:main" })).data;
  assert.deepEqual(data, { action: "followup", confidence: 0, stage: "keyword" });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^conversation\.control agent:main: JEV failed, fell back to keywords \(the provider answered HTTP 401\)$/);
  assert.doesNotMatch(lines[0]!, /secret-owner-words/);
  // a keyword decision, no JEV configured, and a cancelled call are not failures to log
  const quiet: string[] = [];
  const stop = setup(async () => { throw new Error("never asked"); }, {}, (line) => quiet.push(line));
  await stop.call("conversation.control", { message_id: stop.owner("停下").id, agent: "agent:main" });
  const none = setup(undefined, {}, (line) => quiet.push(line));
  await none.call("conversation.control", { message_id: none.owner("等等看吧").id, agent: "agent:main" });
  assert.deepEqual(quiet, []);
});

test("task.outcome logs a JEV failure too, and still answers unavailable", async () => {
  const lines: string[] = [];
  const f = setup(async () => { throw new Error("the provider answered HTTP 401"); }, {}, (line) => lines.push(line));
  const owner = f.owner("do it");
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [owner.id] }, "t1");
  f.ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "done" }, turn: "t1" });
  f.event("agent:main", "turn.ended", { turn: "t1", outcome: "completed" }, "t1");
  assert.equal(await code(f.call("task.outcome", { turn: "t1" })), "unavailable");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^task\.outcome t1: JEV failed, no label given \(the provider answered HTTP 401\)$/);
});

test("jev goes through the post of edges/llm: the decisions path, the model and the state in the body", async () => {
  const seen: unknown[] = [];
  const jev = createJev({ post: async (r) => { seen.push(r); return intent("unrelated", 0.9, 0.1); }, timeoutMs: 6000 });
  const f = setup();
  const service = createReflexService({ ledger: f.ledger, router: { send: async () => ({ ok: true }) }, jev });
  const m = f.owner("今天几号");
  const out = await service.handle(request("conversation.control", { message_id: m.id, agent: "agent:main" }), ctx()) as WordResult;
  assert.equal((out.data as { action: string }).action, "followup");
  const call = seen[0] as { provider: string; path: string; body: { model: string; state: unknown; questions: unknown }; timeout_ms: number };
  assert.equal(call.provider, "openrouter"); assert.equal(call.path, "/api/alpha/decisions"); assert.equal(call.timeout_ms, 6000);
  assert.equal(call.body.model, "typesafe/jev-1.13");
  assert.ok(call.body.state && call.body.questions);
  assert.equal(JEV_PATH, "/api/alpha/decisions");
});

test("conversation.control: bad input and an unknown message", async () => {
  const f = setup();
  assert.equal(await code(f.call("conversation.control", { agent: "agent:main" })), "bad_request");
  assert.equal(await code(f.call("conversation.control", { message_id: "nope", agent: "agent:main" })), "not_found");
  assert.equal(await code(f.call("nothing", {})), "not_found");
});

// ---- task.stop and task.end ----------------------------------------------------------------------------------

test("task.stop sends session.interrupt for the lane the turn runs on, as service:reflex", async () => {
  const f = setup(undefined, { "service:agents/session.interrupt": { ok: true, result: { data: { interrupted: true } } } });
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  assert.deepEqual((await f.call("task.stop", { turn: "t1" })).data, { cancelled: true });
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]!.msg, { to: "service:agents", kind: "request", word: "session.interrupt", body: { agent: "agent:main", key: "front" } });
  assert.equal(f.sent[0]!.caller.member, "service:reflex");
});

test("task.stop never stops a turn that is over, a newer turn, or one that does not exist", async () => {
  const f = setup();
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  f.event("agent:main", "turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  f.event("agent:main", "turn.started", { turn: "t2", lane: "back", ids: [] });
  f.event("agent:main", "turn.started", { turn: "t3", lane: "back", ids: [] });
  for (const turn of ["t1", "t2", "nope"]) assert.deepEqual((await f.call("task.stop", { turn })).data, { cancelled: false }, turn);
  assert.equal(f.sent.length, 0);
  assert.equal(await code(f.call("task.stop", {})), "bad_request");
});

test("task.stop passes the agents' refusal on", async () => {
  const f = setup(undefined, { "service:agents/session.interrupt": { ok: false, error: { code: "offline", message: "agent is stopped" } } });
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  assert.equal(await code(f.call("task.stop", { turn: "t1" })), "offline");
});

test("task.end withdraws the displayed requests, then interrupts the running turn", async () => {
  const f = setup(undefined, { "service:agents/session.interrupt": { ok: true, result: { data: { interrupted: true } } } });
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  assert.deepEqual((await f.call("task.end", { turn: "t1", pending_ids: ["p1", "p2"] })).data, { ended: true });
  assert.deepEqual(f.sent.map((s) => `${s.msg.to}/${s.msg.word}`), ["service:gate/pending.withdraw", "service:gate/pending.withdraw", "service:agents/session.interrupt"]);
  assert.deepEqual(f.sent[1]!.msg.body, { id: "p2" });
});

test("task.end on a finished turn only takes the cards down; one that cannot come down is logged and the turn is still stopped", async () => {
  const done = setup();
  done.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  done.event("agent:main", "turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  assert.deepEqual((await done.call("task.end", { turn: "t1", pending_ids: ["p1"] })).data, { ended: true });
  assert.deepEqual(done.sent.map((s) => s.msg.word), ["pending.withdraw"]);

  const lines: string[] = [];
  const stuck = setup(undefined, {
    "service:gate/pending.withdraw": { ok: false, error: { code: "conflict", message: "not waiting any more" } },
    "service:agents/session.interrupt": { ok: true, result: { data: { interrupted: true } } },
  }, (line) => lines.push(line));
  stuck.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  assert.deepEqual((await stuck.call("task.end", { turn: "t1", pending_ids: ["px", "py"] })).data, { ended: true });
  assert.deepEqual(stuck.sent.map((s) => s.msg.word), ["pending.withdraw", "pending.withdraw", "session.interrupt"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /px/);
  assert.deepEqual((await stuck.call("task.end", { turn: "nope", pending_ids: [] })).data, { ended: false });
});

// ---- task.outcome --------------------------------------------------------------------------------------------

function finishedTurn(f: ReturnType<typeof setup>, outcome = "completed") {
  const ask = f.owner("查一下明天的航班");
  f.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [ask.id] });
  const action = f.ledger.append({ from: "agent:main", to: "device:phone", kind: "request", word: "calendar.read", body: {}, turn: "t1" });
  f.ledger.append({ from: "device:phone", to: "agent:main", kind: "response", word: "calendar.read", body: { ok: true }, reply_to: action.id });
  f.ledger.append({ from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "明天 9:40 有一班，要订吗？" }, turn: "t1" });
  f.event("agent:main", "turn.ended", { turn: "t1", lane: "front", outcome });
}

test("task.outcome labels a finished turn from what the owner asked and what the agent said", async () => {
  const f = setup({ answers: { outcome: { choice: "needs_reply", confidence: 0.85 } } });
  finishedTurn(f);
  assert.deepEqual((await f.call("task.outcome", { turn: "t1" })).data, { outcome: "needs_reply", confidence: 0.85 });
  const { state, questions } = f.asked[0] as { state: Record<string, unknown>; questions: Record<string, unknown> };
  assert.deepEqual(state.owner_request, ["查一下明天的航班"]);
  assert.deepEqual(state.final_replies, ["明天 9:40 有一班，要订吗？"]);
  assert.deepEqual(state.actions, [{ word: "calendar.read", ok: true }]);
  assert.ok("outcome" in questions);
});

test("task.outcome: no label for a turn that did not end normally, said nothing, or when JEV cannot answer or is not sure (below 0.6)", async () => {
  const cancelled = setup({ answers: { outcome: { choice: "delivered", confidence: 1 } } });
  finishedTurn(cancelled, "cancelled");
  assert.equal(await code(cancelled.call("task.outcome", { turn: "t1" })), "conflict");

  const running = setup({});
  running.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  assert.equal(await code(running.call("task.outcome", { turn: "t1" })), "conflict");

  const silent = setup({});
  silent.event("agent:main", "turn.started", { turn: "t1", lane: "front", ids: [] });
  silent.event("agent:main", "turn.ended", { turn: "t1", lane: "front", outcome: "completed" });
  assert.equal(await code(silent.call("task.outcome", { turn: "t1" })), "conflict");

  const broken = setup({ answers: { outcome: { choice: "fine", confidence: 1 } } });
  finishedTurn(broken);
  assert.equal(await code(broken.call("task.outcome", { turn: "t1" })), "unavailable");

  const unsure = setup({ answers: { outcome: { choice: "delivered", confidence: 0.4 } } });
  finishedTurn(unsure);
  assert.equal(await code(unsure.call("task.outcome", { turn: "t1" })), "unavailable");

  const noJev = setup();
  finishedTurn(noJev);
  assert.equal(await code(noJev.call("task.outcome", { turn: "t1" })), "unavailable");
  assert.equal(await code(noJev.call("task.outcome", { turn: "nope" })), "not_found");
});
