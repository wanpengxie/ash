import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import type { WorldConfigV2 } from "../../../sdk/src/config";
import { hostPresentationErrors, type HostPresentationV2 } from "../../../sdk/src/host";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import { PostJournal, type DeliveryRecord } from "../world/post-journal";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

const visible = wordContract("service:post", "visible")!;
const hidden = wordContract("service:post", "hidden")!;
const deliver = wordContract("service:post", "deliver")!;
const service: TrustedRouteContext = { member: "service:post", transport: "service", transportPrincipal: "service:post", local: true, remote: false, ownerProxy: false };
const error = (code: "bad_request" | "failed" | "offline", message: string): ResponseBody => ({ ok: false, error: { code, message } });
const minute = 60_000;
const quietRange = (quiet: string): [number, number] => {
  const match = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(quiet);
  if (!match) throw new TypeError("invalid quiet interval");
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start >= 1440 || end >= 1440) throw new TypeError("invalid quiet interval");
  return [start, end];
};
const localMinute = (at: number, zone?: string): number => {
  if (!zone) { const date = new Date(at); return date.getHours() * 60 + date.getMinutes(); }
  const fields = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(fields.find((item) => item.type === "hour")?.value) * 60 + Number(fields.find((item) => item.type === "minute")?.value);
};
/** Quiet uses the running host's local timezone; tests can inject an IANA zone. */
export function isQuiet(at: number, quiet: string, zone?: string): boolean {
  const [start, end] = quietRange(quiet); const time = localMinute(at, zone);
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}
export function quietEnd(at: number, quiet: string, zone?: string): number {
  if (!isQuiet(at, quiet, zone)) return at;
  for (let next = Math.floor(at / minute) * minute + minute; next < at + 3 * 86_400_000; next += minute)
    if (!isQuiet(next, quiet, zone)) return next;
  throw new Error("quiet interval has no release boundary");
}

export interface ScreenPresence { markVisible(screen: string): void; markHidden(screen: string): void; list(): { id: string; name: string; online: boolean }[]; visible(screen: string): boolean }
export interface HostPresenter { present(value: HostPresentationV2): Promise<void>; hidePresentation(id: string): Promise<void> }
export interface UiPresenter { present(message: Message): Promise<void> | void }
/** Existing owner ledger stream is the in-app presenter, not a second output log. */
export class LedgerUiPresenter implements UiPresenter {
  constructor(private readonly ledger: Ledger) {}
  present(message: Message): void { if (message.to !== "person:owner" || this.ledger.byId(message.id)?.seq !== message.seq) throw new Error("owner stream message unavailable"); }
}
export interface PostOptions { ledger: Ledger; router: WorldRouter; screens: ScreenPresence; delivery: WorldConfigV2["delivery"];
  host?: HostPresenter; ui?: UiPresenter; now?: () => number; timeZone?: string; scanMs?: number }

