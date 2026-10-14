// The words the home pages say about keys, devices, the relay, spending and apps: plain functions of what the hub answered.
import { balanceText } from "./money.js";

export const QUIET_KEY = "delivery.quiet_hours";
export const QUIET_DEFAULT = "21:30-09:00";
export const QUIET_FORMAT = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

export const KEYS = [
  { ref: "DEEPSEEK_API_KEY", provider: "deepseek", title: "DeepSeek Key", lost: "对话模型的 DeepSeek Key", account: "对话模型的 DeepSeek 账户", effect: "她暂时无法对话" },
  { ref: "OPENROUTER_API_KEY", provider: "openrouter", title: "OpenRouter Key", lost: "快速判断的 OpenRouter Key", account: "快速判断的 OpenRouter 账户", effect: "快速判断只能靠关键词" },
];

/** What `service:llm/keys.status` says about one saved key, in words for the owner. `health` is undefined when the hub could not be asked. */
/** One line under a credential's name on the keys page: what kind, whose, and how it stands. */
export function vaultLine(entry) {
  const kind = { oauth: "连接", password: "密码", generated: "中枢生成的密钥" }[entry?.kind] ?? "密钥";
  const state = { waiting: "等你填", broken: "失效了，要重新连接", expiring: "快过期" }[entry?.status] ?? (entry?.configured ? "可用" : "还没有");
  return [kind, entry?.account || null, state].filter(Boolean).join(" · ");
}

export function keyStateText(health) {
  if (health?.status === "ok") return "已保存，已验证可用。";
  if (health?.status === "low_balance") return "已验证，但余额不足，她暂时无法对话。";
  if (health?.status === "rejected") return `已失效（${health.reason || "无效"}），请换一把新的 Key。`;
  if (health?.status === "unknown") return `已保存，暂时没验证上${health.reason ? `（${health.reason}）` : ""}。`;
  return "已保存。";
}

/** The saved keys that do not work, one plain sentence each: refused by the provider, or accepted but the account is out of balance. */
export function keyProblems(keys) {
  const list = Array.isArray(keys) ? keys : [];
  return KEYS.flatMap(({ provider, lost, effect, account }) => {
    const health = list.find((item) => item?.provider === provider);
    if (health?.configured !== true) return [];
    if (health.status === "rejected") return [`${lost} 已失效（${health.reason || "无效"}），${effect}。`];
    if (health.status === "low_balance") return [`${account}余额不足，${effect}。`];
    return [];
  });
}
export const KIND_NAMES = { computer: "电脑", laptop: "电脑", server: "服务器", browser: "浏览器" };
const PROVIDER_NAMES = { deepseek: "DeepSeek", openrouter: "OpenRouter" };

export const clock = (at) => {
  const d = new Date(Number(at));
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "";
};

/** The hand id behind a device id (`device:<hand>`), which `service:link` words name. */
/** A helper agent that has no name yet. */
export const HELPER = "一个帮手";

/** A plugin's package name as a reader can say it: no scope, no vendor prefix, words apart. */
export const pluginName = (name) => String(name).replace(/^@[^/]+\//, "").replace(/^(?:dsh|cordis)-(?:plugin-)?/, "").replace(/[-_/:]+/g, " ").trim() || String(name);

/** The service behind a model, in the name people know it by; the model's own code when it is not a known one. */
export function providerName(model) {
  const code = String(model ?? "");
  if (/^deepseek/i.test(code)) return "DeepSeek";
  if (/^(?:gpt|o\d|chatgpt)/i.test(code)) return "OpenAI";
  if (/^claude/i.test(code)) return "Claude";
  if (/^gemini/i.test(code)) return "Gemini";
  if (/^(?:qwen|qwq)/i.test(code)) return "通义千问";
  if (/^(?:kimi|moonshot)/i.test(code)) return "Kimi";
  if (/^glm/i.test(code)) return "智谱";
  return code;
}

/**
 * What the system itself keeps in her work folder, so it is not "her files" (the documents she made for the owner). The list is the
 * set of names the hub writes or reads there; a test checks it against the sources named here.
 *   AGENTS.md          the baseline instructions the DSH driver rewrites into the folder before every session
 *                      (edges/agents/dsh/driver.ts, BASELINE_FILE)
 *   SOUL.md, IDENTITY.md  her persona, seeded and changed through the persona member (services/semantic/persona.ts, PERSONA_FILES)
 *   PULSE.md           the guide she reads when woken for her pulse, seeded by the pulse service (services/semantic/pulse.ts, GUIDANCE)
 *   USER.md, MEMORY.md what she knows of the owner and of things; put into her context (edges/agents/modules.ts), kept by the
 *                      daily review (skills/daily-review)
 *   PROACTIVE.md       the owner's words on when she may reach out, written by the promises page
 *   skills/, memory/   the skills she has (modules.ts) and her diary, memory/YYYY-MM-DD.md (services/semantic/daily.ts)
 * Other capitalised files (README.md, SPEC.md, ACCEPTANCE.md…) are documents an agent wrote for a job, so they stay; names that
 * start with a dot are hidden by convention.
 */
export const SYSTEM_FILES = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "PULSE.md", "USER.md", "MEMORY.md", "PROACTIVE.md"];
export const SYSTEM_FOLDERS = ["skills", "memory"];

