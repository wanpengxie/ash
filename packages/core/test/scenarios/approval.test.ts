/**
 * REGRESSION-0.3 §2: approvals. A request that needs the owner is answered `waiting_owner` at once; the owner answers the
 * card; the one who asked is told by the owner's own message in the conversation (a front turn) and carries the request out with `pending.redeem`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN, accepted, byOwnerText, errorCode, extensionCapability, ownerApproval, isApprovalAsk, quiet, resultOf,
  startScenario, type Hand, type Scenario, type TurnScript, type ToolResult, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

interface Flow { pendingId: string; first?: ToolResult; redeemed?: ToolResult; again?: ToolResult }

/**
 * The agent's side of an approval: ask for something that needs the owner; when the owner's answer comes in the conversation,
 * redeem the pending request (and try once more, which must not work: a redeem is good once).
 */
function approvalScript(phone: Hand, flow: Flow, app = "com.example.notes"): TurnScript {
  return async (turn) => {
    if (turn.messages.some(ownerApproval)) {
      flow.redeemed = await turn.tool("human_pending_redeem", { id: flow.pendingId });
      flow.again = await turn.tool("human_pending_redeem", { id: flow.pendingId });
      return;
    }
    flow.first = await turn.call(phone.member, "clipboard.set", { text: app }, { purpose: "把笔记名放进剪贴板" });
    flow.pendingId = resultOf(flow.first)?.pending_id ?? "";
  };
}

async function setup(t: Parameters<typeof startScenario>[0], options: Parameters<typeof startScenario>[1] = {}): Promise<{ s: Scenario; phone: Hand; flow: Flow }> {
  const s = await startScenario(t, options);
  const phone = await s.phone();
  const flow: Flow = { pendingId: "" };
  s.driver.script(approvalScript(phone, flow));
  return { s, phone, flow };
}

test("S032, S039, S033: an outward action waits for the owner; once approved the asker redeems it and it runs once", async (t) => {
  const { s, phone, flow } = await setup(t);
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  assert.deepEqual([...owner.optionIds(card)].sort(), ["always", "deny", "once"], "the card's options are exactly once / always / deny");

  await eventually(() => flow.first, "the asker's receipt");
  assert.equal(resultOf(flow.first!).status, "waiting_owner");
  assert.ok(flow.pendingId, "the receipt names the pending request");
  assert.equal(phone.calls.length, 0, "nothing runs before the owner answers");

  accepted(await owner.answer(card, "once"));

  const { delivery, message } = await s.driver.delivery(ownerApproval, "the owner's message about the answer");
  assert.equal(message.word, "say", "the answer reaches the asker as the owner's say");
  assert.equal(delivery.agent, MAIN, "and only the agent that asked");
  assert.equal(message.lane, "front", "on the front lane, in the owner's conversation");
  assert.ok(message.text.includes(flow.pendingId), "naming the pending request");
  assert.ok(message.text.includes("option once") && message.text.includes("批准："), "with the choice, in words");
  assert.equal(s.driver.deliveries.some((d) => d.messages.some((m) => m.word === "tell" && m.from === "service:gate")), false, "no background tell from the gate");
  await eventually(() => flow.again, "the redeem results");
  assert.equal(flow.redeemed!.isError, false);
  assert.equal(phone.calls.length, 1, "the hand ran it once");
  assert.equal(phone.calls[0]!.capability, "clipboard.set");
  assert.equal(phone.calls[0]!.caller.member, MAIN);
  assert.equal(flow.again!.isError, true, "a second redeem does not run it again");
  const audit = await owner.call("service:gate", "audit", { word: "clipboard.set" });
  assert.ok(audit.ok && JSON.stringify(dataOf(audit)).includes("clipboard.set"), "S034-S038: the decision left evidence in the audit");
});

test("S032: the owner says no: the asker is told, redeeming does nothing", async (t) => {
  const { s, phone, flow } = await setup(t);
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  accepted(await owner.answer(card, "deny"));

  const refusal = await s.driver.delivery(ownerApproval, "the owner's message about the refusal");
  assert.equal(refusal.delivery.agent, MAIN);
  assert.ok(refusal.message.text.includes(flow.pendingId) && refusal.message.text.includes("拒绝："));
  await eventually(() => flow.again, "the redeem results");
  assert.equal(flow.redeemed!.isError, true);
  assert.equal(phone.calls.length, 0);
});

