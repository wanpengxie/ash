import { createHash } from "node:crypto";
import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { Member } from "../world/member";
import { WorldRouter, type TrustedRouteContext } from "../world/router";
import type { SenseArchive } from "./senses-archive";
import { activityTimeline, cyclingWakes, geofenceWake, WakeLimiter, type LocationLine, type Segment, type SenseWake } from "./senses-facts";

const service: TrustedRouteContext = { member: "service:senses", transport: "service", transportPrincipal: "service:senses",
  local: true, remote: false, ownerProxy: false };

export interface SensesOptions {
  router: WorldRouter;
  heartbeat: () => Promise<string | null>;
  isPaused: () => boolean;
  opener: (slot: string) => void;
  proactive: (slot: string) => void;
  /** Where batched location, activity, health and geofence facts are kept; without it they only wake. */
  archive?: SenseArchive;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

/** How far back the activity timeline is read to find where a ride began. */
const RIDE_LOOKBACK_MS = 12 * 3_600_000;

/**
 * Phone facts are already validated and recorded by the router. This member archives batched facts into the owner's
 * home workspace and applies wake rules; only a geofence crossing or a ride starting or ending wakes the mind.
 */
export class SensesMember implements Member {
  readonly id = "service:senses";
  readonly kind = "service" as const;
  readonly name = "Phone senses";
  readonly online = true;
  private readonly stop: () => void;
  private readonly limiter = new WakeLimiter();
  private readonly woken = new Set<string>();

  constructor(private readonly options: SensesOptions) {
    this.stop = options.router.subscribe((message) => {
      if (message.from !== "device:phone" || message.to !== null || message.kind !== "event") return;
      if (this.options.isPaused()) return;
      const slot = createHash("sha256").update(message.id).digest("hex").slice(0, 32);
      if (message.word === "sense.screen" && message.body.state === "app_open" && Number(message.body.away_ms) >= 6 * 3_600_000)
        this.options.opener(`screen:${slot}`);
      if (message.word === "sense.calendar") {
        this.options.proactive(`calendar:${slot}`);
        if (message.body.kind === "upcoming") void this.calendarReminder(message).catch(() => {});
      }
      if (["sense.location", "sense.activity", "sense.health", "sense.geofence"].includes(message.word)) this.batch(message);
    });
  }

  words(): readonly WordSpec[] { return []; }
  handle(): ResponseBody { return { ok: false, error: { code: "not_found", message: "senses do not accept direct calls" } }; }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private batch(message: Message): void {
    const archive = this.options.archive;
    try { archive?.record(message); } catch (error) { this.options.log?.("senses archive failed", error); }
    const now = this.now();
    if (message.word === "sense.geofence") {
      const wake = geofenceWake(message.body as { name: string; transition: "enter" | "exit"; ts: number }, now);
      if (wake) this.wake(wake, now);
    }
    if (message.word === "sense.activity") {
      const items = message.body.items as Segment[];
      const low = Math.min(...items.map((item) => item.ts_start)), high = Math.max(...items.map((item) => item.ts_end ?? item.ts_start), now);
      let lines: Segment[] = items, points: LocationLine[] = [];
      if (archive) try {
        lines = [...archive.lines("activity", low - RIDE_LOOKBACK_MS, high + 1), ...items];
        points = archive.lines("location", low - RIDE_LOOKBACK_MS, high + 1);
      } catch (error) { this.options.log?.("senses archive read failed", error); }
      for (const wake of cyclingWakes(items, activityTimeline(lines), points, now)) this.wake(wake, now);
    }
  }

  /** One wake per fact, at most one of a kind per ten minutes; a dropped wake stays in the archive. */
  private wake(wake: SenseWake, now: number): void {
    if (this.woken.has(wake.key) || !this.limiter.allow(wake.kind, now)) return;
    this.woken.add(wake.key);
    void this.options.router.send(service, { to: "agent:main", kind: "request", word: "wake",
      body: { reason: wake.kind, context: wake.context }, client_id: `sense:${wake.key}`, wait: true }).catch(() => {});
  }

  private async calendarReminder(message: Message): Promise<void> {
    const event = message.body.event as { title?: unknown; important?: unknown } | undefined;
    if (!event) return;
    const heartbeat = await this.options.heartbeat();
    if (this.options.isPaused()) return;
    const title = String(event.title ?? "").trim();
    const relevant = event.important === true || Boolean(title && heartbeat?.split("\n")
      .some((line) => line.trim() && !line.trim().startsWith("#") && line.includes(title)));
    if (!relevant) return;
    await this.options.router.send(service, { to: "agent:main", kind: "request", word: "wake",
      body: { reason: "calendar_reminder", context: { event } }, client_id: `sense:${message.id}`, wait: true });
  }

  close(): void { this.stop(); }
}
