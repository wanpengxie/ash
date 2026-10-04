import { JevClient, type DecisionModel } from "../world/decision/jev";
/** Compatibility adapter for the conversation route; transport is shared by all routes. */
export interface JevReflexState {
  current_task: string;
  latest_user_message: string;
  recent_messages: string[];
}

export interface JevReflexDecision { intent: "stop" | "unrelated"; confidence: number }

export const conversationQuestions = {
  intent: { type: "choice", instructions: "Classify the new message in relation to the current task.", criteria: {
    stop_all: "Stop all ongoing work.", stop_current: "Stop the current action.", wait: "Pause briefly.",
    redirect: "Change the direction of the task.", unrelated: "No control instruction for the current task.",
  } },
  targets_current: { type: "noul", instructions: "Probability that the message refers to the current task." },
  urgency: { type: "score", instructions: "Urgency of the control instruction, from 0 to 3.",
    criteria: ["No immediate action needed", "Can wait until the current turn finishes",
      "Stop after the current action", "Stop immediately"] },
};

export class JevReflexClient {
  private readonly model: DecisionModel;
  constructor(url: string, key: string, timeoutMs = 6000, fetchImpl: typeof fetch = fetch, model?: DecisionModel) {
    this.model = model ?? new JevClient(url, key, timeoutMs, fetchImpl);
  }

  async judge(state: JevReflexState, signal?: AbortSignal): Promise<JevReflexDecision> {
    const result = await this.model.evaluate(state, conversationQuestions, signal) as { answers?: { intent?: { choice?: unknown; confidence?: unknown };
      targets_current?: { noul?: unknown }; urgency?: { score?: unknown } } };
    const choice = result.answers?.intent?.choice;
    const confidence = result.answers?.intent?.confidence;
    const target = result.answers?.targets_current?.noul;
    if (!["stop_all", "stop_current", "wait", "redirect", "unrelated"].includes(String(choice)) ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      typeof target !== "number" || !Number.isFinite(target) || target < 0 || target > 1)
      throw new Error("JEV answer unavailable");
    const stop = choice === "stop_all" || choice === "stop_current" || choice === "wait";
    return { intent: stop ? "stop" : "unrelated", confidence: choice === "stop_all" ? confidence : Math.min(confidence, target) };
  }
}