test("S032: 'always' makes a rule: the same request does not ask again", async (t) => {
  const { s, phone, flow } = await setup(t);
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  accepted(await owner.answer(card, "always"));
  await eventually(() => flow.again, "the first request carried out");
  assert.equal(phone.calls.length, 1);

  flow.first = undefined;
  accepted(await owner.say("再打开一次笔记"));
  await eventually(() => flow.first, "the second receipt");
  assert.notEqual(resultOf(flow.first!)?.status, "waiting_owner");
  assert.equal(phone.calls.length, 2, "it ran without a card");
  const rules = await owner.call("service:gate", "rules.list");
  assert.ok(rules.ok && JSON.stringify(dataOf(rules)).includes("clipboard.set"), "S034-S038: the rule is listed");
});

test("S039: the approval has expired: answering it late does not let the request run", async (t) => {
  const s = await startScenario(t, { fakeNow: true });
  const phone = await s.phone();
  const flow: Flow = { pendingId: "" };
  s.driver.script(byOwnerText({
    "帮我打开笔记": async (turn) => {
      flow.first = await turn.call(phone.member, "clipboard.set", { text: "com.example.notes" }, { approval_ttl_minutes: 1 });
      flow.pendingId = resultOf(flow.first)?.pending_id ?? "";
    },
    "试试执行": async (turn) => { flow.redeemed = await turn.tool("human_pending_redeem", { id: flow.pendingId }); },
  }));
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  s.advance(2 * 60_000);
  await owner.answer(card, "once");
  accepted(await owner.say("试试执行"));

  await eventually(() => flow.redeemed, "the late redeem");
  assert.equal(flow.redeemed!.isError, true);
  assert.equal(phone.calls.length, 0);
});

test("S040: the hub restarts while the card waits: the question is asked again as a new card, answering it still lets the asker carry it out", async (t) => {
  const { s, phone, flow } = await setup(t);
  const owner = await s.human();
  accepted(await owner.say("帮我打开笔记"));
  const first = await owner.seen(isApprovalAsk, "the approval card");
  await eventually(() => flow.pendingId, "the pending id");

  await s.restart();

  // The card of the first boot is withdrawn and the question is asked again as a new card.
  const again = await owner.seen((m) => isApprovalAsk(m) && m.id !== first.id, "the approval card after the restart");
  assert.equal(phone.calls.length, 0);
  accepted(await owner.answer(again, "once"));
  await s.driver.delivery(ownerApproval, "the owner's message after the restart");
  await eventually(() => flow.redeemed, "the redeem after the restart");
  assert.equal(flow.redeemed!.isError, false);
  assert.equal(phone.calls.length, 1, "run once, not replayed");
});

test("S044, 设备 20: the hand assesses a call; 'none' runs it without a card, anything else asks", async (t) => {
  const s = await startScenario(t);
  const phone = await s.hand({
    capabilities: [extensionCapability("x.test.note", { effect: "write", risk: "outward", per_call_risk: true })],
  });
  phone.assessAs("x.test.note", (args) => (args.where === "inside" ? "none" : "outward"));
  s.driver.script(byOwnerText({
    "写在里面": async (turn) => { await turn.call(phone.member, "x.test.note", { where: "inside" }); },
    "写在外面": async (turn) => { await turn.call(phone.member, "x.test.note", { where: "outside" }); },
  }));
  const owner = await s.human();

  accepted(await owner.say("写在里面"));
  await phone.call("x.test.note");
  assert.deepEqual(phone.assessed.map((a) => a.args), [{ where: "inside" }], "the hand was asked first");
  assert.equal(s.driver.calls.at(-1)?.result.isError ?? false, false);

  accepted(await owner.say("写在外面"));
  await owner.seen(isApprovalAsk, "a card for the outward call");
  assert.equal(phone.calls.length, 1, "the outward call did not run");
});

test("S044: a hand the owner gave the 'full' tier is trusted: its outward actions run without a card", async (t) => {
  const { s, phone, flow } = await setup(t);
  const owner = await s.human();
  const set = await owner.call("service:devices", "access_set", { device: phone.member, tier: "full" });
  assert.ok(set.ok, "the owner sets the tier directly");

  accepted(await owner.say("帮我打开笔记"));

  await eventually(() => flow.first, "the agent's receipt");
  assert.notEqual(resultOf(flow.first!)?.status, "waiting_owner");
  assert.equal(phone.calls.length, 1);
  await quiet();
  assert.equal(owner.messages.filter(isApprovalAsk).length, 0, "no card");
});

