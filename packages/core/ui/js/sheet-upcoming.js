// Clock list is authoritative. Never optimistically hide a timer after cancel.
const text = (parent, tag, value, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
};

export function normalizeClockList(reply) {
  const timers = reply?.body?.ok === true ? reply.body.result?.timers : null;
  if (!Array.isArray(timers)) throw new Error("计划列表暂不可用");
  return timers.filter((item) => item && typeof item.id === "string" && item.id && Number.isSafeInteger(item.next) && item.next >= 0)
    .map((item) => ({ id: item.id, next: item.next, every: Number.isSafeInteger(item.every) && item.every >= 60 ? item.every : null,
      to: typeof item.to === "string" ? item.to : null, word: typeof item.word === "string" ? item.word : null,
      label: typeof item.label === "string" ? item.label : "", blocked: typeof item.blocked === "string" ? item.blocked : null }));
}

/** Render timers returned by service:clock/list. onCancel must await the paired cancel response. */
export function renderUpcomingSheet(root, timers, { onCancel } = {}) {
  root.replaceChildren();
  if (!Array.isArray(timers) || !timers.length) return text(root, "p", "暂无计划。", "sheet-empty");
  for (const timer of [...timers].sort((a, b) => a.next - b.next)) {
    const section = text(root, "section", "", "upcoming-timer");
    section.dataset.timer = timer.id;
    text(section, "h3", timer.label || "未命名计划");
    text(section, "small", `${new Date(timer.next).toLocaleString()}${timer.every ? ` · 每 ${timer.every} 秒` : ""}`, "upcoming-time");
    if (timer.blocked) text(section, "p", `无法执行：${timer.blocked}`, "upcoming-blocked");
    if (typeof onCancel === "function") {
      const button = text(section, "button", "删除计划", "upcoming-cancel");
      button.type = "button";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await onCancel(timer.id); }
        catch (error) { text(section, "p", error instanceof Error ? error.message : "未能删除计划", "sheet-error"); }
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
      text(this.root, "p", error instanceof Error ? error.message : "计划列表暂不可用", "sheet-error");
      throw error;
    }
  }
  async cancel(id) {
    if (!this.timers.some((item) => item.id === id)) throw new Error("计划已不存在");
    const reply = await this.send({ to: "service:clock", kind: "request", word: "cancel", body: { id }, wait: true });
    if (reply?.reply?.body?.ok !== true || reply.reply.body.result?.cancelled !== true) throw new Error("未能删除计划");
    return this.load();
  }
  render() { return renderUpcomingSheet(this.root, this.timers, { onCancel: (id) => this.cancel(id) }); }
}
