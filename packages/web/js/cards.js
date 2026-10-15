import { addIcon, button, text } from "./chat-ui.js";
import { renderA2uiCard } from "./a2ui-card.js";

/**
 * A file the kernel names: {workspace, path} where `workspace` says which body (see body.js) and `path` is a path on it,
 * relative to its work directory (an absolute path is fine for a link in a message). Null when it is not a plain path.
 */
export function fileRef(ref) {
  if (!ref || typeof ref.workspace !== "string" || !/^[A-Za-z0-9:_-]+$/.test(ref.workspace) || typeof ref.path !== "string" || !ref.path || ref.path.includes("\\") || ref.path.includes("\0") || ref.path.includes("//")) return null;
  if (ref.path.split("/").slice(ref.path.startsWith("/") ? 1 : 0).some((part) => !part || part === "." || part === "..")) return null;
  return { workspace: ref.workspace, path: ref.path };
}

/** The phone permissions a card can ask for, in the words the owner knows them by. */
const PERMISSION_NAME = Object.freeze({
  calendar: "日历", notifications: "通知", battery: "后台运行", accessibility: "无障碍", photos: "照片和文件",
  all_files: "所有文件", usage: "使用情况", write_settings: "系统设置", overlay: "悬浮窗", host_shell: "后台也能动手",
});

/** `tone` is her / warn / err / you: the colour of the head line and of the little tile in front of it. */
export function cardHead(parent, tone, glyph, label) {
  const head = text(parent, "div", "", `card-hd c-${tone}`);
  const tile = text(head, "span", "", `chip-ic tile-${tone}`);
  addIcon(tile, glyph, "i-xs");
  text(head, "span", label, "card-hd-text");
  return head;
}

const shell = (parent, className = "") => text(parent, "div", "", `a-card card ${className}`.trim());

/** Every action is a normal owner message or link; the card creates no private channel. */
export function renderCard(parent, item, { onSelect, onPermission, optionPending, onOpenFile, herName = "Ash", a2ui = null } = {}) {
  const card = item.card;
  // A card the agent designed: drawn from its plan; a button on it is the owner's own message or the answer of a form.
  if (card.type === "a2ui") return renderA2uiCard(parent, item, a2ui);
  const root = shell(parent, ["file", "image", "link", "app"].includes(card.type) ? "slim" : "");
  if (card.type === "options") {
    cardHead(root, "her", "ask", `${herName} 问你`);
    text(root, "div", card.prompt || "选一个", "card-title");
    const choices = text(root, "div", "", "opts");
    const busy = item.locked || optionPending?.has(item.id) || typeof onSelect !== "function";
    for (const option of card.options) {
      const mine = item.locked && item.selected_option_id === option.id;
      const choice = button(choices, option.text, `opt${mine ? " on" : item.locked ? " dim" : ""}`, mine ? "check" : "", "i-xs");
      choice.disabled = busy;
      choice.addEventListener("click", async () => {
        if (choice.disabled) return;
        choice.disabled = true;
        try { await onSelect(item, option); }
        catch { choice.disabled = false; }
      });
    }
    if (card.allow_custom && !item.locked) {
      const say = text(root, "div", "", "say");
      const custom = document.createElement("input");
      custom.type = "text";
      custom.placeholder = "自己说…";
      custom.className = "card-custom";
      custom.disabled = busy;
      say.append(custom);
      const send = button(say, "", "sbtn", "up", "i-s");
      send.setAttribute("aria-label", "发送");
      send.disabled = custom.disabled;
      const submit = async () => {
        const value = custom.value.trim();
        if (!value || send.disabled) return;
        send.disabled = true;
        try { await onSelect(item, { id: "__custom", text: value }); }
        catch { send.disabled = false; }
      };
      send.addEventListener("click", submit);
      custom.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void submit(); } });
    }
    return root;
  }
  if (card.type === "file" || card.type === "image") {
    if (!fileRef(card)) return root;
    const open = button(root, "", "att-file card-file");
    const tile = text(open, "span", "", "ic");
    addIcon(tile, card.type === "image" ? "image" : "file");
    text(open, "span", card.type === "image" ? "查看图片" : card.name || card.path.split("/").pop() || "打开文件", "card-file-name");
    open.disabled = typeof onOpenFile !== "function";
    open.addEventListener("click", () => onOpenFile?.(card));
    return root;
  }
  if (card.type === "link") {
    let url;
    try { url = new URL(card.url); } catch { return root; }
    if (!["http:", "https:"].includes(url.protocol)) return root;
    const link = text(root, "a", card.title || url.hostname, "card-title card-open");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (card.summary) text(root, "small", card.summary, "card-body");
    return root;
  }
  if (card.type === "app") {
    // Opens the shell app ("Ash 应用") on this app's page; Ash's chat itself never hosts an app's screens.
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(card.app)) return root;
    root.classList.add("app-card");
    const link = text(root, "a", `打开${card.name} · ${card.title}`, "card-title card-open");
    link.href = `intent://open?app=${card.app}#Intent;package=ai.ash.apps;scheme=ash-app;end`;
    if (card.text) text(root, "small", card.text, "card-body");
    return root;
  }
  if (card.type === "permission") {
    cardHead(root, "you", "lock", "需要授权");
    text(root, "div", `打开「${PERMISSION_NAME[card.permission] ?? "手机"}」权限`, "card-title");
    text(root, "div", card.why || "需要授权", "card-body");
    const row = text(root, "div", "", "card-row");
    const go = button(row, "去授权", "a-btn btn-sm btn-primary");
    go.disabled = typeof onPermission !== "function";
    go.addEventListener("click", () => onPermission?.(card.permission));
  }
  return root;
}
