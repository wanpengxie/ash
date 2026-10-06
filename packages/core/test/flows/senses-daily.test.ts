import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dailySummary, geofenceTime, sensesDailyFlow } from "../../src/flows/senses-daily";
import { SenseArchive } from "../../src/members/senses-archive";
import { cyclingSessions, dayStart, haversine, localDate, trackDistance, type ActivityLine, type GeofenceLine, type HealthLine,
  type LocationLine } from "../../src/members/senses-facts";
import { WorkMember } from "../../src/members/work";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter } from "../../src/world/router";

const zone = "Asia/Shanghai";
const midnight = Date.UTC(2026, 9, 4, 16); // 2026-10-05 00:00 in Shanghai
const at = (hour: number, minute = 0) => midnight + hour * 3_600_000 + minute * 60_000;
const fix = (ts: number, lat: number, extra: Partial<LocationLine> = {}): LocationLine =>
  ({ ts, source: "device:phone", batch_id: "l", lat, lon: 121.4, accuracy_m: 10, provider: "gps", ...extra });
const act = (ts_start: number, state: ActivityLine["state"], ts_end?: number): ActivityLine =>
  ({ ts: ts_start, source: "device:phone", batch_id: "a", ts_start, state, ...(ts_end === undefined ? {} : { ts_end }) });
const health = (ts: number, metric: string, value: number, source = "hc", unit = ""): HealthLine =>
  ({ ts, source, device: "device:phone", batch_id: "h", metric, value, unit });
const fence = (ts: number, name: string, transition: "enter" | "exit"): GeofenceLine => ({ ts, source: "device:phone", batch_id: `g${ts}`, name, transition });

test("local day bounds, distance and ride arithmetic", () => {
  assert.equal(dayStart("2026-10-05", zone), midnight);
  assert.equal(dayStart("2026-10-05", "UTC"), Date.UTC(2026, 9, 5));
  assert.equal(dayStart("2026-03-29", "Europe/Berlin"), Date.UTC(2026, 2, 28, 23), "a day starting before a DST change");
  assert.equal(dayStart("2026-03-30", "Europe/Berlin"), Date.UTC(2026, 2, 29, 22), "a day starting after a DST change");
  assert.equal(localDate(midnight - 1, zone), "2026-10-04");
  assert.equal(localDate(midnight, zone), "2026-10-05");
  assert.ok(Math.abs(haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }) - 111_195) < 1);
  // Mocked, inaccurate and teleporting fixes are not travel.
  const track = [fix(0, 31.2), fix(60_000, 31.2036), fix(90_000, 31.25, { is_mocked: true }), fix(100_000, 31.3, { accuracy_m: 500 }),
    fix(120_000, 31.2072), fix(150_000, 32.5), fix(180_000, 31.2108)];
  const metres = trackDistance(track, 0, 180_000)!;
  assert.ok(Math.abs(metres - 3 * 400.3) < 2, `metres ${metres}`);
  assert.equal(trackDistance([fix(0, 31.2)], 0, 1), null);
  assert.deepEqual(cyclingSessions([act(0, "cycling", 100), act(200, "cycling", 400), act(400 + 6 * 60_000, "cycling"), act(1_000_000, "still")]),
    [{ start: 0, end: 400 }, { start: 400 + 6 * 60_000, end: 1_000_000 }], "a short gap merges; a long one or another state splits");
  assert.deepEqual(cyclingSessions([act(0, "walking"), act(10, "cycling")]), [{ start: 10, end: null }]);
});

test("geofence time carries where the day began and closes at the horizon", () => {
  const day = [fence(at(8), "home", "exit"), fence(at(9), "office", "enter"), fence(at(18), "office", "exit"), fence(at(19), "home", "enter")];
  const before = [fence(at(-30), "home", "enter"), fence(at(-40), "gym", "enter"), fence(at(-39), "gym", "exit")];
  assert.deepEqual(geofenceTime(before, day, midnight, midnight + 86_400_000), {
    home: { inside_min: 8 * 60 + 5 * 60, enters: 1, exits: 1 }, office: { inside_min: 9 * 60, enters: 1, exits: 1 } });
  assert.deepEqual(geofenceTime(before, day, midnight, at(12)), {
    home: { inside_min: 8 * 60, enters: 0, exits: 1 }, office: { inside_min: 3 * 60, enters: 1, exits: 0 } }, "an unfinished day stops at its horizon");
});

