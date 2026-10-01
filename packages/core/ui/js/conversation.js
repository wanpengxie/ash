// Render only selected conversation facts. The projection never contains raw tool data.
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

/** A legacy workspace reference; the server still enforces owner auth and realpath. */
export function workspaceFileUrl(ref) {
  if (!ref || typeof ref.workspace !== "string" || !/^[a-z0-9_-]+$/.test(ref.workspace) || typeof ref.path !== "string" || !ref.path || ref.path.startsWith("/") || ref.path.includes("\\") || ref.path.includes("\0") || ref.path.includes("//") || ref.path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return `/api/workspaces/${ref.workspace}/files?path=${encodeURIComponent(ref.path)}`;
}

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
export function appendConversation(fragment, entries, { openInline, openWorkspaceFile } = {}) {
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
      const card = text(fragment, "div", item.ask.title, "card ask");
      text(card, "small", item.ask.detail);
    } else if (item.type === "card") {
      text(fragment, "div", item.card.prompt || item.card.title || item.card.name || "卡片", "card");
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