/** Whether an entry of her work folder is the system's own (see SYSTEM_FILES): a file by name, a folder by name. */
export const isSystemEntry = ({ name, type }) => name.startsWith(".") ||
  (type === "directory" ? SYSTEM_FOLDERS.includes(name) : SYSTEM_FILES.some((file) => file.toLowerCase() === name.toLowerCase()));

export const handOf = (device) => (typeof device === "string" ? device.replace(/^device:/, "") : "");

/** A device's diagnosis in plain words for the owner, not the raw record. */
export function deviceDiagnosis({ device = {}, connections = [], diagnosis = null } = {}) {
  const lines = [`${device.online ? "在线" : "离线"}${device.via === "gateway" ? "（经中转站）" : device.via === "local" ? "（和这台手机直连）" : ""}。`];
  if (!device.online && device.last_seen) lines.push(`上次在线：${clock(device.last_seen)}。`);
  if (connections.length) lines.push(`现在有 ${connections.length} 条连接。`);
  if (diagnosis) {
    const findings = Array.isArray(diagnosis.findings) ? diagnosis.findings.filter((finding) => typeof finding?.message === "string") : [];
    if (diagnosis.ok === true && !findings.length) lines.push("没有发现问题。");
    else lines.push(diagnosis.ok === true ? "提醒：" : "发现这些问题：", ...findings.map((finding) => `· ${finding.message}`));
  }
  return lines.join("\n");
}

/** The relay's state in one plain sentence (`service:link/gateway.status`). */
export function relayText(status) {
  if (!status || status.configured !== true) return "还没有设置中转站，其他设备暂时连不上。";
  const where = typeof status.url === "string" && status.url ? `（${status.url}）` : "";
  if (status.connected === true) return `中转站已连接${where}${status.account_email ? `，账号 ${status.account_email}` : ""}。`;
  const why = typeof status.last_error === "string" && status.last_error ? `：${status.last_error}` : "";
  return `中转站暂时连不上${where}${why}。会自动重试，也请检查网络和地址。`;
}

/** What the account balances answer says, with an unreadable provider named rather than shown as zero. */
export function balanceSentence(data) {
  const entries = Array.isArray(data?.balances) ? data.balances : [];
  const parts = [];
  let unavailable = false;
  for (const entry of entries) {
    const balance = entry?.balance;
    if (!balance || typeof balance !== "object") continue;
    if (balance.available === false) unavailable = true;
    const list = Array.isArray(balance.balances) ? balance.balances : [];
    const label = PROVIDER_NAMES[entry.provider] ?? entry.provider ?? "";
    for (const item of list) parts.push(`${label ? `${label} ` : ""}${balanceText(item)}`);
  }
  const failed = Object.keys(data?.errors ?? {}).map((provider) => PROVIDER_NAMES[provider] ?? provider);
  return `账户余额：${parts.join("，") || "无数据"}${unavailable ? "（账户当前不可用）" : ""}${failed.length ? `（${failed.join("、")} 暂时读不到）` : ""}`;
}

/** The time a quiet-hours setting names: "HH:MM-HH:MM", "" for none, or null when it cannot be read. */
export function quietOf(settings) {
  const value = settings?.[QUIET_KEY];
  if (value === undefined) return QUIET_DEFAULT;
  if (value === "") return "";
  return typeof value === "string" && QUIET_FORMAT.test(value) ? value : null;
}

/** 启用 / 停用 / 未授权, and whether it is actually running. */
export function appState(app) {
  if (appBroken(app)) return "出错了";
  if (app.granted !== true) return "未授权";
  if (app.enabled !== true) return "已停用";
  return app.running === true ? "已启用 · 运行中" : "已启用 · 还没运行起来";
}

/** An app whose app.json cannot be read or does not pass: not one that wants in, and it cannot be installed or opened. (An older hub gave no kind: a not-yet-installed app with an error is such a one.) */
export function appBroken(app) {
  const error = typeof app.error === "string" && app.error.trim() !== "";
  return app.problem === "manifest" || (!app.problem && error && app.granted !== true);
}

/** What the owner reads about an app's trouble — what happened, why, what can be done — or null. Never the hub's own line (it names files and parser errors). */
export function appTrouble(app) {
  if (typeof app.error !== "string" || app.error.trim() === "") return null;
  if (appBroken(app)) return app.granted === true ? "这个应用的说明文件写得不对，打不开；可以点「收回全部权限」把它卸掉。" : "这个应用的说明文件写得不对，装不了；让她帮你改好，改好之后它会出现在这里。";
  if (app.problem === "folder") return "这个应用的文件夹已经不在了，只剩安装记录；可以点「收回全部权限」把它卸掉。";
  return "这个应用没能正常跑起来；重新打开试试，还不行可以让她看看原因，或点「收回全部权限」把它卸掉。";
}

/** The home row's line: how many apps, how many on. */
export function appsSummary(apps) {
  if (!apps.length) return "还没有应用";
  const on = apps.filter((app) => app.granted === true && app.enabled === true).length;
  return `${apps.length} 个应用 · ${on ? `${on} 个已启用` : "都没启用"}`;
}
