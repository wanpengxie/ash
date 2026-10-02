import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import { AdminJournal } from "../world/admin-journal";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

const pause = wordContract("service:admin", "pause")!;
const resume = wordContract("service:admin", "resume")!;
const settingsGet = wordContract("service:admin", "settings.get")!;
const settingsSet = wordContract("service:admin", "settings.set")!;
const pluginsList = wordContract("service:admin", "plugins.list")!;
const pluginsOp = wordContract("service:admin", "plugins.op")!;
const gatewayState = wordContract("service:admin", "gateway.state")!;
const modelSet = wordContract("service:admin", "model.set")!;
const service: TrustedRouteContext = { member: "service:admin", transport: "service", transportPrincipal: "service:admin",
  local: true, remote: false, ownerProxy: false };

export interface AdminOptions { ledger: Ledger; router: WorldRouter; dbFile: string; onPauseChanged: () => void;
  delivery?: { quiet: string };
  pluginsList?: () => Promise<Record<string, unknown>>;
  pluginsOp?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  gatewayState?: () => Record<string, unknown>;
  modelGet?: () => Record<string, unknown>;
  modelSet?: (provider: string, model: string) => Promise<Record<string, unknown>>;
  currentAgentTurn?: () => string | null;
  /** Current server-owned registration, not the screen name persisted with the request. */
  currentScreenBinding: (screen: string, principal: string) => boolean }

/** Only implemented words are registered; opaque mutation bodies have no production route. */
export class AdminMember implements Member {
  readonly id = "service:admin";
  readonly kind = "service" as const;
  readonly name = "Administration";
  readonly online = true;
  readonly idempotentRecovery = ["pause", "resume", "settings.get", "settings.set", "plugins.list", "gateway.state"] as const;
  readonly journal: AdminJournal;
  private closed = false;
  constructor(private readonly options: AdminOptions) { this.journal = new AdminJournal(options.dbFile); }
  words(): readonly WordSpec[] { return [pause, resume, settingsGet, settingsSet, pluginsList, pluginsOp, gatewayState, modelSet]; }

  /** A current durable pause may have crashed before it reached agent cancellation. */
  currentCommittedPause(): { requestId: string; targetTurn: string | null } | null {
    const latest = this.journal.currentCommand();
    if (!latest?.paused) return null;
    const message = this.options.ledger.byId(latest.requestId);
    if (!message || message.seq !== latest.seq || message.word !== "pause" || message.to !== this.id ||
      message.kind !== "request" || !this.journal.committedFact(message)?.current)
      throw new TypeError("current pause has no matching accepted request");
    return { requestId: message.id, targetTurn: latest.targetTurn };
  }

  /** The original accepted pause and its captured turn must both still be current. */
  currentPauseTargets(requestId: unknown, turn: unknown): boolean {
    if (typeof requestId !== "string" || typeof turn !== "string" || !turn) return false;
    const latest = this.currentCommittedPause();
    return latest?.requestId === requestId && latest.targetTurn === turn;
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
    if (message.word === "plugins.list" || message.word === "gateway.state") {
      if (message.from !== "person:owner" || !context.caller.local || context.caller.remote)
        return { ok: false, error: { code: "forbidden", message: "local administration unavailable" } };
      try {
        if (message.word === "gateway.state") return { ok: true, result: this.options.gatewayState?.() ?? { configured: false } };
        if (!this.options.pluginsList) return { ok: false, error: { code: "offline", message: "plugin manager unavailable" } };
        const result = await this.options.pluginsList();
        if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "admin request settled" } };
        return { ok: true, result };
      } catch { return { ok: false, error: { code: "failed", message: "admin read unavailable" } }; }
    }
    if (message.word === "plugins.op") {
      if (message.from !== "person:owner" || !context.caller.local || context.caller.remote)
        return { ok: false, error: { code: "forbidden", message: "local administration unavailable" } };
      if (!this.options.pluginsOp) return { ok: false, error: { code: "offline", message: "plugin manager unavailable" } };
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "admin request settled" } };
      try { return { ok: true, result: await this.options.pluginsOp(message.body) }; }
      catch { return { ok: false, error: { code: "failed", message: "plugin operation failed" } }; }
    }
    if (message.word === "model.set") {
      if (message.from !== "person:owner" || !context.caller.local || context.caller.remote)
        return { ok: false, error: { code: "forbidden", message: "local administration unavailable" } };
      if (!this.options.modelSet) return { ok: false, error: { code: "offline", message: "model configuration unavailable" } };
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "admin request settled" } };
      try { return { ok: true, result: await this.options.modelSet(message.body.provider as string, message.body.model as string) }; }
      catch { return { ok: false, error: { code: "failed", message: "model selection failed" } }; }
    }
    if (message.word === "settings.get" || message.word === "settings.set") {
      if (message.from !== "person:owner" || !context.caller.local || context.caller.remote || !this.options.delivery)
        return { ok: false, error: { code: "forbidden", message: "local settings unavailable" } };
      if (message.word === "settings.get") return { ok: true, result: { delivery: { quiet: this.options.delivery.quiet }, ...(this.options.modelGet ? { model: this.options.modelGet() } : {}) } };
      const body = message.body;
      const section = body.delivery;
      const quiet = section && typeof section === "object" && !Array.isArray(section) ? (section as Record<string, unknown>).quiet : undefined;
      if (Object.keys(body).length !== 1 || !section || typeof section !== "object" || Array.isArray(section) ||
        Object.keys(section).length !== 1 || typeof quiet !== "string" ||
        !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(quiet))
        return { ok: false, error: { code: "bad_request", message: "expected delivery.quiet as HH:MM-HH:MM" } };
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "settings request settled" } };
      this.journal.setQuietHours(quiet);
      this.options.delivery.quiet = quiet;
      return { ok: true, result: { delivery: { quiet } } };
    }
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
    const targetTurn = paused ? this.options.currentAgentTurn?.() ?? null : null;
    let applied: ReturnType<AdminJournal["apply"]>;
    try { applied = this.journal.apply(message, paused, targetTurn); }
    catch { return { ok: false, error: { code: "failed", message: "durable pause state unavailable" } }; }
    if (!applied.applied) return { ok: false, error: { code: "failed", message: "admin command superseded by a newer request" } };
    this.options.onPauseChanged();
    if (paused && targetTurn) {
      try {
        const cancel = await this.options.router.send({ ...service, turn: targetTurn }, { to: "agent:main", kind: "request", word: "cancel_turn",
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
