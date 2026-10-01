import type { ClockFiredBodyV2, Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { matchesSchema } from "../../../sdk/src/schema";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger, RequestContextSnapshot } from "../world/ledger";
import { ClockJournal, type ClockFire, type ClockPayload, type ClockTimer } from "../world/clock-journal";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

const names = ["set", "cancel", "list"] as const;
const contracts = names.map((name) => wordContract("service:clock", name));
if (contracts.some((contract) => !contract)) throw new Error("clock contracts unavailable");
const service: TrustedRouteContext = { member: "service:clock", transport: "service", transportPrincipal: "service:clock", local: true, remote: false, ownerProxy: false };
const error = (code: "bad_request" | "forbidden" | "offline" | "failed", message: string): ResponseBody => ({ ok: false, error: { code, message } });
const clientId = (kind: string, fire: ClockFire) => `clock-${kind}:${fire.timerId}:${fire.scheduledAt}`;
const safeNow = (value: number) => Number.isSafeInteger(value) && value >= 0;

export interface ClockOptions {
  ledger: Ledger;
  router: WorldRouter;
  dbFile: string;
  /** The current durable admin pause state, never a timer-body assertion. */
  isPaused: () => boolean | Promise<boolean>;
  /** Host /alarm acknowledgement; null cancels the prior alarm. */
  alarm?: (at: number | null) => Promise<void>;
  now?: () => number;
  scanMs?: number;
}

