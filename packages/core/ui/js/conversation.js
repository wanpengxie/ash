// Render selected conversation facts; gate originals appear only in an explicit plain-text disclosure.
import { renderCard, workspaceFileUrl } from "./cards.js";
import { appendApprovalOriginal } from "./approval-original.js";
import { humanPendingOutcome } from "./human-pending.js";
export { workspaceFileUrl } from "./cards.js";
const text = (parent, tag, value, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
};

const say = (item) => item?.type === "say";
const grouped = (item, neighbor) => say(item) && say(neighbor) && item.side === "agent" && neighbor.side === "agent" && !!item.group && item.group === neighbor.group && !item.legacy && !neighbor.legacy;
const deliveryText = { sent: "发送中", delivered: "已送达", read: "已读" };

function attachment(parent, item, openInline, openWorkspaceFile) {
  const name = typeof item?.name === "string" ? item.name : "附件";
  if (item?.source === "inline" && Number.isSafeInteger(item.index) && item.index >= 0) {
    const button = text(parent, "button", name, "attachment");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.title = "正在读取附件";
      try {
        const opened = await openInline?.(item.message_id, item.index);
        if (!opened) throw new Error("attachment unavailable");
        if (opened.preview) {
          const image = document.createElement("img");
          image.alt = opened.name;
          image.src = opened.url;
          image.addEventListener("load", opened.revoke, { once: true });
          image.addEventListener("error", opened.revoke, { once: true });
          setTimeout(opened.revoke, 60_000);
          parent.append(image);
        } else {
          const download = document.createElement("a");
          download.href = opened.url;
          download.download = opened.name;
          download.click();
          setTimeout(opened.revoke, 1000);
        }
        button.dataset.opened = "true";
        button.title = "";
      } catch { button.title = "附件无法打开"; }
      finally { button.disabled = false; }
    });
    return;
  }
  const url = workspaceFileUrl(item);
  if (!url) return;
  if (openWorkspaceFile) {
    const button = text(parent, "button", name, "attachment");
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const blob = await openWorkspaceFile(item);
        const objectUrl = URL.createObjectURL(blob);
        const download = document.createElement("a");
        download.href = objectUrl;
        download.download = name;
        download.click();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      } catch { button.title = "附件无法打开"; }
      finally { button.disabled = false; }
    });
    return;
  }
  const link = text(parent, "a", name, "attachment");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
}

