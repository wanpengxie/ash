/** One display vocabulary for the activity page and the native task capsule. No authority lives here. */
import { serviceLabel, statusLabel } from "./labels";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function redactActivityText(text: string): string {
  return text.replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk_[A-Za-z0-9_-]{12,})\b/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|(?:(?:access|refresh|id)[_-]?)?token|password|secret|authorization|验证码|密码)\s*[=:：]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&]+)/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏]@");
}
export const activityText = (v: unknown, max = 100): string => typeof v === "string"
  ? [...redactActivityText(v).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("") : "";

/** Owner-only, on-demand detail. This is deliberately not transported to the capsule. */
export function activityDetail(value: unknown): string {
  const secret = /token|password|secret|authorization|cookie|api.?key|credential|验证码|密码/i;
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 20) return "[嵌套过深]";
    if (typeof v === "string") {
      try { const parsed = JSON.parse(v); if (parsed && typeof parsed === "object") return walk(parsed, depth + 1); } catch {}
      return redactActivityText(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, secret.test(k) ? "[已隐藏]" : walk(x, depth + 1)]));
    return v;
  };
  return JSON.stringify(walk(value), null, 2);
}

const labels: Record<string, string> = {
  "screen.read": "读取当前页面", "screen.see": "查看屏幕内容", "screen.screenshot": "获取屏幕截图",
  "screen.tap": "点击页面控件", "screen.type": "填写页面内容", "screen.scroll": "滚动页面", "screen.swipe": "滑动页面",
  "screen.global_action": "切换页面", "apps.open": "打开应用", "browser.open": "打开网页", "browser.read": "读取网页",
  "browser.click": "点击网页控件", "browser.type": "填写网页内容", "browser.run": "执行网页操作",
  "vscreen.create": "创建后台屏幕", "vscreen.launch": "在后台打开应用", "vscreen.see": "查看后台页面",
  "vscreen.tap": "操作后台页面", "vscreen.type": "填写后台页面", "vscreen.close": "关闭后台屏幕",
  bash: "执行命令（未提供用途）", "shell.run": "执行命令（未提供用途）", read: "读取文件", write: "写入文件",
  edit: "修改文件", glob: "查找文件", grep: "搜索文件内容", web_search: "搜索资料", web_fetch: "读取网页", subagent: "委派子任务",
};
export interface ActivityAction {
  label: string; tool: string; target: string; purpose: boolean; native: boolean;
  member: string; signature: string; wrapper: boolean; polling: boolean;
}
function signature(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  // Correlation hint only; never an authorization hash. Keep argument values out of display projections.
  let a = 2166136261, b = 5381;
  for (const c of JSON.stringify(stable(value))) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0); }
  return `${a >>> 0}:${b >>> 0}`;
}
export function activityAction(to: string, word: string, raw: unknown): ActivityAction {
  const native = to === "service:dsh-tool";
  let args = object(raw), member = to, tool = word, wrapper = false;
  if (native) { try { args = object(JSON.parse(String(args.arguments ?? "{}"))); } catch { args = {}; } }
  const purpose = activityText(args.purpose || args.description);
  if (native && word === "mcp__ash__capability_call") { wrapper = true; member = String(args.member ?? ""); tool = String(args.word ?? word); args = object(args.body); }
  let target = activityText(args.package ?? args.package_name ?? args.app ?? args.path ?? args.file_path ?? args.agent ?? args.name, 65);
  if (typeof args.url === "string") { try { target = new URL(args.url).hostname; } catch {} }
  // Do not put submitted text, raw commands, URL query strings or coordinates on top of another app.
  const label = purpose || `${labels[tool] ?? serviceLabel(member, tool) ?? statusLabel(native ? "native" : member, tool)}${target ? ` · ${target}` : ""}`;
  return { label, tool: activityText(tool, 128), target, purpose: !!purpose, native, member,
    signature: signature(args), wrapper, polling: native && /(?:^|__)(?:await_result|list_pending)$/.test(word) };
}

export function activityResult(body: unknown): { state: string; receipt?: string } {
  let value = object(body);
  for (let i = 0; i < 5; i++) {
    if (value.ok === false || value.isError === true) return { state: "failed" };
    if (value.truncated === true) return { state: "unconfirmed" };
    if (value.status === "accepted") return { state: "accepted", ...(typeof value.request_id === "string" ? { receipt: value.request_id } : {}) };
    if (typeof (value.detail ?? value.preview) === "string") {
      const text = String(value.detail ?? value.preview);
      try { value = object(JSON.parse(text)); continue; } catch { if (/^\s*[\[{]/.test(text)) return { state: "unconfirmed" }; }
    }
    if (value.result && typeof value.result === "object") { value = object(value.result); continue; }
    break;
  }
  return { state: "ok" };
}

export interface ActivityStep extends ActivityAction {
  requestId: string; ts: number; ended?: number; state: string; approval?: string; childId?: string; receipt?: string;
}
/** One instance per actor turn. Pair only an unambiguous identical capability wrapper/dispatch. */
export class ActivitySteps {
  readonly steps: ActivityStep[] = [];
  private byId = new Map<string, ActivityStep>();
  request(id: string, ts: number, action: ActivityAction): void {
    if (this.byId.has(id)) return;
    const matches = this.steps.filter((s) => s.state === "pending" && !s.childId && s.member === action.member && s.tool === action.tool &&
      s.signature === action.signature && s.wrapper !== action.wrapper && s.native !== action.native);
    if (matches.length === 1 && (action.wrapper || !action.native)) {
      const step = matches[0]!;
      if (action.wrapper) { step.childId = step.requestId; step.requestId = id; Object.assign(step, action); }
      else step.childId = id;
      this.byId.set(id, step); return;
    }
    const step: ActivityStep = { ...action, requestId: id, ts, state: "pending" };
    this.steps.push(step); this.byId.set(id, step);
  }
  response(id: string, ts: number, body: unknown): boolean {
    const step = this.byId.get(id) ?? this.steps.find((s) => s.receipt === id);
    if (!step) return false;
    const result = activityResult(body);
    // An accepted outer MCP response is not completion of its inner request.
    if (result.state === "accepted" && step.ended) return true;
    // A wrapper's successful transport cannot erase a failed device operation.
    if (id === step.requestId && step.childId && step.state === "failed") return true;
    step.state = result.state; if (result.receipt) step.receipt = result.receipt;
    if (result.state !== "accepted") step.ended = ts;
    return true;
  }
  gate(id: string, state: string): void { const step = this.byId.get(id); if (step) step.approval = state; }
  visible(): ActivityStep[] { return this.steps.filter((s) => !s.polling || s.state === "failed"); }
  current(): ActivityStep | undefined { return this.visible().filter((s) => !s.ended).at(-1); }
}
