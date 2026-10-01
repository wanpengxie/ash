// Pending gate answers use the registered screen; rule mutation and history remain unavailable.
import { SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";
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

/** Only authenticated ledger projections are shown; no optimistic approval or fake rule rows. */
export function renderApprovalsSheet(root, view, { now = Date.now(), onAnswer, answerState = new Map() } = {}) {
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
    if (!onAnswer) { text(card, "p", "此页暂不能作出决定。", "sheet-warning"); continue; }
    const state = answerState.get(ask.id);
    for (const option of ask.options) {
      const button = text(card, "button", option.label, "sheet-choice");
      button.type = "button";
      button.dataset.choice = option.id;
      button.disabled = state?.status === "pending" || state?.status === "confirmed" ||
        state?.status === "rejected" || Boolean(state?.choice && state.choice !== option.id);
      button.addEventListener("click", () => { void onAnswer(ask, option.id); });
    }
    if (state?.status === "pending") text(card, "p", "正在核对回答…", "sheet-warning");
    else if (state?.status === "uncertain") text(card, "p", "回答结果未确认；只能原样重试该选项。", "sheet-warning");
    else if (state?.status === "rejected") text(card, "p", "回答被拒绝；请重新载入审批记录。", "sheet-warning");
  }
  text(fragment, "h3", "历史", "sheet-heading");
  text(fragment, "p", "完整审批历史尚未连接。", "sheet-unavailable");
  text(fragment, "h3", "以后都允许的规则", "sheet-heading");
  text(fragment, "p", "规则清单和撤销功能尚未连接；不能据此判断没有规则。", "sheet-unavailable");
  root.replaceChildren(fragment);
  return sections;
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