test("daily summary: steps, distance by activity, rides, geofence time and latest health readings", () => {
  const rideFixes = Array.from({ length: 21 }, (_, i) => fix(at(8, 30 + i), 31.2 + i * 0.0036));
  const walkFixes = [fix(at(18), 31.3), fix(at(18, 10), 31.3036)];
  const summary = dailySummary("2026-10-05", zone, {
    location: [...rideFixes, ...walkFixes, fix(at(25), 40)],
    activity: [act(at(8, 30), "cycling"), act(at(8, 50), "still"), act(at(18), "walking", at(18, 10)), act(at(18, 10), "still")],
    health: [health(at(9), "steps", 1200, "hc"), health(at(20), "steps", 3000, "hc"), health(at(21), "steps", 3500, "watch"),
      health(at(7), "weight", 62, "scale", "kg"), health(at(22), "weight", 61.8, "scale", "kg"), health(at(23), "heart_rate", 64, "watch", "bpm"),
      health(at(-2), "weight", 63, "scale", "kg")],
    geofence: [fence(at(8, 20), "home", "exit"), fence(at(9), "office", "enter"), fence(at(17, 30), "office", "exit"), fence(at(18, 30), "home", "enter")],
  }, { activity: [act(at(-2), "still")], geofence: [fence(at(-3), "home", "enter")] });
  assert.equal(summary.date, "2026-10-05");
  assert.equal(summary.from, "2026-10-04T16:00:00.000Z");
  assert.equal(summary.to, "2026-10-05T16:00:00.000Z");
  assert.deepEqual(summary.counts, { location: 23, activity: 4, health: 6, geofence: 4 });
  assert.deepEqual(summary.steps, { total: 4200, by_source: { hc: 4200, watch: 3500 } });
  assert.deepEqual(Object.keys(summary.distance_m), ["cycling", "walking"]);
  assert.ok(Math.abs(summary.distance_m.cycling - 20 * 400.3) < 5, `cycling ${summary.distance_m.cycling}`);
  assert.ok(Math.abs(summary.distance_m.walking - 400.3) < 2);
  assert.deepEqual(summary.activity_min, { still: 24 * 60 - 20 - 10, walking: 10, cycling: 20 });
  assert.equal(summary.cycling.count, 1);
  assert.equal(summary.cycling.total_min, 20);
  assert.equal(summary.cycling.total_km, 8.01);
  assert.deepEqual(summary.cycling.sessions, [{ start: new Date(at(8, 30)).toISOString(), end: new Date(at(8, 50)).toISOString(), minutes: 20, km: 8.01 }]);
  assert.deepEqual(summary.geofences, { home: { inside_min: 8 * 60 + 20 + 5 * 60 + 30, enters: 1, exits: 1 },
    office: { inside_min: 8 * 60 + 30, enters: 1, exits: 1 } });
  assert.deepEqual(summary.health_latest, {
    heart_rate: { value: 64, unit: "bpm", at: new Date(at(23)).toISOString(), source: "watch" },
    weight: { value: 61.8, unit: "kg", at: new Date(at(22)).toISOString(), source: "scale" } });
  const empty = dailySummary("2026-10-05", zone, { location: [], activity: [], health: [], geofence: [] }, { activity: [], geofence: [] });
  assert.equal(empty.steps, null);
  assert.deepEqual(empty.cycling, { count: 0, total_min: 0, total_km: null, sessions: [] });
});

test("the daily flow writes each recent finished day with facts, rewrites only on change, and never wakes the mind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-senses-daily-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const sent: string[] = [];
  router.subscribe((message) => { if (message.kind === "request") sent.push(`${message.to}/${message.word}`); });
  const archive = new SenseArchive({ home, timeZone: zone });
  let now = at(24 + 9); // 2026-10-06 09:00 in Shanghai
  const work = new WorkMember({ ledger, router, isPaused: () => false, now: () => now, flows: [sensesDailyFlow(archive, () => now)] });
  members.register(work);
  const settled = async (count: number) => {
    for (let i = 0; i < 200; i++) {
      const runs = ledger.workRuns("senses-daily");
      if (runs.length === count && runs.every((run) => run.state !== "running")) return runs;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("daily run did not settle");
  };
  const file = (date: string) => join(home, "senses", `daily-${date}.json`);
  try {
    archive.record({ word: "sense.health", body: { batch_id: "h1", items: [{ ts: at(10), metric: "steps", value: 800, unit: "count", source: "hc" }] } });
    archive.record({ word: "sense.health", body: { batch_id: "h0", items: [{ ts: at(-14), metric: "steps", value: 50, unit: "count", source: "hc" }] } });
    archive.record({ word: "sense.health", body: { batch_id: "h-today", items: [{ ts: at(24 + 8), metric: "steps", value: 99, unit: "count", source: "hc" }] } });
    work.tick();
    assert.equal((await settled(1))[0].state, "done");
    assert.equal(JSON.parse(readFileSync(file("2026-10-05"), "utf8")).steps.total, 800);
    assert.equal(JSON.parse(readFileSync(file("2026-10-04"), "utf8")).steps.total, 50);
    assert.equal(existsSync(file("2026-10-03")), false, "a day without facts gets no file");
    assert.equal(existsSync(file("2026-10-06")), false, "today is not finished");
    // Same slot: no second run. Next day: yesterday's late batch lands; unchanged days are left alone.
    work.tick();
    assert.equal(ledger.workRuns("senses-daily").length, 1);
    now += 86_400_000;
    archive.record({ word: "sense.health", body: { batch_id: "h2", items: [{ ts: at(11), metric: "steps", value: 200, unit: "count", source: "hc" }] } });
    work.tick();
    assert.equal((await settled(2)).filter((run) => run.state === "done").length, 2);
    assert.equal(JSON.parse(readFileSync(file("2026-10-05"), "utf8")).steps.total, 1000);
    assert.equal(JSON.parse(readFileSync(file("2026-10-06"), "utf8")).steps.total, 99);
    now += 86_400_000 * 10;
    work.tick();
    assert.equal((await settled(3))[0].state, "no_change");
    assert.deepEqual(sent, [], "the summary uses no words: no model, no wake");
  } finally { work.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
