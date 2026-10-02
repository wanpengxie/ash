import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tourFlow } from "../../src/flows/tour";
import { WorkMember } from "../../src/members/work";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter } from "../../src/world/router";
import { wordContract } from "../../../sdk/src/words";

const dayMs = 86_400_000;
const wait = async (done: () => boolean) => {
  for (let i = 0; i < 100; i++) { if (done()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("tour did not settle");
};

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-tour-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const wakes: { day: number; hint: string }[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!], handle(message) {
      assert.equal(message.body.reason, "first_week_tour");
      wakes.push(message.body.context as { day: number; hint: string });
      return { ok: true, result: { accepted: true } };
    } });
  let now = Date.now();
  const work = new WorkMember({ ledger, router, isPaused: () => false, now: () => now, flows: [tourFlow(ledger, () => now)] });
  members.register(work);
  const ownerSays = (text: string) => {
    const message = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text } });
    now = Date.now();
    return message;
  };
  const run = async (slot: string) => {
    now += 1; // runs are ordered by start time; distinct times keep the newest findable
    const id = work.trigger("tour", "event", slot);
    assert.ok(id);
    await wait(() => ledger.workRuns("tour").find((item) => item.run === id)?.state !== "running");
    return ledger.workRuns("tour").find((item) => item.run === id)!.state;
  };
  return { ledger, work, wakes, ownerSays, run, advanceDay() { now += dayMs; }, async close() {
    work.close(); ledger.close(); rmSync(dir, { recursive: true, force: true });
  } };
}

test("first owner turn starts seven days; each day hands exactly one distinct hint to Ash", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.run("before-owner"), "no_change");
    f.ownerSays("你好");
    for (let day = 1; day <= 7; day++) {
      assert.equal(await f.run(`day-${day}`), "done");
      assert.equal(await f.run(`day-${day}-again`), "no_change");
      f.advanceDay();
    }
    assert.equal(await f.run("day-8"), "no_change");
    assert.deepEqual(f.wakes.map((wake) => wake.day), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(new Set(f.wakes.map((wake) => wake.hint)).size, 7);
  } finally { await f.close(); }
});

test("owner replying 不用了 after a tour stops later hints", async () => {
  const f = await fixture();
  try {
    f.ownerSays("你好");
    assert.equal(await f.run("first-day"), "done");
    f.ownerSays("不用了");
    f.advanceDay();
    assert.equal(await f.run("next-day"), "no_change");
    assert.deepEqual(f.wakes.map((wake) => wake.day), [1]);
  } finally { await f.close(); }
});

test("a polite decline still stops hints after many quiet runs and a long ledger", async () => {
  const f = await fixture();
  try {
    // The first owner turn lands after more than a page of other history.
    for (let i = 0; i < 1100; i++) f.ledger.append({ from: "agent:main", to: null, kind: "event", word: "status", body: { state: "idle" } });
    f.ownerSays("你好");
    assert.equal(await f.run("first-day"), "done");
    f.ownerSays("不用了，谢谢");
    // Every reply triggers a tour run; a busy day leaves far more than fifty no_change runs and messages.
    for (let i = 0; i < 60; i++) assert.equal(await f.run(`same-day-${i}`), "no_change");
    for (let i = 0; i < 1100; i++) f.ledger.append({ from: "agent:main", to: null, kind: "event", word: "status", body: { state: "idle" } });
    f.advanceDay();
    assert.equal(await f.run("next-day"), "no_change");
    assert.deepEqual(f.wakes.map((wake) => wake.day), [1]);
  } finally { await f.close(); }
});

test("only a decline of the hints stops them", async () => {
  const { declinesTour } = await import("../../src/flows/tour");
  for (const text of ["不用了", " 不用了，谢谢", "不需要了", "别发了", "不要再发了"]) assert.equal(declinesTour(text), true, text);
  for (const text of ["你好", "这个不用了解", "我不用了解细节吗"]) assert.equal(declinesTour(text), false, text);
});
