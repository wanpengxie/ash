import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { SenseArchive } from "../../src/members/senses-archive";
import { SensesMember } from "../../src/members/senses";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "device:phone",
  local: true, remote: false, ownerProxy: false };
const day = Date.UTC(2026, 9, 6, 2); // 2026-10-06 10:00 in Shanghai
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const point = (ts: number) => ({ ts, lat: 31.2, lon: 121.4, accuracy_m: 10, provider: "fused" });

test("archive appends one line per item with time and source, splits by local month, and never writes a batch twice", () => {
  const home = mkdtempSync(join(tmpdir(), "ash-sense-archive-"));
  try {
    const archive = new SenseArchive({ home, timeZone: "Asia/Shanghai" });
    const location = { word: "sense.location", body: { batch_id: "b1", items: [point(day), { ...point(day + 60_000), is_mocked: true }] } };
    assert.equal(archive.record(location), 2);
    assert.equal(archive.record(location), 0, "a repeated batch is skipped");
    const file = join(home, "senses", "location-2026-10.jsonl");
    assert.deepEqual(lines(file), [
      { ts: day, source: "device:phone", batch_id: "b1", lat: 31.2, lon: 121.4, accuracy_m: 10, provider: "fused" },
      { ts: day + 60_000, source: "device:phone", batch_id: "b1", lat: 31.2, lon: 121.4, accuracy_m: 10, provider: "fused", is_mocked: true },
    ]);
    // 2026-09-30 17:00 UTC is already October 1st in Shanghai; 16:59 is still September.
    const edge = { word: "sense.location", body: { batch_id: "b2", items: [point(Date.UTC(2026, 8, 30, 15, 59)), point(Date.UTC(2026, 8, 30, 16, 1))] } };
    assert.equal(archive.record(edge), 2);
    assert.equal(lines(join(home, "senses", "location-2026-09.jsonl")).length, 1);
    assert.equal(lines(file).length, 3);
    assert.equal(archive.record(edge), 0);

    // A fresh process rebuilds its view from the files; a line torn by a crash is skipped and the next batch starts a new line.
    appendFileSync(file, '{"ts":1,"source":"device:phone","batch_id":"torn"');
    const reopened = new SenseArchive({ home, timeZone: "Asia/Shanghai" });
    assert.equal(reopened.record(location), 0);
    assert.equal(reopened.record({ word: "sense.location", body: { batch_id: "b3", items: [point(day + 120_000)] } }), 1);
    assert.equal(reopened.lines("location", Date.UTC(2026, 8, 1), Date.UTC(2026, 10, 1)).length, 5);
    assert.equal(reopened.lines("location", day, day + 60_000).length, 1, "range is [from, to)");

    assert.equal(reopened.record({ word: "sense.health", body: { batch_id: "h1", items: [{ ts: day, metric: "weight", value: 61.5, unit: "kg", source: "scale.app" }] } }), 1);
    assert.deepEqual(lines(join(home, "senses", "health-2026-10.jsonl")), [
      { ts: day, source: "scale.app", device: "device:phone", batch_id: "h1", metric: "weight", value: 61.5, unit: "kg" }]);
    assert.equal(reopened.record({ word: "sense.activity", body: { batch_id: "a1", items: [{ ts_start: day, state: "cycling" }] } }), 1);
    assert.deepEqual(lines(join(home, "senses", "activity-2026-10.jsonl")), [
      { ts: day, source: "device:phone", batch_id: "a1", ts_start: day, state: "cycling" }]);
    const crossing = { word: "sense.geofence", body: { name: "home", transition: "exit", ts: day } };
    assert.equal(reopened.record(crossing), 1);
    assert.equal(reopened.record(crossing), 0, "a geofence crossing is identified by its content");
    assert.equal(lines(join(home, "senses", "geofence-2026-10.jsonl"))[0].name, "home");
    assert.equal(reopened.record({ word: "sense.screen", body: { state: "on", away_ms: 0 } }), 0);

    assert.equal(reopened.writeDaily("2026-10-05", { a: 1 }), true);
    assert.equal(reopened.writeDaily("2026-10-05", { a: 1 }), false, "unchanged summary is not rewritten");
    assert.equal(JSON.parse(reopened.readDaily("2026-10-05")!).a, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("archive refuses a senses directory that is an alias for somewhere else", () => {
  const root = mkdtempSync(join(tmpdir(), "ash-sense-alias-"));
  try {
    const home = join(root, "home"), elsewhere = join(root, "elsewhere");
    mkdirSync(home); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(home, "senses"));
    const archive = new SenseArchive({ home, timeZone: "UTC" });
    assert.throws(() => archive.record({ word: "sense.location", body: { batch_id: "b1", items: [point(day)] } }));
    assert.equal(existsSync(join(elsewhere, "location-2026-10.jsonl")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("phone batches reach the archive through the router; a paused Ash archives and wakes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-sense-route-"));
  const home = join(dir, "home"); mkdirSync(home);
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const wakes: string[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!], handle(message) { wakes.push(String(message.body.reason)); return { ok: true, result: { accepted: true } }; } });
  let paused = false;
  const archive = new SenseArchive({ home, timeZone: "UTC" });
  const senses = new SensesMember({ router, heartbeat: async () => "", isPaused: () => paused, opener: () => {}, proactive: () => {}, archive, now: () => day });
  members.register(senses);
  const file = join(home, "senses", "location-2026-10.jsonl");
  try {
    const body = { batch_id: "b1", items: [point(day)] };
    await router.send(phone, { to: null, kind: "event", word: "sense.location", body, client_id: "loc:b1" });
    // Same batch under another delivery key: a second ledger row, still one archived copy.
    await router.send(phone, { to: null, kind: "event", word: "sense.location", body, client_id: "loc:b1:again" });
    assert.equal(lines(file).length, 1);
    paused = true;
    await router.send(phone, { to: null, kind: "event", word: "sense.location", body: { batch_id: "b2", items: [point(day + 1)] } });
    await router.send(phone, { to: null, kind: "event", word: "sense.geofence", body: { name: "home", transition: "exit", ts: day } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(lines(file).length, 1);
    assert.equal(existsSync(join(home, "senses", "geofence-2026-10.jsonl")), false);
    assert.deepEqual(wakes, []);
    assert.equal(ledger.list({ limit: 100 }).filter((message) => message.from === "device:phone").length, 4, "paused senses are still recorded");
  } finally { senses.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
