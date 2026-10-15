// 她的状态 (packages/apps/vitals): the lamp and the readings from a fake hub, the card against the card checker, the manifest,
// and the bundled server over stdio.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { checkManifest } from "../../core/src/edges/apps/check";
import { validateCard } from "../../sdk/src/card";
import { INVARIANTS as HUB_INVARIANTS } from "../../core/src/services/health/budgets";
import { bundleApp } from "../bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../vitals/src");
const load = async (name: string) => await import(join(src, name)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const copy = JSON.parse(readFileSync(join(here, "../../../design/vitals/copy.json"), "utf8"));
const MIN = 60_000, DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 12, 14, 2, 0);

const INVARIANTS = ["idle.msg_rate", "idle.msg_key_rate", "idle.ledger_growth", "idle.cpu", "link.reconnect_storm", "errors.rate", "errors.internal", "loop.lag"];
const budgets: Record<string, number> = { "idle.msg_rate": 30, "idle.msg_key_rate": 6, "idle.ledger_growth": 10, "idle.cpu": 5, "link.reconnect_storm": 5, "errors.rate": 20, "errors.internal": 5, "loop.lag": 200 };

interface World {
  down?: boolean; paused?: boolean; idle?: boolean; uptime_s?: number; broken?: Record<string, { value: number; since: number }>; events?: any[]; minutes?: any[];
  checkup?: any; devices?: any[]; turns?: number; usage?: any; calls?: [string, string, any][]; unmeasured?: boolean;
}
const minutesRows = (n: number, o: Partial<Record<string, number>> = {}) => Array.from({ length: n }, (_, i) => ({ at: NOW - (i + 1) * MIN, idle: true, msg: 8, ledger: 0, err: 0, link_opens: 0, cpu_pct: 2, rss_mb: 186, lag_p99_ms: 3, top: [], ...o }));
function fakeAsh(w: World) {
  return {
    async call(member: string, word: string, body: any) {
      w.calls?.push([member, word, body]);
      const data = (d: unknown) => ({ data: d });
      switch (`${member}/${word}`) {
        case "service:health/status":
          if (w.down) throw new Error("offline");
          return data({ now: NOW, uptime_s: w.uptime_s ?? 86_400, idle: w.idle ?? true, window_s: 60, rates: {}, top: [], proc: { cpu_pct: 2.4, rss_mb: 186.2, heap_mb: 40, lag_p99_ms: 3 },
            invariants: INVARIANTS.map((id) => ({ id, ok: !w.broken?.[id], value: w.unmeasured && !w.broken?.[id] && id.startsWith("idle.") ? null : w.broken?.[id]?.value ?? 1, budget: budgets[id], ...(w.broken?.[id] ? { since: w.broken[id].since } : {}) })), last_events: [] });
        case "service:health/recent": return data(body.kind === "minute" ? { minutes: w.minutes ?? minutesRows(120) } : { events: w.events ?? [] });
        case "service:admin/status": return data({ now: NOW, paused: Boolean(w.paused), time_zone: "UTC", hands_online: 2 });
        case "service:admin/checkup": return data(w.checkup ?? { known: false });
        case "service:devices/list": return data({ devices: w.devices ?? [] });
        case "service:history/activity.count": return data({ total_count: w.turns ?? 12 });
        case "service:cost/usage.get": return data(w.usage ?? { periods: { today: { calls: 86, cost_usd: 0.5 } }, by_day: [{ date: "2026-10-12", cost_usd: 0.5 }, { date: "2026-10-11", cost_usd: 0.3 }] });
        case "service:host/restart": return data({ restarting: true });
        default: throw new Error(`unexpected ${member}/${word}`);
      }
    },
  };
}
async function make(w: World) {
  const { Vitals, Store } = await load("logic.mjs");
  return new Vitals({ ash: fakeAsh(w), store: new Store(join(mkdtempSync(join(tmpdir(), "ash-vitals-")), "data.json")), now: () => NOW });
}

