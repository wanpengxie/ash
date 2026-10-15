import assert from "node:assert/strict";
import test from "node:test";
import { standardAction, standardContract } from "../../../../sdk/src/namespaces";
import { wordContract } from "../../../../sdk/src/words";
import { agent, DEVICE, fake, owner, success, world } from "../router/world";

const command = "install-device --ticket TEST-TICKET --secret TEST-PAIRING-SECRET";

test("real pairing contracts deliver the original command to owner and agent, while the ledger holds no command", async () => {
  const w = world();
  const data = { pair_id: "p1", expires_at: 1_600_000, command };
  const contracts = ["pair_start", "pair_code"].map((name) => wordContract("service:devices", name)!);
  w.registry.add(fake("service:devices", contracts, () => ({ data })));
  for (const caller of [owner, agent()]) {
    for (const word of ["pair_start", "pair_code"]) {
      const reply = await w.router.send({ to: "service:devices", kind: "request", word,
        body: word === "pair_start" ? { kind: "computer" } : { pair_id: "p1" } }, caller);
      assert.equal(success(reply).command, command);
      assert.deepEqual(data, { pair_id: "p1", expires_at: 1_600_000, command }, "the router did not mutate the original result");
    }
  }
  const messages = w.ledger.page({ limit: 100 });
  const responses = messages.filter((m) => m.from === "service:devices" && m.kind === "response");
  assert.equal(responses.length, 3, "the owner read is not recorded; both writes and the agent read are recorded");
  for (const message of responses) assert.deepEqual((message.body as any).result.data.command, { set: true, length: command.length });
  assert.ok(!JSON.stringify(messages).includes("TEST-PAIRING-SECRET"));
});

test("clipboard writing keeps the copied command only in raw delivery, never in the ledger or handler's recorded view", async () => {
  const w = world({ tiers: { [DEVICE]: "full" } });
  const contract = { ...standardContract(standardAction("clipboard.set")!), member: DEVICE };
  const received: string[] = [];
  w.registry.add(fake(DEVICE, [contract], (message, ctx) => {
    assert.deepEqual((message.body as any).text, { set: true, length: command.length });
    received.push((ctx.raw as any).text);
    return { data: { copied: true } };
  }));
  const body = { text: command };
  for (const caller of [owner, agent()]) {
    assert.equal(success(await w.router.send({ to: DEVICE, kind: "request", word: "clipboard.set", body }, caller)).copied, true);
  }
  assert.deepEqual(received, [command, command]);
  assert.deepEqual(body, { text: command }, "the original caller payload was not mutated");
  assert.ok(!JSON.stringify(w.ledger.page({ limit: 100 })).includes("TEST-PAIRING-SECRET"));
});
