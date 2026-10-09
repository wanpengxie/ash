import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startOwner } from "../../src/main";
import { AgentMember } from "../../src/members/agent";
import { EchoTurnRunner } from "../../src/runtimes/echo";
import type { TrustedRouteContext } from "../../src/world/router";
import { STUCK_MS } from "../fixtures/wait";

const [mode, root] = process.argv.slice(2);
if (!root || !["victim", "recover"].includes(mode)) throw new Error("invalid isolated stale-cancel mode");
let firstRelease!: () => void, runs = 0;
const firstGate = new Promise<void>((resolve) => { firstRelease = resolve; });
EchoTurnRunner.prototype.runTurn = async function () {
  runs++;
  if (mode === "victim" && runs === 1) await firstGate;
  if (mode === "victim" && runs === 2) await new Promise<void>(() => {});
  return { reason: "completed" };
};
const originalHandle = AgentMember.prototype.handle;
Object.defineProperty(AgentMember.prototype, "handle", { value: function (message: Parameters<AgentMember["handle"]>[0], context: Parameters<AgentMember["handle"]>[1]) {
  if (mode === "victim" && message.word === "cancel_turn" && message.from === "service:admin") return new Promise(() => {});
  return originalHandle.call(this, message, context);
} });
const running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`,
  local: true, remote: false, ownerProxy: true };
const rows = () => running.ledger.list({ limit: 1000 });
const until = async (check: () => boolean) => {
  const end = Date.now() + STUCK_MS;
  while (Date.now() < end) { if (check()) return; await delay(20); }
  throw new Error("isolated stale-cancel state did not arrive");
};
if (mode === "victim") {
  await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first isolated turn" }, wait: true });
  await until(() => runs === 1);
  const first = rows().find((row) => row.word === "turn.start")!;
  void running.world.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
  await until(() => rows().some((row) => row.word === "cancel_turn" && row.kind === "request"));
  const registration = running.edge.screens.register(owner, "scope:isolated");
  const screen: TrustedRouteContext = { ...owner, transport: "web_ui", screenId: registration.screen, screenLabel: registration.label };
  const resume = await running.world.send(screen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
  if (resume.reply?.body.ok !== true) throw new Error("isolated resume failed");
  await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "second isolated turn" }, wait: true });
  firstRelease();
  await until(() => runs === 2);
  const second = rows().filter((row) => row.word === "turn.start").at(-1)!;
  const cancel = rows().find((row) => row.word === "cancel_turn" && row.kind === "request")!;
  if (cancel.turn !== first.body.turn || second.body.turn === first.body.turn) throw new Error("isolated target turn mismatch");
  writeSync(1, "READY\n");
} else {
  const cancel = rows().find((row) => row.word === "cancel_turn" && row.kind === "request")!;
  const db = new DatabaseSync(join(root, "state", "agent-main", "agent-inbox.db"), { readOnly: true });
  const intents = (db.prepare("SELECT COUNT(*) AS n FROM cancel_intents").get() as { n: number }).n;
  db.close();
  writeSync(1, `RESULT ${JSON.stringify({ reply: running.ledger.responseTo(cancel.id)?.body, intents, runs,
    ends: rows().filter((row) => row.word === "turn.end").map((row) => row.body.reason), cancelled: rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length })}\n`);
  await running.close();
}
