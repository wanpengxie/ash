import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Message } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { proactiveFlow } from "../../src/flows/proactive";
import { createSelfMember } from "../../src/members/self";
import { WorkMember } from "../../src/members/work";
import { registerWorkerMembers, type WorkerModel } from "../../src/workers/llm";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "test-owner",
  local: true, remote: false, ownerProxy: true };
const wait = async (done: () => boolean) => {
  for (let i = 0; i < 200; i++) { if (done()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("proactive run did not settle");
};

async function fixture(model: WorkerModel) {
  const dir = mkdtempSync(join(tmpdir(), "ash-proactive-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  registerWorkerMembers(members, model);
  const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router }); members.register(self);
  const wakes: Message[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!], handle(message) { wakes.push(message); return { ok: true, result: { accepted: true } }; } });
  const work = new WorkMember({ ledger, router, isPaused: () => false, flows: [proactiveFlow(ledger)] }); members.register(work);
  const run = async () => {
    const sent = await router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "proactive" }, wait: true });
    assert.equal(sent.reply?.body.ok, true);
    const id = (sent.reply!.body.result as { run: string }).run;
    await wait(() => ledger.workRuns("proactive").find((item) => item.run === id)?.state !== "running");
    return ledger.workRuns("proactive").find((item) => item.run === id)!.state;
  };
  return { dir, home, ledger, self, work, wakes, run, async close() { work.close(); await self.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const candidate = { suggestion: { kind: "heads_up", title: "Passport renewal", text: "Your passport expires soon.", urgency: "regular", facts: [1] } };
const model = (output: unknown): WorkerModel & { prompts: string[] } => {
  const prompts: string[] = [];
  return { prompts, async complete(prompt) { prompts.push(prompt.user); return { text: JSON.stringify(output), finish: "stop" }; } };
};

test("proactive worker cites a fact, then hands candidate to Ash mind without directly messaging owner", async () => {
  const provider = model(candidate);
  const f = await fixture(provider);
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "Passport expires on 2026-11-01\n");
    writeFileSync(join(f.home, "PROACTIVE.md"), "Tell me about deadlines\n");
    assert.equal(await f.run(), "done");
    assert.equal(f.wakes.length, 1);
    assert.equal(f.wakes[0].body.reason, "proactive_candidate");
    assert.deepEqual((f.wakes[0].body.context as { suggestion: unknown }).suggestion, candidate.suggestion);
    assert.match(provider.prompts[0], /Tell me about deadlines/);
    assert.equal(f.ledger.list({ limit: 1000 }).some((row) => row.from === "service:work" && row.to === "person:owner" && row.word === "say"), false);
  } finally { await f.close(); }
});

test("a just-said fact returns no_change instead of waking Ash", async () => {
  const provider = model(candidate);
  const f = await fixture(provider);
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "Passport expires on 2026-11-01\n");
    f.ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "Passport expires on 2026-11-01" } });
    assert.equal(await f.run(), "no_change");
    assert.equal(f.wakes.length, 0);
    assert.equal(provider.prompts.length, 1);
  } finally { await f.close(); }
});

test("upcoming calendar event can nominate a cited fact without MEMORY.md", async () => {
  const provider = model(candidate);
  const f = await fixture(provider);
  try {
    f.ledger.append({ from: "device:phone", to: null, kind: "event", word: "sense.calendar", body: {
      kind: "upcoming", event: { id: "appointment", title: "Passport renewal", start: Date.now() + 3_600_000,
        end: Date.now() + 7_200_000, important: true },
    } });
    assert.equal(await f.run(), "done");
    assert.equal(f.wakes.length, 1);
    assert.match(provider.prompts[0], /Passport renewal/);
  } finally { await f.close(); }
});

test("worker no_change stays silent and invalid citations fail before wake", async () => {
  for (const [output, state] of [[{ no_change: { checked: [], details: "nothing timely" } }, "no_change"],
    [{ suggestion: { ...candidate.suggestion, facts: [99] } }, "failed"]] as const) {
    const provider = model(output);
    const f = await fixture(provider);
    try {
      writeFileSync(join(f.home, "MEMORY.md"), "Passport expires on 2026-11-01\n");
      assert.equal(await f.run(), state);
      assert.equal(f.wakes.length, 0);
      assert.equal(provider.prompts.length, state === "failed" ? 2 : 1);
    } finally { await f.close(); }
  }
});
