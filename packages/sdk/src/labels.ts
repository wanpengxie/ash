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
  glob: "在找文件",
  grep: "在找文件",
  skill: "在翻手册",
  mcp__ash__human_say: "在回你",
  mcp__ash__human_notify: "在提醒你",
  mcp__ash__human_ask: "在问你",
  mcp__ash__human_show: "在给你看",
  mcp__ash__human_confirm: "在等你确认",
  mcp__ash__capability_list: "在查能做什么",
  mcp__ash__capability_describe: "在查怎么做",
  mcp__ash__capability_call: "在动手",
  mcp__ash__await_result: "在等结果",
  mcp__ash__history_query: "在翻聊天记录",
  mcp__ash__timer_set: "在定提醒",
  mcp__ash__system_status: "在看时间",
});

const clean = (value: string, max: number) => {
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max).join("")}…` : text;
};

/**
 * Where she is looking, for the two web tools only: the site she opened, or what she searched for.
 * Only the host of a fetched page is shown, never its path or query, which can carry tokens.
 */
export function nativeDetailLabel(word: string, args: unknown): string | null {
  let parsed: unknown = args;
  if (typeof args === "string") { try { parsed = JSON.parse(args); } catch { return null; } }
  if (!parsed || typeof parsed !== "object") return null;
  const input = parsed as { url?: unknown; queries?: unknown; query?: unknown };
  if (word === "web_fetch" && typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      return host ? `${nativeLabels.web_fetch} · ${clean(host, 60)}` : null;
    } catch { return null; }
  }
  if (word === "web_search") {
    const query = Array.isArray(input.queries) ? input.queries.find((item) => typeof item === "string" && item.trim()) : input.query;
    return typeof query === "string" && clean(query, 30) ? `${nativeLabels.web_search} · ${clean(query, 30)}` : null;
  }
  return null;
}

/** The native namespace is display-only; it does not register a callable member. */
export function statusLabel(member: string, word: string, declared?: string): string {
  if (member === "native") return Object.hasOwn(nativeLabels, word) ? nativeLabels[word] : STATUS_FALLBACK_LABEL;
  const label = declared?.trim();
  if (!label || /[\p{Cc}\p{Cf}]/u.test(label) || label === "Working" || label === word || label === `${member}/${word}` ||
    (label.includes(":") && !/\s/.test(label)) || (label.includes("_") && !/\s/.test(label))) return STATUS_FALLBACK_LABEL;
  return [...label].slice(0, 80).join("");
}

/** The site of a page she is opening in her browser, next to the action's own label. Only the host, never path or query. */
export function pageDetailLabel(label: string, body: unknown): string | null {
  const input = body && typeof body === "object" ? body as { url?: unknown; steps?: unknown } : {};
  // A browser script names its page in its first open step.
  const url = input.url ?? (Array.isArray(input.steps) ? (input.steps.find((step) => step && typeof step === "object" && typeof (step as { url?: unknown }).url === "string") as { url?: unknown } | undefined)?.url : undefined);
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host ? `${clean(label, 40)} · ${clean(host, 60)}` : null;
  } catch { return null; }
}
