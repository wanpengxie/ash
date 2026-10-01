import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Claim, Message } from "../../../sdk/src/api";
import { memoryFlow } from "../../src/flows/memory";
import { createSelfMember } from "../../src/members/self";
import { WorkMember } from "../../src/members/work";
import { registerWorkerMembers, type WorkerModel } from "../../src/workers/llm";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "test-owner", local: true, remote: false, ownerProxy: true };
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("memory run did not settle");
};

function scripted(reply: (name: string, input: Record<string, unknown>) => unknown): WorkerModel & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async complete(prompt) {
    const name = /source="worker:([^/]+)\/input"/.exec(prompt.user)?.[1];
    const data = /<data source="worker:[^/]+\/input">\n([^\n]+)\n<\/data>/.exec(prompt.user)?.[1];
    if (!name || !data) throw new Error("missing worker input");
    calls.push(name);
    return { text: JSON.stringify(reply(name, JSON.parse(data) as Record<string, unknown>)), finish: "stop" };
  } };
}

async function fixture(model: WorkerModel, afterApplied?: (run: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ash-memory-flow-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  router.setGate(async () => ({ allow: true, by: "answer" }));
  const members = new WorldMembers(router);
  registerWorkerMembers(members, model);
  const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router }); members.register(self);
  const errors: unknown[] = [];
  const flow = memoryFlow(ledger, afterApplied);
  const work = new WorkMember({ ledger, router, isPaused: () => false, flows: [{ ...flow, async execute(ctx) { try { return await flow.execute(ctx); } catch (error) { errors.push(error); throw error; } } }] }); members.register(work);
  const add = (text: string): Message => ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text } }).message;
  const run = async () => {
    const sent = await router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "memory" }, wait: true });
    assert.equal(sent.reply?.body.ok, true);
    const id = (sent.reply!.body.result as { run: string }).run;
    await wait(() => ledger.workRuns("memory")[0]?.state !== "running");
    return { id, state: ledger.workRuns("memory")[0].state };
  };
  return { dir, home, ledger, self, work, errors, add, run, async close() { work.close(); await self.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("memory flow verifies two claims, appends dated log, applies only approved edits, and then sees an empty window", async () => {
  const model = scripted((name, input) => {
    if (name === "extract") {
      const messages = input.chunk as Message[];
      return { claims: messages.map((message): Claim => message.body.text === "I prefer short answers"
        ? { text: "Prefers short answers", type: "preference", salience: "medium", evidence: [message.id], quote: "I prefer short answers" }
        : { text: "Now lives in Singapore", type: "correction", salience: "high", evidence: [message.id], quote: "I live in Singapore now", supersedes: "Lives in London" }) };
    }
    if (name === "verify_claims") return { verdicts: (input.claims as Claim[]).flatMap((_, i) => [
      { i, lens: "refute", pass: true, confidence: 0.9, why: "no contradiction" },
      { i, lens: "grounded", pass: true, confidence: 0.9, why: "cited owner text" },
    ]) };
    if (name === "reconcile") return input.file === "MEMORY.md" ? { edits: [
      { op: "replace", start: 1, end: 1, guard: "Lives in London", text: "Lives in Singapore", reason: "correct", evidence: [(input.claims as Claim[])[1].evidence[0]] },
      { op: "replace", start: 2, end: 2, guard: "Keep this", text: "Bad edit", reason: "condense", evidence: [(input.claims as Claim[])[0].evidence[0]] },
    ] } : { edits: [
      { op: "replace", start: 1, end: 1, guard: "Style: unknown", text: "Style: short answers", reason: "promote", evidence: [(input.claims as Claim[])[0].evidence[0]] },
    ] };
    if (name === "verify_plan") return { verdicts: (input.edits as unknown[]).flatMap((_, i) => [
      { i, lens: "evidence", pass: true, why: "supported" }, { i, lens: "temporal", pass: true, why: "current" },
      { i, lens: "preservation", pass: i === 0, why: i === 0 ? "preserved" : "destroys unrelated text" },
    ]) };
    throw new Error(`unexpected ${name}`);
  });
  const handoffs: string[] = [];
  const f = await fixture(model, (run) => { handoffs.push(run); });
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "Lives in London\nKeep this\n");
    writeFileSync(join(f.home, "USER.md"), "Style: unknown\n");
    f.add("I prefer short answers"); f.add("I live in Singapore now");
    const first = await f.run(); assert.equal(first.state, "done", JSON.stringify({ calls: model.calls, errors: f.errors.map(String) }));
    assert.deepEqual(handoffs, [first.id]);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "Lives in Singapore\nKeep this\n");
    assert.match(readFileSync(join(f.home, "USER.md"), "utf8"), /^---\nversion: 1\nupdated: .*\n---\nStyle: short answers\n$/);
    const log = readFileSync(join(f.home, "memory", `${new Date().toISOString().slice(0, 10)}.md`), "utf8");
    assert.equal(log.trim().split("\n").length, 2);
    assert.match(log, /"quote":"I prefer short answers"/);
    assert.match(log, /"supersedes":"Lives in London"/);
    assert.deepEqual(f.ledger.list({ limit: 1000 }).filter((m) => m.turn === first.id && m.from === "service:work" && m.kind === "request").map((m) => m.word),
      ["extract", "verify_claims", "read", "reconcile", "verify_plan", "read", "reconcile", "verify_plan", "read", "append", "apply_plan", "apply_plan"]);
    const second = await f.run(); assert.equal(second.state, "no_change");
    assert.deepEqual(handoffs, [first.id]);
    assert.equal(readFileSync(join(f.home, "memory", `${new Date().toISOString().slice(0, 10)}.md`), "utf8"), log);
  } finally { await f.close(); }
});

