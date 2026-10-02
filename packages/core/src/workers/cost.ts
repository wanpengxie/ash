import type { WorkerName } from "../../../sdk/src/api";
import type { Ledger } from "../world/ledger";

/** Provider-reported counts only. A missing price is unknown, never zero. */
export interface WorkerUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Estimate from the exact installed DSH model catalog; absent means unknown. */
  costUsd?: number;
}

export interface WorkerRates { input: number; output: number; cacheRead: number; cacheWrite: number;
  tiers?: readonly (WorkerRates & { inputTokensAbove: number })[] }

/** Provider usage counts are disjoint, as specified by DSH's TokenUsage. Rates are USD per million tokens. */
export function estimateWorkerCost(usage: WorkerUsage, modelCost: WorkerRates): number | null {
  const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) return null;
  let rates: WorkerRates = modelCost;
  let matched = -1;
  const totalInput = counts[0]! + counts[2]! + counts[3]!;
  for (const tier of modelCost.tiers ?? []) if (totalInput > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
    rates = tier;
    matched = tier.inputTokensAbove;
  }
  const prices = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];
  if (prices.some((price) => !Number.isFinite(price) || price < 0)) return null;
  return counts.reduce((sum, count, index) => sum + count! * prices[index]!, 0) / 1_000_000;
}

export function recordWorkerUsage(ledger: Ledger, worker: WorkerName, request: string, attempt: number, usage: WorkerUsage): void {
  ledger.append({ from: `worker:${worker}`, to: null, kind: "event", word: "worker.usage", body: {
    request, attempt, provider: usage.provider, model: usage.model,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens ?? 0, cache_write_tokens: usage.cacheWriteTokens ?? 0,
    cost_usd: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null,
    cost_source: typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? "dsh-bundled-model-catalog" : null,
  } });
}
