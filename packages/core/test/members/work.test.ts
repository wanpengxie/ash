import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WorkMember, type WorkFlow } from "../../src/members/work";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic",
  local: true, remote: false, ownerProxy: true };
const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
  local: true, remote: false, ownerProxy: false };
const wait = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error("work did not settle");
};

async function fixture(flows: readonly WorkFlow[] = [], initialTime = Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), "ash-work-"));
  const file = join(dir, "ash.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  let paused = false, time = initialTime;
  const work = new WorkMember({ ledger, router, isPaused: () => paused, now: () => time, flows });
  members.register(work);
  return { dir, file, ledger, router, work, setTime(value: number) { time = value; }, setPaused(value: boolean) {
    paused = value;
    const db = new DatabaseSync(file);
    try { db.prepare("INSERT INTO kv(key,value) VALUES('v2:admin:paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)); }
    finally { db.close(); }
  },
    close() { work.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("unregistered production flow fails clearly without a synthetic success run", async () => {
  const f = await fixture();
  try {
    const sent = await f.router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "memory" }, wait: true });
    assert.deepEqual(sent.reply?.body, { ok: false, error: { code: "not_found", message: "flow unavailable" } });
    assert.equal(f.ledger.workRuns().length, 0);
    assert.equal(f.ledger.list().filter((row) => row.word === "run.start").length, 0);
    await assert.rejects(f.router.send(agent, { to: "service:work", kind: "request", word: "run", body: { flow: "fixture" } }), /owner/);
    await assert.rejects(f.router.send(agent, { to: "service:work", kind: "request", word: "runs", body: {} }), /owner/);
    assert.equal(f.ledger.list().filter((row) => row.from === "agent:main" && row.to === "service:work").length, 0);
  } finally { f.close(); }
});

test("controlled pure-code flow has atomic metadata, direct r_ turn, bounded readback and retry dedupe", async () => {
  let effects = 0;
  const f = await fixture([{ name: "fixture", triggers: ["manual"], async execute(ctx) {
    await ctx.step("count.once", () => { effects++; return { private_output: "never in ledger" }; });
    return "done";
  } }]);
  try {
    const request = { to: "service:work", kind: "request" as const, word: "run", body: { flow: "fixture" },
      client_id: "once", wait: true };
    const first = await f.router.send(owner, request);
    const retry = await f.router.send(owner, request);
    assert.equal(first.id, retry.id);
    assert.equal(first.reply?.body.ok, true);
    const run = (first.reply!.body.result as { run: string }).run;
    await wait(() => f.ledger.workRuns()[0]?.state === "done");
    const rows = f.ledger.list({ limit: 1000 }).filter((row) => row.from === "service:work" && row.kind === "event");
    assert.deepEqual(rows.map((row) => row.word), ["run.start", "run.step", "run.step", "run.end"]);
    assert.ok(rows.every((row) => row.turn === run && row.body.run === run));
    assert.deepEqual(rows.filter((row) => row.word === "run.step").map((row) => row.body), [
      { run, step: "count.once", state: "started" }, { run, step: "count.once", state: "done" },
    ]);
    assert.equal(JSON.stringify(rows).includes("private_output"), false);
    assert.equal(effects, 1);
    const listed = await f.router.send(owner, { to: "service:work", kind: "request", word: "runs", body: {}, wait: true });
    assert.deepEqual((listed.reply?.body.result as { runs: unknown[] }).runs, f.ledger.workRuns());
    const db = new DatabaseSync(f.file);
    try { assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM work_runs").get() as { n: number }).n), 1); }
    finally { db.close(); }
  } finally { f.close(); }
});

test("flow send uses a real paired router request with run-scoped stable client id", async () => {
  let effects = 0;
  const f = await fixture([{ name: "fixture", triggers: ["manual"], async execute(ctx) {
    const request = { to: "service:fixture", word: "ping", body: {}, client_id: "ping" };
    assert.deepEqual(await ctx.send(request), { ok: true, result: { value: 1 } });
    assert.deepEqual(await ctx.send(request), { ok: true, result: { value: 1 } });
    return "done";
  } }]);
  try {
    f.router.register({ member: "service:fixture", spec: { word: "ping", kind: "request", description: "Synthetic in-process target",
      risk: "none", label: "Testing", input_schema: { type: "object", additionalProperties: false },
      result_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } },
    handle: () => { effects++; return { ok: true, result: { value: 1 } }; } });
    const sent = await f.router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "fixture" }, wait: true });
    const run = (sent.reply!.body.result as { run: string }).run;
    await wait(() => f.ledger.workRuns()[0]?.state === "done");
    const calls = f.ledger.list({ limit: 1000 }).filter((row) => row.from === "service:work" && row.kind === "request" && row.word === "ping");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].turn, run);
    assert.equal(f.ledger.responseTo(calls[0].id)?.body.ok, true);
    assert.equal(effects, 1);
  } finally { f.close(); }
});

