// What ash already has when the phone cannot answer: device:phone health.read from the senses archive (the readings the
// phone pushed earlier, senses/health-YYYY-MM.jsonl). Only ever offered to an app already granted that very word.
import type { RecentFacts } from "./bridge";

interface HealthArchive { lines(kind: "health", from: number, to: number): { ts: number; metric: string; value: number; unit: string; source: string }[] }

const DAY = 86_400_000;
const time = (value: unknown, fallback: number) => {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : fallback;
};

export function recentFacts(archive: () => HealthArchive | null, now: () => number = Date.now): RecentFacts {
  return (member, word, body) => {
    const store = archive();
    if (!store || member !== "device:phone" || word !== "health.read") return null;
    const to = time(body.to, now()) + 1;
    const from = Math.max(time(body.from, to - 7 * DAY), to - 92 * DAY);
    const metrics = Array.isArray(body.metrics) ? new Set(body.metrics.filter((item): item is string => typeof item === "string")) : null;
    const max = typeof body.max_rows === "number" && body.max_rows > 0 ? Math.min(body.max_rows, 20_000) : 20_000;
    const rows = store.lines("health", from, to).filter((line) => !metrics || metrics.has(line.metric))
      .map(({ ts, metric, value, unit, source }) => ({ ts, metric, value, unit, source })).slice(-max);
    if (!rows.length) return null;
    return { as_of: rows.reduce((latest, row) => Math.max(latest, row.ts), 0), source: "Ash 的感知记录", rows };
  };
}
