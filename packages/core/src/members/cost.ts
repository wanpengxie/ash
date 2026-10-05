import type { Message, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import { WorldRouter, type RouteHandlerContext, type TrustedRouteContext } from "../world/router";

const service: TrustedRouteContext = { member: "service:cost", transport: "service", transportPrincipal: "service:cost",
  local: true, remote: false, ownerProxy: false };

/** What the DSH-side collector reports for one model call. Prices are applied here, in ash. */
export interface UsageRecord {
  at: number; ms: number; scope: string; provider: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; ok: boolean;
}

/** The DSH-world collector as ash sees it: a feed of measured calls, and the account balance. */
export interface UsageCollector {
  onUsage(listener: (record: UsageRecord) => void): () => void;
  balance(): Promise<unknown>;
}

export interface CostOptions {
  ledger: Ledger;
  router: WorldRouter;
  collector: UsageCollector;
  /** What one call cost in USD from the installed model catalog; null when no price is known. */
  price: (record: UsageRecord) => Promise<number | null>;
  timeZone?: string;
  now?: () => number;
  /** Where prices come from, recorded with each cost. */
  priceSource?: string;
}

const SCOPES = new Set(["chat", "mind", "background", "title", "compaction", "review", "progress", "other"]);

/**
 * The showing half of ash's cost centre. The DSH-world plugin measures every model call; this member prices it from the
 * installed catalog, writes one usage.recorded fact per call to the world, and answers the owner's usage and balance reads.
 */
export class CostMember implements Member {
  readonly id = "service:cost";
  readonly kind = "service" as const;
  readonly name = "Cost";
  readonly online = true;
  private readonly stop: () => void;
  private tail: Promise<void> = Promise.resolve();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: CostOptions) {
    this.stop = options.collector.onUsage((record) => {
      // One at a time keeps the world's order the order of measurement.
      const task = this.tail.then(() => this.record(record)).catch(() => {});
      this.tail = task;
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task));
    });
  }

  words(): readonly WordSpec[] { return ["usage.get", "balance.get"].map((word) => wordContract("service:cost", word)!); }

  private async record(record: UsageRecord): Promise<void> {
    let cost: number | null = null;
    try { cost = await this.options.price(record); } catch { cost = null; }
    await this.options.router.send(service, { to: null, kind: "event", word: "usage.recorded", body: {
      scope: SCOPES.has(record.scope) ? record.scope : "other", provider: record.provider, model: record.model,
      input_tokens: record.input, output_tokens: record.output, cache_read_tokens: record.cacheRead, cache_write_tokens: record.cacheWrite,
      cost_usd: cost, cost_source: cost === null ? null : this.options.priceSource ?? "dsh-bundled-model-catalog", ms: Math.max(0, Math.trunc(record.ms)), ok: record.ok, at: Math.max(0, Math.trunc(record.at)) } });
  }

  async handle(message: Message, _context: RouteHandlerContext): Promise<ResponseBody> {
    if (message.word === "usage.get") {
      const days = typeof message.body.days === "number" ? message.body.days : 7;
      await this.settle();
      return { ok: true, result: this.options.ledger.usageSummary(days, (this.options.now ?? Date.now)(), this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone) as unknown as Record<string, unknown> };
    }
    if (message.word === "balance.get") {
      try { return { ok: true, result: await this.options.collector.balance() as Record<string, unknown> }; }
      catch (error) { return { ok: false, error: { code: "failed", message: error instanceof Error ? error.message.slice(0, 160) : "balance unavailable" } }; }
    }
    return { ok: false, error: { code: "not_found", message: "cost word unavailable" } };
  }

  /** A read right after a call sees that call: wait for the records already measured. */
  private async settle(): Promise<void> { await Promise.allSettled([...this.pending]); }

  close(): void { this.stop(); }
}