test("human_ask: a question to the owner is answered by the owner; the answer comes back to the agent", async (t) => {
  const s = await startScenario(t);
  const state: { answer?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "问问我": async (turn) => {
      const receipt = await turn.tool("human_ask", { title: "晚饭吃什么", options: [{ id: "noodle", label: "面" }, { id: "rice", label: "饭" }] });
      // Answered inside the quick window, the receipt is the answer; otherwise it is collected with await_result.
      state.answer = resultOf(receipt)?.choice !== undefined ? receipt : await turn.tool("await_result", { request_id: resultOf(receipt)?.request_id });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("问问我"));
  const question = await owner.seen((m) => m.word === "ask" && m.from === MAIN && m.to === "person:owner", "the question card");
  accepted(await owner.answer(question, "rice"));

  const done = await eventually(() => state.answer, "the agent receiving the answer");
  assert.equal(done.data?.choice, "rice");
});

test("SPEC-00 §6.4: an agent proposing to change the persona is asked about by the gate like any structural change; refusing changes nothing", async (t) => {
  const s = await startScenario(t);
  const state: { proposed?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "改一下人格": async (turn) => {
      state.proposed = await turn.call("service:persona", "propose", { file: "SOUL.md", content: "# 全新的人格", reason: "测试" });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("改一下人格"));
  const card = await owner.seen(isApprovalAsk, "the card for the persona change");
  assert.deepEqual([...owner.optionIds(card)].sort(), ["always", "deny", "once"], "no word always asks: 「以后都可以」 is offered as for any other");
  await eventually(() => state.proposed, "the receipt");
  assert.equal(resultOf(state.proposed!).status, "waiting_owner");
  accepted(await owner.answer(card, "deny"));

  await quiet();
  const now = await owner.call("service:persona", "get", { file: "SOUL.md" });
  assert.ok(now.ok);
  assert.ok(!JSON.stringify(dataOf(now)).includes("全新的人格"), "the approved persona did not change");
});

test("SPEC-02 §3.2: an agent sees what the owner can call except the owner's own typing of a secret, which is not in its directory", async (t) => {
  const s = await startScenario(t);
  const state: { listed?: ToolResult; direct?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "看看保险箱": async (turn) => {
      state.listed = await turn.tool("capability_list", { member: "service:vault" });
      state.direct = await turn.call("service:vault", "set", { ref: "x", value: "should-not-work" });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("看看保险箱"));

  await eventually(() => state.direct, "the agent's attempts");
  const words = JSON.stringify(state.listed!.data);
  assert.ok(words.includes("list") && words.includes("describe"), "it can see the read words");
  assert.ok(words.includes('"delete"'), "it sees delete, as the owner does");
  assert.ok(!/"set"/.test(words), "it cannot see set (the owner typing the value)");
  assert.ok(state.direct!.isError);
  assert.equal(errorCode(state.direct!), "forbidden", "and calling set is refused");
});

test("fast path: the owner answers in time: the same call returns the result and the agent goes on in the same turn; no message of the owner's, no redeem", async (t) => {
  const s = await startScenario(t, { fastApproval: true });
    const flow: { first?: ToolResult; turns: number } = { turns: 0 };
  s.driver.script(async (turn) => {
    flow.turns++;
    flow.first = await turn.call("service:gate", "mode.set", { mode: "auto" }, { purpose: "改审批档位（只有主人批准才行）" });
  });
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  await quiet(200);
  assert.equal(flow.first, undefined, "the call is held for the owner");

  accepted(await owner.answer(card, "once"));
  await eventually(() => flow.first, "the call's own result");
  assert.equal(flow.first!.isError, false);
  assert.equal(resultOf(flow.first!)?.status, undefined, "not a receipt");
  assert.deepEqual(resultOf(flow.first!)?.mode, "auto", "it ran: the call's own result is its result");
  await quiet(300);
  assert.equal(s.driver.messages().some(ownerApproval), false, "no message about the answer");
  assert.equal(flow.turns, 1, "the agent did not need another turn");
  const audit = await owner.call("service:gate", "audit", { word: "mode.set" });
  assert.ok(audit.ok && JSON.stringify(dataOf(audit)).includes("once"), "the decision left evidence");
});

test("fast path: refused in time, the same call is refused", async (t) => {
  const s = await startScenario(t, { fastApproval: true });
    const flow: { first?: ToolResult } = {};
  s.driver.script(async (turn) => { flow.first = await turn.call("service:gate", "mode.set", { mode: "auto" }, { purpose: "改审批档位（只有主人批准才行）" }); });
  const owner = await s.human();

  accepted(await owner.say("帮我打开笔记"));
  const card = await owner.seen(isApprovalAsk, "the approval card");
  accepted(await owner.answer(card, "deny"));
  await eventually(() => flow.first, "the call's own result");
  assert.equal(flow.first!.isError, true);
  assert.equal(errorCode(flow.first!), "denied");
  await quiet(300);
  assert.equal(s.driver.messages().some(ownerApproval), false);
});
