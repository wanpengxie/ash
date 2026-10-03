// Clock list is authoritative. Never optimistically hide a timer after cancel.
import { dayLabel } from "./sheet-activity.js";
import { named } from "./editor.js";
const text = (parent, tag, value, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
};
const rawRoute = /\b(?:agent|worker|device|service|person):[A-Za-z0-9_-]+\b|\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/i;
const human = (value) => value == null || typeof value === "string" && value.length <= 160 && !rawRoute.test(value);

export function normalizeClockList(reply) {
  const timers = reply?.body?.ok === true ? reply.body.result?.timers : null;
  if (!Array.isArray(timers)) throw new Error("暂时读不到计划（不代表没有）。");
  if (timers.some((item) => !item || typeof item.id !== "string" || !item.id ||
    !Number.isSafeInteger(item.next) || item.next < 0 || item.next > 8_640_000_000_000_000 ||
    item.every != null && (!Number.isSafeInteger(item.every) || item.every < 60) ||
    !human(item.label) || !human(item.blocked))) throw new Error("暂时读不到计划（不代表没有）。");
  return timers.map((item) => ({ id: item.id, next: item.next, every: Number.isSafeInteger(item.every) && item.every >= 60 ? item.every : null,
      to: typeof item.to === "string" ? item.to : null, word: typeof item.word === "string" ? item.word : null,
      label: typeof item.label === "string" ? item.label : "", blocked: typeof item.blocked === "string" ? "请稍后再看" : null }));
}

const two = (value) => String(value).padStart(2, "0");
/** How often a timer repeats, in the owner's words. */
export function repeatText(every) {
  if (!Number.isSafeInteger(every) || every < 60) return "只一次";
  if (every % 604_800 === 0) return every === 604_800 ? "每周" : `每 ${every / 604_800} 周`;
  if (every % 86_400 === 0) return every === 86_400 ? "每天" : `每 ${every / 86_400} 天`;
  if (every % 3_600 === 0) return every === 3_600 ? "每小时" : `每 ${every / 3_600} 小时`;
  if (every % 60 === 0) return `每 ${every / 60} 分钟`;
  return `每 ${every} 秒`;
}

/** Render timers returned by service:clock/list, grouped by day. onCancel must await the paired cancel response. */
export function renderUpcomingSheet(root, timers, { onCancel, now = Date.now(), name = "Ash" } = {}) {
  root.replaceChildren();
  if (!Array.isArray(timers) || !timers.length)
    return text(root, "p", `暂无计划。${named(name, false)}答应到点做的事、提醒你的事，会出现在这里。`, "sheet-empty set-card");
  let day = null;
  let group = null;
  for (const timer of [...timers].sort((a, b) => a.next - b.next)) {
    const label = dayLabel(timer.next, now);
    if (label !== day) {
      text(root, "h3", label, "set-header");
      group = text(root, "div", "", "set-group");
      day = label;
    }
    const at = new Date(timer.next);
    const time = `${at.getHours()}:${two(at.getMinutes())}`;
    const row = text(group, "div", "", "upcoming-timer");
    row.dataset.timer = timer.id;
    text(row, "span", time, "upcoming-when");
    const body = text(row, "span", "", "set-text");
    const title = timer.label || "没有名字的计划";
    text(body, "span", title, "set-title");
    text(body, "span", repeatText(timer.every), "set-sub upcoming-time");
    if (timer.blocked) text(body, "span", `暂时没法执行：${timer.blocked}`, "set-sub warn upcoming-blocked");
    const note = text(body, "span", "", "set-sub warn");
    note.hidden = true;
    if (typeof onCancel === "function") {
      const button = text(row, "button", "删除", "upcoming-cancel");
      button.type = "button";
      let armed = false;
      let error = null;
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        // Two taps: the first says what will be lost, the second asks the clock to cancel.
        if (!armed) {
          armed = true;
          button.textContent = "确认删除";
          button.className = "upcoming-cancel armed";
          note.textContent = timer.every ? `删除后，「${title}」以后都不会再有了。` : `删除后，${label} ${time} 的「${title}」就取消了。`;
          note.hidden = false;
          return;
        }
        button.disabled = true;
        note.hidden = true;
        error?.remove?.();
        try { await onCancel(timer.id); }
        catch (failure) {
          error = text(body, "span", failure instanceof Error ? failure.message : "没能删除，可以再试一次。", "sheet-error");
          button.textContent = "再试一次";
        }
        finally { button.disabled = false; }
      });
    }
  }
  return root;
}

/** A registered screen supplies send(request); transport and authorization remain in the edge. */
export class UpcomingSheet {
  constructor(root, send) { this.root = root; this.send = send; this.timers = []; }
  async load() {
    try {
      const reply = await this.send({ to: "service:clock", kind: "request", word: "list", body: {}, wait: true });
      this.timers = normalizeClockList(reply?.reply);
      this.render();
      return this.timers;
    } catch (error) {
      this.root.replaceChildren();
      text(this.root, "p", error instanceof Error ? error.message : "暂时读不到计划（不代表没有）。", "sheet-error");
      throw error;
    }
  }
  async cancel(id) {
    if (!this.timers.some((item) => item.id === id)) throw new Error("这条计划已经不在了。");
    const reply = await this.send({ to: "service:clock", kind: "request", word: "cancel", body: { id }, wait: true });
    if (reply?.reply?.body?.ok !== true || reply.reply.body.result?.cancelled !== true) throw new Error("没能删除，可以再试一次。");
    return this.load();
  }
  render() { return renderUpcomingSheet(this.root, this.timers, { onCancel: (id) => this.cancel(id) }); }
}
