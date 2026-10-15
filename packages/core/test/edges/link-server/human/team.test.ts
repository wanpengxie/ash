import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryService } from "../../../../src/services/history";
import { call, owner } from "../../../services/support";
import { eventually } from "../../../fixtures/wait";
import { Channel, startHumanHub } from "./helpers";

/** The team's actual human-channel shape: an async ask gets a durable receipt before the long-running answer. */
test("team async asks leave the channel free and a same-client-id confirmation never starts a second question", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  let resolve!: (answer: unknown) => void;
  const answer = new Promise((done) => { resolve = done; });
  let deliveries = 0;
  hub.mini.stub("service:agents", ["ask"], () => { deliveries++; return answer; });
  const phone = await Channel.open(hub); phone.follow();
  const question = { to: "service:agents", kind: "request" as const, word: "ask", body: { agent: "agent:h", text: "请在团队回答" }, wait: false, client_id: "team-durable-one" };
  const first = await phone.send(question);
  assert.ok(first.ok); assert.ok(first.message?.id); assert.equal(first.response, undefined);
  await eventually(() => deliveries === 1, "the first question delivered");
  const retry = await phone.send(question);
  assert.ok(retry.ok); assert.equal(retry.message?.id, first.message?.id); assert.equal(retry.duplicate, true);
  assert.equal(deliveries, 1);
  // A normal owner operation still completes while the helper has not answered.
  const unrelated = await phone.send({ to: "service:vault", kind: "request", word: "set", body: { ref: "test-ref", value: "test-value" }, wait: true });
  assert.ok(unrelated.ok && unrelated.response?.ok);
  const history = createHistoryService({ ledger: hub.ledger });
  assert.equal((await call(history, owner, "exchanges")).items[0].state, "waiting");
  resolve({ agent: "agent:h", answer: "团队里的回答" });
  await phone.seen((m) => m.reply_to === first.message?.id && m.kind === "response", "the later answer on sync");
  const item = (await call(history, owner, "exchanges")).items[0];
  assert.equal(item.id, first.message?.id); assert.equal(item.state, "answered"); assert.equal(item.answer.text, "团队里的回答");
  assert.equal(hub.ledger.page({ limit: 100 }).filter((m) => m.word === "ask" && m.kind === "request").length, 1);
});
