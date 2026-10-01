import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startOwner } from "../../src/main";
import { EchoTurnRunner } from "../../src/runtimes/echo";
import { AdminJournal } from "../../src/world/admin-journal";
import type { TrustedRouteContext } from "../../src/world/router";

const [mode, root] = process.argv.slice(2);
if (!root || !["victim", "recover", "reopen"].includes(mode)) throw new Error("invalid isolated recovery mode");
let running: Awaited<ReturnType<typeof startOwner>>;
let runs = 0;
const stopFactsSeen: number[] = [];
EchoTurnRunner.prototype.runTurn = async function (input) {
  runs++;
  stopFactsSeen.push(input.stopFacts.length);
  if (mode === "victim") {
    await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false, turn: input.turn },
    { to: "device:probe", kind: "request", word: "hold", body: {}, wait: true });
    return { reason: "completed" };
  }
  return { reason: "completed" };
};
running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`,
  local: true, remote: false, ownerProxy: true };
const rows = () => running.ledger.list({ limit: 1000 });
const inspect = () => {
  const db = new DatabaseSync(join(root, "state", "agent-main", "agent-inbox.db"), { readOnly: true });
  try {
    const turns = db.prepare("SELECT id,status,reason_v2 FROM turns ORDER BY rowid").all();
    const pending = (db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE state='pending'").get() as { n: number }).n;
    const intents = (db.prepare("SELECT COUNT(*) AS n FROM cancel_intents").get() as { n: number }).n;
    const facts = (db.prepare("SELECT COUNT(*) AS n FROM cancel_intents WHERE consumed_at IS NULL").get() as { n: number }).n;
    return { turns, pending, intents, facts };
  } finally { db.close(); }
};
const until = async (check: () => boolean) => {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await delay(20); }
  throw new Error("isolated state did not arrive");
};
if (mode === "victim") {
  running.members.registerDevice({ id: "device:probe", kind: "device", name: "Synthetic probe", online: true,
    capabilities: () => [{ name: "hold", description: "Isolated held effect", input_schema: { type: "object", additionalProperties: false },
      risk: "none", label: "Held" }],
    handle: () => { writeSync(1, "TOOL\n"); return new Promise(() => {}); } });
  const access = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json" }, body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:probe/hold" }, wait: true }) });
  if (access.status !== 200 || !(await access.json() as { reply?: { body?: { ok?: boolean } } }).reply?.body?.ok)
    throw new Error("synthetic device access grant failed");
  await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic active turn" }, wait: true });
  await until(() => rows().some((row) => row.to === "device:probe" && row.word === "hold"));
  await running.world.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic queued turn" }, wait: true });
  const apply = AdminJournal.prototype.apply;
  AdminJournal.prototype.apply = function (message, paused, targetTurn) {
    const committed = apply.call(this, message, paused, targetTurn);
    if (message.word === "pause") {
      writeSync(1, "COMMITTED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return committed;
  };
  void running.world.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, client_id: "pause:active:kill", wait: true });
} else {
  const state = inspect();
  const tool = rows().find((row) => row.to === "device:probe" && row.word === "hold" && row.kind === "request");
  const pause = rows().find((row) => row.to === "service:admin" && row.word === "pause" && row.kind === "request");
  if (!tool || !pause) throw new Error("isolated requests missing");
  const report = () => ({ state: inspect(), runs, stopFactsSeen, history: (() => {
    const { startedTurns, completedTurns } = running.ledger.agentTurnHistory("agent:main");
    return { started: startedTurns.size, completed: completedTurns.size };
  })(), ends: rows().filter((row) => row.word === "turn.end").map((row) => row.body.reason),
    toolReplies: rows().filter((row) => row.reply_to === tool.id).map((row) => row.body),
    pauseReply: running.ledger.responseTo(pause.id)?.body, cancelled: rows().filter((row) => row.word === "cancel_turn").length });
  if (mode === "recover") {
    writeSync(1, `RESULT ${JSON.stringify(report())}\n`);
  } else {
    const before = report();
    const registration = running.edge.screens.register(owner, "scope:synthetic");
    const screen: TrustedRouteContext = { ...owner, transport: "web_ui", screenId: registration.screen, screenLabel: registration.label };
    const resume = await running.world.send(screen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    await until(() => inspect().turns.length === 2 && rows().filter((row) => row.word === "turn.end").length === 2);
    writeSync(1, `RESULT ${JSON.stringify({ before, after: report(), resume: resume.reply?.body })}\n`);
  }
  await running.close();
}
