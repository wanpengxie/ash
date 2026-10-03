// The activity sheet consumes display-safe projection facts, never raw ledger bodies.
const text = (parent, tag, value, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
};

const two = (value) => String(value).padStart(2, "0");
const WEEK = "日一二三四五六";
const startOfDay = (value) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
const clock = (value) => { const at = new Date(value); return `${at.getHours()}:${two(at.getMinutes())}`; };

/** "今天", "昨天", or "10月1日 周三" (with the year when it is not this year). */
export function dayLabel(value, now = Date.now()) {
  const diff = Math.round((startOfDay(value) - startOfDay(now)) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === -1) return "昨天";
  if (diff === 1) return "明天";
  const at = new Date(value);
  const year = at.getFullYear() === new Date(now).getFullYear() ? "" : `${at.getFullYear()}年`;
  return `${year}${at.getMonth() + 1}月${at.getDate()}日 周${WEEK[at.getDay()]}`;
}

const duration = (ms) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` :
  ms < 3_600_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 360_000) / 10} 小时`;

/** The ending of a turn in plain words. */
export function outcomeText(turn) {
  if (!Number.isFinite(turn.ended)) return { key: "running", label: "还在做…" };
  const took = turn.ended >= turn.started ? ` · 用时 ${duration(turn.ended - turn.started)}` : "";
  if (turn.outcome === "completed") return { key: "completed", label: `完成了${took}` };
  if (turn.outcome === "cancelled") return { key: "cancelled", label: `被打断了${took}` };
  if (turn.outcome === "error") return { key: "error", label: `没做完${took}` };
  return { key: "ended", label: `结束了${took}` };
}

const VISIBLE_STEPS = 5;

function turnCard(parent, id, turn, { askAbout, now, expanded, onExpand, background }) {
  const card = text(parent, "article", "", `activity-turn${background ? " background" : ""}`);
  card.dataset.turn = id;
  const head = text(card, "div", "", "activity-head");
  text(head, "h3", turn.title || (background ? "后台任务" : "对话"));
  text(head, "span", background && startOfDay(turn.started) !== startOfDay(now) ? `${dayLabel(turn.started, now)} ${clock(turn.started)}` : clock(turn.started), "activity-time");
  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  if (steps.length) {
    const list = text(card, "ol", "", "activity-steps");
    const open = expanded?.has(id) === true;
    steps.forEach((step, index) => {
      const row = text(list, "li", step.label || "处理了一步", "activity-step");
      // A step still marked pending after the turn ended is just a past step, not a live spinner.
      const state = step.state === "pending" && Number.isFinite(turn.ended) ? "" : step.state;
      if (state) row.dataset.state = state;
      row.hidden = !open && steps.length > VISIBLE_STEPS + 1 && index >= VISIBLE_STEPS;
    });
    if (steps.length > VISIBLE_STEPS + 1 && typeof onExpand === "function") {
      const more = text(card, "button", open ? "收起" : `还有 ${steps.length - VISIBLE_STEPS} 步`, "activity-more");
      more.type = "button";
      more.addEventListener("click", () => onExpand(id));
    }
  }
  const foot = text(card, "div", "", "activity-foot");
  const outcome = outcomeText(turn);
  const result = text(foot, "span", outcome.label, "activity-outcome");
  result.dataset.outcome = outcome.key;
  if (typeof askAbout === "function") {
    const button = text(foot, "button", "问问她这件事", "activity-ask");
    button.type = "button";
    button.addEventListener("click", () => askAbout({ turn: id, text: `关于${turn.title || "这件事"}，` }));
  }
  return card;
}

/**
 * Render conversations grouped by day, newest first, then background work in its own group, collapsed unless
 * backgroundOpen. askAbout sends a plain prefill to the main composer.
 */
export function renderActivitySheet(root, view, { askAbout, now = Date.now(), backgroundOpen = false, onToggleBackground,
  expanded, onExpand } = {}) {
  root.replaceChildren();
  const turns = Object.entries(view?.turns ?? {})
    .filter(([id, item]) => /^[tr]_[A-Za-z0-9_-]+$/.test(id) && item && Number.isFinite(item.started))
    .sort((a, b) => b[1].started - a[1].started);
  if (!turns.length) return text(root, "p", "还没有活动记录。她做过的事会按天出现在这里。", "sheet-empty set-card");
  const options = { askAbout, now, expanded, onExpand };
  const foreground = turns.filter(([, turn]) => turn.background !== true);
  const background = turns.filter(([, turn]) => turn.background === true);
  let day = null;
  for (const [id, turn] of foreground) {
    const label = dayLabel(turn.started, now);
    if (label !== day) { text(root, "h3", label, "set-header activity-group"); day = label; }
    turnCard(root, id, turn, { ...options, background: false });
  }
  if (background.length) {
    const toggle = text(root, "button", "", "set-header activity-group activity-bg-toggle");
    toggle.type = "button";
    text(toggle, "span", `后台任务 · ${background.length} 项`);
    text(toggle, "span", "", "set-chev");
    toggle.ariaExpanded = String(backgroundOpen);
    if (typeof onToggleBackground === "function") toggle.addEventListener("click", () => onToggleBackground(!backgroundOpen));
    const box = text(root, "div", "", "activity-bg");
    box.hidden = !backgroundOpen;
    for (const [id, turn] of background) turnCard(box, id, turn, { ...options, background: true });
  }
  return root;
}
