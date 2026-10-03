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
