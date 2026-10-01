import { join } from "node:path";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const [mode, dir] = process.argv.slice(2);
if (!dir || !["victim", "recover"].includes(mode)) throw new Error("mode and state directory required");
const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-api", member: "person:owner", local: true, remote: false, ownerProxy: false };
const ledger = await Ledger.open(join(dir, "ledger.db"));
const router = new WorldRouter(ledger, async () => true);
const agent = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner: {
  async runTurn(input, emit) {
    if (mode === "victim") {
      await emit({ id: "first-answer", text: "first answer" });
      for (let i = 0; i < 3; i++) await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: `pending ${i}` }, wait: true });
      process.send?.({ phase: "kill-ready", first: input.messages.map((message) => message.id) });
      return new Promise(() => {});
    }
    process.send?.({ phase: "recovered-batch", texts: input.messages.map((message) => message.body.text) });
    await emit({ id: "recovery-answer", text: "recovered answer" });
    return { reason: "completed" };
  },
} });
new WorldMembers(router).register(agent);
router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
agent.prepareRecovery();
await router.recover();
await agent.start();
if (mode === "victim") await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
else {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (ledger.list({ after: 0, limit: 1000 }).filter((message) => message.word === "turn.end").length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await agent.close();
  ledger.close();
  process.send?.({ phase: "done" });
}
