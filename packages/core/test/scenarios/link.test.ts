/**
 * SPEC-03 §11 (acceptance of `ash-link/2` on the local connection). Not in REGRESSION-0.3 by number: they are the rules
 * that make "手机启动和保活" (S168-S174) and "设备上线" (agent 7) hold from the outside.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { newIdentity, startScenario } from "./harness";
import { eventually } from "../fixtures/wait";

test("SPEC-03 §11.2: a wrong local token is refused with 4001", async (t) => {
  const s = await startScenario(t);

  const hand = await s.raw({ channels: { device: {} }, token: "not-the-token" });

  await eventually(() => hand.closes.length > 0, "the connection being closed");
  assert.equal(hand.closes[0]!.code, 4001);
  hand.client.stop();
});

test("SPEC-03 §11.2: no token at all is refused with 4001", async (t) => {
  const s = await startScenario(t);

  const hand = await s.raw({ channels: { device: {} }, token: null });

  await eventually(() => hand.closes.length > 0, "the connection being closed");
  assert.equal(hand.closes[0]!.code, 4001);
  hand.client.stop();
});

test("SPEC-03 §11.2: a signature made with another key is refused with 4001", async (t) => {
  const s = await startScenario(t);

  const hand = await s.raw({ channels: { device: {} }, signWith: await newIdentity() });

  await eventually(() => hand.closes.length > 0, "the connection being closed");
  assert.equal(hand.closes[0]!.code, 4001);
  hand.client.stop();
});

test("SPEC-03 §11.2, 3a: a second device connection of the same hand replaces the first (4009); two chat tabs live side by side", async (t) => {
  const s = await startScenario(t);
  const identity = await newIdentity();
  const first = await s.raw({ channels: { device: {} }, identity });
  await first.client.ready();
  const second = await s.raw({ channels: { device: {} }, identity });
  await second.client.ready();

  await eventually(() => first.client.stoppedBy === 4009, "the first connection being replaced");

  const tab1 = await s.human({ identity });
  const tab2 = await s.human({ identity });
  assert.notEqual(tab1.clientId, tab2.clientId, "each tab is its own client:<sid>");
  assert.equal(tab1.client.state, "ready");
  assert.equal(tab2.client.state, "ready");
});

test("SPEC-03 §2.3: on this machine the human channel is granted as local, and the device channel is accepted", async (t) => {
  const s = await startScenario(t);
  const hand = await s.raw({ channels: { device: {}, human: { label: "手机 · 对话", surfaces: ["chat"] } } });

  const welcome = await hand.client.ready();

  assert.deepEqual(welcome.channels.device, { accepted: true });
  assert.ok(welcome.channels.human && "client" in welcome.channels.human && welcome.channels.human.local === true);
  hand.client.stop();
});
