/** Stateless transport shared by all peripheral decision routes. */
export interface DecisionModel {
  available?(): boolean;
  evaluate(state: unknown, questions: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export class JevClient implements DecisionModel {
  constructor(private readonly url: string, private readonly key: string, private readonly timeoutMs = 6000,
    private readonly fetchImpl: typeof fetch = fetch, private readonly model = url.includes("openrouter.ai/") ? "typesafe/jev-1.13" : "jev-latest") {
    if (!url || !key || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("JEV configuration unavailable");
  }
  async evaluate(state: unknown, questions: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("JEV timeout")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
      if (!response.ok) throw new Error("JEV unavailable");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result) || JSON.stringify(result).length > 64 * 1024)
        throw new Error("JEV answer unavailable");
      return result;
    } finally { clearTimeout(timer); }
  }
}

export function choiceAnswer(raw: unknown, name: string, choices: readonly string[]): { choice: string; confidence: number } {
  const answer = (raw as { answers?: Record<string, { choice?: unknown; confidence?: unknown }> } | null)?.answers?.[name];
  if (!answer || typeof answer.choice !== "string" || !choices.includes(answer.choice) ||
    typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)
    throw new Error("JEV answer unavailable");
  return { choice: answer.choice, confidence: answer.confidence };
}
