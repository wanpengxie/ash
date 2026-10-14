/**
 * REGRESSION-0.3 §4: hands. A phone and a computer are the same kind of thing to the hub: a connection on the device
 * channel with a manifest. Agents and the owner call their capabilities; the hub never invents an answer for them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN, OWNER, accepted, byOwnerText, errorCode, extensionCapability, isApprovalAsk, quiet, resultOf, standardCapability, startScenario,
  textResult, type ToolResult, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

test("agent 7, 设备 19: a hand's manifest becomes its capabilities; one bad capability is refused alone", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [standardCapability("location.get"), extensionCapability("Bad Name")] });
  const owner = await s.human();

  assert.deepEqual(hand.ack.rejected.map((r) => r.name), ["Bad Name"]);
  const listed = await owner.call("service:directory", "list", { member: hand.member });
  assert.ok(listed.ok);
  const words = JSON.stringify(dataOf(listed));
  assert.ok(words.includes("location.get"));
  assert.ok(!words.includes("Bad Name"));
});

test("S085, 设备 20: an agent calls a capability of a hand; the hand sees who called, the agent gets the answer", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  phone.on("location.get", () => textResult("lat 31.2 lon 121.5", { lat: 31.2, lon: 121.5 }));
  s.driver.script(byOwnerText({ "我在哪": async (turn) => { await turn.call(phone.member, "location.get", {}); } }));
  const owner = await s.human();

  accepted(await owner.say("我在哪"));

  const call = await phone.call("location.get");
  assert.equal(call.caller.member, MAIN);
  assert.deepEqual(call.args, {});
  const done = await s.driver.toolCall("capability_call");
  assert.equal(done.result.isError, false);
  assert.equal(done.result.data?.lat, 31.2, "the hand's data comes back as the structured result");
});

test("设备 8, SPEC-03 §11.3b: revoking a hand closes it with 4003 and it cannot come back, not even from this machine", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const owner = await s.human();

  const revoked = await owner.call("service:devices", "revoke", { device: phone.member });
  assert.ok(revoked.ok);

  await eventually(() => phone.client.stoppedBy === 4003, "the hand being closed with 4003");
  const again = await s.raw({ kind: "phone", channels: { device: {} }, identity: phone.identity });
  await eventually(() => again.closes.length > 0, "the second attempt being refused");
  assert.equal(again.closes[0]!.code, 4003);
  assert.equal(again.client.stoppedBy, 4003);
});

test("S141-S146: a hand that is gone cannot be called (offline), and nothing is made up for it", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const owner = await s.human();
  s.driver.script(byOwnerText({ "看看位置": async (turn) => { await turn.call(phone.member, "location.get", {}); } }));

  phone.disconnect();
  const refused = await eventually(async () => {
    const reply = await owner.call(phone.member, "location.get");
    return reply.ok ? null : reply;
  }, "the hub noticing the hand left");
  assert.equal(refused.error.code, "offline");

  accepted(await owner.say("看看位置"));
  const done = await s.driver.toolCall("capability_call");
  assert.equal(errorCode(done.result), "offline");
});

test("S141-S146, SPEC-03 §8: the hand drops while an action is running: the asker is told result_unknown", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [extensionCapability("x.test.act", { effect: "act", risk: "none" })] });
  const held = hand.hold("x.test.act");
  s.driver.script(byOwnerText({ "做一件事": async (turn) => { await turn.call(hand.member, "x.test.act", {}); } }));
  const owner = await s.human();

  accepted(await owner.say("做一件事"));
  await held.started;
  hand.disconnect();

  const done = await s.driver.toolCall("capability_call");
  assert.equal(errorCode(done.result), "result_unknown");
});

test("S056, 设备: a slow call gives a receipt; cancelling it reaches the hand as a cancel", async (t) => {
  const s = await startScenario(t);
  const hand = await s.hand({ capabilities: [extensionCapability("x.test.act", { effect: "act", risk: "none" })] });
  const held = hand.hold("x.test.act");
  const state: { receipt?: ToolResult; cancelled?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "开始然后取消": async (turn) => {
      state.receipt = await turn.call(hand.member, "x.test.act", {}, { wait: false });
      await held.started;
      state.cancelled = await turn.tool("cancel", { request_id: resultOf(state.receipt)?.request_id });
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("开始然后取消"));

  const call = await held.started;
  await eventually(() => state.cancelled, "the cancel result");
  assert.equal(resultOf(state.receipt!).status, "accepted");
  await eventually(() => hand.cancelled.includes(call.id), "the hand being told to stop");
});

test("agent 7: a second computer program and a phone are the same to the hub (same member kind, same words)", async (t) => {
  const s = await startScenario(t);
  const phone = await s.hand({ kind: "phone", capabilities: [standardCapability("location.get")] });
  const computer = await s.hand({ kind: "computer", capabilities: [standardCapability("location.get")] });
  const owner = await s.human();

  const a = await owner.call(phone.member, "location.get");
  const b = await owner.call(computer.member, "location.get");

  assert.ok(a.ok && b.ok, "both answer the same word");
  assert.notEqual(phone.member, computer.member);
});

test("设备 8: the owner renames a hand and changes what it may do; the list shows it", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  const owner = await s.human();

  const renamed = await owner.call("service:devices", "rename", { device: phone.member, name: "客厅的手机" });
  const access = await owner.call("service:devices", "access_set", { device: phone.member, tier: "full", local_agents: true });

  assert.ok(renamed.ok && access.ok);
  const listed = await owner.call("service:devices", "list");
  assert.ok(listed.ok);
  const mine = (dataOf(listed) as { devices: { device: string; name: string; tier: string; local_agents: boolean }[] }).devices.find((d) => d.device === phone.member);
  assert.equal(mine?.name, "客厅的手机");
  assert.equal(mine?.tier, "full");
  assert.equal(mine?.local_agents, true);
});

test("设备 15: the owner updates a computer program: the hub calls x.ash.update on it, nobody else can", async (t) => {
  const s = await startScenario(t);
  const update = extensionCapability("x.ash.update", { effect: "execute", risk: "structure", callers: ["kernel"] });
  const computer = await s.hand({ kind: "computer", capabilities: [update] });
  const owner = await s.human();
  const sha256 = "ab".repeat(32);

  const direct = await owner.call(computer.member, "x.ash.update", { version: "0.2.0", sha256 });
  assert.ok(!direct.ok && direct.error.code === "forbidden", "the owner cannot call the kernel-only capability");
  const started = await owner.call("service:devices", "update", { device: computer.member, version: "0.2.0", sha256 });

  assert.ok(started.ok);
  const call = await computer.call("x.ash.update");
  assert.equal((call.args as { version: string }).version, "0.2.0");
  assert.equal(owner.messages.filter(isApprovalAsk).length, 0, "the owner approved by asking: no second card");
});

test("设备 27: decision.* are for the hub's reflex only: neither the owner nor an agent can call them", async (t) => {
  const s = await startScenario(t);
  const phone = await s.hand({ capabilities: [standardCapability("decision.surface")] });
  const state: { agent?: ToolResult } = {};
  s.driver.script(byOwnerText({ "看界面": async (turn) => { state.agent = await turn.call(phone.member, "decision.surface", {}); } }));
  const owner = await s.human();

  const mine = await owner.call(phone.member, "decision.surface");
  accepted(await owner.say("看界面"));

  assert.ok(!mine.ok && mine.error.code === "forbidden");
  await eventually(() => state.agent, "the agent's attempt");
  assert.equal(errorCode(state.agent!), "forbidden");
  // Neither the owner's call nor the agent's reached the hand.
  await quiet();
  assert.equal(phone.calls.length, 0);
});