export class PostMember implements Member {
  readonly id = "service:post";
  readonly kind = "service" as const;
  readonly name = "Delivery";
  readonly online = true;
  readonly idempotentRecovery = ["deliver"] as const;
  readonly journal: PostJournal;
  private readonly ui: UiPresenter;
  private readonly tasks = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private scanTask: Promise<void> | null = null;
  private started = false;
  private prepared = false;
  private closed = false;
  constructor(private readonly options: PostOptions) {
    quietRange(options.delivery.quiet);
    if (!Number.isSafeInteger(options.delivery.dedupe_minutes) || options.delivery.dedupe_minutes < 0 ||
      !Number.isSafeInteger(options.delivery.dedupe_minutes * minute)) throw new TypeError("invalid dedupe interval");
    this.journal = new PostJournal(options.ledger);
    this.ui = options.ui ?? new LedgerUiPresenter(options.ledger);
  }
  words(): readonly WordSpec[] { return [visible, hidden, deliver]; }
  private now(): number { const now = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid post time"); return now; }
  private foreground(): boolean { return this.options.screens.list().some((entry) => entry.online && this.options.screens.visible(entry.id)); }
  private source(id: string, kind: DeliveryRecord["kind"]): Message | null {
    const source = this.options.ledger.byId(id);
    if (!source || source.seq <= this.options.ledger.migration.lastLegacySeq || source.kind !== "request" || source.to !== "person:owner") return null;
    if (kind === "approval") return source.word === "ask" ? source : null;
    return source.word === "say" && source.body.kind === kind ? source : null;
  }
  private presentation(source: Message, kind: DeliveryRecord["kind"]): HostPresentationV2 | null {
    if (kind === "approval" && (this.options.ledger.responseTo(source.id) ||
      typeof source.body.expires_at !== "number" || source.body.expires_at <= Date.now())) return null;
    const value = kind === "approval" ? { id: source.id, kind, title: source.body.title, text: source.body.detail,
      options: source.body.options, expires_at: source.body.expires_at, reply_to: source.id, reply_target: source.from }
      : { id: source.id, kind, title: kind === "due" ? "Due" : kind === "reply" ? "Reply" : "Ash", text: source.body.text };
    return hostPresentationErrors(value).length ? null : value as HostPresentationV2;
  }
  private publish(snapshot: Message | null): void { if (snapshot) this.options.router.publishPostEvent(snapshot); }
  private track(task: Promise<unknown>): void { this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {}); }
  handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody | void> | ResponseBody | void {
    if (message.kind === "event" && message.word === "visible" && message.to === this.id && message.from.startsWith("screen:")) {
      this.options.screens.markVisible(message.from);
      this.publish(this.options.ledger.postWrite((_db, snapshot) => snapshot(this.journal.heldCount())));
      return;
    }
    if (message.kind === "event" && message.word === "hidden" && message.to === this.id && message.from.startsWith("screen:")) {
      this.options.screens.markHidden(message.from);
      return;
    }
    if (message.kind !== "request" || message.to !== this.id || message.word !== "deliver") return error("bad_request", "unsupported post word");
    const task = this.deliver(message); this.track(task); return task;
  }
  private async deliver(message: Message): Promise<ResponseBody> {
    if (this.closed) return error("failed", "delivery service closed");
    const kind = message.body.kind as DeliveryRecord["kind"];
    const source = this.source(String(message.body.message_id), kind);
    if (!source) return error("bad_request", "delivery source and kind do not match owner ledger message");
    if ((kind === "offer" || kind === "heads_up") &&
      (Object.hasOwn(source.body, "dedupe_key") !== Object.hasOwn(message.body, "dedupe_key") ||
        (Object.hasOwn(source.body, "dedupe_key") && source.body.dedupe_key !== message.body.dedupe_key)))
      return error("bad_request", "delivery key must match the accepted owner message");
    const now = this.now(), foreground = this.foreground();
    const held = !foreground && (kind === "offer" || kind === "heads_up") && isQuiet(now, this.options.delivery.quiet, this.options.timeZone);
    const notification = !foreground && !held && (kind === "approval" || kind === "due" || kind === "reply");
    const channel = held ? "held" : notification ? "notification" : "inapp";
    const selected = this.journal.classify({ messageId: source.id, kind, channel,
      ...(typeof message.body.dedupe_key === "string" ? { dedupeKey: message.body.dedupe_key } : {}), now,
      dedupeMs: this.options.delivery.dedupe_minutes * minute,
      ...(held ? { releaseAt: quietEnd(now, this.options.delivery.quiet, this.options.timeZone) } : {}) });
    this.publish(selected.visibility);
    this.publish(selected.snapshot);
    const record = selected.record;
    if (!selected.fresh) {
      if (record.state === "failed") return error("failed", `presentation rejected: ${record.error ?? "unavailable"}`);
      if (record.state === "unknown" || record.state === "dispatching") return error("failed", "prior presentation outcome unknown; not replayed");
      return { ok: true, result: { channel: record.channel } };
    }
    if (record.channel === "dropped" || record.channel === "held") return { ok: true, result: { channel: record.channel } };
    if (record.channel === "inapp") { await this.ui.present(source); return { ok: true, result: { channel: "inapp" } }; }
    const presentation = this.presentation(source, kind);
    if (!presentation) { this.journal.failKnown(source.id, "presentation_contract_rejected"); return error("bad_request", "unsafe host presentation"); }
    if (!this.options.host) { this.journal.failKnown(source.id, "host_unavailable"); return error("offline", "host presenter unavailable"); }
    try { await this.options.host.present(presentation); }
    catch { this.journal.finish(source.id, false); return error("failed", "host presentation outcome unknown; not replayed"); }
    this.journal.finish(source.id, true);
    if (kind === "approval" && this.options.ledger.responseTo(source.id)) await this.options.host.hidePresentation(source.id).catch(() => {});
    return { ok: true, result: { channel: "notification" } };
  }
  private async auto(message: Message): Promise<void> {
    if (this.closed || message.kind !== "request" || message.to !== "person:owner" || message.seq <= this.options.ledger.migration.lastLegacySeq) return;
    const kind = message.word === "ask" ? "approval" : message.word === "say" && ["reply", "offer", "heads_up", "due"].includes(String(message.body.kind))
      ? message.body.kind as DeliveryRecord["kind"] : null;
    if (!kind || this.journal.record(message.id)) return;
    await this.options.router.send(service, { to: this.id, kind: "request", word: "deliver", body: { message_id: message.id, kind,
      ...((kind === "offer" || kind === "heads_up") && typeof message.body.dedupe_key === "string" ? { dedupe_key: message.body.dedupe_key } : {}) },
    client_id: `post:${message.id}` });
  }
  private async scan(): Promise<void> {
    if (this.scanTask) return this.scanTask;
    this.scanTask = (async () => {
      let cursor = this.journal.cursor() ?? this.options.ledger.lastSeq();
      while (!this.closed) {
        const page = this.options.ledger.list({ after: cursor, limit: 1000 });
        if (!page.length) break;
        for (const message of page) {
          if (this.closed) return;
          await this.auto(message);
          cursor = message.seq;
          this.journal.advanceCursor(cursor);
        }
      }
    })();
    try { await this.scanTask; } finally { this.scanTask = null; }
  }
  private async releaseDue(): Promise<void> {
    const now = this.now();
    for (const item of this.journal.due(now)) {
      const source = this.source(item.messageId, item.kind);
      const claim = this.journal.release(item.messageId);
      if (!claim) continue;
      this.publish(claim.visibility);
      this.publish(claim.snapshot);
      if (source) await this.ui.present(source);
    }
  }
  async tick(): Promise<void> { if (!this.closed) { await this.scan(); await this.releaseDue(); } }
  prepareRecovery(): void {
    if (this.closed || this.prepared) throw new Error("post already prepared or closed");
    this.publish(this.journal.beginAt(this.options.ledger.lastSeq()));
    this.prepared = true;
  }
  async start(): Promise<void> {
    if (this.closed || this.started || !this.prepared) throw new Error("post needs recovery preparation before start");
    this.started = true;
    this.unsubscribe = this.options.router.subscribe((message) => {
      if (message.kind === "response" && message.word === "ask" && message.reply_to) {
        const record = this.journal.record(message.reply_to);
        if (record?.channel === "notification" && (record.state === "done" ||
          (record.state === "unknown" && record.error === "presentation_outcome_unknown")) && this.options.host)
          this.track(this.options.host.hidePresentation(message.reply_to).catch(() => {}));
      }
      if (message.kind === "request" && message.to === "person:owner") this.track(this.scan());
    });
    await this.tick();
    this.interval = setInterval(() => this.track(this.tick()), this.options.scanMs ?? 1000);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.unsubscribe?.();
    if (this.interval) clearInterval(this.interval);
    await Promise.allSettled([...this.tasks, ...(this.scanTask ? [this.scanTask] : [])]);
  }
}
