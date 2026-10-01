// The activity sheet consumes display-safe projection facts, never raw ledger bodies.
const text = (parent, tag, value, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
};

const date = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : "时间未知";

/** Render a turn-grouped, read-only activity sheet. askAbout sends a plain prefill to the main composer. */
export function renderActivitySheet(root, view, { askAbout } = {}) {
  root.replaceChildren();
  const turns = Object.entries(view?.turns ?? {})
    .filter(([id, item]) => /^[tr]_[A-Za-z0-9_-]+$/.test(id) && item && Number.isFinite(item.started))
    .sort((a, b) => Number(a[1].background === true) - Number(b[1].background === true) || b[1].started - a[1].started);
  if (!turns.length) return text(root, "p", "还没有活动记录。", "sheet-empty");
  let group = null;
  for (const [id, turn] of turns) {
    const nextGroup = turn.background ? "后台任务" : "对话";
    if (nextGroup !== group) { text(root, "h4", nextGroup, "activity-group"); group = nextGroup; }
    const section = text(root, "section", "", `activity-turn${turn.background ? " background" : ""}`);
    section.dataset.turn = id;
    text(section, "h3", turn.title || (turn.background ? "后台任务" : "对话"));
    text(section, "small", `${date(turn.started)} · ${turn.ended ? turn.outcome || "已结束" : "进行中"}`, "activity-time");
    const steps = Array.isArray(turn.steps) ? turn.steps : [];
    for (const step of steps) {
      const row = text(section, "p", step.label || "处理步骤", "activity-step");
      if (step.state) row.dataset.state = step.state;
    }
    if (typeof askAbout === "function") {
      const button = text(section, "button", "问问她这件事", "activity-ask");
      button.type = "button";
      button.addEventListener("click", () => askAbout({ turn: id, text: `关于${turn.title || "这件事"}，` }));
    }
  }
  return root;
}
