/**
 * REGRESSION-0.3 §3 (agent 和子 agent), SPEC-08 §5, HUB-MODULES §2.5: declarations, sub-agents, lanes, restarts, pausing,
 * the first meeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN, OWNER, accepted, bodyOf, byOwnerText, deferred, errorCode, extensionCapability, ownerMessage, quiet, resultOf,
  startScenario, textOf, toOwner, type ToolResult, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

const HELPER = "agent:helper";
const helper = (extra: Record<string, unknown> = {}) => ({
  id: HELPER, name: "帮手", summary: "做小事的帮手", brief: "照吩咐做小事，做完说一句。", runtime: { kind: "scripted" }, ...extra,
});

test("S046-S051: an agent declares a sub-agent, asks it, and the answer comes back; the owner hears nothing of it", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { created?: ToolResult; asked?: ToolResult } = {};
  s.driver.scriptFor(HELPER, (turn) => turn.say("答案是 42"));
  s.driver.scriptFor(MAIN, byOwnerText({
    "找帮手问问": async (turn) => {
      state.created = await turn.tool("agent_create", helper());
      await turn.tool("agent_start", { agent: HELPER });
      state.asked = await turn.tool("agent_ask", { agent: HELPER, text: "生命的意义是什么" });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("找帮手问问"));

  await eventually(() => state.asked, "the answer from the helper");
  assert.equal(state.created!.isError, false);
  assert.equal(resultOf(state.asked!).answer, "答案是 42");
  await quiet();
  assert.ok(!owner.messages.some((m) => m.to === OWNER && m.word === "say" && m.from === HELPER), "a sub-agent does not speak to the owner on its own");
  const list = await owner.call("service:agents", "list");
  assert.ok(list.ok && JSON.stringify(dataOf(list)).includes(HELPER), "the declaration is in the list");
});

test("SPEC-08 §5.7: a sub-agent cannot be given more than its maker has (declare is narrowed to the caller's tools)", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { within?: ToolResult; beyond?: ToolResult } = {};
  s.driver.scriptFor(HELPER, async (turn) => {
    state.within = await turn.tool("agent_create", { ...helper({ id: "agent:child-a" }), tools: ["human_say"] });
    state.beyond = await turn.tool("agent_create", { ...helper({ id: "agent:child-b" }), tools: ["human_say", "timer_set"] });
  });
  const owner = await s.human();
  const made = await owner.call("service:agents", "declare", { ...helper(), tools: ["agent_create", "human_say"] });
  assert.ok(made.ok, "the owner may declare any agent");
  await owner.call("service:agents", "start", { agent: HELPER });

  const told = await owner.call("service:agents", "tell", { agent: HELPER, text: "试着派两个下属" });
  assert.ok(told.ok);

  await eventually(() => state.beyond, "the helper's attempts");
  assert.equal(state.within!.isError, false, "a subset is allowed");
  assert.equal(state.beyond!.isError, true);
  assert.equal(errorCode(state.beyond!), "forbidden", "more than the caller has is forbidden, not a question to the owner");
});

test("SPEC-08 §5.7 (spawn): a temporary agent does one task and is gone; the ledger keeps what it did", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const state: { spawned?: ToolResult } = {};
  s.driver.script(async (turn) => {
    if (turn.agent !== MAIN) { turn.say("结果是 7"); return; }
    if (turn.messages.some(ownerMessage("派个临时工"))) {
      state.spawned = await turn.call("service:agents", "spawn", { task: "算 3 + 4", runtime: { kind: "scripted" } });
    }
  });
  const owner = await s.human();

  accepted(await owner.say("派个临时工"));

  await eventually(() => state.spawned, "the result of the temporary agent");
  assert.equal(resultOf(state.spawned!).answer, "结果是 7");
  const worker = s.driver.turns.find((r) => r.agent !== MAIN);
  assert.ok(worker && /^agent:w-/.test(worker.agent), "the temporary agent is named agent:w-<id>");
  await eventually(async () => {
    const list = await owner.call("service:agents", "list");
    return list.ok && !JSON.stringify(dataOf(list)).includes(worker.agent) ? true : null;
  }, "the temporary agent being removed");
  const ledger = await owner.ledger();
  assert.ok(ledger.some((m) => m.from === worker.agent || m.to === worker.agent), "what it did is still in the ledger");
});

test("SPEC-08 §5.8: the front and back lanes of one agent run at the same time", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => {
    if (turn.key === "front") await turn.until(hold.promise);
    else turn.say("后台那边我看到了");
  });
  const owner = await s.human();

  accepted(await owner.say("占着前台"));
  const front = await s.driver.turn((r) => r.key === "front", "the front turn");
  const told = await owner.call("service:agents", "tell", { agent: MAIN, text: "后台有事" });
  assert.ok(told.ok);

  const back = await s.driver.turn((r) => r.key === "back" && r.messages.some((m) => m.text.includes("后台有事")), "a back-lane turn");
  assert.equal(front.outcome, "running", "the front turn is still running");
  await back.done;
  assert.equal(back.outcome, "completed");
  await quiet();
  assert.ok(!owner.messages.some((m) => m.from === MAIN && textOf(m) === "后台那边我看到了"), "what the back lane says does not go to the owner");
  hold.resolve();
});

test("SPEC-01 §5.2: a sub-agent speaks to the owner only in the turn where the owner addressed it; its back lane in a turn at once is refused", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const hold = deferred();
  const state: { created?: ToolResult; back?: ToolResult; front?: ToolResult } = {};
  s.driver.scriptFor(MAIN, byOwnerText({
    "找帮手": async (turn) => {
      state.created = await turn.tool("agent_create", helper({ tools: ["human_say"] }));
      await turn.tool("agent_start", { agent: HELPER });
    },
    "叫帮手": async (turn) => { await turn.tool("agent_tell", { agent: HELPER, text: "后台有事" }); },
  }));
  s.driver.scriptFor(HELPER, async (turn) => {
    if (turn.key === "front") { await turn.until(hold.promise); state.front = await turn.tool("human_say", { text: "你好，我在" }); }
    else state.back = await turn.tool("human_say", { text: "我自己想说一句" });
  });
  const owner = await s.human();
  accepted(await owner.say("找帮手"));
  await eventually(() => state.created, "the helper being made");
  await eventually(async () => { const l = await owner.call("service:agents", "describe", { agent: HELPER }); return l.ok ? true : null; }, "the helper declared");

  const said = await owner.call(HELPER, "say", { text: "在吗" });
  assert.ok(said.ok, `the owner may speak to the helper directly: ${JSON.stringify(said)}`);
  const front = await s.driver.turn((r) => r.agent === HELPER && r.key === "front", "the helper's front turn");
  // another agent, not the owner, sends it news: that lands on the back lane, in a turn the owner did not address
  accepted(await owner.say("叫帮手"));
  const back = await s.driver.turn((r) => r.agent === HELPER && r.key === "back", "the helper's back turn");
  await back.done;
  assert.equal(front.outcome, "running", "both lanes were in a turn at once");
  assert.equal(state.back!.isError, true);
  assert.equal(errorCode(state.back!), "forbidden", "the back lane did not borrow the front lane's turn");
  await quiet();
  const spoke = () => owner.messages.filter((m) => m.from === HELPER && m.to === "person:owner" && m.kind === "request");
  assert.deepEqual(spoke(), [], "nothing of the back lane reached the owner");

  hold.resolve();
  await front.done;
  assert.equal(state.front!.isError, false);
  await eventually(() => spoke().find((m) => textOf(m) === "你好，我在"), "the front lane's words reaching the owner");
});

test("S170, S171, SPEC-00 §6.5: the hub restarts in the middle of a turn: the batch is not sent again; the agent is told, and a call in flight is not replayed", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [extensionCapability("x.test.act", { effect: "act", risk: "none" })] });
  const held = hand.hold("x.test.act");
  s.driver.script(byOwnerText({ "做一件慢事": async (turn) => { await turn.call(hand.member, "x.test.act", {}); } }));
  const owner = await s.human();
  accepted(await owner.say("做一件慢事"));
  await held.started;
  const before = s.driver.deliveries.length;

  await s.restart();

  const { message } = await s.driver.delivery((m) => m.lane === "back" && /中断|interrupt/i.test(m.text), "the note that the last turn was interrupted");
  assert.notEqual(message.from, OWNER);
  assert.equal(s.driver.deliveries.slice(before).filter((d) => d.messages.some(ownerMessage("做一件慢事"))).length, 0, "the owner's message was not given again");
  assert.equal(hand.calls.length, 1, "the call in flight was not replayed");
});

test("the hub is killed in the middle of a front turn (nothing written at the stop): after the restart the chat does not say it is still working", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [extensionCapability("x.test.act", { effect: "act", risk: "none" })] });
  const held = hand.hold("x.test.act");
  s.driver.script(byOwnerText({ "做一件慢事": async (turn) => { await turn.call(hand.member, "x.test.act", {}); } }));
  const owner = await s.human();
  accepted(await owner.say("做一件慢事"));
  await held.started;
  const state = async () => dataOf(await (await s.human({ name: "after" })).call("service:history", "current")).presence.state;
  assert.notEqual(await state(), "idle", "while the turn runs the chat shows it");

  await s.restart(undefined, { crash: true });

  await eventually(async () => !["working", "thinking"].includes(await state()), "the chat no longer showing the cut turn as running");
});

test("S172: the hub has just restarted and the main agent's runtime is still coming up: the owner's first words are not refused, and the agent answers once it is up", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => { for (const m of turn.messages) if (m.from === OWNER) turn.say(`听到了：${m.text}`); });
  const up = deferred();
  s.driver.holdStarts(up.promise);
  let sent: Awaited<ReturnType<Awaited<ReturnType<typeof s.human>>["say"]>> | undefined;
  let owner: Awaited<ReturnType<typeof s.human>> | undefined;
  await s.restart(async () => {
    owner = await s.human({ name: "reopened" });
    sent = await owner.say("重启后的第一句");
    await quiet();
    assert.equal(s.driver.messages().filter(ownerMessage("重启后的第一句")).length, 0, "nothing is handed to a runtime that is not up");
    up.resolve();
  });
  s.driver.holdStarts(null);
  assert.ok(sent && sent.ok, `the hub took the words: ${JSON.stringify(sent)}`);
  await s.driver.delivery(ownerMessage("重启后的第一句"), "the words reaching the agent once it is up");
  await eventually(() => owner!.messages.find((m) => m.from === MAIN && m.to === OWNER && textOf(m) === "听到了：重启后的第一句"), "the answer");
});

test("the host hears lifecycle.ready while the main agent's runtime is still coming up: the kernel's start does not wait for the agents", async (t) => {
  const s = await startScenario(t);
  const ready = s.host.callsOf("lifecycle.ready").length;
  const up = deferred();
  s.driver.holdStarts(up.promise);
  const starts = s.driver.starts.length;
  await s.restart(); // returns when the hub has started; the runtime has not answered
  assert.equal(s.host.callsOf("lifecycle.ready").length, ready + 1, "ready was reported");
  await eventually(() => s.driver.starts.length > starts, "the main agent's start was begun");
  const owner = await s.human({ name: "early" });
  const list = async () => (dataOf(await owner.call("service:agents", "list")) as { agents: { id: string; state: string; available: boolean; reachable: boolean }[] }).agents.find((a) => a.id === MAIN)!;
  const early = await list();
  assert.deepEqual([early.state, early.available, early.reachable], ["starting", false, true]);
  up.resolve();
  s.driver.holdStarts(null);
  await eventually(async () => (await list()).state === "idle", "the main agent to come up");
});

test("S168: DSH is killed (kill -9) again and again, a few seconds apart; each time the hub starts it anew and the owner's next words are answered", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => { for (const m of turn.messages) if (m.from === OWNER) turn.say(`听到了：${m.text}`); });
  const owner = await s.human();
  for (let round = 1; round <= 5; round++) {
    const text = `第${round}句`;
    // every other round the runtime is slow to come up, and the words arrive while it does
    const up = deferred();
    if (round % 2 === 0) s.driver.holdStarts(up.promise);
    const starts = s.driver.starts.length;
    s.driver.die(MAIN);
    await eventually(() => s.driver.starts.length > starts, `the runtime started anew (round ${round})`);
    accepted(await owner.say(text));
    up.resolve();
    s.driver.holdStarts(null);
    await eventually(() => owner.messages.find((m) => m.from === MAIN && m.to === OWNER && textOf(m) === `听到了：${text}`), `the answer to ${text}`);
  }
  const list = await owner.call("service:agents", "list");
  const main = (dataOf(list) as { agents: { id: string; state: string; available: boolean }[] }).agents.find((a) => a.id === MAIN);
  assert.equal(main?.available, true, "never given up on");
});

test("S164, S165: pausing stops the running turns of every agent; resuming is the owner's, from this machine", async (t) => {
  const s = await startScenario(t);
  const hold = deferred();
  s.driver.script(async (turn) => { await turn.until(hold.promise); });
  const owner = await s.human();
  accepted(await owner.say("忙着"));
  const turn = await s.driver.turn((r) => r.agent === MAIN, "a running turn");

  const paused = await owner.call("service:admin", "pause");
  assert.ok(paused.ok);

  await turn.done;
  assert.equal(turn.outcome, "interrupted");
  const resumed = await owner.call("service:admin", "resume", { confirmed: true });
  assert.ok(resumed.ok && (dataOf(resumed) as { paused: boolean }).paused === false);
  hold.resolve();
});

test("S028 (first_meeting): the first time the owner connects, the primary agent is woken once; a later connection does not wake it again", async (t) => {
  const s = await startScenario(t, { firstMeeting: true });
  const first = await s.human();
  const saved = await first.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-test", kind: "key" });
  assert.ok(saved.ok);

  const { message } = await s.driver.delivery((m) => m.word === "wake" && m.text.startsWith("Wake · first_meeting"), "the first-meeting wake");
  assert.equal(message.lane, "back");

  await s.human({ name: "another channel of the owner" });
  await quiet();
  const wakes = s.driver.messages().filter((m) => m.word === "wake" && m.text.startsWith("Wake · first_meeting"));
  assert.equal(wakes.length, 1);
});

test("S028 (first_meeting, no key): a new install has no model key, so a connection wakes nobody; the key the owner saves brings the first meeting, a wrong one fails it and a corrected one tries again, only until the agent has spoken", async (t) => {
  const s = await startScenario(t, { firstMeeting: true });
  const isMeeting = (m: { word: string; text: string }) => m.word === "wake" && m.text.startsWith("Wake · first_meeting");
  const meetings = () => s.driver.messages().filter(isMeeting);
  let keyed = false;
  s.driver.script(async (turn) => {
    if (!turn.messages.some(isMeeting)) return;
    if (!keyed) throw new Error("bad model key");
    await turn.tool("human_say", { text: "你好，我是 Ash。" });
  });
  const owner = await s.human();
  await s.human({ name: "a second channel" });
  await quiet();
  assert.equal(meetings().length, 0, "no model key: connecting does not start a turn that can only fail");

  const wrong = await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-wrong", kind: "key" });
  assert.ok(wrong.ok);
  const failed = await s.driver.turn((r) => r.messages.some(isMeeting), "the first turn, with a wrong key");
  await failed.done;
  assert.equal(failed.outcome, "error");
  await quiet();
  assert.equal(meetings().length, 1, "a failed turn is not retried on a timer");

  keyed = true;
  const saved = await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-test", kind: "key" });
  assert.ok(saved.ok);
  await eventually(() => meetings().length === 2, "the first meeting again once the key is saved");
  await eventually(() => s.driver.messages().length > 0 && owner.messages.some((m) => m.to === OWNER && m.word === "say" && textOf(m) === "你好，我是 Ash。"), "the agent greets the owner");

  await s.human({ name: "another channel of the owner" });
  const saved2 = await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-test-2", kind: "key" });
  assert.ok(saved2.ok);
  await quiet();
  assert.equal(meetings().length, 2, "the agent has spoken: no third meeting");
});

test("SPEC-08 §5.7: primary.set hands the primary role to another agent", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  const owner = await s.human();
  const made = await owner.call("service:agents", "declare", helper());
  assert.ok(made.ok);

  const set = await owner.call("service:agents", "primary.set", { agent: HELPER });

  assert.ok(set.ok);
  const list = await owner.call("service:agents", "list");
  const agents = (dataOf(list) ?? { agents: [] }) as { agents: { id: string; primary?: boolean }[] };
  assert.equal(agents.agents.find((a) => a.id === HELPER)?.primary, true);
  assert.notEqual(agents.agents.find((a) => a.id === MAIN)?.primary, true);
});

test("S046: the owner talks to a sub-agent directly; in that turn it may answer the owner, and only there", async (t) => {
  const s = await startScenario(t, { runtimes: ["scripted"] });
  s.driver.scriptFor(HELPER, (turn) => turn.say("我是帮手，听到了"));
  const owner = await s.human();
  assert.ok((await owner.call("service:agents", "declare", helper())).ok);
  assert.ok((await owner.call("service:agents", "start", { agent: HELPER })).ok);

  accepted(await owner.say("帮手你好", { to: HELPER }));

  const answer = await owner.seen(toOwner("say", HELPER), "the helper answering the owner");
  assert.equal(textOf(answer), "我是帮手，听到了");
});

test("HUB-MODULES §2.5: the owner's channels reach the agent's environment (「主人在哪」), without the owner's attention", async (t) => {
  const s = await startScenario(t);
  s.driver.script((turn) => { turn.say("在"); });
  const owner = await s.human();
  owner.presence({ visible: true });

  accepted(await owner.say("你好"));

  await eventually(() => s.driver.injections.flatMap((i) => i.modules).find((m) => m.id === "environment" && /主人在哪：手机 App（本机）/.test(m.content)), "the line in the environment the agent was given");
  const before = s.driver.injections.length;
  owner.presence({ visible: false });
  accepted(await owner.say("还在吗"));
  await eventually(() => s.driver.deliveries.some((d) => d.messages.some((m) => m.text.includes("还在吗"))), "the second message delivered");
  assert.equal(s.driver.injections.length, before, "looking away is not a change of the environment");
});
