// 页面和 Ash 之间（MCP Apps，JSON-RPC 2.0）。每一页都会带上这个文件，页面里用 window.app：
//   await app.call("工具名", {参数})  调用本应用自己的工具，返回它的 structuredContent；失败时抛出错误，message 是工具给的说明
//   app.show("视图名")               在一页里切换 <section data-view="…">（页面内跳转）
//   await app.tell("文字")            替主人给 Ash 发一句话（主人先确认）
//   await app.openLink("https://…")   在浏览器里打开链接（主人先确认）
//   app.el("div", {class: "card"}, "文字", 子元素…)  造一个元素
// 深浅色跟着 Ash：<html data-theme="light|dark">，配色用 app.css 里的变量。
(() => {
  let next = 0;
  const waiting = new Map();
  const post = (message) => window.parent.postMessage(message, "*");
  const theme = (context) => { if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme; };
  window.addEventListener("message", (event) => {
    let message = event.data;
    if (typeof message === "string") { try { message = JSON.parse(message); } catch { return; } }
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && !message.method && waiting.has(message.id)) {
      const item = waiting.get(message.id); waiting.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || "出错了")); else item.resolve(message.result);
    } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  });
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error("Ash 没有回应：请在「Ash 应用」里打开这一页")); }, ms);
    post({ jsonrpc: "2.0", id, method, params });
  });
  const ready = request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: document.title, version: "1" }, appCapabilities: {} }, 10000)
    .then((result) => {
      theme(result && result.hostContext);
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      return (result && result.hostContext) || {};
    });
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (key === "class") node.className = value; else node.setAttribute(key, value);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  };
  window.app = {
    ready,
    el,
    async call(name, args = {}) {
      await ready;
      const result = await request("tools/call", { name, arguments: args }, 120000);
      if (!result || result.isError) throw new Error((result && result.content && result.content[0] && result.content[0].text) || "没办成");
      return result.structuredContent || {};
    },
    show(view) { for (const node of document.querySelectorAll("[data-view]")) node.hidden = node.dataset.view !== view; },
    async tell(text) { await ready; await request("ui/message", { role: "user", content: [{ type: "text", text }] }, 300000); },
    async openLink(url) { await ready; await request("ui/open-link", { url }, 300000); },
  };
})();