test("the lamp: ok, busy, new, paused, the brain not answering", async () => {
  assert.deepEqual(pick(await (await make({})).status()), { lamp: "ok", say: { id: "ok" }, stale: false });
  assert.equal((await (await make({ idle: false })).status()).busy_what, null, "no source for what she is busy with yet");
  assert.deepEqual(pick(await (await make({ idle: false })).status()), { lamp: "ok", say: { id: "ok_busy" }, stale: false });
  assert.deepEqual(pick(await (await make({ uptime_s: 20, minutes: [] })).status()), { lamp: "new", say: { id: "new" }, stale: false });
  assert.deepEqual(pick(await (await make({ paused: true })).status()), { lamp: "paused", say: { id: "paused" }, stale: false });
  const down = await (await make({ down: true })).status();
  assert.deepEqual(pick(down), { lamp: "err", say: { id: "err_brain_down" }, stale: true });
  assert.equal(down.vitals, null);
  const empty = await (async () => { const { Vitals, Store } = await load("logic.mjs"); return new Vitals({ ash: { call: async () => ({}) }, store: new Store(join(mkdtempSync(join(tmpdir(), "v-")), "d.json")), now: () => NOW }).status(); })();
  assert.deepEqual(pick(empty), { lamp: "err", say: { id: "err_brain_down" }, stale: true }, "an empty answer is no answer");
});
const pick = (s: any) => ({ lamp: s.lamp, say: s.say, stale: s.stale });

test("a budget broken now is err and says its own sentence, the most important first; its alert is live with minutes and the value", async () => {
  const since = NOW - 6 * MIN;
  const s = await (await make({ broken: { "loop.lag": { value: 400, since: NOW - MIN }, "idle.msg_rate": { value: 2640, since } }, idle: true })).status();
  assert.equal(s.lamp, "err");
  assert.equal(s.say.id, "idle.msg_rate", "priority decides: the loop before the lag");
  assert.deepEqual(s.primary_alert, { id: "idle.msg_rate", since });
  assert.deepEqual(s.alerts.map((a: any) => [a.id, a.state, a.minutes, a.value]), [["idle.msg_rate", "live", 6, 2640], ["loop.lag", "live", 1, 400]]);
  assert.equal(s.rules.find((r: any) => r.id === "idle.msg_rate").state, "err");
  assert.equal(copy.invariants[s.say.id].say, "我在空转，可能很费电");
});

test("a breach that is over: warn for an hour, one alert whose end and peak come from its ok; two events of one breach are one alert", async () => {
  const since = NOW - 20 * MIN;
  const events = [
    { at: NOW - 15 * MIN, type: "ok", id: "idle.cpu", since, peak: 38 },
    { at: NOW - 19 * MIN, type: "breach", id: "idle.cpu", value: 22, budget: 5, since, top: [], idle: true },
  ];
  const s = await (await make({ events })).status();
  assert.equal(s.lamp, "warn");
  assert.equal(s.say.id, "warn_recovered");
  assert.deepEqual(s.alerts.map((a: any) => [a.id, a.state, a.since, a.ended, a.minutes, a.value, a.budget]), [["idle.cpu", "recovered", since, NOW - 15 * MIN, 5, 38, 5]]);
  const lag = await (await make({ events: [{ at: NOW - 10 * MIN, type: "breach", id: "loop.lag", value: 400, budget: 200, since: NOW - 11 * MIN }] })).status();
  assert.equal(lag.say.id, "warn_recovered_lag");
  const old = await (await make({ events: [{ at: NOW - 3 * 3_600_000, type: "breach", id: "loop.lag", value: 400, budget: 200, since: NOW - 3 * 3_600_000 }] })).status();
  assert.equal(old.lamp, "ok", "after an hour it is only in the list");
  assert.equal(old.alerts.length, 1);
});

test("a hand that reconnects: the alert names the device, the sentence has its name", async () => {
  const since = NOW - 4 * MIN;
  const hand = "A".repeat(22);
  const events = [{ at: NOW - 3 * MIN, type: "breach", id: "link.reconnect_storm", value: 9, budget: 5, since, top: [{ key: `open:${hand}`, n: 9 }] }];
  const s = await (await make({ broken: { "link.reconnect_storm": { value: 9, since } }, events, devices: [{ device: `device:${hand}`, name: "办公室的 Mac" }] })).status();
  assert.deepEqual(s.alerts[0].device, { id: `device:${hand}`, name: "办公室的 Mac" });
  assert.deepEqual(s.say, { id: "link.reconnect_storm", args: { device: "办公室的 Mac" } });
  const nameless = await (await make({ broken: { "link.reconnect_storm": { value: 9, since } }, events })).status();
  assert.equal(nameless.alerts[0].device.name, copy.unknown_device);
});

