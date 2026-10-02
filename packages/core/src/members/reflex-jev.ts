/** Small typed JEV client for the second-stage stop judgement. No credential is written to the ledger. */
export interface JevReflexState {
  current_task: string;
  latest_user_message: string;
  recent_messages: string[];
}

export interface JevReflexDecision { intent: "stop" | "unrelated"; confidence: number }

const questions = {
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
  constructor(private readonly url: string, private readonly key: string, private readonly timeoutMs = 1000,
    private readonly fetchImpl: typeof fetch = fetch) {
    if (!url || !key || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("JEV configuration unavailable");
  }

  async judge(state: JevReflexState): Promise<JevReflexDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result: { answers?: { intent?: { choice?: unknown; confidence?: unknown };
      targets_current?: { noul?: unknown }; urgency?: { score?: unknown } } };
    try {
      const response = await this.fetchImpl(this.url, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.url.includes("openrouter.ai/") ? "typesafe/jev-1.13" : "jev-latest",
        state, questions,
      }), signal: controller.signal });
      if (!response.ok) throw new Error("JEV unavailable");
      result = await response.json() as typeof result;
    } finally { clearTimeout(timer); }
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