/** A scheduled request keeps its original delegate, while actual sends always originate at service:clock. */
export class ClockMember implements Member {
  readonly id = "service:clock";
  readonly kind = "service" as const;
  readonly name = "Clock";
  readonly online = true;
  readonly idempotentRecovery = ["set", "cancel", "list"] as const;
  readonly journal: ClockJournal;
  private interval: ReturnType<typeof setInterval> | null = null;
  private active: Promise<void> | null = null;
  private readonly handlers = new Set<Promise<ResponseBody>>();
  private armedAt: number | null | undefined;
  private alarmTask: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: ClockOptions) { this.journal = new ClockJournal(options.dbFile); }
  words(): readonly WordSpec[] { return contracts as WordSpec[]; }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!safeNow(now)) throw new TypeError("invalid clock time");
    return now;
  }
  private allowedDelegate(message: Message, caller: Readonly<RequestContextSnapshot> | undefined): caller is RequestContextSnapshot {
    if (!caller || caller.member !== message.from || !caller.transportPrincipal) return false;
    if (message.from === "person:owner") return caller.ownerProxy &&
      (caller.transportPrincipal.startsWith("token:") || Boolean(caller.remote && caller.pairedDeviceId));
    return message.from === "agent:main" && caller.local && !caller.remote && caller.transportPrincipal === "agent:main";
  }
  private allowedPayload(value: Record<string, unknown>): ClockPayload | null {
    const to = value.to;
    const word = value.word;
    const body = value.body;
    const label = value.label;
    if (typeof label !== "string" || !label.trim() || !body || typeof body !== "object" || Array.isArray(body)) return null;
    if (!((to === "agent:main" && (word === "wake" || word === "say")) ||
      (to === "person:owner" && word === "say" && (body as Record<string, unknown>).kind === "due"))) return null;
    const contract = wordContract(to, word);
    if (!contract?.input_schema || !matchesSchema(contract.input_schema, body) || !this.options.router.acceptsRequest(to, word, body)) return null;
    return { to, word, body: structuredClone(body as Record<string, unknown>), label } as ClockPayload;
  }

  handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    const task = this.handleRequest(message, context);
    this.handlers.add(task);
    void task.then(() => this.handlers.delete(task), () => this.handlers.delete(task));
    return task;
  }
  private async handleRequest(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (this.closed || message.kind !== "request" || message.to !== this.id) return error("failed", "clock unavailable");
    if (!this.allowedDelegate(message, context.caller) || !await this.options.router.currentlyAuthorized(message, context.caller))
      return error("forbidden", "current delegate authorization unavailable");
    const prior = this.journal.command(message.id);
    if (prior && (message.word === "set" || message.word === "cancel")) return { ok: true, result: prior };
    if (message.word === "list") {
      const timers = this.journal.list().filter((item) => message.from === "person:owner" || item.createdBy === message.from)
        .map((item) => ({ id: item.id, next: item.next, every: item.every, to: item.payload?.to ?? null,
          word: item.payload?.word ?? null, label: item.payload?.label ?? null, blocked: item.blocked }));
      return { ok: true, result: { timers } };
    }
    if (message.word === "set") {
      const payload = this.allowedPayload(message.body);
      if (!payload) return error("bad_request", "unsupported scheduled target or body");
      const now = this.now();
      const at = message.body.at;
      const every = message.body.every;
      if ((at === undefined && every === undefined) || (at !== undefined && (!safeNow(at as number) || (at as number) < now)) ||
        (every !== undefined && (!Number.isSafeInteger(every) || (every as number) < 60 || !Number.isSafeInteger((every as number) * 1000))))
        return error("bad_request", "invalid scheduled time");
      const next = at === undefined ? now + (every as number) * 1000 : at as number;
      if (!safeNow(next)) return error("bad_request", "scheduled time out of range");
      const result = this.journal.set(message.id, payload, context.caller, message.from, next, every === undefined ? null : every as number);
      try { await this.rearm(); } catch { return error("offline", "host alarm acknowledgement unavailable; timer is durably pending"); }
      return { ok: true, result };
    }
    if (message.word === "cancel") {
      const timer = this.journal.list().find((item) => item.id === message.body.id);
      if (timer && timer.createdBy !== message.from && message.from !== "person:owner") return error("forbidden", "timer belongs to another delegate");
      const result = this.journal.cancel(message.id, String(message.body.id));
      try { await this.rearm(); } catch { return error("offline", "host alarm acknowledgement unavailable; cancellation is durable"); }
      return { ok: true, result };
    }
    return error("bad_request", "unknown clock word");
  }

  private async rearm(): Promise<void> {
    const update = async () => {
      const next = this.journal.nextAlarm();
      if (next === this.armedAt) return;
      await this.options.alarm?.(next);
      this.armedAt = next; // only an acknowledged host update becomes the local cache
    };
    const task = this.alarmTask.then(update, update);
    this.alarmTask = task.catch(() => {});
    await task;
  }
  private async currentAuthority(fire: ClockFire): Promise<boolean> {
    if (fire.legacy) {
      // Legacy provenance was matched against an original timer.set event at claim time.
      return ["person:owner", "agent:main"].includes(fire.createdBy) &&
        this.options.router.acceptsRequest(fire.createdBy, "say", fire.createdBy === "agent:main" ? { text: "clock provenance" } : { text: "clock provenance", kind: "due" });
    }
    const original = fire.sourceRequestId && this.options.ledger.byId(fire.sourceRequestId);
    return Boolean(original && fire.delegated && this.allowedDelegate(original, fire.delegated) &&
      await this.options.router.currentlyAuthorized(original, fire.delegated));
  }
  private async settleFire(fire: ClockFire): Promise<void> {
    if (fire.outcome === null) {
      const existing = this.options.ledger.retryMessage(service.transportPrincipal, clientId("request", fire));
      if (existing && existing.kind === "request" && existing.from === this.id) {
        this.journal.finishFire(fire, "dispatched", null, existing.id);
      } else if (!fire.payload || !await this.currentAuthority(fire)) {
        this.journal.finishFire(fire, "failed", "delegate_unavailable", null);
      } else if (await this.options.isPaused()) {
        this.journal.finishFire(fire, "skipped", "paused", null);
      } else if (!this.options.router.acceptsRequest(fire.payload.to, fire.payload.word, fire.payload.body)) {
        this.journal.finishFire(fire, "failed", "target_unavailable", null);
      } else {
        try {
          const accepted = await this.options.router.send(service, { to: fire.payload.to, kind: "request", word: fire.payload.word,
            body: fire.payload.body, client_id: clientId("request", fire) });
          this.journal.finishFire(fire, "dispatched", null, accepted.id);
        } catch {
          const accepted = this.options.ledger.retryMessage(service.transportPrincipal, clientId("request", fire));
          if (accepted?.kind === "request" && accepted.from === this.id) this.journal.finishFire(fire, "dispatched", null, accepted.id);
          else this.journal.finishFire(fire, "failed", "target_rejected", null);
        }
      }
    }
    const settled = this.journal.pendingFires().find((item) => item.timerId === fire.timerId && item.scheduledAt === fire.scheduledAt);
    if (!settled || !settled.outcome) return;
    const body: ClockFiredBodyV2 = { timer_id: settled.timerId, scheduled_at: settled.scheduledAt, outcome: settled.outcome,
      ...(settled.reason ? { reason: settled.reason } : {}), ...(settled.requestId ? { request_id: settled.requestId } : {}) };
    const event = await this.options.router.send(service, { to: null, kind: "event", word: "clock.fired", body: body as unknown as Record<string, unknown>,
      client_id: clientId("event", settled) });
    this.journal.markEvent(settled, event.id);
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    if (this.active) return this.active;
    this.active = (async () => {
      this.journal.claimDue(this.now());
      for (const fire of this.journal.pendingFires()) await this.settleFire(fire);
      await this.rearm();
    })();
    try { await this.active; } finally { this.active = null; }
  }
  async start(): Promise<void> {
    if (this.closed || this.interval) throw new Error("clock already started or closed");
    await this.tick();
    this.interval = setInterval(() => { void this.tick().catch(() => {}); }, this.options.scanMs ?? 1000);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    await Promise.allSettled([...this.handlers]);
    await this.active;
    await this.alarmTask;
    this.journal.close();
  }
}