test("the hands and eyes: the phone's counts pass through; todo makes the lamp warn; before the phone reported, there is no checkup block", async () => {
  const groups = [{ id: "brain", title: "大脑", todo: 0, optional: false, text: "在运行" }, { id: "alarm", title: "闹钟", todo: 2, optional: false, text: "可能晚几分钟" }];
  const s = await (await make({ checkup: { known: true, todo: 2, groups, at: NOW - MIN, device: "device:x" } })).status();
  assert.deepEqual([s.lamp, s.say, s.checkup.todo, s.checkup.groups], ["warn", { id: "warn_hands", args: { n: 2 } }, 2, groups]);
  const none = await (await make({})).status();
  assert.equal(none.checkup.known, false);
  assert.equal(none.lamp, "ok");
});

test("rules: a rule that counts only when idle is busy while she works, and waits while there is nothing to see", async () => {
  const s = await (await make({ idle: false })).status();
  assert.equal(s.rules.find((r: any) => r.id === "idle.cpu").state, "ok");
  const busy = fakeAsh({ idle: false });
  const wait = await (async () => { const { Vitals, Store } = await load("logic.mjs"); const ash = { call: async (m: string, w: string, b: unknown) => { const r = await busy.call(m, w, b); return w === "status" && m === "service:health" ? { data: { ...(r.data as any), invariants: (r.data as any).invariants.map((i: any) => ({ ...i, value: null })) } } : r; } }; return new Vitals({ ash, store: new Store(join(mkdtempSync(join(tmpdir(), "v-")), "d.json")), now: () => NOW }).status(); })();
  assert.equal(wait.rules.find((r: any) => r.id === "idle.cpu").state, "busy");
  assert.equal(wait.rules.find((r: any) => r.id === "loop.lag").state, "wait");
});

test("today and the last 24 hours", async () => {
  const rows = [...minutesRows(150, { link_opens: 1, err: 1 })];
  const d = await (await make({ minutes: rows, turns: 12 })).day();
  assert.equal(d.today.turns, 12);
  assert.equal(d.today.calls, 86);
  assert.equal(d.today.cost_cny, 3.37);
  assert.equal(d.today.errors, 150);
  assert.equal(d.today.reconnects, 150);
  assert.equal(d.has_data, true);
  assert.equal(d.hours.length, 24);
  assert.equal(d.hours[23].at, Date.UTC(2026, 9, 12, 14));
  assert.ok(d.hours[22].act > 0 && d.hours[22].cpu_pct === 2);
  assert.equal(d.hours[0].act, 0);
  assert.equal(d.hours[0].cpu_pct, null);
  const before = await (await make({ minutes: [{ ...minutesRows(1)[0], link_opens: undefined }], turns: 3 })).day();
  assert.equal(before.today.reconnects, null, "rows from before the counter: a dash, not a zero");
  assert.equal(before.has_data, false);
  const nothing = await (await make({ down: true, minutes: [] })).day();
  assert.equal(nothing.today.errors, 0);
});

test("the hub is asked once for a read the page repeats; restart asks the host only when confirmed", async () => {
  const calls: [string, string, any][] = [];
  const v = await make({ calls });
  await v.status(); await v.status(); await v.status();
  assert.equal(calls.filter(([m, w]) => m === "service:health" && w === "status").length, 1);
  await assert.rejects(v.restart(undefined), /confirmed/);
  assert.equal(calls.some(([, w]) => w === "restart"), false);
  assert.deepEqual(await v.restart(true), { restarting: true });
  assert.deepEqual(calls.at(-1)!.slice(0, 2), ["service:host", "restart"]);
});

