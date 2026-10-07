import { complete } from "@mariozechner/pi-ai";
import type { WorkerModel } from "../../core/src/workers/llm";
import type { WorkerUsage } from "../../core/src/workers/cost";
import { DEEPSEEK_DEFAULT_MODEL, catalogProvider, resolveModel } from "../../core/src/workers/deepseek-model";

export { catalogProvider };
export const WORKER_MAX_TOKENS = 16_384;

/** USD-per-million rates from pi-ai's model catalog (and the DeepSeek models it does not list yet), or null when the model is unknown. */
export function catalogRates(provider: string, model: string): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  try { return resolveModel(provider, model)?.cost ?? null; } catch { return null; }
}

/**
 * Background judgement steps (memory, proactive, heartbeat...) as single model calls in ash itself, with the vault key.
 * They need no agent runtime, no tools and no session.
 */
export function piWorkerModel(key: () => string | null, configured: () => { provider: string; model: string } | null | undefined): WorkerModel {
  return {
    async complete(prompt, signal) {
      const setting = configured() ?? { provider: "deepseek", model: DEEPSEEK_DEFAULT_MODEL };
      const provider = catalogProvider(setting.provider);
      const apiKey = key();
      if (!apiKey) throw new Error("worker model unavailable: no API key");
      const model = resolveModel(provider, setting.model);
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
