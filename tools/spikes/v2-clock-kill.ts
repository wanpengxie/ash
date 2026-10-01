// Synthetic, isolated SIGKILL recovery probe for ASH-301. No user database or device is touched.
// Run: node --import tsx tools/spikes/v2-clock-kill.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wordContract } from "../../packages/sdk/src/words";
import { ClockMember } from "../../packages/core/src/members/clock";
import { OwnerMember } from "../../packages/core/src/members/owner";
import { Ledger } from "../../packages/core/src/world/ledger";
import { WorldMembers } from "../../packages/core/src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../packages/core/src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:synthetic", local: true, remote: false, ownerProxy: true };
const service: TrustedRouteContext = { member: "service:clock", transport: "service", transportPrincipal: "service:clock", local: true, remote: false, ownerProxy: false };
const stage = process.argv[2];
const file = process.argv[3];
const stages = ["claimed", "request-accepted", "event-accepted"] as const;

async function fixture(dbFile: string) {
  const ledger = await Ledger.open(dbFile);
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  members.register(new OwnerMember("Owner", ledger));
  members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say")!],
    handle: () => ({ ok: true, result: { accepted: true } }) });
  const clock = new ClockMember({ ledger, router: world, dbFile, isPaused: () => false, now: () => 2000 });
  members.register(clock);
  return { ledger, world, clock, async close() { await clock.close(); ledger.close(); } };
}

async function child(mode: string, dbFile: string) {
  const f = await fixture(dbFile);
  const set = await f.world.send(owner, { to: "service:clock", kind: "request", word: "set",
    body: { at: 2000, to: "agent:main", word: "say", body: { text: "synthetic" }, label: "Synthetic" }, wait: true });
  assert.equal(set.reply?.body.ok, true);
  const fire = f.clock.journal.claimDue(2000)[0];
  if (mode !== "claimed") {
    const request = await f.world.send(service, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic" },
      client_id: `clock-request:${fire.timerId}:${fire.scheduledAt}` });
    if (mode === "event-accepted") {
      f.clock.journal.finishFire(fire, "dispatched", null, request.id);
      await f.world.send(service, { to: null, kind: "event", word: "clock.fired",
        body: { timer_id: fire.timerId, scheduled_at: fire.scheduledAt, outcome: "dispatched", request_id: request.id },
        client_id: `clock-event:${fire.timerId}:${fire.scheduledAt}` });
    }
  }
  process.stdout.write("READY\n");
  process.stdin.resume(); // Parent kills this process; there is deliberately no graceful close.
}

async function run() {
  const report: Record<string, string> = {};
  for (const mode of stages) {
    const dir = mkdtempSync(join(tmpdir(), "ash-clock-kill-"));
    const dbFile = join(dir, "world.db");
    const childProcess = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child", mode, dbFile],
      { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => { childProcess.kill("SIGKILL"); reject(new Error(`child did not reach ${mode}`)); }, 15_000);
        childProcess.stdout!.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("READY\n")) { clearTimeout(timer); resolve(); }
        });
        childProcess.once("error", (error) => { clearTimeout(timer); reject(error); });
        childProcess.once("exit", (code) => { if (!output.includes("READY\n")) { clearTimeout(timer); reject(new Error(`child exited before ${mode}: ${code}`)); } });
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => childProcess.once("exit", (_code, endedBy) => resolve(endedBy)));
      childProcess.kill("SIGKILL");
      const signal = await exited;
      assert.equal(signal, "SIGKILL");
      const f = await fixture(dbFile);
      try {
        await f.world.recover();
        await f.clock.tick();
        await f.clock.tick();
        const rows = f.ledger.list({ limit: 1000 });
        assert.equal(rows.filter((item) => item.from === "service:clock" && item.word === "say").length, 1);
        assert.equal(rows.filter((item) => item.from === "service:clock" && item.word === "clock.fired").length, 1);
        assert.equal(f.clock.journal.pendingFires().length, 0);
        report[mode] = "PASS";
      } finally { await f.close(); }
    } finally {
      childProcess.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (stage === "--child") await child(process.argv[3], process.argv[4]);
else await run();
