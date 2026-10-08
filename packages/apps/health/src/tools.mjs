// The five tools and three screens of 健康, as MCP shapes. Screens follow MCP Apps: ui:// resources of type
// text/html;profile=mcp-app, linked from tools through _meta.ui.resourceUri.
import { GOAL_METRICS, METRICS, kg } from "./logic.mjs";

export const UI_MIME = "text/html;profile=mcp-app";
const metric = { type: "string", enum: Object.keys(METRICS), description: "weight (kg), steps, sleep (minutes) or resting_heart_rate (bpm)" };
export const TOOLS = [
  { name: "health.today", title: "看今日健康", description: "Today's overview: latest weight, steps today, last night's sleep, resting heart rate, and goals.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
    _meta: { ui: { resourceUri: "ui://health/home" } } },
  { name: "health.trend", title: "看健康趋势", description: "One metric per day over the last N days (default 7, at most 90), with min, max, average and change.",
    inputSchema: { type: "object", properties: { metric, days: { type: "integer", minimum: 1, maximum: 90 } }, required: ["metric"], additionalProperties: false },
    annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://health/trends" } } },
  { name: "health.log", title: "记一条健康数据", description: "Record one value by hand (weight in kg, steps, sleep in minutes, resting heart rate in bpm), now or at ts (epoch ms or ISO date).",
    inputSchema: { type: "object", properties: { metric, value: { type: "number", minimum: 0 }, ts: { anyOf: [{ type: "number" }, { type: "string" }] } }, required: ["metric", "value"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: "health.goal.set", title: "设健康目标", description: "Set a goal: target weight (kg), daily steps, or nightly sleep (minutes).",
    inputSchema: { type: "object", properties: { metric: { type: "string", enum: GOAL_METRICS }, target: { type: "number", exclusiveMinimum: 0 } }, required: ["metric", "target"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false }, _meta: { ui: { resourceUri: "ui://health/goals" } } },
  { name: "health.card", title: "画今日健康卡片", description: "The home-screen card (A2UI): today's weight and steps, with a button that opens the trends. Ash calls it to redraw the card.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "health.report", title: "看健康周报", description: "The last 7 days in a few numbers and one paragraph, against the week before.",
    inputSchema: { type: "object", properties: { period: { type: "string", enum: ["week"] } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
];

export const RESOURCES = [
  { uri: "ui://health/home", name: "今日", mimeType: UI_MIME },
  { uri: "ui://health/trends", name: "趋势", mimeType: UI_MIME },
  { uri: "ui://health/goals", name: "目标", mimeType: UI_MIME },
];

const ok = (data, text) => ({ content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data });
const failed = (message) => ({ content: [{ type: "text", text: message }], isError: true });

export async function callTool(health, name, args) {
  try {
    switch (name) {
      case "health.today": return ok(await health.today());
      case "health.trend": return ok(await health.trend(String(args.metric ?? ""), args.days === undefined ? 7 : Number(args.days)));
      case "health.log": return ok({ logged: health.log(String(args.metric ?? ""), args.value, args.ts) });
      case "health.goal.set": return ok(health.setGoal(String(args.metric ?? ""), args.target));
      case "health.report": { const report = await health.report(true); return ok(report, report.text); }
      case "health.card": return ok(todayCard(await health.today()));
      default: return failed(`unknown tool ${name}`);
    }
  } catch (error) { return failed(error instanceof Error ? error.message : String(error)); }
}

/**
 * The home-screen card (app.json cards "today"): weight and steps from health.today, a step goal bar, and 「看趋势」 that
 * opens the trends page. Old numbers (the phone could not answer) say when they are from.
 */
export function todayCard(today) {
  const w = today.weight, s = today.steps;
  const day = (item) => !item ? "" : item.date === today.date && !today.stale ? "今天" : item.date ? item.date.slice(5) : "";
  const stepsSub = s && s.goal ? `目标 ${s.goal}` : day(s);
  const components = [
    { id: "root", component: "Column", children: ["head", "nums", "foot"], action: { openApp: { app: "health" } } },
    { id: "head", component: "Row", align: "center", children: ["icon", "title"] },
    { id: "icon", component: "Icon", name: "heart", style: { color: "red" } },
    { id: "title", component: "Text", text: "今日健康", variant: "h5", style: { margin: [0, 0, 0, 6] } },
    { id: "nums", component: "Row", children: ["weight", "steps"], style: { margin: [6, 0, 6, 0] } },
    { id: "weight", component: "Column", weight: 1, children: ["wl", "wv", "ws"] },
    { id: "wl", component: "Text", text: "体重", variant: "caption" },
    { id: "wv", component: "Text", text: w ? `${kg(w.value)} kg` : "—", variant: "h3" },
    { id: "ws", component: "Text", text: w ? day(w) : "还没有记录", variant: "caption" },
    { id: "steps", component: "Column", weight: 1, children: ["sl", "sv", ...(s && s.goal ? ["sb"] : []), "ss"] },
    { id: "sl", component: "Text", text: "步数", variant: "caption" },
    { id: "sv", component: "Text", text: s ? String(s.value) : "—", variant: "h3" },
    ...(s && s.goal ? [{ id: "sb", component: "ProgressBar", value: Math.min(s.value, s.goal), max: s.goal }] : []),
    { id: "ss", component: "Text", text: stepsSub || " ", variant: "caption" },
    { id: "foot", component: "Row", align: "center", children: ["note", "open"] },
    { id: "note", component: "Text", weight: 1, variant: "caption", style: { maxLines: 1, ellipsize: "end" },
      text: today.stale ? "手机暂时没读到，显示的是之前的记录" : today.errors?.length ? today.errors[0] : " " },
    { id: "open", component: "Button", child: "open_label", variant: "primary", action: { openApp: { app: "health", surface: "trends" } } },
    { id: "open_label", component: "Text", text: "看趋势" },
  ];
  return { components };
}

/** pages: { shared, home, trends, goals } HTML fragments; every screen is one self-contained page, no network. */
export function page(pages, id) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">` +
    `<title>健康</title>${pages.shared}</head><body data-screen="${id}">${pages[id]}</body></html>`;
}

export function readResource(uri, pages) {
  const id = { "ui://health/home": "home", "ui://health/trends": "trends", "ui://health/goals": "goals" }[uri];
  if (!id) throw new Error(`unknown resource ${uri}`);
  return { contents: [{ uri, mimeType: UI_MIME, text: page(pages, id), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
}
