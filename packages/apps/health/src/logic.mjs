// 健康 — the app's logic, free of MCP: reads the owner's health data through Ash (device:phone, within the grants
// the owner gave at install), keeps its own logs and goals in data.json, and decides alerts and the weekly card.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const METRICS = {
  weight: { label: "体重", unit: "kg", phone: "weight" },
  steps: { label: "步数", unit: "步", phone: "steps" },
  sleep: { label: "睡眠", unit: "分钟", phone: "sleep" },
  resting_heart_rate: { label: "静息心率", unit: "次/分", phone: "heart_rate" },
};
export const GOAL_METRICS = ["weight", "steps", "sleep"];
const DAY = 24 * 60 * 60 * 1000;

/** The local calendar day of a time, as YYYY-MM-DD. */
export const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
/** A scale reads to 0.05 kg: keep two decimals, and always show at least one (71.95 → "71.95", 72 → "72.0"). */
export const kg = (value) => { const v = round(value, 2); return v.toFixed(Number.isInteger(round(v * 10, 6)) ? 1 : 2); };
const signedKg = (value) => `${value >= 0 ? "+" : "-"}${kg(Math.abs(value))}`;

/** The app's own data: manual logs, goals, and what it already told Ash. */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { logs: [], goals: {}, sent: {} };
    try { if (existsSync(file)) this.data = { ...this.data, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* start fresh, keep the bad file aside */ }
  }
  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 1));
    renameSync(temp, this.file);
  }
  log(metric, value, ts) {
    const entry = { metric, value, ts, source: "manual" };
    this.data.logs.push(entry);
    this.data.logs = this.data.logs.slice(-5000);
    this.save();
    return entry;
  }
  setGoal(metric, target) { this.data.goals[metric] = target; this.save(); return { ...this.data.goals }; }
  sent(key) { return this.data.sent[key]; }
  markSent(key, value) { this.data.sent[key] = value; this.save(); }
}

