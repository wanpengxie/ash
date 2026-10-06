import type { WorkFlow } from "../members/work";
import type { SenseArchive } from "../members/senses-archive";
import { activityTimeline, cyclingSessions, dayStart, hops, localDate, nextDate, segmentEnd, trackDistance, type GeofenceLine,
  type SenseLines } from "../members/senses-facts";
import { ACTIVITY_STATES } from "../../../sdk/src/words";

export interface DailySummary {
  date: string;
  time_zone: string;
  from: string;
  to: string;
  /** Lines of each kind inside the day. */
  counts: Record<keyof SenseLines, number>;
  /** Steps per source; the total is the largest source, since two sources usually count the same steps. */
  steps: { total: number; by_source: Record<string, number> } | null;
  /** Track length attributed to the activity in force at the middle of each hop; "unknown" when none was reported. */
  distance_m: Record<string, number>;
  activity_min: Record<string, number>;
  cycling: { count: number; total_min: number; total_km: number | null; sessions: { start: string; end: string; minutes: number; km: number | null }[] };
  geofences: Record<string, { inside_min: number; enters: number; exits: number }>;
  /** The latest reading of every other health metric in the day. */
  health_latest: Record<string, { value: number; unit: string; at: string; source: string }>;
}

const round = (value: number, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;
const iso = (at: number) => new Date(at).toISOString();

/** Minutes inside each geofence during [from, until); `before` is the history that says where the day began. */
export function geofenceTime(before: readonly GeofenceLine[], day: readonly GeofenceLine[], from: number, until: number): DailySummary["geofences"] {
  const inside = new Map<string, number>();
  const out: DailySummary["geofences"] = {};
  const entry = (name: string) => out[name] ??= { inside_min: 0, enters: 0, exits: 0 };
  const ms = new Map<string, number>();
  for (const event of [...before].sort((a, b) => a.ts - b.ts)) {
    if (event.ts >= from) continue;
    if (event.transition === "enter") inside.set(event.name, from); else inside.delete(event.name);
  }
  for (const name of inside.keys()) entry(name);
  for (const event of [...day].sort((a, b) => a.ts - b.ts)) {
    if (event.ts < from || event.ts >= until) continue;
    const stats = entry(event.name);
    if (event.transition === "enter") {
      stats.enters++;
      if (!inside.has(event.name)) inside.set(event.name, event.ts);
    } else {
      stats.exits++;
      const since = inside.get(event.name);
      if (since !== undefined) ms.set(event.name, (ms.get(event.name) ?? 0) + event.ts - since);
      inside.delete(event.name);
    }
  }
  for (const [name, since] of inside) ms.set(name, (ms.get(name) ?? 0) + Math.max(0, until - since));
  for (const [name, total] of ms) entry(name).inside_min = round(total / 60_000);
  return out;
}

/**
 * Per-day totals from archived lines. `lines` holds the day itself; `history` holds what came before
 * (activity to know the state at midnight, geofences to know where the day began). `until` caps an unfinished day.
 */
export function dailySummary(date: string, timeZone: string, lines: SenseLines, history: Pick<SenseLines, "activity" | "geofence">, until?: number): DailySummary {
  const from = dayStart(date, timeZone), to = dayStart(nextDate(date), timeZone), end = Math.min(to, until ?? to);
  const within = <T extends { ts: number }>(items: readonly T[]) => items.filter((item) => item.ts >= from && item.ts < to);
  const location = within(lines.location), health = within(lines.health), geofence = within(lines.geofence);
  const timeline = activityTimeline([...history.activity, ...lines.activity]);

  const stateAt = (at: number): string => {
    for (let i = timeline.length - 1; i >= 0; i--) if (timeline[i].ts_start <= at) return at < segmentEnd(timeline, i, end) ? timeline[i].state : "unknown";
    return "unknown";
  };
  const activityMs = new Map<string, number>();
  timeline.forEach((segment, i) => {
    const overlap = Math.min(segmentEnd(timeline, i, end), end) - Math.max(segment.ts_start, from);
    if (overlap > 0) activityMs.set(segment.state, (activityMs.get(segment.state) ?? 0) + overlap);
  });
  const distance = new Map<string, number>();
  for (const hop of hops(location)) {
    const state = stateAt((hop.from + hop.to) / 2);
    distance.set(state, (distance.get(state) ?? 0) + hop.metres);
  }

  const stepsBySource = new Map<string, number>();
  const latest = new Map<string, (typeof health)[number]>();
  for (const item of health) {
    if (item.metric === "steps") { stepsBySource.set(item.source, (stepsBySource.get(item.source) ?? 0) + item.value); continue; }
    const prior = latest.get(item.metric);
    if (!prior || item.ts >= prior.ts) latest.set(item.metric, item);
  }

  const rides = cyclingSessions(timeline).filter((ride) => ride.start >= from && ride.start < to)
    .map((ride) => ({ start: ride.start, end: Math.max(ride.start, Math.min(ride.end ?? end, end)) }))
    .map((ride) => ({ ...ride, metres: trackDistance(location, ride.start, ride.end) }));
  const rideMetres = rides.filter((ride) => ride.metres !== null);

  const sorted = <V>(map: Map<string, V>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    date, time_zone: timeZone, from: iso(from), to: iso(to),
    counts: { location: location.length, activity: timeline.filter((segment) => segment.ts_start >= from && segment.ts_start < to).length,
      health: health.length, geofence: geofence.length },
    steps: stepsBySource.size ? { total: round(Math.max(...stepsBySource.values())), by_source: Object.fromEntries(sorted(stepsBySource).map(([key, value]) => [key, round(value)])) } : null,
    distance_m: Object.fromEntries(sorted(distance).map(([key, value]) => [key, round(value)])),
    activity_min: Object.fromEntries(ACTIVITY_STATES.filter((state) => activityMs.has(state)).map((state) => [state, round(activityMs.get(state)! / 60_000)])),
    cycling: {
      count: rides.length,
      total_min: round(rides.reduce((sum, ride) => sum + ride.end - ride.start, 0) / 60_000),
      total_km: rideMetres.length ? round(rideMetres.reduce((sum, ride) => sum + ride.metres!, 0) / 1000, 2) : null,
      sessions: rides.map((ride) => ({ start: iso(ride.start), end: iso(ride.end), minutes: round((ride.end - ride.start) / 60_000),
        km: ride.metres === null ? null : round(ride.metres / 1000, 2) })),
    },
    geofences: geofenceTime(history.geofence, geofence, from, end),
    health_latest: Object.fromEntries(sorted(latest).map(([metric, item]) => [metric, { value: item.value, unit: item.unit, at: iso(item.ts), source: item.source }])),
  };
}

/** How many finished days each run recomputes, so a late batch still lands in its day's summary. */
export const DAILY_DAYS = 3;
/** History read before a day: enough to know an open geofence or the state at midnight. */
const HISTORY_MS = 31 * 86_400_000;

/** Write senses/daily-<date>.json for each recent finished day that has any facts. Pure code; never wakes the mind. */
export function sensesDailyFlow(archive: SenseArchive, now: () => number = Date.now): WorkFlow {
  return { name: "senses-daily", triggers: ["hourly"], periodMinutes: 1440, async execute(ctx) {
    const written = await ctx.step("summarize", () => {
      const zone = archive.timeZone;
      let date = localDate(now(), zone);
      const dates: string[] = [];
      for (let i = 0; i < DAILY_DAYS; i++) {
        date = localDate(dayStart(date, zone) - 1, zone);
        dates.unshift(date);
      }
      let count = 0;
      for (const day of dates) {
        const from = dayStart(day, zone), to = dayStart(nextDate(day), zone);
        const lines: SenseLines = { location: archive.lines("location", from, to), activity: archive.lines("activity", from, to),
          health: archive.lines("health", from, to), geofence: archive.lines("geofence", from, to) };
        if (!lines.location.length && !lines.activity.length && !lines.health.length && !lines.geofence.length) continue;
        const history = { activity: archive.lines("activity", from - 86_400_000, from), geofence: archive.lines("geofence", from - HISTORY_MS, from) };
        if (archive.writeDaily(day, dailySummary(day, zone, lines, history))) count++;
      }
      return count;
    });
    return written ? "done" : "no_change";
  } };
}