test("reopen marks an uncertain active run failed once and frees its flow mutex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-work-crash-"));
  const file = join(dir, "ash.db");
  const first = await Ledger.open(file);
  let run: string;
  try {
    run = first.workStart(null, "fixture", "hourly", 100).run;
    assert.equal(first.workRuns()[0].state, "running");
  } finally { first.close(); }
  const reopened = await Ledger.open(file);
  const router = new WorldRouter(reopened, async () => true);
  const work = new WorkMember({ ledger: reopened, router, isPaused: () => false });
  try {
    work.prepareRecovery(); work.prepareRecovery();
    assert.deepEqual(reopened.workRuns().map((item) => item.state), ["failed"]);
    assert.equal(reopened.list({ limit: 1000 }).filter((row) => row.word === "run.end" && row.body.run === run).length, 1);
    const next = reopened.workStart(null, "fixture", "hourly", 101);
    assert.notEqual(next.run, run);
  } finally { work.close(); reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("pause settles a non-cooperative run immediately and suppresses its late success", async () => {
  let release!: () => void, entered!: () => void;
  const enteredRun = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture([{ name: "fixture", triggers: ["manual"], async execute(ctx) {
    await ctx.step("blocked", async () => { entered(); await held; });
    return "done";
  } }]);
  try {
    const sent = await f.router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "fixture" }, wait: true });
    const run = (sent.reply!.body.result as { run: string }).run;
    await enteredRun;
    f.setPaused(true);
    f.work.resamplePause();
    assert.equal(f.ledger.workRuns()[0].state, "failed");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.ledger.list({ limit: 1000 }).filter((row) => row.word === "run.end" && row.body.run === run).length, 1);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((row) => row.word === "run.step" && row.body.state === "done").length, 0);
  } finally { release?.(); f.close(); }
});

test("hourly slot runs once across restart; paused slot is consumed without a resume backfill", async () => {
  let calls = 0;
  const flow: WorkFlow = { name: "fixture", triggers: ["hourly"], async execute() { calls++; return "done"; } };
  const hour = 1_727_740_800_000;
  const f = await fixture([flow], hour);
  try {
    f.work.tick();
    await wait(() => f.ledger.workRuns()[0]?.state === "done");
    f.work.tick();
    assert.equal(calls, 1);
    f.setTime(hour + 3_600_000);
    f.setPaused(true);
    f.work.tick();
    assert.equal(calls, 1);
    f.setPaused(false);
    f.work.tick();
    assert.equal(calls, 1);
    f.setTime(hour + 7_200_000);
    f.work.tick();
    await wait(() => calls === 2);
    assert.equal(f.ledger.workRuns().length, 2);
  } finally { f.close(); }
});

test("durable hourly claim survives reopening and will not execute the same slot twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-work-hour-reopen-"));
  const file = join(dir, "ash.db");
  const first = await Ledger.open(file);
  const slot = "hourly:fixture:100";
  let run: string;
  try {
    run = first.workStartScheduled("fixture", "hourly", slot, 360_000_000).run!;
    first.workFinish(run, "done", "completed", 360_000_001);
  } finally { first.close(); }
  const reopened = await Ledger.open(file);
  try {
    assert.deepEqual(reopened.workStartScheduled("fixture", "hourly", slot, 360_000_002),
      { run, event: null, duplicate: true, skipped: false });
    assert.equal(reopened.workRuns().length, 1);
    assert.equal(reopened.list({ limit: 1000 }).filter((row) => row.word === "run.start").length, 1);
  } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cooldown waits five minutes after latest real turn and ignores a stale idle window", async () => {
  let calls = 0;
  const flow: WorkFlow = { name: "fixture", triggers: ["cooldown"], async execute() { calls++; return "no_change"; } };
  const at = 1_727_740_800_000;
  const f = await fixture([flow], at);
  try {
    const end = f.ledger.append({ from: "agent:main", to: null, kind: "event", word: "turn.end", body: { turn: "t_1", reason: "completed" } }).message;
    f.setTime(end.ts + 299_999);
    f.work.tick(); assert.equal(calls, 0);
    f.setTime(end.ts + 300_000);
    f.work.tick(); await wait(() => calls === 1);
    f.work.tick(); assert.equal(calls, 1);
    f.ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "new input" } });
    f.setTime(end.ts + 600_000);
    f.work.tick(); assert.equal(calls, 1);
  } finally { f.close(); }
});

test("real SIGKILL on both sides of work commits never leaves a half row/event or repeats a terminal", async () => {
  const child = fileURLToPath(new URL("./fixtures/work-kill-child.ts", import.meta.url));
  for (const stage of ["start-after-row", "start-before-commit", "start-after-commit", "end-after-row", "end-before-commit", "end-after-commit"] as const) {
    const dir = mkdtempSync(join(tmpdir(), `ash-work-${stage}-`));
    const file = join(dir, "ash.db");
    const first = await Ledger.open(file);
    if (stage.startsWith("end")) first.workStart(null, "fixture", "manual");
    first.close();
    try {
      const killed = spawnSync(process.execPath, ["--expose-internals", "--import", "tsx", child, file, stage], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
      assert.equal(killed.signal, "SIGKILL", `${stage}: ${killed.stderr}`);
      const reopened = await Ledger.open(file);
      try {
        const starts = reopened.list({ limit: 1000 }).filter((row) => row.word === "run.start");
        const ends = reopened.list({ limit: 1000 }).filter((row) => row.word === "run.end");
        if (stage.startsWith("start") && stage !== "start-after-commit") {
          assert.equal(reopened.workRuns().length, 0);
          assert.equal(starts.length, 0);
          assert.equal(ends.length, 0);
          assert.ok(reopened.workStart(null, "fixture", "manual").run);
        } else if (stage === "end-after-commit") {
          assert.equal(reopened.workRuns()[0].state, "done");
          assert.equal(starts.length, 1);
          assert.equal(ends.length, 1);
          assert.deepEqual(reopened.workRecover(), []);
        } else {
          assert.equal(reopened.workRuns()[0].state, "running");
          assert.equal(starts.length, 1);
          assert.equal(ends.length, 0);
          reopened.workRecover(); reopened.workRecover();
          assert.equal(reopened.workRuns()[0].state, "failed");
          assert.equal(reopened.list({ limit: 1000 }).filter((row) => row.word === "run.end").length, 1);
        }
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
