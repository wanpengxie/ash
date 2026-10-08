// 健康 (packages/apps/health): its logic with a fake Ash, its Ash client against a fake Ash MCP endpoint, and the
// bundled server the core installs, end to end over stdio.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
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
import { BUILTIN_APPS } from "../../core/src/apps/builtin.generated";
import { appCapabilities } from "../../core/src/apps/runtime";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../health/src");
// Plain ESM without type declarations: loaded by path so the checker treats them as untyped.
const load = async (name: string) => await import(join(src, name)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const DAY = 86_400_000;
// Monday 2026-10-05, 09:00 local time.
const MONDAY = new Date(2026, 9, 5, 9, 0, 0).getTime();

/** Phone rows like device:phone health.read returns them. */
function rows(now: number) {
  const at = (daysAgo: number, hour: number) => new Date(now - daysAgo * DAY).setHours(hour, 0, 0, 0);
  const out: Record<string, unknown>[] = [];
  for (let d = 0; d <= 14; d++) {
    out.push({ ts: at(d, 7), metric: "weight", value: 70 + (d === 0 ? 2 : 0) + d * 0.05, unit: "kg", source: "xiaomi_scale" });
    out.push({ ts: at(d, 10), metric: "steps", value: 3000, unit: "count", source: "health_connect:a" });
    out.push({ ts: at(d, 15), metric: "steps", value: 2000, unit: "count", source: "health_connect:a" });
    out.push({ ts: at(d, 15), metric: "steps", value: 4000, unit: "count", source: "gadgetbridge:watch" });
    out.push({ ts: at(d + 1, 23), ts_end: at(d, 5), metric: "sleep", value: d < 3 ? 330 : 420, unit: "min", source: "gadgetbridge:watch" });
    out.push({ ts: at(d, 4), metric: "heart_rate", value: 58 + d % 3, unit: "bpm", source: "gadgetbridge:watch" });
    out.push({ ts: at(d, 12), metric: "heart_rate", value: 90, unit: "bpm", source: "gadgetbridge:watch" });
  }
  return out;
}

function fakeAsh(now: number, options: { steps?: number; fail?: boolean } = {}) {
  const calls: { member: string; word: string; body: Record<string, unknown> }[] = [];
  const events: { name: string; body: Record<string, unknown> }[] = [];
  return { calls, events, ash: {
    async call(member: string, word: string, body: Record<string, unknown>) {
      calls.push({ member, word, body });
      if (options.fail) throw new Error("forbidden: not granted");
      if (word === "health.read") return { content: [{ type: "text", text: JSON.stringify({ rows: rows(now) }) }] };
      if (word === "sensors.steps") return { content: [{ type: "text", text: "{}" }], data: { steps_today: options.steps ?? 100, complete: true } };
      throw new Error("unexpected");
    },
    async event(name: string, body: Record<string, unknown>) { events.push({ name, body }); },
  } };
}

test("health tools: today, trend, log, goals and report from Ash's rows plus the app's own logs", async () => {
  const { Health, Store, dailySeries } = await load("logic.mjs");
  const now = MONDAY;
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ash-health-")), "data.json"));
  const fake = fakeAsh(now, { steps: 12000 });
  const health = new Health({ ash: fake.ash, store, now: () => now });

  // Steps: the source with the most per day (not added across sources); sleep counts on the day it ended; heart rate the lowest.
  const steps = dailySeries(rows(now), [], "steps", 3, now);
  assert.deepEqual(steps.map((point: { value: number }) => point.value), [5000, 5000, 5000]);
  assert.equal(dailySeries(rows(now), [], "sleep", 1, now)[0].value, 330);

  const today = await health.today();
  assert.equal(today.weight.value, 72);
  assert.equal(today.steps.value, 12000, "the phone's counter wins when it is ahead");
  assert.deepEqual([today.sleep.minutes, today.sleep.hours], [330, 5.5]);
  assert.equal(today.resting_heart_rate.value, 58);
  assert.deepEqual(fake.calls.map((call) => `${call.member}/${call.word}`), ["device:phone/health.read", "device:phone/sensors.steps"]);
  assert.deepEqual(fake.calls[0]!.body.metrics, ["weight", "steps", "sleep", "heart_rate"]);

  health.log("weight", 71.2, now - 1000);
  health.log("steps", 9999, now - 1000);
  assert.equal((await health.today()).weight.value, 71.2, "a manual weigh-in after the scale's is the latest");
  const trend = await health.trend("steps", 7);
  assert.equal(trend.points.length, 7);
  assert.equal(trend.points[6].value, 9999, "the owner's own number for a day is kept");
  assert.equal(trend.stats.max, 9999);
  assert.throws(() => health.log("mood", 1), /metric/);
  assert.throws(() => health.setGoal("resting_heart_rate", 50), /goals exist/);
  assert.deepEqual(health.setGoal("steps", 8000).goals, { steps: 8000 });
  assert.equal((await health.trend("steps", 7)).goal, 8000);
  assert.equal(JSON.parse(readFileSync(store.file, "utf8")).goals.steps, 8000);

  const report = await health.report(true);
  assert.equal(report.period, "week");
  assert.match(report.text, /日均步数/);
  assert.match(report.text, /平均睡眠/);
  assert.match(report.text, /体重/);

  // Without grants (or Ash offline) the tools still answer from the app's own data, saying what was missing.
  const offline = new Health({ ash: fakeAsh(now, { fail: true }).ash, store, now: () => now });
  const fallback = await offline.today();
  assert.equal(fallback.weight.value, 71.2);
  assert.deepEqual(fallback.errors, ["没读到，稍后再试"], "plain words for the owner, never a code");
  assert.deepEqual(fake.calls.filter((call) => call.word === "sensors.steps").length, 2, "the step counter is asked only when the phone answered");
});

test("when the phone's senses are away, today and trends show what Ash recorded (or what the app read last), with its time", async () => {
  const { Health, Store } = await load("logic.mjs");
  const now = MONDAY;
  // Ash's records stop at yesterday evening; the phone answers "no capability" while its senses helper restarts.
  const recorded = rows(now - DAY).map(({ ts_end: _end, ...row }) => row);
  const away = (recent: unknown) => ({ async call(_member: string, word: string) {
    throw Object.assign(new Error(`failed: the phone has no capability ${word}`), { code: "failed", ownerText: "感知暂时不在线，稍后再试", recent });
  }, async event() {} });
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ash-health-")), "data.json"));
  const recent = { as_of: Math.max(...recorded.map((row) => row.ts as number)), source: "Ash 的感知记录", rows: recorded };
  const today = await new Health({ ash: away(recent), store, now: () => now }).today();
  assert.deepEqual(today.errors, ["感知暂时不在线，稍后再试"]);
  assert.deepEqual(today.stale, { as_of: recent.as_of, source: "Ash 的感知记录" });
  assert.equal(today.weight.value, 72, "the latest weight Ash has");
  assert.equal(today.steps.value, 5000, "the latest day's steps instead of a blank");
  assert.equal(today.steps.date, "2026-10-04");
  assert.equal(typeof today.steps.at, "number");
  assert.equal(today.resting_heart_rate.value, 58);
  const trend = await new Health({ ash: away(recent), store, now: () => now }).trend("weight", 7);
  assert.equal(trend.stale.source, "Ash 的感知记录");
  assert.equal(trend.points.filter((point: { value: number | null }) => point.value !== null).length, 6);

  // Nothing recorded by Ash either: what this app read last time, marked as such.
  const fresh = new Store(join(mkdtempSync(join(tmpdir(), "ash-health-")), "data.json"));
  const before = await new Health({ ash: fakeAsh(now - 3600_000, { steps: 9321 }).ash, store: fresh, now: () => now - 3600_000 }).today();
  assert.equal(before.stale, null);
  const later = await new Health({ ash: away(undefined), store: fresh, now: () => now }).today();
  assert.deepEqual(later.stale, { as_of: now - 3600_000, source: "上次读到的" });
  assert.equal(later.steps.value, 9321);
  assert.deepEqual(later.errors, ["感知暂时不在线，稍后再试"]);
});

test("health weight keeps a scale's 0.05 kg and always shows one decimal", async () => {
  const { dailySeries, kg } = await load("logic.mjs");
  const reading = (value: number) => [{ ts: MONDAY - 1000, metric: "weight", value, unit: "kg", source: "xiaomi_scale" }];
  assert.equal(dailySeries(reading(71.95), [], "weight", 1, MONDAY)[0].value, 71.95);
  assert.equal(dailySeries(reading(71.954), [], "weight", 1, MONDAY)[0].value, 71.95);
  assert.deepEqual([kg(71.95), kg(72), kg(71.9), kg(70.25)], ["71.95", "72.0", "71.9", "70.25"]);
  // The screens format the same way.
  const shared = readFileSync(join(here, "../health/ui/shared.html"), "utf8");
  const window = { health: {} as { num?: (metric: string, value: number) => string } };
  const helper = shared.match(/const round = \(value, digits\) =>[^\n]*\n/)![0] + "window.health.num = " + shared.match(/num\(metric, value\) \{[\s\S]*?\n    \}/)![0].replace(/^num/, "function");
  new Function("window", helper)(window);
  assert.deepEqual([window.health.num!("weight", 71.95), window.health.num!("weight", 72), window.health.num!("sleep", 330), window.health.num!("steps", 8123.4)], ["71.95", "72.0", "5.5", "8123"]);
});

test("health alerts: weight change over 1.5 kg in 7 days, three short nights, and the Monday card, each once", async () => {
  const { Health, Store } = await load("logic.mjs");
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ash-health-")), "data.json"));
  const fake = fakeAsh(MONDAY);
  const health = new Health({ ash: fake.ash, store, now: () => MONDAY });
  assert.deepEqual(await health.check(), ["weight_jump", "short_sleep", "weekly_card"]);
  assert.deepEqual(fake.events.map((event) => [event.name, event.body.kind ?? event.body.title]),
    [["health.alert", "weight_jump"], ["health.alert", "short_sleep"], ["app.card", "上周健康小结"]]);
  assert.match(String(fake.events[2]!.body.text), /^2026-09-28 至 2026-10-04/);
  assert.deepEqual(await health.check(), [], "nothing twice on the same day");
  const tuesday = new Health({ ash: fakeAsh(MONDAY + DAY).ash, store, now: () => MONDAY + DAY });
  assert.ok(!(await tuesday.check()).includes("weekly_card"), "the card only on Monday");
});

test("the tools' MCP shapes map to ash capabilities with the intended risk; screens are self-contained MCP Apps HTML", async () => {
  const { TOOLS, RESOURCES, readResource, UI_MIME } = await load("tools.mjs");
  const caps = appCapabilities("健康", TOOLS);
  assert.deepEqual(caps.map((cap) => [cap.name, cap.effect]), [["health.today", "read"], ["health.trend", "read"], ["health.log", "write"],
    ["health.goal.set", "write"], ["health.report", "read"]]);
  assert.equal(caps[0]!.label, "在健康里看今日健康");
  const linked = TOOLS.filter((tool: { _meta?: { ui?: { resourceUri?: string } } }) => tool._meta?.ui?.resourceUri).map((tool: { _meta: { ui: { resourceUri: string } } }) => tool._meta.ui.resourceUri);
  assert.deepEqual(linked, ["ui://health/home", "ui://health/trends", "ui://health/goals"]);
  const ui = join(here, "../health/ui");
  const pages = Object.fromEntries(["shared", "home", "trends", "goals"].map((name) => [name, readFileSync(join(ui, `${name}.html`), "utf8")]));
  for (const resource of RESOURCES) {
    const read = readResource(resource.uri, pages).contents[0];
    assert.equal(read.mimeType, UI_MIME);
    assert.deepEqual(read._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.doesNotMatch(read.text, /(src|href)\s*=\s*["']?https?:/i, "no network resources");
    assert.match(read.text, /ui\/initialize/);
    assert.match(read.text, /tools\/call/);
  }
  assert.match(readResource("ui://health/trends", pages).contents[0].text, /<svg/);
});

/** A fake Ash endpoint: the same four tools ash gives an app, answering from a script. */
async function fakeAshEndpoint(token: string, now: number) {
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const http: HttpServer = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const server = new Server({ name: "ash", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const args = (call.params.arguments ?? {}) as Record<string, unknown>;
      seen.push({ name: call.params.name, args });
      let result: Record<string, unknown>;
      if (call.params.name === "capability_call" && args.word === "health.read") result = { ok: true, result: { content: [{ type: "text", text: JSON.stringify({ rows: rows(now) }) }] } };
      else if (call.params.name === "capability_call") result = { ok: false, error: { code: "forbidden", message: "not granted", owner_text: "安装时没有批准这一项，用不了" } };
      else result = { ok: true, result: { recorded: true } };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, seen, close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); }) };
}

test("the Ash client speaks MCP to the endpoint ash gives the app, with its token", async () => {
  const { ashClient } = await load("ash.mjs");
  const endpoint = await fakeAshEndpoint("secret-token", Date.now());
  try {
    const ash = ashClient(endpoint.url, "secret-token");
    const read = await ash.call("device:phone", "health.read", { metrics: ["weight"] });
    assert.ok(Array.isArray(read.content));
    await assert.rejects(ash.call("device:phone", "sensors.steps", {}), /forbidden/);
    await ash.event("app.card", { title: "上周健康小结", text: "x" });
    assert.deepEqual(endpoint.seen.map((item) => item.name), ["capability_call", "capability_call", "ash_event"]);
    await assert.rejects(ashClient(endpoint.url, "wrong").call("device:phone", "health.read", {}));
  } finally { await endpoint.close(); }
});

test("the bundled server the core installs runs over stdio: tools, a call through Ash, and its screens", async () => {
  const app = BUILTIN_APPS.find((item) => item.id === "health")!;
  const dir = mkdtempSync(join(tmpdir(), "ash-health-app-"));
  for (const [name, text] of Object.entries(app.files)) writeFileSync(join(dir, name), text);
  assert.deepEqual(JSON.parse(app.files["app.json"]!), JSON.parse(readFileSync(join(here, "../health/app.json"), "utf8")), "the bundle carries the current app.json");
  const endpoint = await fakeAshEndpoint("t0ken", Date.now());
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, "server.mjs")], cwd: dir, stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", ASH_APP_ID: "health", ASH_APP_DIR: dir, ASH_MCP_URL: endpoint.url, ASH_MCP_TOKEN: "t0ken" } }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(tools, ["health.today", "health.trend", "health.log", "health.goal.set", "health.report"]);
    const today = await client.callTool({ name: "health.today", arguments: {} });
    const data = today.structuredContent as { weight: { value: number }; errors: string[] };
    assert.equal(typeof data.weight.value, "number");
    assert.deepEqual(data.errors, ["安装时没有批准这一项，用不了"], "Ash's sentence for the owner, not a code");
    const logged = await client.callTool({ name: "health.log", arguments: { metric: "weight", value: 70.5 } });
    assert.equal(logged.isError, undefined);
    assert.equal(JSON.parse(readFileSync(join(dir, "data.json"), "utf8")).logs[0].value, 70.5, "its data lives in ASH_APP_DIR");
    const bad = await client.callTool({ name: "health.goal.set", arguments: { metric: "mood", target: 1 } });
    assert.equal(bad.isError, true);
    const resources = (await client.listResources()).resources.map((item) => [item.uri, item.mimeType]);
    assert.deepEqual(resources.map(([uri]) => uri), ["ui://health/home", "ui://health/trends", "ui://health/goals"]);
    const home = await client.readResource({ uri: "ui://health/home" });
    assert.match(String((home.contents[0] as { text: string }).text), /今日/);
  } finally { await client.close(); await endpoint.close(); }
});
