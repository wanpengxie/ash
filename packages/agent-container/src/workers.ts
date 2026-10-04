import { complete, getModel } from "@mariozechner/pi-ai";
import type { WorkerModel } from "../../core/src/workers/llm";
import type { WorkerUsage } from "../../core/src/workers/cost";

export const WORKER_MAX_TOKENS = 16_384;

/** pi-ai files DeepSeek's own API under "deepseek"; ash's agent profile calls the same route "deepseek-official". */
export const catalogProvider = (provider: string) => provider === "deepseek-official" ? "deepseek" : provider;

/** USD-per-million rates from pi-ai's model catalog, or null when the model is unknown. */
export function catalogRates(provider: string, model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  try {
    const found = getModel(catalogProvider(provider) as "deepseek", model as "deepseek-v4-flash") as { cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } } | undefined;
    return found?.cost ?? null;
  } catch { return null; }
}

/**
 * Background judgement steps (memory, proactive, heartbeat...) as single model calls in ash itself, with the vault key.
 * They need no agent runtime, no tools and no session.
 */
export function piWorkerModel(key: () => string | null, configured: () => { provider: string; model: string } | null | undefined): WorkerModel {
  return {
    async complete(prompt, signal) {
      const setting = configured() ?? { provider: "deepseek", model: "deepseek-v4-flash" };
      const provider = catalogProvider(setting.provider);
      const apiKey = key();
      if (!apiKey) throw new Error("worker model unavailable: no API key");
      const model = getModel(provider as "deepseek", setting.model as "deepseek-v4-flash");
      if (!model) throw new Error(`worker model unavailable: ${provider}/${setting.model}`);
      const reply = await complete(model, { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] },
        { apiKey, signal, maxTokens: WORKER_MAX_TOKENS });
      if (signal.aborted) throw new Error("worker cancelled");
      if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? "worker model failed");
      const text = reply.content.filter((block) => block.type === "text").map((block) => (block as { text: string }).text).join("");
      const usage: WorkerUsage = { provider: setting.provider, model: setting.model, inputTokens: reply.usage.input, outputTokens: reply.usage.output,
        cacheReadTokens: reply.usage.cacheRead, cacheWriteTokens: reply.usage.cacheWrite,
        ...(Number.isFinite(reply.usage.cost.total) && reply.usage.cost.total >= 0 ? { costUsd: reply.usage.cost.total } : {}) };
      const toolOutput = reply.content.some((block) => block.type === "toolCall");
      return { text, finish: reply.stopReason === "stop" && !toolOutput ? "stop" : "incomplete", usage };
    },
  };
}
