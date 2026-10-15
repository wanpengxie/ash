import assert from "node:assert/strict";
import test from "node:test";
import { LinkMember } from "../../../src/edges/link-server/control/words";
import type { LinkConnection } from "../../../src/edges/link-server";
import type { HandleContext, Message } from "../../../../sdk/src/message";

const conn = (hand: string, id: string, rtt: number | null, channels: any[] = ["device"]): LinkConnection => ({
  conn: id, hand, name: hand, kind: "computer", channels, grants: {}, via: "gateway", since: 1,
  latency: rtt === null ? null : { rtt_ms: rtt, age_ms: 11 },
});

test("link list and diagnose preserve hand/session/channel identity and return unknown for an unmeasured connection", async () => {
  let connections = [conn("a", "a-device", null), conn("a", "a-human", 7, ["human"]), conn("b", "b-device", 90)];
  const member = new LinkMember({ router: {} as any, hands: { get: (id: string) => ({ id }) } as any,
    link: { connections: () => connections } as any,
    gateway: { snapshot: () => ({ configured: true, connected: true, devices: [] }) } as any });
  const read = async (word: string, body: object = {}) => (await member.handle({ word, body } as Message, {} as HandleContext) as any).data;
  const all = await read("list");
  assert.deepEqual(all.connections.map((c: any) => [c.hand, c.conn, c.latency]), [
    ["a", "a-device", null], ["a", "a-human", { rtt_ms: 7, age_ms: 11 }], ["b", "b-device", { rtt_ms: 90, age_ms: 11 }],
  ]);
  const onlyA = await read("diagnose", { hand: "a" });
  assert.equal(onlyA.connections.length, 2); assert.ok(onlyA.connections.every((c: any) => c.hand === "a"));
  assert.equal(onlyA.connections.find((c: any) => c.conn === "a-device").latency, null, "do not substitute the human or another computer's sample");
  connections = connections.filter((c) => c.hand !== "a");
  const disconnected = await read("diagnose", { hand: "a" }); assert.deepEqual(disconnected.connections, []);
  assert.ok(disconnected.findings.some((f: any) => f.code === "hand.offline"));
});
