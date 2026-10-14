/**
 * HUB-MODULES §4 / SPEC-02 §4.1.1: a flow that takes minutes and waits for a person (pairing a computer)
 * tells whoever started it, with a background message at each step, and does not put those into the owner's conversation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { accepted, byOwnerText, dataOf, resultOf, startScenario, type ToolResult } from "./harness";
import { eventually } from "../fixtures/wait";

/** An agent starts a pairing on a relay the owner set up; the agent and the owner both read the install command. */
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
  assert.ok(code.ok, "the owner can see it");
  const command = (dataOf(code) as { command: string }).command;
  assert.ok(command.length > 0);
  return { owner, state, started, command };
}

test("SPEC-03 §9.5.4, agent first: an agent starts a pairing and gets the install command to hand the owner; pair_code gives it the same", async (t) => {
  const { state, started, command } = await pairing(t);

  assert.ok(started.pair_id && started.expires_at, "the agent gets pair_id and expires_at");
  assert.equal(started.command, command, "and the command with its code and secret: nothing in a result is hidden from an agent");
  assert.match(command, /install\.sh \| sh -s -- \S+ \S+ \S+$/);
  assert.equal(state.peek!.isError, false, "an agent may ask for the command again");
  assert.equal((resultOf(state.peek!) as { command: string }).command, command);
});
