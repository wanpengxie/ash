import { createHash } from "node:crypto";
import type { Message } from "../../../sdk/src/api";
import { ACTIVITY_STATES } from "../../../sdk/src/words";

/** Pure sensing arithmetic shared by the wake rules and the daily summary. No I/O, no model. */
export type SenseKind = "location" | "activity" | "health" | "geofence";
export type ActivityState = typeof ACTIVITY_STATES[number];
export const SENSE_KINDS: readonly SenseKind[] = ["location", "activity", "health", "geofence"];
export const PHONE = "device:phone";

export interface LocationLine { ts: number; source: string; batch_id: string; lat: number; lon: number; accuracy_m: number; provider: string; is_mocked?: boolean }
export interface ActivityLine { ts: number; source: string; batch_id: string; ts_start: number; ts_end?: number; state: ActivityState }
export interface HealthLine { ts: number; source: string; device: string; batch_id: string; metric: string; value: number; unit: string }
export interface GeofenceLine { ts: number; source: string; batch_id: string; name: string; transition: "enter" | "exit" }
export interface SenseLines { location: LocationLine[]; activity: ActivityLine[]; health: HealthLine[]; geofence: GeofenceLine[] }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown): value is string => typeof value === "string";
const isState = (value: unknown): value is ActivityState => (ACTIVITY_STATES as readonly unknown[]).includes(value);

/** A geofence event carries no batch id; its content is its identity. */
export function geofenceKey(body: { name: string; transition: string; ts: number }): string {
  return `gf_${createHash("sha256").update(JSON.stringify([body.name, body.transition, body.ts])).digest("hex").slice(0, 32)}`;
}

/** The archive lines of one validated phone sense event, each with its timestamp and source; null for other words. */
export function senseLines(message: Pick<Message, "word" | "body">): { kind: SenseKind; batch: string; lines: (LocationLine | ActivityLine | HealthLine | GeofenceLine)[] } | null {
  const body = message.body as Record<string, unknown>;
  const items = Array.isArray(body.items) ? body.items as Record<string, unknown>[] : [];
  const batch = String(body.batch_id ?? "");
  switch (message.word) {
    case "sense.location": return { kind: "location", batch, lines: items.map((item) => ({ ts: item.ts as number, source: PHONE, batch_id: batch,
      lat: item.lat as number, lon: item.lon as number, accuracy_m: item.accuracy_m as number, provider: item.provider as string,
      ...(typeof item.is_mocked === "boolean" ? { is_mocked: item.is_mocked } : {}) })) };
    case "sense.activity": return { kind: "activity", batch, lines: items.map((item) => ({ ts: item.ts_start as number, source: PHONE, batch_id: batch,
      ts_start: item.ts_start as number, ...(typeof item.ts_end === "number" ? { ts_end: item.ts_end } : {}), state: item.state as ActivityState })) };
    case "sense.health": return { kind: "health", batch, lines: items.map((item) => ({ ts: item.ts as number, source: item.source as string, device: PHONE,
      batch_id: batch, metric: item.metric as string, value: item.value as number, unit: item.unit as string })) };
    case "sense.geofence": {
      const event = { name: body.name as string, transition: body.transition as "enter" | "exit", ts: body.ts as number };
      const key = geofenceKey(event);
      return { kind: "geofence", batch: key, lines: [{ ts: event.ts, source: PHONE, batch_id: key, name: event.name, transition: event.transition }] };
    }
    default: return null;
  }
}

/** Reads one archived line back; anything torn or foreign is dropped rather than trusted. */
export function parseLine(kind: SenseKind, raw: string): LocationLine | ActivityLine | HealthLine | GeofenceLine | null {
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value) || !finite(value.ts) || !text(value.source) || !text(value.batch_id)) return null;
  switch (kind) {
    case "location": return finite(value.lat) && finite(value.lon) && finite(value.accuracy_m) && text(value.provider) ? value as unknown as LocationLine : null;
    case "activity": return finite(value.ts_start) && isState(value.state) && (value.ts_end === undefined || finite(value.ts_end)) ? value as unknown as ActivityLine : null;
    case "health": return text(value.metric) && finite(value.value) && text(value.unit) ? value as unknown as HealthLine : null;
    case "geofence": return text(value.name) && (value.transition === "enter" || value.transition === "exit") ? value as unknown as GeofenceLine : null;
  }
}