/** Append a stable ledger conversation without inventing an approval or option action. */
export function appendConversation(fragment, entries, { openInline, openWorkspaceFile, onSelect, onAnswerAsk, onPermission, optionPending, askIntents } = {}) {
  if (!entries.length) text(fragment, "div", "还没有对话。", "hello");
  for (let index = 0; index < entries.length; index++) {
    const item = entries[index];
    if (item.type === "say") {
      const side = item.side === "owner" ? "me" : "ai";
      if (item.legacy) text(fragment, "small", `历史记录 · ${item.legacy.workspace} · ${item.legacy.member} · 只读`, `from ${side === "me" ? "r" : "l"}`);
      else if (item.side === "owner" && item.origin?.label) text(fragment, "small", `来自 ${item.origin.label}`, "from r");
      else if (item.side === "inbound") text(fragment, "small", `来自 ${item.from || "未知来源"}`, "from l");
      const previous = grouped(item, entries[index - 1]);
      const next = grouped(item, entries[index + 1]);
      const group = item.side === "agent" && item.group ? ` group-${previous ? next ? "middle" : "last" : next ? "first" : "single"}` : "";
      const bubble = text(fragment, "div", item.text, `msg ${side}${group}`);
      bubble.dataset.seq = String(item.seq);
      if (item.legacy) bubble.dataset.readonly = "true";
      if (Array.isArray(item.attachments) && item.attachments.length) {
        const attachments = text(bubble, "div", "", "atts");
        for (const ref of item.attachments) attachment(attachments, ref, openInline, openWorkspaceFile);
      }
      if (Array.isArray(item.reactions) && item.reactions.length) {
        const reactions = text(bubble, "span", "", "reactions");
        for (const reaction of item.reactions) if (typeof reaction?.emoji === "string" && reaction.emoji) text(reactions, "span", reaction.emoji, "reaction");
      }
      if (item.side === "owner" && !item.legacy) text(fragment, "span", deliveryText[item.delivery] || deliveryText.sent, "delivery r");
    } else if (item.type === "ask") {
      const card = text(fragment, "div", "", "card ask");
      text(card, "b", item.ask.title, "ask-title");
      if (item.ask.detail) text(card, "small", item.ask.detail, "ask-detail");
      appendApprovalOriginal(card, item.ask);
      text(card, "small", `有效期至 ${new Date(item.ask.expires_at).toLocaleString()}`, "ask-expiry");
      const expired = item.ask.state === "expired" || item.ask.state === "pending" && item.ask.expires_at <= Date.now();
      // A decided card says how it ended instead of keeping buttons that look live but do nothing.
      if (expired || item.ask.state !== "pending") {
        const chosen = (item.ask.options || []).find((option) => option.id === item.ask.choice);
        const outcome = expired ? "已过期，未执行" : humanPendingOutcome(item.ask.human) ||
          (item.ask.choice === "deny" ? "已拒绝" : item.ask.choice === "once" ? "已允许这一次" : chosen ? `已选择：${chosen.label}` : item.ask.answer_text ? `已回答：${item.ask.answer_text}` : "已结束");
        text(card, "small", outcome, "ask-outcome");
        continue;
      }
      const answer = askIntents?.get(item.ask.id);
      const actions = text(card, "div", "", "ask-actions");
      for (const option of item.ask.options || []) {
        const button = text(actions, "button", option.label, "btn gray");
        button.type = "button";
        button.disabled = expired || item.ask.state !== "pending" || item.ask.from !== "service:gate" || typeof onAnswerAsk !== "function" ||
          answer?.status === "pending" || answer?.status === "confirmed" || answer?.status === "rejected" || Boolean(answer?.choice && answer.choice !== option.id);
        button.addEventListener("click", async () => {
          if (button.disabled) return;
          button.disabled = true;
          try { await onAnswerAsk(item.ask, option.id); }
          catch { button.disabled = false; }
        });
      }
      if (item.ask.allow_custom && typeof onAnswerAsk === "function") {
        const input = document.createElement("input");
        input.placeholder = "输入其他回答";
        input.maxLength = 4000;
        input.value = answer?.customDraft ?? "";
        input.disabled = Boolean(answer?.choice);
        input.addEventListener("input", () => { if (askIntents && !askIntents.get(item.ask.id)?.choice)
          askIntents.set(item.ask.id, { customDraft: input.value }); });
        const send = text(actions, "button", "发送回答", "btn gray");
        send.type = "button";
        send.disabled = Boolean(answer?.status === "pending" || answer?.status === "confirmed");
        send.addEventListener("click", async () => { if (!input.value.trim() || send.disabled) return; send.disabled = true;
          try { await onAnswerAsk(item.ask, "custom", input.value.trim()); } finally { send.disabled = false; } });
        actions.insertBefore(input, send);
      }
      if (answer?.status === "uncertain") text(card, "small", "结果尚未确认；只能原样重试");
    } else if (item.type === "card") {
      renderCard(fragment, item, { onSelect, onPermission, optionPending, openWorkspaceFile });
    }
  }
}

/** Local-only placeholders are removed as soon as their accepted id appears in the ledger. */
export function appendOutbox(fragment, outbox) {
  const labels = { unsent: "未发送", sending: "发送中", accepted: "已送达", rejected: "未送达" };
  for (const item of outbox || []) {
    if (!item || typeof item.client_id !== "string" || typeof item.text !== "string" || !Object.hasOwn(labels, item.status)) continue;
    const bubble = text(fragment, "div", item.text, "msg me pending-local");
    bubble.dataset.clientId = item.client_id;
    for (const file of item.attachments || []) if (typeof file?.name === "string") text(bubble, "div", `${file.name} · ${Math.ceil((file.size || 0) / 1024)} KiB`, "attachment");
    text(fragment, "span", labels[item.status], `delivery r${item.status === "rejected" || item.status === "unsent" ? " error" : ""}`);
  }
}