test("invalid extract output fails after one retry without changing managed files", async () => {
  const model = scripted(() => ({ claims: [{ text: "Preference", type: "preference", salience: "medium", evidence: ["invented"] }] }));
  const f = await fixture(model);
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "original\n");
    f.add("I prefer short answers");
    const outcome = await f.run(); assert.equal(outcome.state, "failed");
    assert.deepEqual(model.calls, ["extract", "extract"]);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "original\n");
    assert.equal(existsSync(join(f.home, "memory")), false);
    assert.equal(f.ledger.list({ limit: 1000 }).some((m) => m.turn === outcome.id && m.word === "run.end" && m.body.outcome === "failed"), true);
  } finally { await f.close(); }
});

test("a refuting verifier rejects its claim before any file effect", async () => {
  const model = scripted((name, input) => {
    if (name === "extract") {
      const message = (input.chunk as Message[])[0];
      return { claims: [{ text: "Prefers short answers", type: "preference", salience: "medium",
        evidence: [message.id], quote: "I prefer short answers" }] };
    }
    if (name === "verify_claims") return { verdicts: [
      { i: 0, lens: "refute", pass: false, confidence: 0.9, why: "contradicted" },
      { i: 0, lens: "grounded", pass: true, confidence: 0.9, why: "quote matches" },
    ] };
    throw new Error(`unexpected ${name}`);
  });
  const f = await fixture(model);
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "original\n");
    f.add("I prefer short answers");
    assert.equal((await f.run()).state, "no_change");
    assert.deepEqual(model.calls, ["extract", "verify_claims"]);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "original\n");
    assert.equal(existsSync(join(f.home, "memory")), false);
  } finally { await f.close(); }
});

test("a failed plan can be retried without duplicating an already appended claim", async () => {
  let plans = 0;
  const model = scripted((name, input) => {
    if (name === "extract") {
      const message = (input.chunk as Message[])[0];
      return { claims: [{ text: "Prefers short answers", type: "preference", salience: "medium",
        evidence: [message.id], quote: "I prefer short answers" }] };
    }
    if (name === "verify_claims") return { verdicts: [
      { i: 0, lens: "refute", pass: true, confidence: 1, why: "clear" },
      { i: 0, lens: "grounded", pass: true, confidence: 1, why: "quoted" },
    ] };
    if (name === "reconcile") return input.file === "MEMORY.md" ? { edits: [
      { op: "replace", start: 1, end: 1, guard: ++plans === 1 ? "wrong guard" : "Style: unknown",
        text: "Style: short answers", reason: "promote", evidence: [(input.claims as Claim[])[0].evidence[0]] },
    ] } : { edits: [] };
    if (name === "verify_plan") return { verdicts: [
      { i: 0, lens: "evidence", pass: true, why: "supported" },
      { i: 0, lens: "temporal", pass: true, why: "current" },
      { i: 0, lens: "preservation", pass: true, why: "preserved" },
    ] };
    throw new Error(`unexpected ${name}`);
  });
  const f = await fixture(model);
  try {
    writeFileSync(join(f.home, "MEMORY.md"), "Style: unknown\n");
    f.add("I prefer short answers");
    assert.equal((await f.run()).state, "failed");
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "Style: unknown\n");
    const logPath = join(f.home, "memory", `${new Date().toISOString().slice(0, 10)}.md`);
    const firstLog = readFileSync(logPath, "utf8"); assert.equal(firstLog.trim().split("\n").length, 1);
    assert.equal((await f.run()).state, "done");
    assert.equal(readFileSync(logPath, "utf8"), firstLog);
    assert.equal(readFileSync(join(f.home, "MEMORY.md"), "utf8"), "Style: short answers\n");
  } finally { await f.close(); }
});
