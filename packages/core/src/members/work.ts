import { createHash } from "node:crypto";
import type { Message, ResponseBody, SendRequestV2, WordSpec, WorkRunInfoV2 } from "../../../sdk/src/api";
import { matchesSchema } from "../../../sdk/src/schema";
import { wordContract, workRunTurn } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

type Trigger = WorkRunInfoV2["trigger"];
type Outcome = "done" | "no_change";
const runSpec = wordContract("service:work", "run")!;
const runsSpec = wordContract("service:work", "runs")!;
const service = (run: string): TrustedRouteContext => ({ member: "service:work", transport: "service", transportPrincipal: "service:work",
  local: true, remote: false, ownerProxy: false, turn: workRunTurn(run) });
const error = (code: "bad_request" | "forbidden" | "not_found" | "failed" | "cancelled", message: string): ResponseBody =>
  ({ ok: false, error: { code, message } });

export interface WorkRunContext {
  readonly run: string;
  readonly signal: AbortSignal;
  /** The step label is code-owned metadata. The task's result is never put in the event. */
  step<T>(name: string, task: () => Promise<T> | T): Promise<T>;
  /** A real router request; client_id is a stable code-owned call key within this run. */
  send(request: Pick<SendRequestV2, "to" | "word" | "body"> & { client_id: string }): Promise<ResponseBody>;
}

/** Test fixtures may inject a controlled flow; production registers only implemented flows. */
export interface WorkFlow {
  name: string;
  triggers: readonly Trigger[];
  execute(context: WorkRunContext): Promise<Outcome>;
}
export interface WorkOptions { ledger: Ledger; router: WorldRouter; isPaused: () => boolean; flows?: readonly WorkFlow[]; now?: () => number; scanMs?: number }

