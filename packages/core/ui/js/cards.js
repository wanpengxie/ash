const text = (parent, tag, value, className = "") => {
  const element = document.createElement(tag);
  element.textContent = String(value ?? "");
  if (className) element.className = className;
  parent.append(element);
  return element;
};

export function workspaceFileUrl(ref) {
  if (!ref || typeof ref.workspace !== "string" || !/^[a-z0-9_-]+$/.test(ref.workspace) || typeof ref.path !== "string" || !ref.path || ref.path.startsWith("/") || ref.path.includes("\\") || ref.path.includes("\0") || ref.path.includes("//") || ref.path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return `/api/workspaces/${ref.workspace}/files?path=${encodeURIComponent(ref.path)}`;
}

/** Every action is a normal owner message or link; the card creates no private channel. */
export function renderCard(parent, item, { onSelect, onPermission, optionPending, openWorkspaceFile, onOpenFile } = {}) {
  const card = item.card;
  const root = text(parent, "div", "", "card");
  if (card.type === "options") {
    text(root, "b", card.prompt || "选一个");
    for (const option of card.options) {
      const button = text(root, "button", option.text, "btn gray");
      button.type = "button";
      button.disabled = item.locked || optionPending?.has(item.id) || typeof onSelect !== "function";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await onSelect(item, option); }
        catch { button.disabled = false; }
      });
    }
    if (card.allow_custom) {
      const custom = document.createElement("input");
      custom.type = "text";
      custom.placeholder = "自己说…";
      custom.className = "card-custom";
      custom.disabled = item.locked || optionPending?.has(item.id) || typeof onSelect !== "function";
      root.append(custom);
      const send = text(root, "button", "发送", "btn gray");
      send.type = "button";
      send.disabled = custom.disabled;
      send.addEventListener("click", async () => {
        const value = custom.value.trim();
        if (!value || send.disabled) return;
        send.disabled = true;
        try { await onSelect(item, { id: "__custom", text: value }); }
        catch { send.disabled = false; }
      });
    }
    if (item.locked) text(root, "small", "已选择");
    return root;
  }
  if (card.type === "file" || card.type === "image") {
    const url = workspaceFileUrl(card);
    if (!url) return root;
    if (onOpenFile) {
      const button = text(root, "button", card.name || card.path.split("/").pop(), "btn gray");
      button.type = "button"; button.onclick = () => onOpenFile(card); return root;
    }
    if (openWorkspaceFile) {
      const button = text(root, "button", card.type === "image" ? "查看图片" : card.name || "打开文件", "btn gray");
      button.type = "button";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const blob = await openWorkspaceFile(card);
          const objectUrl = URL.createObjectURL(blob);
          if (card.type === "image") {
            const image = document.createElement("img");
            image.src = objectUrl;
            image.alt = card.alt || "图片";
            image.className = "card-image";
            image.addEventListener("load", () => setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000), { once: true });
            image.addEventListener("error", () => URL.revokeObjectURL(objectUrl), { once: true });
            root.append(image);
          } else {
            const download = document.createElement("a");
            download.href = objectUrl;
            download.download = card.name || "file";
            download.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
          }
        } catch { button.title = "文件无法打开"; }
        finally { button.disabled = false; }
      });
      return root;
    }
    if (card.type === "image") {
      const image = document.createElement("img");
      image.src = url;
      image.alt = card.alt || "图片";
      image.className = "card-image";
      root.append(image);
    } else {
      const link = text(root, "a", card.name || "打开文件");
      link.href = url;
      link.download = card.name || "file";
    }
    return root;
  }
  if (card.type === "link") {
    let url;
    try { url = new URL(card.url); } catch { return root; }
    if (!["http:", "https:"].includes(url.protocol)) return root;
    const link = text(root, "a", card.title || url.hostname);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (card.summary) text(root, "small", card.summary);
    return root;
  }
  if (card.type === "permission") {
    text(root, "b", card.why || "需要授权");
    const button = text(root, "button", "去授权", "btn gray");
    button.type = "button";
    button.disabled = typeof onPermission !== "function";
    button.addEventListener("click", () => onPermission?.(card.permission));
  }
  return root;
}
