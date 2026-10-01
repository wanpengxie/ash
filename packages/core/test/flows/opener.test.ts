import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { openerFlow } from "../../src/flows/opener";
import { WorkMember } from "../../src/members/work";
import { registerWorkerMembers, type WorkerModel } from "../../src/workers/llm";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "device:phone",
  local: true, remote: false, ownerProxy: false };
const wait = async (done: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (done()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("opener did not settle");
};

async function fixture(speak: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "ash-opener-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const inputs: Record<string, unknown>[] = [];
  const model: WorkerModel = { async complete(prompt) {
    const raw = /<data source="worker:opener\/input">\n([^\n]+)\n<\/data>/.exec(prompt.user)?.[1];
    assert.ok(raw); inputs.push(JSON.parse(raw) as Record<string, unknown>);
    return { text: JSON.stringify({ speak, why: speak ? "upcoming appointment" : "nothing timely", hint: "Appointment today" }), finish: "stop" };
  } };
  registerWorkerMembers(members, model);
  const wakes: Record<string, unknown>[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!], handle(message) {
      wakes.push(message.body); return { ok: true, result: { accepted: true } };
    } });
  const work = new WorkMember({ ledger, router, isPaused: () => false, flows: [openerFlow(ledger)] }); members.register(work);
  const stop = router.subscribe((message) => {
    if (message.from === "device:phone" && message.word === "sense.screen" && Number(message.body.away_ms) >= 6 * 3_600_000)
      work.trigger("opener", "event", `screen:${createHash("sha256").update(message.id).digest("hex").slice(0, 32)}`);
  });
  const send = (word: string, body: Record<string, unknown>) => router.send(phone, { to: null, kind: "event", word, body });
  return { ledger, work, inputs, wakes, send, async close() { stop(); work.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("app open after six hours passes upcoming sense facts to opener; only speak:true wakes Ash", async () => {
  for (const speak of [true, false]) {
    const f = await fixture(speak);
    try {
      await f.send("sense.calendar", { kind: "upcoming", event: { id: "e1", title: "Appointment", start: Date.now() + 3_600_000, end: Date.now() + 7_200_000, important: true } });
      await f.send("sense.screen", { state: "app_open", away_ms: 5 * 3_600_000 });
      assert.equal(f.ledger.workRuns("opener").length, 0);
      await f.send("sense.screen", { state: "app_open", away_ms: 7 * 3_600_000 });
      await wait(() => Boolean(f.ledger.workRuns("opener")[0] && f.ledger.workRuns("opener")[0].state !== "running"));
      assert.equal(f.ledger.workRuns("opener")[0].state, speak ? "done" : "no_change");
      assert.equal(f.inputs.length, 1);
      assert.equal((f.inputs[0].pending as unknown[]).length, 1);
      assert.equal(f.wakes.length, Number(speak));
      if (speak) assert.equal(f.wakes[0].reason, "app_open");
    } finally { await f.close(); }
  }
});
