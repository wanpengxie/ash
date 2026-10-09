import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main";
import type { TrustedRouteContext } from "../../src/world/router";
import { STUCK_MS } from "../fixtures/wait";

const [mode, root] = process.argv.slice(2);
if (!root || !["victim", "recover"].includes(mode)) throw new Error("invalid synthetic post child mode");
const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
const rows = () => running.ledger.list({ limit: 1000 });
const waitRecord = async (id: string) => {
  const until = Date.now() + STUCK_MS;
  while (Date.now() < until) {
    if (rows().some((item) => item.word === "post.delivery" && item.body.message_id === id)) return;
    await delay(20);
  }
  throw new Error("post classification did not finish");
};
if (mode === "victim") {
  const first = await running.world.send(agent, { to: "person:owner", kind: "request", word: "say",
    body: { text: "synthetic first offer", kind: "offer", dedupe_key: "job:crash-1" }, client_id: "synthetic:first", wait: true });
  await waitRecord(first.id);
  running.ledger.append({ from: "service:work", to: "person:owner", kind: "request", word: "say",
    body: { text: "synthetic stranded offer", kind: "offer", dedupe_key: "job:unauthorized" } }, undefined,
  { deadlineAt: Date.now() + 30_000, context: { member: "service:work", local: true, remote: false, ownerProxy: false,
    transportPrincipal: "service:work" } });
  process.stdout.write("READY\n");
  await new Promise(() => {});
} else {
  try {
    const original = rows().find((item) => item.word === "say" && item.body.dedupe_key === "job:crash-1");
    const stranded = rows().find((item) => item.word === "say" && item.body.dedupe_key === "job:unauthorized");
    if (!original || !stranded) throw new Error("synthetic source missing after restart");
    const before = rows().filter((item) => item.word === "deliver" && item.body.message_id === original.id).length;
    await delay(120);
    const after = rows().filter((item) => item.word === "deliver" && item.body.message_id === original.id).length;
    const second = await running.world.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic second offer", kind: "offer", dedupe_key: "job:crash-1" }, client_id: "synthetic:second", wait: true });
    await waitRecord(second.id);
    process.stdout.write(`RESULT ${JSON.stringify({ before, after,
      strandedResponse: running.ledger.responseTo(stranded.id)?.body,
      secondState: rows().find((item) => item.word === "post.delivery" && item.body.message_id === second.id)?.body.state,
      secondDeliveries: rows().filter((item) => item.word === "deliver" && item.body.message_id === second.id).length })}\n`);
  } finally { await running.close(); }
}
