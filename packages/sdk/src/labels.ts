/** Display-only labels. Tool names and arguments are never a status sentence. */
export const STATUS_FALLBACK_LABEL = "在忙";

const nativeLabels: Readonly<Record<string, string>> = Object.freeze({
  bash: "在跑命令",
  read: "在看文件",
  write: "在写文件",
  edit: "在写文件",
  web_search: "在搜索",
  web_fetch: "在看网页",
  subagent: "在找帮手",
});

/** The native namespace is display-only; it does not register a callable member. */
export function statusLabel(member: string, word: string, declared?: string): string {
  if (member === "native") return Object.hasOwn(nativeLabels, word) ? nativeLabels[word] : STATUS_FALLBACK_LABEL;
  const label = declared?.trim();
  if (!label || /[\p{Cc}\p{Cf}]/u.test(label) || label === "Working" || label === word || label === `${member}/${word}` ||
    (label.includes(":") && !/\s/.test(label)) || (label.includes("_") && !/\s/.test(label))) return STATUS_FALLBACK_LABEL;
  return [...label].slice(0, 80).join("");
}
