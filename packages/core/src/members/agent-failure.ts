/**
 * What the owner hears when a turn that was answering them fails, and how a short "retry" reply is recognised.
 * The words are plain and short: what went wrong, whether anything was already done, and an offer to try again.
 */

/** The runtime's error for a turn cut off because Ash itself restarted. */
export const RESTART_ERROR = "Interrupted by process restart";
/** The option id of the retry button on a failure notice card. */
export const RETRY_OPTION = "retry";

/** The likely cause in plain words, never the raw provider payload. */
export function turnFailureCause(error: string | null | undefined): string {
  const text = String(error ?? "");
  if (/invalid JSON|tool input/i.test(text)) return "模型这次给出的操作指令格式坏了";
  if (/no model key/i.test(text)) return "还没有填模型的 Key（设置 → 密钥）";
  if (/runtime unavailable|Container runtime/i.test(text)) return "我的运行环境没能启动";
  if (/\b(401|403)\b|auth|api.?key|unauthori[sz]ed|forbidden/i.test(text)) return "模型那边没认我的 Key";
  if (/\b402\b|balance|insufficient|quota/i.test(text)) return "模型账户余额不足";
  if (/\b429\b|rate.?limit/i.test(text)) return "模型那边在限流";
  if (/time.?out|timed out|ETIMEDOUT|deadline/i.test(text)) return "等模型回应超时了";
  if (/\b5\d\d\b|overloaded|server error|bad gateway/i.test(text)) return "模型服务那边暂时出错了";
  if (/network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|offline|unreachable|socket|model call failed/i.test(text)) return "连不上模型";
  if (/Interrupted before turn completion/i.test(text)) return "Ash 内部出了点问题，中途断了";
  if (/cancel|abort/i.test(text)) return "做到一半被停下了";
  return "出了点意外的错误";
}

export interface TurnFailureNotice {
  /** The words in the conversation; null when the runtime already told the owner what went wrong. */
  text: string | null;
  /** The question on the retry card, and its one button. */
  prompt: string;
  option: string;
}

/**
 * steps: actions the failed turn had already started (tool calls, requests); replied: whether it had already said
 * something to the owner. told: the runtime already explained this failure to the owner itself.
 */
export function turnFailureNotice(error: string | null | undefined, done: { steps: number; replied: boolean }, told = false): TurnFailureNotice {
  const did = done.steps > 0 ? `出错前已经做了 ${done.steps} 步，可以在活动里查看。` : done.replied ? "" : "这次还什么都没做。";
  if (error === RESTART_ERROR) {
    const text = done.steps > 0 || done.replied
      ? `刚才那件事做到一半被打断了（Ash 重启）。${done.steps > 0 ? `已经做了 ${done.steps} 步，可以在活动里查看。` : ""}`
      : "刚才那件事还没开始做就被打断了（Ash 重启）。";
    return { text: told ? null : text, prompt: "要我接着做吗？", option: "接着做" };
  }
  return { text: told ? null : `刚才这件事没做成：${turnFailureCause(error)}。${did}`, prompt: "要我再试一次吗？", option: "重试" };
}

/** A reply that only asks to try the failed request again. */
export function isRetryText(text: unknown): boolean {
  return typeof text === "string" && /^(?:重试|再试|再试一次|再试试|再来一次|重来|接着做|继续做|retry)[。.!！~～]*$/iu.test(text.trim());
}
