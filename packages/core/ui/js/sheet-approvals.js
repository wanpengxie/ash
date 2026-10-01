// Read-only gate approval view. Rule mutation and complete history require the gate service.
const safeText = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const choices = new Set(["once", "always", "deny"]);
export function approvalSections(view, now = Date.now()) {
  const pending = [];
  let unknownSource = 0;
  const seen = new Set();
  for (const ask of Array.isArray(view?.asks) ? view.asks : []) {
    if (!ask || !validId(ask.id) || seen.has(ask.id)) continue;
    seen.add(ask.id);
    if (ask.from !== "service:gate") {
      if (ask.from === undefined) unknownSource++;
      continue;
    }
    if (!Number.isSafeInteger(ask.seq) || ask.seq < 1 || ask.state !== "pending" || ask.options_valid !== true || !validTime(ask.expires_at) || ask.expires_at <= now) continue;
    const offered = ask.options;
    if (!Array.isArray(offered) || offered.length === 0 || offered.length > choices.size ||
      !offered.every((option) => option && choices.has(option.id) && typeof option.label === "string" && option.label.length > 0) ||
      new Set(offered.map((option) => option.id)).size !== offered.length) continue;
    pending.push({ id: ask.id, seq: ask.seq, title: safeText(ask.title) || "待确认的操作", detail: safeText(ask.detail, 1000),
      expires_at: ask.expires_at, options: offered.map((option) => ({ id: option.id, label: safeText(option.label, 80) })) });
  }
  pending.sort((a, b) => a.expires_at - b.expires_at || a.seq - b.seq);
  return { pending, unknownSource };
}

function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  parent.append(node);
  return node;
}

/** Only authenticated ledger projections are shown; no optimistic approval or fake rule rows. */
export function renderApprovalsSheet(root, view, { now = Date.now() } = {}) {
  const sections = approvalSections(view, now);
  const fragment = document.createDocumentFragment();
  text(fragment, "h2", "审批", "sheet-title");
  if (sections.unknownSource) text(fragment, "p", "部分旧记录缺少可验证来源，未纳入审批页。", "sheet-warning");
  text(fragment, "h3", "待批", "sheet-heading");
  if (!sections.pending.length) text(fragment, "p", "当前没有可确认的待批请求。", "sheet-empty");
  for (const ask of sections.pending) {
    const card = text(fragment, "article", "", "sheet-approval pending");
    card.dataset.askId = ask.id;
    text(card, "h4", ask.title);
    if (ask.detail) text(card, "p", ask.detail);
    text(card, "small", `截止 ${new Date(ask.expires_at).toLocaleString()} · 可选：${ask.options.map((option) => option.label).join("、")}`);
    text(card, "p", "此页暂不能作出决定。", "sheet-warning");
  }
  text(fragment, "h3", "历史", "sheet-heading");
  text(fragment, "p", "完整审批历史尚未连接。", "sheet-unavailable");
  text(fragment, "h3", "以后都允许的规则", "sheet-heading");
  text(fragment, "p", "规则清单和撤销功能尚未连接；不能据此判断没有规则。", "sheet-unavailable");
  root.replaceChildren(fragment);
  return sections;
}
