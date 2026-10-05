// All approval-page operations use the current registered screen and gate member.
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
import { named } from "./editor.js";
import { appendApprovalOriginal } from "./approval-original.js";
import { humanPendingOutcome } from "./human-pending.js";
const safeText = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const choices = new Set(["once", "always", "deny"]);
const actionLabel = (item) => item?.word === "calendar.create" ? "创建日历事件" :
  item?.word === "message.send" ? "发送消息" :
  item?.word === "browser.click" ? "在网页上点击" : item?.word === "browser.type" ? "在网页上输入" :
  item?.word === "shell.run" ? "执行命令" :
  item?.word === "rules.set" || item?.word === "rules.revoke" ? "修改审批规则" : item?.word === "mode.set" ? "修改审批档位" :
  item?.risk === "outward" ? "对外操作" : item?.risk === "structure" ? "修改资料" : "受保护操作";
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
    if (!Array.isArray(offered) || offered.length === 0 || offered.length > (ask.human_kind === "question" ? 8 : choices.size) ||
      !offered.every((option) => option && (ask.human_kind === "question" ? typeof option.id === "string" && option.id.length > 0 : choices.has(option.id)) && typeof option.label === "string" && option.label.length > 0) ||
      new Set(offered.map((option) => option.id)).size !== offered.length) continue;
    pending.push({ id: ask.id, seq: ask.seq, from: "service:gate", state: "pending", options_valid: true,
      human_kind: ask.human_kind, allow_custom: ask.allow_custom === true,
      title: safeText(ask.title) || "待确认的操作", detail: safeText(ask.detail, 1000),
      ...(typeof ask.original === "string" ? { original: ask.original } : {}),
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

const two = (value) => String(value).padStart(2, "0");
const at = (value, now) => {
  const date = new Date(value);
  const time = `${date.getHours()}:${two(date.getMinutes())}`;
  const day = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const diff = Math.round((day(value) - day(now)) / 86_400_000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === -1) return `昨天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  return `${date.getFullYear() === new Date(now).getFullYear() ? "" : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
};
const HISTORY_SHOWN = 20;
const EFFECTS = { read: "读", act: "操作", write: "改数据", send: "对外发送", execute: "执行命令", structure: "改结构" };
const DECIDED_BY = { rule: "你定的规则", review: "裁判（模型判断）", carry: "沿用你几分钟前的允许", owner: "你", timeout: "没人回答，过期", cancelled: "取消了", waiting: "还在等" };
const ANSWERS = { once: "允许这一次", always: "以后都允许", deny: "不允许" };

/** One record's evidence: what was asked, what the reviewer saw and said, the card, the answer, and whether it ran. */
export function renderEvidence(parent, entry, { now = Date.now(), name = "Ash" } = {}) {
  const box = text(parent, "div", "", "sheet-evidence");
  const row = (label, value) => {
    if (!value) return;
    const line = text(box, "div", "", "sheet-evidence-row");
    text(line, "span", label, "sheet-evidence-label");
    text(line, "span", value, "sheet-evidence-value");
  };
  const effect = EFFECTS[entry.effect] ?? safeText(entry.effect, 40);
  row("谁要做", entry.requester === "agent:main" ? name : safeText(entry.requester, 80));
  // The gate's own words carry English contract labels; the owner reads them by what they do.
  const what = entry.member === "service:gate" ? actionLabel(entry) : safeText(entry.label, 120) || safeText(entry.word, 80);
  row("要做什么", `${what}${effect ? `（${effect}）` : ""}`);
  row("具体内容", safeText(entry.content, 1200));
  const facts = entry.facts && typeof entry.facts === "object" ? entry.facts : null;
  if (facts) {
    const said = Array.isArray(facts.owner_said) ? facts.owner_said.filter((item) => typeof item === "string").map((item) => `「${safeText(item, 300)}」`) : [];
    row("裁判看到你说的", said.length ? said.join("\n") : "这一轮你没有说话");
    const steps = Array.isArray(facts.context) ? facts.context.filter((item) => typeof item === "string").map((item) => safeText(item, 200)) : [];
    if (steps.length) row("裁判看到的前几步", steps.join("\n"));
  }
  const review = entry.review && typeof entry.review === "object" ? entry.review : null;
  if (review) {
    const ms = Number.isSafeInteger(review.ms) ? `，用了 ${(review.ms / 1000).toFixed(1)} 秒` : "";
    if (review.decision === "unavailable") row("裁判结论", `没判出来（${safeText(review.error, 200)}）${ms}，所以问你`);
    else row("裁判结论", `${review.decision === "allow" ? "可以直接做" : "要问你"}${ms}${safeText(review.reason, 400) ? `：${safeText(review.reason, 400)}` : ""}`);
  }
  const card = entry.card && typeof entry.card === "object" ? entry.card : null;
  if (card) {
    row("卡片上写的", [safeText(card.title, 240), safeText(card.detail, 1000)].filter(Boolean).join("\n"));
    if (card.forced) row("为什么一定问你", "改审批规则和档位，写死必须由你决定");
  }
  const answer = ANSWERS[entry.decision];
  if (answer) row("你的回答", `${answer}${validTime(entry.answered_at) ? ` · ${at(entry.answered_at, now)}` : ""}`);
  row("谁做的决定", DECIDED_BY[entry.decided_by] ?? safeText(entry.decided_by, 40));
  if (entry.decided_by !== "review" && entry.decided_by !== "carry" && safeText(entry.reason, 400) && !review) row("理由", safeText(entry.reason, 400));
  const executed = entry.executed && typeof entry.executed === "object" ? entry.executed : null;
  row("最后", humanPendingOutcome(entry.human_pending) || (executed ? executed.ok ? "做成了" : entry.decision === "deny" ? "没有做" : `没做成（${safeText(executed.message, 200) || safeText(executed.error, 60)}）` : "还没有结果"));
  return box;
}

function group(parent, header, intro = "") {
  text(parent, "h3", header, "set-header");
  if (intro) text(parent, "p", intro, "set-intro sheet-note");
  return text(parent, "div", "", "set-group");
}

/** Only authenticated ledger projections are shown; no optimistic approval or fake rule rows. */
export function renderApprovalsSheet(root, view, { now = Date.now(), onAnswer, answerState = new Map(),
  history, rules, onRevoke, status = "", onRetry, name = "Ash", armedRule = null, onArm, loading = false,
  evidence = new Map(), onEvidence } = {}) {
  const sections = approvalSections(view, now);
  const fragment = document.createDocumentFragment();
  if (status) text(fragment, "p", status, "set-status warn sheet-status");
  if (sections.unknownSource) text(fragment, "p", "有几条旧记录看不出来自哪里，没有放在这里。", "set-status sheet-warning");
  text(fragment, "h3", "等你决定", "set-header");
  if (!sections.pending.length) text(fragment, "p", "现在没有要你决定的事。", "sheet-empty set-card");
  for (const ask of sections.pending) {
    const card = text(fragment, "article", "", "set-card sheet-approval pending");
    card.dataset.askId = ask.id;
    text(card, "h4", ask.title);
    if (ask.detail) text(card, "p", ask.detail, "approval-detail");
    appendApprovalOriginal(card, ask);
    text(card, "small", `${at(ask.expires_at, now)} 前有效`, "approval-expiry");
    if (!onAnswer) { text(card, "p", "这里暂时不能回答；请在对话里回答。", "set-status warn sheet-warning"); continue; }
    const state = answerState.get(ask.id);
    const actions = text(card, "div", "", "set-actions");
    for (const option of ask.options) {
      const button = text(actions, "button", option.label, `btn${option.id === "deny" ? " gray" : option.id === "always" ? " tint" : ""} sheet-choice`);
      button.type = "button";
      button.dataset.choice = option.id;
      button.disabled = state?.status === "pending" || state?.status === "confirmed" ||
        state?.status === "rejected" || Boolean(state?.choice && state.choice !== option.id);
      button.addEventListener("click", () => { void onAnswer(ask, option.id); });
    }
    const chosen = ask.options.find((option) => option.id === state?.choice)?.label;
    if (state?.status === "pending") text(card, "p", "正在送出你的回答…", "set-status sheet-warning");
    else if (state?.status === "uncertain") text(card, "p", `还没确认你的回答送到了。再点一次「${chosen ?? "同一个选项"}」会原样重试。`, "set-status warn sheet-warning");
    else if (state?.status === "rejected") text(card, "p", "这次回答没有被接受；它可能已经过期，或这台设备不能回答。", "set-status warn sheet-warning");
  }

  const recent = (view?.asks || []).filter((ask) => ask.human && ask.human.state !== "waiting").slice(-20).reverse();
  if (recent.length) {
    const recentBox = group(fragment, "回答后的进展");
    for (const ask of recent) {
      const card = text(recentBox, "article", "", "set-card sheet-approval resolved");
      text(card, "h4", ask.title);
      text(card, "p", humanPendingOutcome(ask.human), "approval-outcome");
      appendApprovalOriginal(card, ask);
    }
  }
  const rulesBox = group(fragment, "以后都允许", `在「有影响时才问」档位，${named(name, false)}会按这些有效规则直接去做；「每次都问」会暂时忽略它们。`);
  const live = Array.isArray(rules) ? rules.filter((rule) => rule && validId(rule.id) && !rule.revoked_at &&
    validTime(rule.expires_at) && rule.expires_at > now) : [];
  if (loading) text(rulesBox, "p", "正在读取…", "set-line sheet-loading");
  else if (!rules) text(rulesBox, "p", "暂时读不到这些规则（不代表没有）。", "set-line sheet-unavailable");
  else if (!live.length) text(rulesBox, "p", "没有正在生效的规则。", "set-line sheet-empty");
  else for (const rule of live) {
    const row = text(rulesBox, "div", "", "set-item sheet-rule");
    const body = text(row, "span", "", "set-text");
    // "*" covers every use of the capability: there is no single object to name.
    const objectLabel = rule.object_pattern === "*" ? "" : rule.word === "calendar.create" ? `日历 ${safeText(rule.object_pattern, 80)}` :
      rule.word === "message.send" ? `收件人 ${safeText(rule.object_pattern, 80)}` : safeText(rule.object_pattern, 80);
    text(body, "span", actionLabel(rule), "set-title");
    text(body, "span", `${objectLabel ? `${objectLabel} · ` : ""}${at(rule.expires_at, now)} 前有效`, "set-sub");
    if (typeof onRevoke === "function") {
      const armed = armedRule === rule.id;
      if (armed) text(body, "span", `撤销后，${named(name, false)}下次做这件事前会先问你。`, "set-sub warn");
      const button = text(row, "button", armed ? "确认撤销" : "撤销", `sheet-link${armed ? " armed" : ""}`);
      button.type = "button";
      button.addEventListener("click", () => {
        // Two taps: the first explains the consequence, the second revokes.
        if (!armed) { onArm?.(rule.id); return; }
        button.disabled = true;
        void onRevoke(rule.id).catch(() => { button.disabled = false; });
      });
    }
  }

  const historyBox = group(fragment, "最近的决定");
  const items = Array.isArray(history) ? history.filter((item) => item && validId(item.id) && validTime(item.at)) : [];
  if (loading) text(historyBox, "p", "正在读取…", "set-line sheet-loading");
  else if (!history) text(historyBox, "p", "暂时读不到审批记录（不代表没有）。", "set-line sheet-unavailable");
  else if (!items.length) text(historyBox, "p", "还没有审批记录。", "set-line sheet-empty");
  else for (const item of items.slice(0, HISTORY_SHOWN)) {
    const label = item.source === "current" ? safeText(item.label, 80) || actionLabel(item) : "较早的审批";
    const decision = { once: "仅这一次", always: "以后都允许", deny: "已拒绝", timeout: "过期没回答",
      cancelled: "已取消", rule: "按规则放行", review: "由她判断后放行", carry: "刚允许过，沿用" }[item.decision] || "已记录";
    const row = text(historyBox, "div", "", "set-line sheet-history");
    const body = text(row, "span", "", "set-text");
    text(body, "span", safeText(label, 80), "set-title");
    text(body, "span", `${decision} · ${at(item.at, now)}`, "set-sub");
    if ((item.decision === "review" || item.decision === "carry") && safeText(item.reason, 200))
      text(body, "span", safeText(item.reason, 200), "set-sub sheet-reason");
    if (item.source !== "current" || !validId(item.request_id) || typeof onEvidence !== "function") continue;
    const shown = evidence.get(item.request_id);
    const toggle = text(row, "button", shown ? "收起" : "查看依据", "sheet-link");
    toggle.type = "button";
    toggle.addEventListener("click", () => { void onEvidence(item.request_id); });
    if (!shown) continue;
    if (shown.status === "loading") text(body, "span", "正在读取…", "set-sub");
    else if (shown.status === "missing") text(body, "span", "这条没有留下依据（多半是证据记录上线之前的）。", "set-sub");
    else if (shown.status === "failed") text(body, "span", "暂时读不到依据（不代表没有），稍后再点一次。", "set-sub warn");
    else renderEvidence(body, shown.entry, { now, name });
  }
  if (items.length > HISTORY_SHOWN) text(fragment, "p", `只显示最近 ${HISTORY_SHOWN} 条。`, "sheet-empty");
  if (!loading && (!history || !rules) && typeof onRetry === "function") {
    const retry = text(fragment, "button", "重试", "btn gray sheet-retry-button");
    retry.type = "button";
    retry.addEventListener("click", () => { retry.disabled = true; void onRetry(); });
  }
  root.replaceChildren(fragment);
  return sections;
}

/** Current-screen request with a paired gate response; callers never trust a bare HTTP 200. */
export async function gatePageRequest(net, current, word, body, clientId = crypto.randomUUID()) {
  const binding = { token: net.token, screen: net.screen, scope: net.currentScope, generation: net.generation };
  const same = () => current() && binding.token && binding.screen && binding.scope &&
    binding.token === net.token && binding.screen === net.screen && binding.scope === net.currentScope &&
    binding.generation === net.generation;
  if (!same()) throw new Error("屏幕未连接。");
  const response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: binding.token },
    body: JSON.stringify({ to: "service:gate", kind: "request", word, body, client_id: clientId, wait: true }) });
  if (!same()) throw new Error("屏幕身份已变化。");
  if (!response.ok) throw new Error("审批服务未确认操作。");
  const accepted = await response.json();
  const reply = accepted?.reply;
  if (!same() || typeof accepted?.id !== "string" || reply?.kind !== "response" || reply.reply_to !== accepted.id ||
    reply.from !== "service:gate" || reply.to !== "person:owner" || reply.word !== word || reply.body?.ok !== true)
    throw new Error("审批服务回执未配对。");
  return reply.body.result;
}

