/**
 * REGRESSION-0.3 / SPEC-00 §6.12, §6.9: what the ledger keeps (the owner's words, anything an agent asked for, anything with
 * an effect, and the events marked `record: true`) and what it does not (polling by services, sense events), and that it
 * never holds a secret. Everything is looked up through `service:history`, the way an agent would.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../sdk/src/message";
import { MAIN, OWNER, accepted, byOwnerText, findBlob, startScenario, textOf, dataOf } from "./harness";
import { eventually } from "../fixtures/wait";

const timerBody = (): Record<string, unknown> => ({ at: Date.now() + 3_600_000, to: MAIN, word: "wake", body: { reason: "later" }, label: "稍后" });

test("SPEC-00 §6.12: the owner's words, agent requests (reads too) and effects are recorded; service polling and sense events are not", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  s.driver.script(byOwnerText({
    "做几件事": async (turn) => {
      await turn.call(phone.member, "location.get", {});
      await turn.tool("timer_set", timerBody());
      turn.say("做完了");
    },
  }));
  const owner = await s.human();

  accepted(await owner.say("做几件事"));
  await owner.seen((m) => m.from === MAIN && textOf(m) === "做完了", "the answer");
  await phone.emit("sense.battery", { level: 50 });
  const turn = await s.driver.turn((r) => r.agent === MAIN, "the turn");
  await turn.done;

  const ledger: Message[] = await eventually(async () => {
    const all = await owner.ledger();
    return all.some((m) => m.word === "turn.ended") ? all : null;
  }, "the end of the turn in the ledger");
  const has = (match: (m: Message) => boolean) => ledger.some(match);
  assert.ok(has((m) => m.from === OWNER && m.word === "say" && textOf(m) === "做几件事"), "the owner's words");
  assert.ok(has((m) => m.from === MAIN && m.to === phone.member && m.word === "location.get"), "an agent's read request");
  assert.ok(has((m) => m.from === MAIN && m.to === "service:clock" && m.word === "set"), "an agent's write request");
  assert.ok(has((m) => m.word === "turn.started") && has((m) => m.word === "turn.ended"), "the events marked record: true");
  assert.ok(has((m) => m.word === "agent.tool"), "the tool summaries");
  assert.ok(!has((m) => m.word.startsWith("sense.")), "no sense event");
  assert.ok(!has((m) => m.to === "service:cost" && m.word === "quota.check"), "the quota check before a turn is a service's read: not recorded");
  assert.ok(!has((m) => m.to === "service:persona" && m.word === "get"), "loading the persona is a service's read: not recorded");
});

test("the owner's page reading the history leaves no trace: nothing in the ledger, nothing echoed to a following sync, and a page at rest does not grow it", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const aboutHistory = (m: Message): boolean => m.to === "service:history" || m.from === "service:history";

  // what the page does on every open and refresh (all of them service:history reads, over the human channel)
  for (let i = 0; i < 5; i++) {
    assert.ok((await owner.call("service:history", "current", { limit: 20 })).ok, "current");
    assert.ok((await owner.call("service:history", "window", { limit: 20 })).ok, "window");
    assert.ok((await owner.call("service:history", "activity.page", { limit: 20 })).ok, "activity.page");
  }
  // then it sits there for ten seconds with its sync following the ledger
  await new Promise((resolve) => setTimeout(resolve, 10_000));

  assert.deepEqual((await owner.ledger()).filter(aboutHistory), [], "the ledger holds no row of these reads, request or response");
  assert.deepEqual(owner.messages.filter(aboutHistory), [], "and the following sync was never handed one");
});

test("SPEC-00 §6.9, S159: a secret put in the vault is in no ledger record; only that it is set remains", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const secret = "sk-scenario-0123456789abcdef";

  const set = await owner.call("service:vault", "set", { ref: "deepseek", value: secret, label: "DeepSeek", kind: "key" });
  assert.ok(set.ok, "the owner sets a key from this machine");

  // An agent's reading of the ledger is itself recorded (a `query` to service:history, whose filter may hold what was searched for): those are left out.
  const notOwnQuery = (m: Message): boolean => !(m.to === "service:history" && m.word === "query");
  const ledger = (await owner.ledger()).filter(notOwnQuery);
  assert.ok(!JSON.stringify(ledger).includes(secret), "the secret is not in the ledger");
  const record = ledger.find((m) => m.word === "set" && m.to === "service:vault");
  assert.ok(record, "the request itself is recorded");
  assert.deepEqual(bodyValue(record), { set: true, length: secret.length });
  const found = (await owner.ledger({ text: secret })).filter(notOwnQuery);
  assert.equal(found.length, 0, "searching for it finds nothing");
  const listed = await owner.call("service:vault", "list");
  assert.ok(listed.ok && JSON.stringify(dataOf(listed)).includes("deepseek") && !JSON.stringify(dataOf(listed)).includes(secret));
});

function bodyValue(m: Message): unknown {
  return (m.body as { value?: unknown }).value;
}

test("S011-S014: a very long message is kept as a summary and an attachment; the whole text can be read back", async (t) => {
  const s = await startScenario(t);
  const owner = await s.human();
  const text = "这是很长的一段话。".repeat(30_000);

  accepted(await owner.say(text));

  const row = await eventually(async () => (await owner.ledger()).find((m) => m.from === OWNER && m.word === "say"), "the message in the ledger");
  assert.ok(JSON.stringify(row).length < 20_000, "the row stays small");
  const blob = findBlob(row.body);
  assert.ok(blob, "the long text is an attachment");
  assert.ok((blob.size ?? 0) >= text.length, "it knows how big the original is");
  let got = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const part = await owner.call("service:blobs", "read", { hash: blob.$blob, offset, limit: 200_000 });
    assert.ok(part.ok);
    const result = dataOf(part) as { text: string; next_offset: number | null };
    got += result.text;
    offset = result.next_offset;
  }
  assert.equal(got, text);
});

test("S020-S023: what a turn did can be looked up afterwards: its messages and its tool calls", async (t) => {
  const s = await startScenario(t);
  const phone = await s.phone();
  s.driver.script(byOwnerText({ "查一下位置": async (turn) => { await turn.call(phone.member, "location.get", {}); turn.say("查好了"); } }));
  const owner = await s.human();

  accepted(await owner.say("查一下位置"));
  const turn = await s.driver.turn((r) => r.agent === MAIN, "the turn");
  await turn.done;

  const detail = await eventually(async () => {
    const reply = await owner.call("service:history", "turn", { turn: turn.turn });
    return reply.ok && JSON.stringify(dataOf(reply)).includes("location.get") ? reply : null;
  }, "the turn's record");
  assert.ok(detail.ok);
  const text = JSON.stringify(dataOf(detail));
  assert.ok(text.includes("查一下位置") && text.includes("查好了"), "what it was given and what it said");
});