/** A device:phone result ({content, data?}) as its JSON object. */
export function phoneJson(result) {
  if (result && typeof result === "object" && result.data && typeof result.data === "object") return result.data;
  const text = Array.isArray(result?.content) ? result.content.find((item) => item?.type === "text")?.text : typeof result?.content === "string" ? result.content : undefined;
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/** One value per day from readings: weight the last, steps and sleep the largest source's total, heart rate the lowest. */
export function dailySeries(rows, logs, metric, days, now) {
  const phone = METRICS[metric].phone;
  const first = startOfDay(now) - (days - 1) * DAY;
  const keys = Array.from({ length: days }, (_, i) => dayKey(first + i * DAY + DAY / 2));
  const byDay = new Map(keys.map((key) => [key, []]));
  for (const row of rows) {
    if (row?.metric !== phone || typeof row.value !== "number") continue;
    const at = metric === "sleep" && typeof row.ts_end === "number" ? row.ts_end : row.ts;
    byDay.get(dayKey(at))?.push({ ts: at, value: row.value, source: String(row.source ?? "phone") });
  }
  const manual = new Map();
  for (const log of logs) if (log.metric === metric) {
    if (metric === "weight") byDay.get(dayKey(log.ts))?.push({ ts: log.ts, value: log.value, source: "manual" });
    else if (byDay.has(dayKey(log.ts))) manual.set(dayKey(log.ts), log.value);
  }
  return keys.map((date) => {
    if (manual.has(date)) return { date, value: manual.get(date) };
    const list = byDay.get(date);
    if (!list.length) return { date, value: null };
    if (metric === "weight") return { date, value: round(list.reduce((a, b) => (b.ts >= a.ts ? b : a)).value, 2) };
    if (metric === "resting_heart_rate") return { date, value: Math.round(Math.min(...list.map((item) => item.value))) };
    const totals = new Map();
    for (const item of list) totals.set(item.source, (totals.get(item.source) ?? 0) + item.value);
    return { date, value: Math.round(Math.max(...totals.values())) };
  });
}

const values = (series) => series.map((point) => point.value).filter((value) => typeof value === "number");
const average = (list) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
const hours = (minutes) => round(minutes / 60, 1);

export class Health {
  /** ash: { call(member, word, body) → result, event(name, body) }; store: Store. */
  constructor({ ash, store, now = Date.now }) { this.ash = ash; this.store = store; this.now = now; }

  async readings(days) {
    const now = this.now();
    try {
      const result = phoneJson(await this.ash.call("device:phone", "health.read", { metrics: ["weight", "steps", "sleep", "heart_rate"],
        from: new Date(startOfDay(now) - (days - 1) * DAY).toISOString(), to: new Date(now).toISOString(), max_rows: 20000 }));
      return { rows: Array.isArray(result.rows) ? result.rows : [], errors: result.source_errors ? [JSON.stringify(result.source_errors).slice(0, 200)] : [] };
    } catch (error) { return { rows: [], errors: [`health.read: ${error instanceof Error ? error.message : error}`.slice(0, 200)] }; }
  }

  series(rows, metric, days) { return dailySeries(rows, this.store.data.logs, metric, days, this.now()); }

  async today() {
    const now = this.now();
    const { rows, errors } = await this.readings(8);
    const last = (metric) => { const s = this.series(rows, metric, 8); return s[s.length - 1].value; };
    const weightSeries = this.series(rows, "weight", 8).filter((point) => point.value !== null);
    let steps = last("steps");
    try {
      const counter = phoneJson(await this.ash.call("device:phone", "sensors.steps", {}));
      if (typeof counter.steps_today === "number" && (steps === null || counter.steps_today > steps)) steps = counter.steps_today;
    } catch (error) { errors.push(`sensors.steps: ${error instanceof Error ? error.message : error}`.slice(0, 200)); }
    const sleep = last("sleep");
    const goals = { ...this.store.data.goals };
    const weight = weightSeries.length ? weightSeries[weightSeries.length - 1] : null;
    return { date: dayKey(now),
      weight: weight ? { value: weight.value, date: weight.date, goal: goals.weight ?? null } : null,
      steps: steps === null ? null : { value: steps, goal: goals.steps ?? null },
      sleep: sleep === null ? null : { minutes: sleep, hours: hours(sleep), goal: goals.sleep ?? null },
      resting_heart_rate: last("resting_heart_rate") === null ? null : { value: last("resting_heart_rate") },
      goals, errors };
  }

  async trend(metric, days = 7) {
    if (!METRICS[metric]) throw new Error(`metric must be one of ${Object.keys(METRICS).join(", ")}`);
    const span = Math.max(1, Math.min(90, Math.trunc(days)));
    const { rows, errors } = await this.readings(span);
    const points = this.series(rows, metric, span);
    const list = values(points);
    const known = points.filter((point) => point.value !== null);
    return { metric, label: METRICS[metric].label, unit: METRICS[metric].unit, days: span, points,
      stats: list.length ? { min: Math.min(...list), max: Math.max(...list), avg: round(average(list), metric === "weight" ? 2 : 1),
        change: known.length > 1 ? round(known[known.length - 1].value - known[0].value, metric === "weight" ? 2 : 1) : 0 } : null,
      goal: this.store.data.goals[metric] ?? null, errors };
  }

  log(metric, value, ts) {
    if (!METRICS[metric]) throw new Error(`metric must be one of ${Object.keys(METRICS).join(", ")}`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative number");
    const at = ts === undefined ? this.now() : typeof ts === "number" ? ts : Date.parse(ts);
    if (!Number.isFinite(at)) throw new Error("ts must be epoch ms or an ISO date");
    return this.store.log(metric, value, at);
  }

  setGoal(metric, target) {
    if (!GOAL_METRICS.includes(metric)) throw new Error(`goals exist for ${GOAL_METRICS.join(", ")}`);
    if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) throw new Error("target must be a positive number");
    return { goals: this.store.setGoal(metric, target) };
  }

  /** A week in a few numbers and one paragraph: the 7 days ending today, or ending yesterday (endToday=false), against the 7 before. */
  async report(endToday = true) {
    const { rows, errors } = await this.readings(endToday ? 14 : 15);
    const take = (metric) => {
      const all = this.series(rows, metric, endToday ? 14 : 15).slice(0, 14);
      return { before: all.slice(0, 7), week: all.slice(7) };
    };
    const metrics = {};
    const lines = [];
    const steps = take("steps"), sleep = take("sleep"), weight = take("weight"), rhr = take("resting_heart_rate");
    const stepsAvg = average(values(steps.week)), stepsBefore = average(values(steps.before));
    if (stepsAvg !== null) { metrics.steps = { avg: Math.round(stepsAvg), before: stepsBefore === null ? null : Math.round(stepsBefore) };
      lines.push(`日均步数 ${Math.round(stepsAvg)}${stepsBefore ? `（前一周 ${Math.round(stepsBefore)}）` : ""}`); }
    const sleepAvg = average(values(sleep.week));
    if (sleepAvg !== null) { const short = values(sleep.week).filter((value) => value < 360).length;
      metrics.sleep = { avg_hours: hours(sleepAvg), nights_under_6h: short };
      lines.push(`平均睡眠 ${hours(sleepAvg)} 小时${short ? `，${short} 晚不足 6 小时` : ""}`); }
    const weights = weight.week.filter((point) => point.value !== null);
    if (weights.length) { const change = weights.length > 1 ? round(weights[weights.length - 1].value - weights[0].value, 2) : 0;
      metrics.weight = { latest: weights[weights.length - 1].value, change };
      lines.push(`体重 ${kg(weights[weights.length - 1].value)} kg${weights.length > 1 ? `（本周 ${signedKg(change)} kg）` : ""}`); }
    const rhrAvg = average(values(rhr.week));
    if (rhrAvg !== null) { metrics.resting_heart_rate = { avg: Math.round(rhrAvg) }; lines.push(`静息心率约 ${Math.round(rhrAvg)} 次/分`); }
    const week = steps.week;
    return { period: "week", from: week[0].date, to: week[week.length - 1].date, metrics,
      text: lines.length ? `${week[0].date} 至 ${week[week.length - 1].date}：${lines.join("；")}。` : "这一周没有读到健康数据。", errors };
  }

  /** Alerts and the Monday card; each sent at most once (per day for alerts, per week for the card). */
  async check() {
    const now = this.now();
    const today = dayKey(now);
    const sent = [];
    const { rows } = await this.readings(8);
    const weights = this.series(rows, "weight", 7).filter((point) => point.value !== null);
    if (weights.length > 1) {
      const change = round(weights[weights.length - 1].value - weights[0].value, 2);
      if (Math.abs(change) > 1.5 && this.store.sent("weight_jump") !== today) {
        await this.emit("health.alert", { kind: "weight_jump", title: "体重变化较大", text: `近 7 天体重${change > 0 ? "上升" : "下降"} ${kg(Math.abs(change))} kg（${kg(weights[0].value)} → ${kg(weights[weights.length - 1].value)} kg）。` });
        this.store.markSent("weight_jump", today); sent.push("weight_jump");
      }
    }
    const nights = this.series(rows, "sleep", 3).map((point) => point.value);
    if (nights.every((value) => typeof value === "number" && value < 360) && this.store.sent("short_sleep") !== today) {
      await this.emit("health.alert", { kind: "short_sleep", title: "连续睡眠不足", text: `最近三晚睡眠 ${nights.map((value) => hours(value)).join("、")} 小时，都不足 6 小时。` });
      this.store.markSent("short_sleep", today); sent.push("short_sleep");
    }
    const week = `week-of-${today}`;
    if (new Date(now).getDay() === 1 && this.store.sent("weekly_card") !== week) {
      const report = await this.report(false);
      await this.emit("app.card", { title: "上周健康小结", text: report.text.slice(0, 200) });
      this.store.markSent("weekly_card", week); sent.push("weekly_card");
    }
    return sent;
  }

  async emit(name, body) { try { await this.ash.event(name, body); } catch { /* Ash decides; a refused event is not retried today */ } }
}
