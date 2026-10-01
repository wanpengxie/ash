import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import { AdminJournal } from "../world/admin-journal";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

const pause = wordContract("service:admin", "pause")!;
const resume = wordContract("service:admin", "resume")!;
const service: TrustedRouteContext = { member: "service:admin", transport: "service", transportPrincipal: "service:admin",
  local: true, remote: false, ownerProxy: false };

export interface AdminOptions { ledger: Ledger; router: WorldRouter; dbFile: string; onPauseChanged: () => void;
  /** Current server-owned registration, not the screen name persisted with the request. */
  currentScreenBinding: (screen: string, principal: string) => boolean }

/** Only implemented words are registered; opaque legacy settings/plugin/gateway bodies have no production route. */
export class AdminMember implements Member {
  readonly id = "service:admin";
  readonly kind = "service" as const;
  readonly name = "Administration";
  readonly online = true;
  readonly idempotentRecovery = ["pause", "resume"] as const;
  readonly journal: AdminJournal;
  private closed = false;
  constructor(private readonly options: AdminOptions) { this.journal = new AdminJournal(options.dbFile); }
  words(): readonly WordSpec[] { return [pause, resume]; }

  /** A current durable pause may have crashed before it reached agent cancellation. */
  currentCommittedPause(): string | null {
    const latest = this.journal.currentCommand();
    if (!latest?.paused) return null;
    const message = this.options.ledger.byId(latest.requestId);
    if (!message || message.seq !== latest.seq || message.word !== "pause" || message.to !== this.id ||
      message.kind !== "request" || !this.journal.committedFact(message)?.current)
      throw new TypeError("current pause has no matching accepted request");
    return message.id;
  }

  /** Settle already committed effects before router recovery rechecks permission or replays handlers. */
  prepareRecovery(): void {
    for (const { message } of this.options.ledger.trackedRequests()) {
      const fact = this.journal.committedFact(message);
      if (!fact) continue;
      const body: ResponseBody = fact.current ? { ok: true, result: { paused: fact.paused } }
        : { ok: false, error: { code: "failed", message: "admin command committed but superseded by a newer state" } };
      this.options.ledger.settle(message.id, this.id, body);
    }
  }

  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (this.closed || !context.caller || message.to !== this.id || message.kind !== "request")
      return { ok: false, error: { code: "offline", message: "admin unavailable" } };
    if (!await this.options.router.currentlyAuthorized(message, context.caller))
      return { ok: false, error: { code: "forbidden", message: "current admin authority unavailable" } };
    const paused = message.word === "pause" ? true : message.word === "resume" ? false : null;
    if (paused === null) return { ok: false, error: { code: "not_found", message: "admin word unavailable" } };
    if (paused && message.from === "service:reflex" && !await this.options.router.currentlyAuthorizedReflexPause(message.body.by))
      return { ok: false, error: { code: "forbidden", message: "original owner authority unavailable" } };
    // No await between this check and the durable effect. A screen accepted earlier
    // may have expired or changed principal while authorization was pending.
    if (!paused && (message.from !== "person:owner" || !context.caller.local || context.caller.remote || !context.caller.ownerProxy ||
      !context.caller.screenId || !context.caller.transportPrincipal ||
      !this.options.currentScreenBinding(context.caller.screenId, context.caller.transportPrincipal)))
      return { ok: false, error: { code: "forbidden", message: "current local owner screen confirmation unavailable" } };
    if (context.signal.aborted)
      return { ok: false, error: { code: "cancelled", message: "admin request settled before effect" } };
    let applied: ReturnType<AdminJournal["apply"]>;
    try { applied = this.journal.apply(message, paused); }
    catch { return { ok: false, error: { code: "failed", message: "durable pause state unavailable" } }; }
    if (!applied.applied) return { ok: false, error: { code: "failed", message: "admin command superseded by a newer request" } };
    this.options.onPauseChanged();
    if (paused) {
      try {
        const cancel = await this.options.router.send(service, { to: "agent:main", kind: "request", word: "cancel_turn",
          body: { reason: "Paused by owner", by: message.id }, client_id: `admin-pause:${message.id}`, wait: true });
        if (cancel.reply?.body.ok !== true) return { ok: false, error: { code: "failed", message: "paused, but current turn cancellation was not acknowledged" } };
      } catch { return { ok: false, error: { code: "failed", message: "paused, but current turn cancellation was not acknowledged" } }; }
    }
    if (!this.journal.committedFact(message)?.current)
      return { ok: false, error: { code: "failed", message: "admin command committed but superseded by a newer state" } };
    return { ok: true, result: { paused } };
  }

  close(): void { if (this.closed) return; this.closed = true; this.journal.close(); }
}
