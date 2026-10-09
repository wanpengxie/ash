import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startOwner } from "../../src/main";
import { AdminJournal } from "../../src/world/admin-journal";
import type { TrustedRouteContext } from "../../src/world/router";
import { STUCK_MS } from "../fixtures/wait";

const [mode, target, root, revoked] = process.argv.slice(2);
if (!root || !["victim", "recover"].includes(mode) || !["pause", "resume"].includes(target)) throw new Error("invalid synthetic admin kill mode");
const running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}`,
  local: true, remote: false, ownerProxy: true };
const register = (): TrustedRouteContext => {
  const registration = running.edge.screens.register(owner, "scope:synthetic");
  return { ...owner, transport: "web_ui", screenId: registration.screen, screenLabel: registration.label };
};
const rows = () => running.ledger.list({ limit: 1000 });
if (mode === "victim") {
  if (target === "resume") {
    const paused = await running.world.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
    if (paused.reply?.body.ok !== true) throw new Error("initial pause failed");
  }
  const apply = AdminJournal.prototype.apply;
  AdminJournal.prototype.apply = function (message, paused) {
    const committed = apply.call(this, message, paused);
    if (message.word === target) {
      writeSync(1, "COMMITTED\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }
    return committed;
  };
  const caller = target === "pause" ? owner : register();
  void running.world.send(caller, { to: "service:admin", kind: "request", word: target,
    body: target === "pause" ? {} : { confirmed: true }, client_id: `kill-${target}`, wait: true });
} else {
  try {
    const request = rows().find((row) => row.to === "service:admin" && row.word === target && row.from === "person:owner");
    if (!request) throw new Error("committed request missing");
    const until = Date.now() + STUCK_MS;
    while (!running.ledger.responseTo(request.id) && Date.now() < until) await delay(20);
    const first = running.ledger.responseTo(request.id);
    const caller = target === "pause" ? owner : register();
    const retry = revoked === "revoked" ? null : await running.world.send(caller, { to: "service:admin", kind: "request", word: target,
      body: target === "pause" ? {} : { confirmed: true }, client_id: `kill-${target}`, wait: true });
    const db = new DatabaseSync(join(root, "state", "ash.db"), { readOnly: true });
    const commands = db.prepare("SELECT paused FROM admin_pause_commands ORDER BY seq").all().map((row) => Number(row.paused));
    const state = db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get()?.value;
    db.close();
    writeSync(1, `RESULT ${JSON.stringify({ requestId: request.id, reply: first?.body, retryId: retry?.id, retryReply: retry?.reply?.body,
      commands, state, cancels: rows().filter((row) => row.to === "agent:main" && row.word === "cancel_turn" && row.body.by === request.id).length })}\n`);
  } finally { await running.close(); }
}
