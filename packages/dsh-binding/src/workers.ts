import type { WorkerModel } from "../../core/src/workers/llm";
import { estimateWorkerCost, type WorkerUsage } from "../../core/src/workers/cost";
import type { WorldConfigV2 } from "../../sdk/src/config";
import type { DshHost } from "./host";

export const WORKER_MAX_TOKENS = 16_384;

/** Uses the selected DSH provider without creating an agent or conversation session. */
export function dshWorkerModel(host: DshHost, configuredModel: () => WorldConfigV2["workers"]["model"]): WorkerModel {
  return {
    async complete(prompt, signal) {
      const setting = configuredModel();
      if (setting === undefined) throw new Error("worker model setting unavailable");
      const model = setting === null ? host.agentOptions() : setting;
      if (!model || typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim()) throw new Error("worker model unavailable");
      const llm = host.ctx?.get("llm");
      if (!llm?.stream) throw new Error("worker model service unavailable");
      let text = "";
      let stopped = false;
      let toolOutput = false;
      let usage: WorkerUsage | undefined;
      for await (const chunk of llm.stream({ ...model, system: prompt.system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
        // Reasoning models spend part of this on thinking; 2048 truncated extract output on the phone.
        tools: [], maxTokens: WORKER_MAX_TOKENS, signal })) {
        if (signal.aborted) throw new Error("worker cancelled");
        if (chunk.type === "text-delta") {
          text += chunk.text;
          if (text.length > 1_000_000) throw new Error("worker output too large");
        }
        if (chunk.type === "tool-call-delta" || (chunk.type === "block-start" && chunk.blockType === "tool-call")) toolOutput = true;
        if (chunk.type === "usage" && Number.isSafeInteger(chunk.usage?.inputTokens) && Number.isSafeInteger(chunk.usage?.outputTokens)) {
          usage = { provider: model.provider, model: model.model, inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens,
            cacheReadTokens: chunk.usage.cacheReadTokens ?? 0, cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0 };
        }
        if (chunk.type === "finish") stopped = chunk.reason?.kind === "stop";
      }
      if (usage && host.modelRates) {
        const rates = await host.modelRates(model.provider, model.model);
        const cost = rates && estimateWorkerCost(usage, rates);
        if (cost !== null && cost !== undefined) usage.costUsd = cost;
      }
      return { text, finish: stopped && !toolOutput ? "stop" : "incomplete", ...(usage ? { usage } : {}) };
    },
  };
}
