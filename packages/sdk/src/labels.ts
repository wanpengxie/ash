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
  mcp__ash__timer_list: "在看提醒",
  mcp__ash__timer_cancel: "在取消提醒",
  mcp__ash__vault_list: "在看保存的密钥",
  mcp__ash__vault_describe: "在看保存的密钥",
  mcp__ash__approval_log: "在查审批记录",
  mcp__ash__approval_rules: "在看审批规则",
  mcp__ash__approval_rule_add: "在申请新增审批规则",
  mcp__ash__approval_rule_remove: "在申请撤销审批规则",
  mcp__ash__approval_mode_set: "在申请改审批档位",
  mcp__ash__agent_list: "在看有哪些帮手",
  mcp__ash__agent_describe: "在看帮手",
  mcp__ash__agent_ask: "在问帮手",
  mcp__ash__agent_tell: "在告诉帮手",
  mcp__ash__agent_create: "在新建帮手",
  mcp__ash__agent_update: "在调整帮手",
  mcp__ash__agent_start: "在启动帮手",
  mcp__ash__agent_stop: "在停下帮手",
  mcp__ash__agent_restart: "在重启帮手",
  mcp__ash__agent_remove: "在删除帮手",
  mcp__ash__agent_runtimes: "在查能在哪儿开帮手",
  mcp__ash__human_pending: "在核对待回复的事",
  mcp__ash__human_pending_get: "在看原问题与回答",
  mcp__ash__human_pending_redeem: "在执行你批准的事",
  mcp__ash__human_pending_skip: "在说明为何不再继续",
  mcp__ash__human_withdraw: "在撤回问题",
  mcp__ash__list_pending: "在看还没完的事",
  mcp__ash__cancel: "在取消",
});

/** What she is doing with one of Ash's own services, in the status line's "在…" voice (the declared label is the action's name). */
const serviceLabels: Readonly<Record<string, string>> = Object.freeze({
  "service:agents/list": "在看有哪些帮手",
  "service:agents/runtimes": "在查能在哪儿开帮手",
  "service:agents/threads": "在看交出去的事",
  "service:agents/thread.stop": "在停下交出去的事",
  "service:agents/describe": "在看帮手",
  "service:agents/ask": "在问帮手",
  "service:agents/tell": "在告诉帮手",
  "service:agents/answer": "在回答",
  "service:agents/declare": "在新建帮手",
  "service:agents/update": "在调整帮手",
  "service:agents/start": "在启动帮手",
  "service:agents/stop": "在停下帮手",
  "service:agents/restart": "在重启帮手",
  "service:agents/remove": "在删除帮手",
  "service:clock/set": "在定提醒",
  "service:clock/list": "在看提醒",
  "service:clock/cancel": "在取消提醒",
  "service:vault/list": "在看保存的密钥",
  "service:vault/describe": "在看保存的密钥",
  "service:widgets/widget.list": "在看桌面小组件",
  "service:widgets/widget.card.put": "在更新桌面卡片",
  "service:widgets/widget.card.get": "在看桌面卡片的内容",
  "service:widgets/widget.card.preview": "在看桌面卡片的样子",
  "service:widgets/widget.card.validate": "在检查桌面卡片",
  "service:widgets/widget.card.remove": "在移除桌面卡片",
  "service:widgets/widget.bind": "在选小组件显示的卡片",
  "service:pulse/pulse.get": "在看主动更新的安排",
  "service:pulse/pulse.set": "在改主动更新的安排",
  "service:pulse/pulse.history": "在看主动更新的记录",
  "service:pulse/pulse.note": "在记下这次做了什么",
  "service:pulse/pulse.fire": "在试一次主动更新",
  "service:pulse/pulse.switch": "在开关主动更新",
  "service:apps/apps.list": "在看有哪些应用",
  "service:apps/apps.describe": "在看应用详情",
  "service:apps/apps.install": "在申请安装应用",
  "service:apps/apps.enable": "在申请启用应用",
  "service:apps/apps.disable": "在停用应用",
  "service:apps/apps.revoke": "在收回应用的权限",
  "service:apps/apps.refresh": "在查找新应用",
  "service:cost/usage.get": "在看用量",
  "service:cost/balance.get": "在看余额",
  "service:gate/audit": "在查审批记录",
  "service:gate/history": "在查审批记录",
  "service:gate/rules.list": "在看审批规则",
  "service:gate/rules.set": "在申请新增审批规则",
  "service:gate/rules.revoke": "在申请撤销审批规则",
  "service:gate/mode.set": "在申请改审批档位",
  "service:self/read": "在看资料",
  "service:self/write": "在改资料",
  "service:self/append": "在记日志",
  "service:self/apply_plan": "在改资料",
  "service:self/rollback": "在撤回改动",
  "service:self/history": "在看改动记录",
  "service:work/run": "在做后台任务",
  "service:work/runs": "在看后台任务",
});

/** The plain status for one of Ash's own service words, or null for anything else. */
export function serviceLabel(member: string, word: string): string | null {
  const key = `${member}/${word}`;
  return Object.hasOwn(serviceLabels, key) ? serviceLabels[key]! : null;
}

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
  // Ash's own service words read in the status voice; everything else keeps its declared label.
  const own = serviceLabel(member, word);
  if (own) return own;
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
