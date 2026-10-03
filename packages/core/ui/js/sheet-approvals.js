// All approval-page operations use the current registered screen and gate member.
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
import { named } from "./editor.js";
const safeText = (value, max = 240) => typeof value === "string" ? value.slice(0, max) : "";
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const validTime = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const choices = new Set(["once", "always", "deny"]);
const actionLabel = (item) => item?.word === "calendar.create" ? "创建日历事件" :
  item?.word === "message.send" ? "发送消息" :
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
    if (!Array.isArray(offered) || offered.length === 0 || offered.length > choices.size ||
      !offered.every((option) => option && choices.has(option.id) && typeof option.label === "string" && option.label.length > 0) ||
      new Set(offered.map((option) => option.id)).size !== offered.length) continue;
    pending.push({ id: ask.id, seq: ask.seq, from: "service:gate", state: "pending", options_valid: true,
      title: safeText(ask.title) || "待确认的操作", detail: safeText(ask.detail, 1000),
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

function group(parent, header, intro = "") {
  text(parent, "h3", header, "set-header");
  if (intro) text(parent, "p", intro, "set-intro sheet-note");
  return text(parent, "div", "", "set-group");
}

/** Only authenticated ledger projections are shown; no optimistic approval or fake rule rows. */
export function renderApprovalsSheet(root, view, { now = Date.now(), onAnswer, answerState = new Map(),
  history, rules, onRevoke, status = "", onRetry, name = "Ash", armedRule = null, onArm, loading = false } = {}) {
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

  const rulesBox = group(fragment, "以后都允许", `你选过「以后都允许」的事，${named(name, false)}在有效期内会直接去做，不再问你。`);
  const live = Array.isArray(rules) ? rules.filter((rule) => rule && validId(rule.id) && !rule.revoked_at &&
    validTime(rule.expires_at) && rule.expires_at > now) : [];
  if (loading) text(rulesBox, "p", "正在读取…", "set-line sheet-loading");
  else if (!rules) text(rulesBox, "p", "暂时读不到这些规则（不代表没有）。", "set-line sheet-unavailable");
  else if (!live.length) text(rulesBox, "p", "没有正在生效的规则。", "set-line sheet-empty");
  else for (const rule of live) {
    const row = text(rulesBox, "div", "", "set-item sheet-rule");
    const body = text(row, "span", "", "set-text");
    const objectLabel = rule.word === "calendar.create" ? `日历 ${safeText(rule.object_pattern, 80)}` :
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
    const label = item.source === "current" ? actionLabel(item) : "较早的审批";
    const decision = { once: "仅这一次", always: "以后都允许", deny: "已拒绝", timeout: "过期没回答",
      cancelled: "已取消", rule: "按规则放行" }[item.decision] || "已记录";
    const row = text(historyBox, "div", "", "set-line sheet-history");
    const body = text(row, "span", "", "set-text");
    text(body, "span", safeText(label, 80), "set-title");
    text(body, "span", `${decision} · ${at(item.at, now)}`, "set-sub");
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
export async function answerGateAsk(net, current, ask, choice, clientId, lookup, { now = Date.now, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxWaitMs = 3000 } = {}) {
  if (!ask || approvalSections({ asks: [ask] }, now()).pending[0]?.id !== ask.id ||
    !ask.options.some((option) => option.id === choice) || typeof clientId !== "string" || !clientId)
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
        body: { ok: true, result: { choice } }, client_id: clientId }) });
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
