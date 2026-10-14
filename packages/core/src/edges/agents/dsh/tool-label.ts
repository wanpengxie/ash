/**
 * What the owner sees for one tool call of DSH: a short human line, never the tool's own name. DSH (0.2) puts the raw tool name
 * in the ACP `title` and always `other` in `kind`, so the name decides; `kind` is only the fallback for a runtime that fills it.
 * Ash's own tools reach DSH through the MCP server `ash` as `mcp__ash__<tool>`.
 */
import { wordContract } from "../../../../../sdk/src/words";

/** What nothing below can name. */
export const GENERIC_STEP = "在处理";

const BY_KIND: Record<string, string> = {
  execute: "在跑命令", read: "在读文件", edit: "在改文件", delete: "在改文件", move: "在改文件", search: "在找东西", fetch: "在看网页", think: "在想",
};

/** DSH's own tools, by name. */
const DSH_TOOLS: Record<string, string> = {
  bash: "在跑命令", pwsh: "在跑命令", terminal_open: "在跑命令", terminal_send: "在跑命令", terminal_read: "在跑命令", terminal_signal: "在跑命令", terminal_close: "在跑命令", terminal_list: "在跑命令",
  job_list: "在看后台任务", job_output: "在看后台任务", job_kill: "在看后台任务",
  read: "在读文件", read_image: "在读文件",
  write: "在改文件", edit: "在改文件", str_replace_editor: "在改文件",
  grep: "在找东西", glob: "在找东西", lsp: "在找东西",
  session_search: "在翻记录", session_trace: "在翻记录", session_event_read: "在翻记录", session_event_search: "在翻记录", session_event_trace: "在翻记录",
  web_fetch: "在看网页", web_search: "在上网查",
  todo_write: "在整理计划", create_goal: "在整理计划", update_goal: "在整理计划", get_goal: "在整理计划", ralph: "在整理计划", plan: "在整理计划",
  ask_user_question: "在问你", present: "在整理要给你看的内容", skill: "在查技能",
  schedule_create: "在设提醒", schedule_update: "在设提醒", schedule_delete: "在设提醒", schedule_list: "在设提醒",
  spawn_teammate: "在和别的 agent 协作", send_message: "在和别的 agent 协作", wait_agent: "在和别的 agent 协作", list_agents: "在和别的 agent 协作",
  interrupt_agent: "在和别的 agent 协作", team_task_create: "在和别的 agent 协作", team_task_get: "在和别的 agent 协作", team_task_list: "在和别的 agent 协作", team_task_update: "在和别的 agent 协作",
};

/** Ash's own tools (the part after `mcp__ash__`), by exact name or by the family they belong to. */
const ASH_TOOLS: Record<string, string> = {
  human_say: "在回你", human_show: "在给你看东西", human_ask: "在问你", human_confirm: "在问你",
  history_query: "在翻记录", system_status: "在看系统状态",
  capability_list: "在看有哪些能力", capability_describe: "在看有哪些能力",
  await_result: "在等结果", list_pending: "在等结果", cancel: "在取消一件事",
};
const ASH_FAMILIES: [prefix: string, label: string][] = [
  ["human_pending", "在看待你确认的事"], ["human_withdraw", "在看待你确认的事"],
  ["timer_", "在设提醒"], ["approval_", "在看审批设置"], ["agent_", "在和别的 agent 协作"], ["vault_", "在看保管的东西"], ["device_", "在用手机/设备能力"],
];

/** The tool of the ash MCP server a title names, or undefined when it is not one of ash's. */
function ashTool(title: string): string | undefined {
  const m = /^mcp__ash__(.+)$/.exec(title);
  return m ? m[1] : undefined;
}

/** The called word's own contract label, when the call carries which word it is. */
function calledWord(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const { member, word } = rawInput as { member?: unknown; word?: unknown };
  if (typeof member !== "string" || typeof word !== "string") return undefined;
  return wordContract(member, word)?.label.doing || undefined;
}

const MAX = 48;
/** One line, at most MAX characters. */
const clip = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX ? `${one.slice(0, MAX - 1)}…` : one;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const base = (path: string): string => path.replace(/\/+$/, "").split("/").pop() || path;
const host = (url: string): string => { try { return new URL(url).host; } catch { return url; } };

/** What this call is about, from its arguments: the step the owner can check, not just its kind. */
function detail(name: string, input: Record<string, unknown>): string | undefined {
  switch (name) {
    case "bash": case "pwsh": case "terminal_send": {
      const said = str(input.description);
      if (said) return clip(said);
      const command = str(input.command) ?? str(input.input);
      return command ? clip(`跑 ${command}`) : undefined;
    }
    case "read": case "read_image": { const p = str(input.file_path) ?? str(input.path); return p ? clip(`读 ${base(p)}`) : undefined; }
    case "write": case "edit": case "str_replace_editor": { const p = str(input.file_path) ?? str(input.path); return p ? clip(`改 ${base(p)}`) : undefined; }
    case "grep": case "glob": { const q = str(input.pattern) ?? str(input.query); return q ? clip(`找 ${q}`) : undefined; }
    case "web_fetch": { const u = str(input.url); return u ? clip(`看网页 ${host(u)}`) : undefined; }
    case "web_search": { const q = str(input.query); return q ? clip(`搜 ${q}`) : undefined; }
    case "skill": { const n = str(input.name); return n ? clip(`查技能 ${n}`) : undefined; }
    case "job_output": case "job_kill": { const j = str(input.job_id); return j ? clip(`看后台任务 ${j}`) : undefined; }
    default: return undefined;
  }
}

/** One line for a tool call: `title` is DSH's tool name, `kind` the ACP kind, `rawInput` the call's arguments. */
export function toolSummary(title: string | undefined, kind?: unknown, rawInput?: unknown): string {
  const name = (title ?? "").trim();
  const input = rawInput && typeof rawInput === "object" ? rawInput as Record<string, unknown> : {};
  const ash = ashTool(name);
  if (ash !== undefined) {
    // The agent says what the call is for (purpose); that is the most telling line. Else the word's own label.
    const purpose = str(input.purpose);
    if (ash === "capability_call") return purpose ? clip(purpose) : calledWord(rawInput) ?? "在用手机/设备能力";
    if (purpose) return clip(purpose);
    return ASH_TOOLS[ash] ?? ASH_FAMILIES.find(([prefix]) => ash.startsWith(prefix))?.[1] ?? GENERIC_STEP;
  }
  if (name.startsWith("mcp__")) return GENERIC_STEP; // a plugin's tool: its name is not for the owner either
  return detail(name, input) ?? DSH_TOOLS[name] ?? (typeof kind === "string" ? BY_KIND[kind] : undefined) ?? GENERIC_STEP;
}