/** An HTTP ACK alone is not displayed as an answered approval. The matching ledger response must be seen. */
export async function answerGateAsk(net, current, ask, choice, clientId, lookup, { now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 3000, answerText } = {}) {
  if (!ask || approvalSections({ asks: [ask] }, now()).pending[0]?.id !== ask.id ||
    !(ask.options.some((option) => option.id === choice) || ask.human_kind === "question" && ask.allow_custom && choice === "custom" && typeof answerText === "string" && answerText.trim()) || typeof clientId !== "string" || !clientId)
    throw new Error("待批请求已失效或选项不可用。");
  const token = net.token;
  const screen = net.screen;
  const scope = net.currentScope;
  const generation = net.generation;
  const same = () => current() && token && screen && scope && token === net.token && screen === net.screen &&
    scope === net.currentScope && generation === net.generation;
  if (!same()) throw new Error("屏幕身份已变化，不能回答审批。");
  let response;
  try {
    response = await net.request("/api/send", { method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
      body: JSON.stringify({ to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
        body: { ok: true, result: { choice, ...(answerText ? { text: answerText } : {}) } }, client_id: clientId }) });
  } catch {
    if (!same()) throw new Error("屏幕身份已变化，回答结果已丢弃。");
    throw new Error("审批回执未知；只能用同一选项原样重试。");
  }
  if (!same()) throw new Error("屏幕身份已变化，回答结果已丢弃。");
  if (!response.ok) {
    if (response.status === 403) throw new Error("当前屏幕无权回答审批。");
    if (!Number.isInteger(response.status) || response.status >= 500 || response.status === 408 || response.status === 429)
      throw new Error("审批回执未知；只能用同一选项原样重试。");
    throw new Error("审批回答被拒绝；请刷新记录。");
  }
  let accepted;
  try { accepted = await response.json(); }
  catch { throw new Error("审批回执无法读取；只能原样重试。"); }
  if (!same()) throw new Error("屏幕身份已变化，回答结果已丢弃。");
  if (typeof accepted?.id !== "string" || !accepted.id || !Number.isSafeInteger(accepted.seq) || accepted.seq <= ask.seq)
    throw new Error("审批回执无法配对；只能原样重试。");
  const matches = (message) => message?.id === accepted.id && message.seq === accepted.seq &&
    message.from === "person:owner" && message.to === "service:gate" && message.kind === "response" &&
    message.word === "ask" && message.reply_to === ask.id && message.origin?.screen === screen &&
    message.body_summary?.ok === true && message.body_summary.result?.choice === choice;
  const deadline = now() + maxWaitMs;
  do {
    if (!same()) throw new Error("屏幕身份已变化，回答结果已丢弃。");
    if (matches(lookup(accepted.id))) return { id: accepted.id, seq: accepted.seq };
    if (now() >= deadline) break;
    await delay(50);
  } while (true);
  throw new Error("回答尚未在权威记录中出现；只能用同一选项原样重试。");
}
