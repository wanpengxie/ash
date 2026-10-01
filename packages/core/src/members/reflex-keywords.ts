/** No-Key fallback: whole, explicit commands only. A substring hit is never permission to stop a turn. */
const explicitStop = new Set([
  "停", "停下", "停了", "别发", "别发了", "先别", "先别发", "算了", "取消", "等等", "打住", "不用了", "不要发", "不要发了",
  "stop", "wait",
]);

export interface KeywordJudgement { intent: "stop" | "unclear" | "unrelated"; confidence: number }

export function judgeStopKeyword(input: string): KeywordJudgement {
  if (typeof input !== "string") return { intent: "unrelated", confidence: 0 };
  const text = input.normalize("NFKC").trim().replace(/[。！!？?.,，]+$/u, "").trim().toLowerCase();
  if ([...text].length <= 6 && explicitStop.has(text)) return { intent: "stop", confidence: 1 };
  return /停|别|算了|取消|等等|打住|不用了|不要发|\bstop\b|\bwait\b/iu.test(text)
    ? { intent: "unclear", confidence: 0 } : { intent: "unrelated", confidence: 0 };
}
