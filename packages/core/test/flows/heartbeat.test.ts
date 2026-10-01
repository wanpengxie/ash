import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { heartbeatFlow } from "../../src/flows/heartbeat";
import { createSelfMember } from "../../src/members/self";
import { WorkMember } from "../../src/members/work";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter } from "../../src/world/router";

const wait = async (done: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (done()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("heartbeat did not settle");
};

test("30-minute heartbeat skips an empty file and wakes Ash only for a real checklist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-heartbeat-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router }); members.register(self);
  const wakes: string[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!], handle(message) {
      wakes.push(String((message.body.context as { checklist?: string }).checklist));
      return { ok: true, result: { accepted: true } };
    } });
  let now = 1_800_000;
  const work = new WorkMember({ ledger, router, isPaused: () => false, now: () => now, flows: [heartbeatFlow()] }); members.register(work);
  try {
    writeFileSync(join(home, "HEARTBEAT.md"), "# Checklist\n\n");
    work.tick(); await wait(() => ledger.workRuns("heartbeat")[0]?.state === "no_change");
    assert.deepEqual(wakes, []);
    writeFileSync(join(home, "HEARTBEAT.md"), "- Check the package\n");
    work.tick(); assert.equal(ledger.workRuns("heartbeat").length, 1, "same slot must not run twice");
    now += 1_800_000;
    work.tick(); await wait(() => ledger.workRuns("heartbeat").some((item) => item.state === "done"));
    assert.deepEqual(wakes, ["- Check the package"]);
    assert.equal(ledger.workRuns("heartbeat").length, 2);
  } finally { work.close(); await self.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
