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
}

export function recordWorkerUsage(ledger: Ledger, worker: WorkerName, request: string, attempt: number, usage: WorkerUsage): void {
  ledger.append({ from: `worker:${worker}`, to: null, kind: "event", word: "worker.usage", body: {
    request, attempt, provider: usage.provider, model: usage.model,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens ?? 0, cache_write_tokens: usage.cacheWriteTokens ?? 0,
    cost_usd: null,
  } });
}
