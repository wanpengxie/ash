import type { WorkerModel } from "../../core/src/workers/llm";
import type { DshHost } from "./host";

/** Uses the selected DSH provider without creating an agent or conversation session. */
export function dshWorkerModel(host: DshHost): WorkerModel {
  return {
    async complete(prompt, signal) {
      const model = host.agentOptions();
      const llm = host.ctx?.get("llm");
      if (!model || !llm?.stream) throw new Error("worker model unavailable");
      let text = "";
      let stopped = false;
      let toolOutput = false;
      for await (const chunk of llm.stream({ ...model, system: prompt.system,
        messages: [{ role: "user", content: [{ type: "text", text: prompt.user }] }],
        tools: [], maxTokens: 2048, signal })) {
        if (signal.aborted) throw new Error("worker cancelled");
        if (chunk.type === "text-delta") {
          text += chunk.text;
          if (text.length > 1_000_000) throw new Error("worker output too large");
        }
        if (chunk.type === "tool-call-delta" || (chunk.type === "block-start" && chunk.blockType === "tool-call")) toolOutput = true;
        if (chunk.type === "finish") stopped = chunk.reason?.kind === "stop";
      }
      return { text, finish: stopped && !toolOutput ? "stop" : "incomplete" };
    },
  };
}
