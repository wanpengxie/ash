import { createHash } from "node:crypto";
import type { Message } from "../../../../sdk/src/api";
import type { WorldRouter, TrustedRouteContext } from "../router";

export const decisionContext: TrustedRouteContext = { member: "service:reflex", transport: "service",
  transportPrincipal: "service:reflex", local: true, remote: false, ownerProxy: false };

export interface DecisionVerdict { outcome: Record<string, unknown>; stage: string; confidence?: number; fallback?: string }
export interface DecisionEffect { acted: boolean; skipped?: string; effects?: string[] }
export interface DecisionJob {
  trigger: Message;
  turn?: string;
  group?: string;
  state: unknown;
  evidence: string[];
  judge(signal: AbortSignal): Promise<DecisionVerdict>;
  current(): boolean | Promise<boolean>;
  apply(verdict: DecisionVerdict, id: string, signal: AbortSignal): Promise<DecisionEffect>;
  finished?(verdict: DecisionVerdict, result: DecisionEffect): Promise<void>;
}
export interface DecisionRoute {
  id: string;
  version: number;
  observe?(message: Message): void;
  match(message: Message): DecisionJob | null;
  beforeTurn?(turn: string, signal: AbortSignal): Promise<Record<string, unknown> | null>;
  close?(): void;
}

/** Routes own semantics and effects; this runtime owns their lifecycle and durable audit. */
export class DecisionRuntime {
  private readonly routes: DecisionRoute[] = [];
  private readonly jobs = new Map<string, { controller: AbortController; group?: string; task: Promise<void> }>();
  private closed = false;
  private failure: Error | null = null;
  constructor(private readonly router: WorldRouter) {}
  register(route: DecisionRoute): void {
    if (this.closed || this.routes.some((item) => item.id === route.id)) throw new Error("duplicate or closed decision route");
    this.routes.push(route);
  }
  get lastError(): Error | null { return this.failure; }
  async recover(): Promise<void> {
    // Accepted host calls from the old process have lost their live-screen guard.
    this.router.cancel(this.router.ledger.trackedRequests().filter((row) => row.message.to === "service:reflex").map((row) => row.message.id));
    for (;;) {
      const unfinished = this.router.ledger.unfinishedDecisions();
      if (!unfinished.length) return;
      for (const start of unfinished) {
        const { decision_id, route, route_version, trigger_id } = start.body;
        await this.event("decision.applied", String(decision_id), { route, route_version, trigger_id,
          acted: false, skipped: "interrupted" }, start.turn);
      }
    }
  }
  observe(message: Message): void {
    if (this.closed) return;
    for (const route of this.routes) {
      try {
        route.observe?.(message);
        const job = route.match(message);
        if (job) this.start(route, job);
      } catch (error) { this.failure = error instanceof Error ? error : new Error(String(error)); }
    }
  }
  supersede(group: string): void {
    for (const job of this.jobs.values()) if (job.group === group) job.controller.abort(new Error("superseded"));
  }
  async beforeTurn(turn: string, signal: AbortSignal): Promise<{ captured: boolean; captures: { route: string; state: Record<string, unknown> }[] }> {
    if (this.closed) return { captured: false, captures: [] };
    const results = await Promise.all(this.routes.map(async (route) => {
      const state = await route.beforeTurn?.(turn, signal);
      return state ? { route: route.id, state } : null;
    }));
    const captures = results.filter((result): result is NonNullable<typeof result> => result !== null);
    return { captured: captures.length > 0, captures };
  }
  private start(route: DecisionRoute, job: DecisionJob): void {
    const id = createHash("sha256").update(`${route.id}:${route.version}:${job.trigger.id}`).digest("hex").slice(0, 32);
    if (this.jobs.has(id) || this.router.ledger.retryMessage("service:reflex", `decision:${id}:started`)) return;
    if (job.group) this.supersede(job.group);
    const controller = new AbortController();
    // The microtask boundary installs the active job before collection/judgment can emit more messages.
    const task = Promise.resolve().then(() => this.run(route, job, id, controller.signal)).catch((error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }).finally(() => this.jobs.delete(id));
    this.jobs.set(id, { controller, group: job.group, task });
  }
  private async event(word: string, id: string, body: Record<string, unknown>, turn?: string): Promise<void> {
    await this.router.send({ ...decisionContext, ...(turn ? { turn } : {}) }, { to: null, kind: "event", word,
      body: { decision_id: id, ...body }, client_id: `decision:${id}:${word.slice(9)}` });
  }
  private async run(route: DecisionRoute, job: DecisionJob, id: string, signal: AbortSignal): Promise<void> {
    const meta = { route: route.id, route_version: route.version, trigger_id: job.trigger.id };
    await this.event("decision.started", id, { ...meta, evidence_ids: job.evidence,
      state_fingerprint: createHash("sha256").update(JSON.stringify(job.state)).digest("hex") }, job.turn);
    let verdict: DecisionVerdict | undefined;
    let result: DecisionEffect;
    const at = Date.now();
    try {
      if (signal.aborted || this.closed) throw signal.reason ?? new Error("closed");
      verdict = await job.judge(signal);
      await this.event("decision.judged", id, { ...meta, ...verdict, latency_ms: Math.max(0, Date.now() - at) }, job.turn);
      if (signal.aborted || this.closed) result = { acted: false, skipped: this.closed ? "closed" : "superseded" };
      else if (!await job.current()) result = { acted: false, skipped: "stale" };
      else result = await job.apply(verdict, id, signal);
    } catch (error) {
      const text = error instanceof Error ? `${error.name} ${error.message}` : "";
      result = { acted: false, skipped: this.closed ? "closed" : signal.aborted ? "superseded" :
        /timeout|abort/iu.test(text) ? "timeout" : /answer/iu.test(text) ? "invalid" : "unavailable" };
    }
    await this.event("decision.applied", id, { ...meta, ...(verdict ? { outcome: verdict.outcome } : {}), ...result }, job.turn);
    if (verdict && !this.closed) await job.finished?.(verdict, result);
  }
  async settled(): Promise<void> {
    while (this.jobs.size) await Promise.all([...this.jobs.values()].map((item) => item.task));
    if (this.failure) throw this.failure;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort(new Error("closed"));
    for (const route of this.routes) route.close?.();
    await this.settled();
  }
}
