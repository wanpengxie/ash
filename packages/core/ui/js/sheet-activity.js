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

function turnCard(parent, id, turn, { askAbout, now, expanded, onExpand, background, loadDetails, detailState }) {
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
      const row = text(list, "li", "", "activity-step");
      text(row, "div", step.label || "处理了一步", "activity-step-title");
      // A step still marked pending after the turn ended is just a past step, not a live spinner.
      const state = step.state === "pending" && Number.isFinite(turn.ended) ? "" : step.state;
      if (state) row.dataset.state = state;
      const stateText = step.summary ? "思路摘要" : step.state === "ok" ? "调用完成" : step.state === "failed" ? "执行失败" : step.state === "unconfirmed" ? "返回记录不完整，查看详情" : step.state === "accepted" ? "已受理，等待结果" : step.state === "pending" ? Number.isFinite(turn.ended) ? "结果未确认" : "进行中" : "";
      const took = step.tool && Number.isFinite(step.ts) ? duration(Math.max(0, (step.ended ?? turn.ended ?? now) - step.ts)) : "";
      text(row, "div", [step.tool, stateText, took, step.approval].filter(Boolean).join(" · "), "activity-step-meta");
      // Keep the newest/current work visible, not only the first five steps.
      row.hidden = !open && steps.length > VISIBLE_STEPS + 1 && index < steps.length - VISIBLE_STEPS;
      if (step.requestId && typeof loadDetails === "function") {
        const previous = detailState.get(step.requestId);
        const version = `${step.state}:${step.ended}`;
        const saved = previous?.version === version ? previous : { version, open: previous?.open ?? false, text: "", next: 0 };
        detailState.set(step.requestId, saved);
        const details = text(row, "details", "", "activity-detail");
        details.open = saved.open;
        text(details, "summary", "查看调用与结果");
        const pre = text(details, "pre", saved.text);
        const more = text(details, "button", "继续查看", "activity-more");
        more.type = "button"; more.hidden = saved.next === null;
        const load = async () => {
          if (saved.loading || saved.next === null) return;
          saved.loading = true; more.disabled = true;
          try {
            const result = await loadDetails(step.requestId, saved.next);
            saved.text += result.text; saved.next = result.next_offset;
            pre.textContent = saved.text; more.hidden = saved.next === null;
          } catch (error) { pre.textContent = `${saved.text}\n${error.message || "读取失败，请重试"}`; }
          finally { saved.loading = false; more.disabled = false; }
        };
        details.addEventListener("toggle", () => { saved.open = details.open; if (saved.open && !saved.text) void load(); });
        more.addEventListener("click", load);
        if (saved.open && !saved.text) void load();
        text(details, "small", "敏感字段已隐藏；这里展示执行记录，不是审批按钮。", "activity-step-meta");
      }
    });
    if (steps.length > VISIBLE_STEPS + 1 && typeof onExpand === "function") {
      const more = text(card, "button", open ? "收起" : `查看前面 ${steps.length - VISIBLE_STEPS} 步`, "activity-more");
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
  expanded, onExpand, loadDetails, detailState = new Map() } = {}) {
  root.replaceChildren();
  const turns = Object.entries(view?.turns ?? {})
    .filter(([id, item]) => /^[tr]_[A-Za-z0-9_-]+$/.test(id) && item && Number.isFinite(item.started))
    .sort((a, b) => b[1].started - a[1].started);
  if (!turns.length) return text(root, "p", "还没有活动记录。她做过的事会按天出现在这里。", "sheet-empty set-card");
  const options = { askAbout, now, expanded, onExpand, loadDetails, detailState };
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