export class WorkMember implements Member {
  readonly id = "service:work";
  readonly kind = "service" as const;
  readonly name = "Background work";
  readonly online = true;
  readonly idempotentRecovery = ["run", "runs"] as const;
  private readonly flows = new Map<string, WorkFlow>();
  private readonly active = new Map<string, AbortController>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly options: WorkOptions) {
    for (const flow of options.flows ?? []) {
      if (!matchesSchema(runSpec.input_schema!, { flow: flow.name }) || this.flows.has(flow.name) ||
        !Array.isArray(flow.triggers) || flow.triggers.some((trigger) => !["manual", "cooldown", "hourly", "event"].includes(trigger)) ||
        typeof flow.execute !== "function") throw new TypeError("invalid work flow registration");
      this.flows.set(flow.name, flow);
    }
  }
  words(): readonly WordSpec[] { return [runSpec, runsSpec]; }
  /** Current production flow registry and committed run provenance, never a stale member string. */
  ownsRequestTurn(message: Message): boolean {
    if (message.from !== this.id || message.kind !== "request" || !message.turn) return false;
    const source = this.options.ledger.workRunSource(message.turn);
    return Boolean(source && this.flows.has(source.flow) && message.ts >= source.startedAt &&
      (source.endedAt === null || message.ts <= source.endedAt));
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("invalid work time");
    return now;
  }

  /** Must precede router recovery: uncertain effects are terminal, never replayed. */
  prepareRecovery(): void {
    for (const event of this.options.ledger.workRecover(this.now())) {
      this.options.router.cancelWorkTurn(event.turn!);
      this.options.router.publishWorkEvent(event);
    }
  }

  /** In-process scheduler and one current-hour startup catch-up; Clock alone owns host alarms. */
  start(): void {
    if (this.closed || this.interval) return;
    if (![...this.flows.values()].some((flow) => flow.triggers.includes("hourly") || flow.triggers.includes("cooldown"))) return;
    const scanMs = this.options.scanMs ?? 60_000;
    if (!Number.isSafeInteger(scanMs) || scanMs < 1_000) throw new TypeError("invalid work scan interval");
    this.tick();
    this.interval = setInterval(() => { try { this.tick(); } catch { /* a failed tick cannot claim an unsafe run */ } }, scanMs);
    this.interval.unref?.();
  }

  /** Bounded scan of the latest turn and current hourly slot, not replay of every missed hour. */
  tick(): void {
    if (this.closed) return;
    const now = this.now();
    const cooldown = this.options.ledger.workCooldownCandidate(now);
    for (const flow of this.flows.values()) {
      if (flow.triggers.includes("hourly")) {
        try { this.trigger(flow.name, "hourly", `hourly:${flow.name}:${Math.floor(now / 3_600_000)}`); }
        catch { /* active-flow mutex or bad pause state: never manufacture success */ }
      }
      if (cooldown && flow.triggers.includes("cooldown")) {
        try { this.trigger(flow.name, "cooldown", `cooldown:${flow.name}:${createHash("sha256").update(cooldown.id).digest("hex").slice(0, 32)}`); }
        catch { /* leave the slot unclaimed until a safe later scan */ }
      }
    }
  }

  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (this.closed || message.kind !== "request" || message.to !== this.id) return error("failed", "work unavailable");
    if (!context.caller || !await this.options.router.currentlyAuthorized(message, context.caller))
      return error("forbidden", "current work authority unavailable");
    if (message.word === "runs") {
      try { return { ok: true, result: { runs: this.options.ledger.workRuns(message.body.flow as string | undefined, message.body.limit as number | undefined) } }; }
      catch { return error("failed", "run metadata unavailable"); }
    }
    if (message.word !== "run") return error("not_found", "work word unavailable");
    const flow = this.flows.get(String(message.body.flow));
    if (!flow) return error("not_found", "flow unavailable");
    if (context.signal.aborted) return error("cancelled", "work request already settled");
    try {
      const result = this.options.ledger.workStart(message.id, flow.name, "manual", this.now());
      if (result.event) this.options.router.publishWorkEvent(result.event);
      if (!result.duplicate) this.launch(result.run, flow);
      return { ok: true, result: { run: result.run } };
    } catch { return error("failed", "work paused, active, or unavailable"); }
  }

  /** Trusted in-process typed trigger. It does not impersonate owner or create an HTTP word. */
  trigger(flowName: string, trigger: Exclude<Trigger, "manual">, slot: string): string | null {
    if (this.closed) throw new TypeError("work unavailable");
    const flow = this.flows.get(flowName);
    if (!flow || !flow.triggers.includes(trigger)) throw new TypeError("flow trigger unavailable");
    const started = this.options.ledger.workStartScheduled(flowName, trigger, slot, this.now());
    if (started.event) this.options.router.publishWorkEvent(started.event);
    if (started.run && !started.duplicate) this.launch(started.run, flow);
    return started.run;
  }

  private launch(run: string, flow: WorkFlow): void {
    const controller = new AbortController();
    this.active.set(run, controller);
    const check = () => { if (controller.signal.aborted || this.closed) throw new Error("work_stopped"); };
    const context: WorkRunContext = {
      run, signal: controller.signal,
      step: async <T>(name: string, task: () => Promise<T> | T): Promise<T> => {
        check();
        this.options.router.publishWorkEvent(this.options.ledger.workStep({ run, step: name, state: "started" }, this.now()));
        try {
          const value = await task(); check();
          this.options.router.publishWorkEvent(this.options.ledger.workStep({ run, step: name, state: "done" }, this.now()));
          return value;
        } catch (cause) {
          if (!controller.signal.aborted && !this.closed)
            this.options.router.publishWorkEvent(this.options.ledger.workStep({ run, step: name, state: "failed" }, this.now()));
          throw cause;
        }
      },
      send: async (request): Promise<ResponseBody> => {
        check();
        if (!request.to || !/^[a-z][a-z0-9._-]{0,47}$/.test(request.client_id)) throw new TypeError("invalid work call target or key");
        const accepted = await this.options.router.send(service(run), { ...request, client_id: `work:${run}:${request.client_id}`,
          kind: "request", wait: true }, controller.signal);
        check();
        const reply = accepted.reply?.body;
        return reply && typeof reply.ok === "boolean" ? reply as ResponseBody : error("failed", "work request has no response");
      },
    };
    void Promise.resolve().then(() => flow.execute(context)).then(
      (outcome) => this.finish(run, outcome === "no_change" ? "no_change" : outcome === "done" ? "done" : "failed",
        outcome === "no_change" ? "no_change" : outcome === "done" ? "completed" : "invalid_flow_outcome"),
      () => this.finish(run, "failed", controller.signal.aborted ? "stopped_unknown_effect" : "flow_failed"),
    ).catch(() => { /* A closed or corrupt journal cannot create another terminal effect. */ });
  }

  private finish(run: string, outcome: "done" | "no_change" | "failed", detail: string): void {
    if (!this.active.has(run)) return; // a late non-cooperative flow has no terminal authority
    this.active.delete(run);
    const event = this.options.ledger.workFinish(run, outcome, detail, this.now());
    if (event) this.options.router.publishWorkEvent(event);
  }

  /** Pause (including malformed durable pause) stops runs without awaiting a non-cooperative step. */
  resamplePause(): void {
    let paused = true;
    try { paused = this.options.isPaused(); } catch { /* invalid state fails closed */ }
    if (!paused) return;
    for (const [run, controller] of this.active) {
      controller.abort();
      this.options.router.cancelWorkTurn(run);
      this.finish(run, "failed", "paused_unknown_effect");
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const [run, controller] of this.active) {
      controller.abort();
      this.options.router.cancelWorkTurn(run);
      this.finish(run, "failed", "stopped_unknown_effect");
    }
  }
}
