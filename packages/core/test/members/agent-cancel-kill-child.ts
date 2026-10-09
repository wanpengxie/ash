import { writeSync } from "node:fs";
import { join } from "node:path";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { STUCK_MS } from "../fixtures/wait";

const [mode, dir] = process.argv.slice(2);
if (!dir || !["victim", "recover"].includes(mode)) throw new Error("mode and state directory required");
const context = (member: string): TrustedRouteContext => ({ transport: member.startsWith("service:") ? "service" : "api",
  transportPrincipal: member, member, local: true, remote: false, ownerProxy: false });
const ledger = await Ledger.open(join(dir, "ledger.db"));
const router = new WorldRouter(ledger, async () => true);
let deviceCalls = 0;
let entered!: () => void;
const deviceEntered = new Promise<void>((resolve) => { entered = resolve; });
router.register({ member: "device:probe", spec: { word: "hold", kind: "request", description: "Wait in a test device", input_schema: { type: "object", additionalProperties: false },
  result_schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false }, risk: "none", label: "Waiting" },
  idempotentRecovery: true, handle: async () => { deviceCalls++; entered(); return new Promise(() => {}); } });
const batches: { texts: unknown[]; facts: readonly string[] }[] = [];
const agent = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner: { async runTurn(input) {
  batches.push({ texts: input.messages.map((message) => message.body.text), facts: input.stopFacts });
  if (mode === "victim") {
    await router.send({ transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false, turn: input.turn },
      { to: "device:probe", kind: "request", word: "hold", body: {}, wait: true });
  }
  return { reason: "completed" };
} } });
new WorldMembers(router).register(agent);
router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });

if (mode === "victim") {
  agent.prepareRecovery();
  await router.recover();
  await agent.start();
  await router.send(context("person:owner"), { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
  await deviceEntered;
  await router.send(context("person:owner"), { to: "agent:main", kind: "request", word: "say", body: { text: "after crash" }, wait: true });
  const actualCancel = router.cancelTurn.bind(router);
  router.cancelTurn = ((actor: string, turn: string) => {
    writeSync(1, "INTENT_READY\n"); // parent kills here: intent committed, router ledger still unsettled
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    return actualCancel(actor, turn);
  }) as WorldRouter["cancelTurn"];
  void router.send(context("service:reflex"), { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "stop before router settlement" }, wait: true });
} else {
  agent.prepareRecovery();
  agent.prepareRecovery(); // repeated reconciliation must not create another terminal or replay
  const unsettledBeforeRouter = ledger.trackedRequests().filter((item) => item.message.word === "hold").length;
  await router.recover();
  await agent.start();
  const deadline = Date.now() + STUCK_MS;
  while (Date.now() < deadline && ledger.list({ after: 0, limit: 1000 }).filter((message) => message.word === "turn.end").length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await router.send(context("person:owner"), { to: "agent:main", kind: "request", word: "say", body: { text: "later" }, wait: true });
  while (Date.now() < deadline && ledger.list({ after: 0, limit: 1000 }).filter((message) => message.word === "turn.end").length < 3) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const rows = ledger.list({ after: 0, limit: 1000 });
  writeSync(1, `RESULT ${JSON.stringify({ deviceCalls, unsettledBeforeRouter, batches,
    holdResponses: rows.filter((message) => message.kind === "response" && message.word === "hold").map((message) => message.body),
    endReasons: rows.filter((message) => message.word === "turn.end").map((message) => message.body.reason) })}\n`);
  await agent.close();
  ledger.close();
}
