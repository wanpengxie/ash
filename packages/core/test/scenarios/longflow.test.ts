/**
 * HUB-MODULES §4 / SPEC-02 §4.1.1: a flow that takes minutes and waits for a person (pairing a computer)
 * tells whoever started it, with a background message at each step, and does not put those into the owner's conversation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accepted, byOwnerText, dataOf, errorCode, resultOf, startScenario, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

/** An agent starts a pairing on a relay the owner set up; the owner then reads the code, from this machine. */
async function pairing(t: Parameters<typeof startScenario>[0]) {
  const s = await startScenario(t);
  const relay = await s.relay();
  const state: { started?: ToolResult; peek?: ToolResult } = {};
  s.driver.script(byOwnerText({
    "配对一台电脑": async (turn) => {
      state.started = await turn.call("service:devices", "pair_start", { kind: "computer", name: "我的 Mac" });
      state.peek = await turn.call("service:devices", "pair_code", { pair_id: resultOf(state.started)?.pair_id ?? "x" });
    },
  }));
  const owner = await s.human();
  const used = await owner.call("service:link", "gateway.use", { url: relay.url });
  assert.ok(used.ok, "the owner points the hub at their relay");
  // gateway.use answers once the address is saved; the hub's tunnel to the relay comes up a moment later. Pairing needs it.
  await eventually(async () => (dataOf(await owner.call("service:link", "gateway.status", {})) as { connected?: boolean } | undefined)?.connected === true,
    "the hub connected to the relay", 60_000, 200);

  accepted(await owner.say("配对一台电脑"));

  await eventually(() => state.peek, "the agent's attempts");
  const started = resultOf(state.started!);
  const code = await owner.call("service:devices", "pair_code", { pair_id: started.pair_id });
  assert.ok(code.ok, "the owner, on this machine, can see it");
  const secret = (dataOf(code) as { code: string }).code;
  assert.ok(secret.length > 0);
  return { owner, state, started, secret };
}

test("SPEC-03 §9.5.4, SPEC-00 §6.9: an agent starts a pairing and never sees the code; the ledger never holds it", async (t) => {
  const { owner, state, started, secret } = await pairing(t);

  assert.ok(started.pair_id && started.expires_at, "the agent gets pair_id and expires_at");
  assert.ok(!("code" in started), "and not the code");
  assert.ok(state.peek!.isError);
  assert.equal(errorCode(state.peek!), "forbidden", "asking for the code is refused");
  assert.ok(!JSON.stringify(state.started).includes(secret) && !state.peek!.text.includes(secret));
  const ledger = await owner.ledger();
  assert.ok(!ledger.some((m) => m.from === "service:devices" && m.word === "pair_code"), "the owner's reading of the code is only a read: it leaves no row at all");
  assert.ok(!JSON.stringify(ledger).includes(secret), "and the code is nowhere in the ledger");
});

// The ledger's copy of `pair_code` masks `code` but keeps `url`, and the real relay's `url` is `<origin>/p/<code>`.
test("SPEC-03 §9.5.4, SPEC-00 §6.9: the ledger has no code anywhere", async (t) => {
  const { owner, secret } = await pairing(t);

  const notOwnQuery = (m: { to: string | null; word: string }): boolean => !(m.to === "service:history" && m.word === "query");
  const ledger = JSON.stringify((await owner.ledger()).filter(notOwnQuery));
  assert.ok(!ledger.includes(secret), "the ledger only has the masked version");
});