test("the card is what the card checker accepts, in every state, with the texts of the copy table", async () => {
  const since = NOW - 6 * MIN;
  const worlds: [string, World][] = [
    ["ok", {}],
    ["live", { broken: { "idle.msg_rate": { value: 2640, since } }, events: [{ at: NOW - 5 * MIN, type: "breach", id: "idle.msg_rate", value: 2000, budget: 30, since }], idle: true }],
    ["recovered", { events: [{ at: NOW - 15 * MIN, type: "ok", id: "idle.cpu", since: NOW - 20 * MIN, peak: 38 }, { at: NOW - 19 * MIN, type: "breach", id: "idle.cpu", value: 22, budget: 5, since: NOW - 20 * MIN }] }],
    ["down", { down: true, minutes: [] }],
    ["young", { uptime_s: 10, minutes: [] }],
  ];
  for (const [name, w] of worlds) {
    const { a2ui } = await (await make(w)).card();
    const render = validateCard(a2ui);
    assert.equal(render.sizes!.length, 3, name);
    assert.ok(render.components.some((c) => c.component === "Chart"), name);
  }
  const live = validateCard((await (await make(worlds[1]![1])).card()).a2ui);
  const texts = live.components.map((c) => c.text).filter((t): t is string => typeof t === "string");
  assert.ok(texts.includes("我在空转，可能很费电"), "the lamp's sentence, from the table");
  assert.ok(texts.some((t) => /^13:56 起 · 闲着时消息不停来回，已经 6 分钟$/.test(t)), "the long alert");
  assert.ok(texts.includes("2"), "CPU now");
});

test("the example cards of the design pass the card checker", () => {
  const dir = join(here, "../../../design/vitals/card/examples");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  assert.deepEqual(files.sort(), ["err.json", "ok.json", "warn.json"]);
  for (const file of files) assert.ok(validateCard(JSON.parse(readFileSync(join(dir, file), "utf8"))).components.length > 20, file);
});

test("the manifest, the bundle and the server over stdio", async () => {
  const text = readFileSync(join(here, "../vitals/app.json"), "utf8");
  const checked = checkManifest(text, "vitals");
  assert.deepEqual(checked.problems.filter((problem: { level: string }) => problem.level === "error"), []);
  const app = await bundleApp(join(here, "../vitals"));
  assert.deepEqual(Object.keys(app).sort(), ["app.json", "icon.svg", "server.mjs"]);
  const dir = mkdtempSync(join(tmpdir(), "ash-vitals-app-"));
  for (const [name, body] of Object.entries(app)) writeFileSync(join(dir, name), body as string);
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, "server.mjs")], cwd: dir, stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", ASH_APP_ID: "vitals", ASH_APP_DIR: dir, ASH_TRIAL: "1" } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["vitals.status", "vitals.day", "vitals.restart", "vitals.card"]);
    assert.deepEqual((await client.listResources()).resources.map((item) => item.uri), ["ui://vitals/home", "ui://vitals/alert"]);
    const home = await client.readResource({ uri: "ui://vitals/home" });
    assert.match(String((home.contents[0] as { text: string }).text), /Content-Security-Policy/, "the app puts the policy in");
    const refused = await client.callTool({ name: "vitals.restart", arguments: {} });
    assert.equal(refused.isError, true);
  } finally { await client.close(); }
});

test("the chart geometry the page draws is the one in chart/vectors.json (the phone's AshChart is held to the same file)", async () => {
  const { layout, chartSvg } = await import(join(here, "../../../design/vitals/chart/chart.mjs")) as any;
  const vectors = JSON.parse(readFileSync(join(here, "../../../design/vitals/chart/vectors.json"), "utf8")) as { name: string; w: number; h: number; chart: unknown; expect: any[] }[];
  assert.equal(vectors.length, 9);
  const near = (a: unknown, b: unknown, at: string): void => {
    if (typeof a === "number" && typeof b === "number") return assert.ok(Math.abs(a - b) <= 0.05, `${at}: ${a} vs ${b}`);
    if (Array.isArray(a) && Array.isArray(b)) { assert.equal(a.length, b.length, at); return a.forEach((x, i) => near(x, b[i], `${at}[${i}]`)); }
    if (a && b && typeof a === "object" && typeof b === "object") { assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), at); return Object.keys(a).forEach((k) => near((a as any)[k], (b as any)[k], `${at}.${k}`)); }
    assert.equal(a, b, at);
  };
  for (const v of vectors) {
    near(JSON.parse(JSON.stringify(layout(v.chart, v.w, v.h))), v.expect, v.name);
    assert.match(chartSvg(v.chart, v.w, v.h), /^<svg /, v.name);
  }
});