/** Great-circle distance in metres. */
export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points worth measuring with: real fixes of useful accuracy, one per instant, in time order. */
export const MAX_ACCURACY_M = 100;
/** A hop faster than this between two fixes is a glitch, not travel. */
export const MAX_SPEED_MPS = 70;
/** Two fixes further apart than this did not measure the way between them (the phone samples at least every 30 minutes). */
export const MAX_HOP_MS = 35 * 60_000;
export function usablePoints(points: readonly LocationLine[]): LocationLine[] {
  const byTs = new Map<number, LocationLine>();
  for (const point of points) if (point.is_mocked !== true && point.accuracy_m <= MAX_ACCURACY_M) {
    const prior = byTs.get(point.ts);
    if (!prior || point.accuracy_m < prior.accuracy_m) byTs.set(point.ts, point);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Each measurable hop between consecutive usable points. */
export function hops(points: readonly LocationLine[]): { from: number; to: number; metres: number }[] {
  const usable = usablePoints(points);
  const out: { from: number; to: number; metres: number }[] = [];
  let prior = usable[0];
  for (const point of usable.slice(1)) {
    const metres = haversine(prior, point), seconds = (point.ts - prior.ts) / 1000;
    if (seconds * 1000 > MAX_HOP_MS) { prior = point; continue; }
    if (metres / seconds > MAX_SPEED_MPS) continue; // the glitch is dropped; the next fix is measured from the last good one
    out.push({ from: prior.ts, to: point.ts, metres });
    prior = point;
  }
  return out;
}

/** Track length between two instants; null when fewer than two usable fixes fall inside. */
export function trackDistance(points: readonly LocationLine[], from: number, to: number): number | null {
  const inside = points.filter((point) => point.ts >= from && point.ts <= to);
  if (usablePoints(inside).length < 2) return null;
  return hops(inside).reduce((sum, hop) => sum + hop.metres, 0);
}

export interface Segment { ts_start: number; ts_end?: number; state: ActivityState }
/** One segment per start instant (a closed report supersedes an open one), in time order. */
export function activityTimeline(lines: readonly Segment[]): Segment[] {
  const byStart = new Map<number, Segment>();
  for (const line of lines) {
    const prior = byStart.get(line.ts_start);
    if (!prior || prior.ts_end === undefined || (line.ts_end !== undefined && line.state === prior.state))
      byStart.set(line.ts_start, { ts_start: line.ts_start, ...(line.ts_end !== undefined ? { ts_end: line.ts_end } : {}), state: line.state });
  }
  return [...byStart.values()].sort((a, b) => a.ts_start - b.ts_start);
}

/** Where a segment stops: its own end, else the next segment's start, else the horizon. */
export function segmentEnd(timeline: readonly Segment[], index: number, horizon: number): number {
  const segment = timeline[index];
  const end = segment.ts_end ?? timeline[index + 1]?.ts_start ?? horizon;
  return Math.max(segment.ts_start, end);
}

/** Two cycling reports this close together are one ride. */
export const RIDE_GAP_MS = 5 * 60_000;
export interface Ride { start: number; end: number | null }
/** Rides from the activity timeline: consecutive cycling segments merge across a short gap; any other state ends a ride. */
export function cyclingSessions(timeline: readonly Segment[]): Ride[] {
  const rides: Ride[] = [];
  let current: Ride | null = null;
  for (const segment of timeline) {
    if (segment.state === "cycling") {
      if (current && (current.end === null || segment.ts_start - current.end <= RIDE_GAP_MS)) {
        current.end = segment.ts_end === undefined ? null : Math.max(current.end ?? segment.ts_end, segment.ts_end);
        continue;
      }
      if (current) rides.push(current);
      current = { start: segment.ts_start, end: segment.ts_end ?? null };
    } else if (current) {
      if (current.end === null) current.end = Math.max(current.start, segment.ts_start);
      rides.push(current); current = null;
    }
  }
  if (current) rides.push(current);
  return rides;
}

/** Only these phone facts are worth a model turn. */
export type WakeKind = "geofence_enter" | "geofence_exit" | "cycling_start" | "cycling_end" | "health_source_stale";
/** bucket: what the ten-minute limit counts (default: the kind). */
export interface SenseWake { kind: WakeKind; key: string; context: Record<string, unknown>; bucket?: string }
/** A fact older than this is archived only: waking for it would be news about the past. */
export const WAKE_FRESH_MS = 30 * 60_000;
/** The same kind of wake at most once in this window. */
export const WAKE_INTERVAL_MS = 10 * 60_000;
const iso = (at: number) => new Date(at).toISOString();

export function geofenceWake(event: { name: string; transition: "enter" | "exit"; ts: number }, now: number): SenseWake | null {
  if (now - event.ts > WAKE_FRESH_MS || event.ts - now > WAKE_FRESH_MS) return null;
  return { kind: event.transition === "enter" ? "geofence_enter" : "geofence_exit", key: geofenceKey(event),
    context: { place: event.name, transition: event.transition, at: iso(event.ts), summary: `${event.transition === "enter" ? "到达" : "离开"}${event.name}` } };
}

/** A notice older than this is not worth a turn: the source has likely been looked at, or come back, since. */
export const SOURCE_WAKE_FRESH_MS = 24 * 3_600_000;

/**
 * A health source that stopped bringing new readings (the phone says so once per stop): one wake, so the owner can be
 * told. Its coming back is recorded only.
 */
export function sourceWake(event: { source: string; state: "stale" | "fresh"; ts: number; stale_hours: number; summary: string; last_data_ts?: number },
  now: number): SenseWake | null {
  if (event.state !== "stale" || Math.abs(now - event.ts) > SOURCE_WAKE_FRESH_MS) return null;
  return { kind: "health_source_stale", key: `source_stale:${event.source}:${event.last_data_ts ?? "none"}`, bucket: `health_source_stale:${event.source}`,
    context: { source: event.source, stale_hours: event.stale_hours, ...(event.last_data_ts === undefined ? {} : { last_data_at: iso(event.last_data_ts) }),
      summary: event.summary } };
}

/**
 * Ride starts and ends touched by one activity batch. An open ride that started recently wakes once at its start;
 * a ride that ended recently wakes once at its end, with its duration and, when the archived fixes allow, its distance.
 */
export function cyclingWakes(batch: readonly Segment[], timeline: readonly Segment[], points: readonly LocationLine[], now: number): SenseWake[] {
  if (!batch.length) return [];
  const low = Math.min(...batch.map((item) => item.ts_start)), high = Math.max(...batch.map((item) => item.ts_end ?? item.ts_start));
  const wakes: SenseWake[] = [];
  for (const ride of cyclingSessions(timeline)) {
    if (ride.start > high || (ride.end ?? Number.POSITIVE_INFINITY) < low) continue;
    if (ride.end === null) {
      if (Math.abs(now - ride.start) <= WAKE_FRESH_MS)
        wakes.push({ kind: "cycling_start", key: `cycling_start:${ride.start}`, context: { started_at: iso(ride.start), summary: "开始骑行" } });
      continue;
    }
    if (Math.abs(now - ride.end) > WAKE_FRESH_MS) continue;
    const minutes = Math.round((ride.end - ride.start) / 60_000);
    const metres = trackDistance(points, ride.start, ride.end);
    wakes.push({ kind: "cycling_end", key: `cycling_end:${ride.start}`, context: { started_at: iso(ride.start), ended_at: iso(ride.end), duration_min: minutes,
      ...(metres === null ? {} : { distance_km: Math.round(metres / 10) / 100 }),
      summary: `骑行结束，${minutes} 分钟${metres === null ? "" : `，${(metres / 1000).toFixed(1)} 公里`}` } });
  }
  return wakes;
}

/** In-memory guard: a kind of wake that fired within the window is dropped, not queued. */
export class WakeLimiter {
  private readonly last = new Map<string, number>();
  constructor(private readonly intervalMs = WAKE_INTERVAL_MS) {}
  allow(bucket: string, now: number): boolean {
    const prior = this.last.get(bucket);
    if (prior !== undefined && now - prior < this.intervalMs && now >= prior) return false;
    this.last.set(bucket, now);
    return true;
  }
}

/** Calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function zoneOffset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return wall - Math.floor(at / 1000) * 1000;
}

/** The instant a local calendar date begins. */
export function dayStart(date: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new TypeError("invalid date");
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let at = wall - zoneOffset(wall, timeZone);
  at = wall - zoneOffset(at, timeZone);
  return at;
}

/** The next local calendar date. */
export function nextDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
