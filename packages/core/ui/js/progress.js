import { safeActivityView } from "./sheet-agent.js";

/** A compact view of the latest real turn; never reads request bodies or raw tool names. */
export function renderProgress(root, view, { now = Date.now(), onOpen } = {}) {
  root.replaceChildren();
  const turns = Object.entries(safeActivityView(view).turns)
    .filter(([, turn]) => !turn.background && (!turn.ended || now - turn.ended < 60_000))
    .sort((a, b) => b[1].started - a[1].started);
  if (!turns.length) { root.hidden = true; return; }
  const [id, turn] = turns[0];
  root.hidden = false;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "progress-button";
  button.dataset.turn = id;
  const seconds = Math.max(0, Math.floor((Math.min(now, turn.ended ?? now) - turn.started) / 1000));
  button.textContent = turn.ended ? `做了 ${turn.steps.length} 步 · ${seconds} 秒 · 查看活动`
    : `${turn.steps.slice(-2).map((step) => step.label).join(" · ") || "正在处理"} · ${seconds} 秒`;
  button.addEventListener("click", () => onOpen?.(id));
  root.append(button);
}