test("a series with min puts the bottom of its axis there: top = max ?? max(floor, min + (largest - min) x 1.25), values below min on the bottom", async () => {
  const { scaleMax, scaleMin, layout } = await import(join(here, "../../../design/vitals/chart/chart.mjs")) as any;
  assert.equal(scaleMin({ values: [1] }), 0);
  assert.equal(scaleMax({ values: [20] }), 25, "without min nothing changes");
  assert.equal(scaleMax({ values: [0, 0] }), 1);
  assert.equal(scaleMax({ values: [60, 62], min: 58 }), 63);
  assert.equal(scaleMax({ values: [60, 62], min: 58, floor: 70 }), 70);
  assert.equal(scaleMax({ values: [60, 62], min: 58, max: 65 }), 65);
  assert.equal(scaleMax({ values: [50, 52], min: 58 }), 59, "nothing above min: a span of 1");
  const [low, high] = layout({ series: [{ type: "bars", values: [40, 63], color: "x", min: 58 }], gap: 0 }, 20, 30);
  assert.equal(low.h, 2, "below min sits on the bottom (the shortest bar)");
  assert.equal(high.h, 24, "axis 58 .. 64.25: 63 is 5 of 6.25 up");
  const line = layout({ series: [{ type: "line", values: [58, 63], color: "x", min: 58, dot: false }] }, 10, 30)[0];
  assert.deepEqual(line.points, [[0, 28], [10, 7.2]], "min on the bottom pad; 63 is 0.8 of the way up the 26 between the pads");
});

test("through the real Ash client and the hub's bridge shape (a word's data comes back as `result`, not wrapped), the status reads", async () => {
  const { ashClient } = await load("ash.mjs");
  const { Vitals, Store } = await load("logic.mjs");
  // what the app bridge answers (edges/apps/bridge.ts): { ok: true, result: <the word's data> }
  const answers: Record<string, unknown> = {
    "service:health/status": { now: NOW, uptime_s: 3600, idle: true, window_s: 60, proc: { cpu_pct: 2, rss_mb: 186, heap_mb: 90, lag_p99_ms: 12 },
      invariants: INVARIANTS.map((id) => ({ id, ok: true, value: 1, budget: budgets[id] })) },
    "service:health/recent": { events: [] },
    "service:admin/status": { hands_online: 2, paused: false },
    "service:admin/checkup": { known: false },
  };
  const http = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const server = new Server({ name: "ash", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const a = (call.params.arguments ?? {}) as { member?: string; word?: string };
      const result = { ok: true, result: answers[`${a.member}/${a.word}`] ?? {} };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const dir = mkdtempSync(join(tmpdir(), "ash-vitals-"));
    const vitals = new Vitals({ ash: ashClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, "t"), store: new Store(join(dir, "data.json")), now: () => NOW });
    const status = await vitals.status();
    assert.equal(status.stale, false, "a word that answered is not 'the brain is down'");
    assert.equal(status.lamp, "ok");
    assert.deepEqual(status.vitals, { cpu_pct: 2, rss_mb: 186, lag_p99_ms: 12, idle: true });
    assert.equal(status.hands_online, 2);
    assert.equal(status.rules.length, 8);
  } finally { http.close(); http.closeAllConnections(); }
});

test("every budget the hub keeps has its words in the copy table, its place in the rules and in the priority", () => {
  for (const { id } of HUB_INVARIANTS) {
    assert.ok(copy.invariants[id], `${id} has no entry in copy.invariants`);
    assert.ok(copy.rules.some((rule: { ids: string[] }) => rule.ids.includes(id)), `${id} is in no rule group`);
    assert.ok(copy.priority.includes(id), `${id} is not in the priority`);
  }
});

test("while she is busy the idle-only checks show their last reading, marked busy; before any reading there is nothing to show", async () => {
  const w: World = {};
  const v = await make(w);
  await v.status();                                  // idle: every check read
  w.idle = false; w.unmeasured = true;
  v.cache.clear();
  const busy = await v.status();
  const row = (id: string) => busy.rules.find((r: any) => r.id === id);
  assert.deepEqual([row("idle.msg_rate").state, row("idle.msg_rate").value], ["busy", 1]);
  assert.deepEqual([row("loop.lag").state, row("loop.lag").value], ["ok", 1], "the checks that are always measured are as they are");
  const first = await (await make({ idle: false, unmeasured: true })).status();
  assert.deepEqual([first.rules.find((r: any) => r.id === "idle.cpu").state, first.rules.find((r: any) => r.id === "idle.cpu").value], ["busy", null]);
});
