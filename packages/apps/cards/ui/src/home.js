// 卡片: the page. The host protocol (MCP Apps, JSON-RPC with the parent window or a MessagePort it hands over) is set up
// here in <head>, so the port the host gives at first draw is not missed; the list is drawn once the body is there.
(() => {
  let port = null, next = 0;
  const waiting = new Map();
  const post = (message) => port ? port.postMessage(JSON.stringify(message)) : window.parent.postMessage(message, "*");
  const theme = (context) => { if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme; };
  const receive = (raw) => {
    let message = raw;
    if (typeof raw === "string") { try { message = JSON.parse(raw); } catch { return; } }
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && waiting.has(message.id) && !message.method) {
      const item = waiting.get(message.id); waiting.delete(message.id);
      message.error ? item.reject(new Error(message.error.message || "host error")) : item.resolve(message.result);
    } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  };
  window.addEventListener("message", (event) => {
    if (!port && event.ports && event.ports[0]) { port = event.ports[0]; port.onmessage = (inner) => receive(inner.data); return; }
    receive(event.data);
  });
  const request = (method, params, ms = 30000) => new Promise((resolve, reject) => {
    const id = ++next; waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error("host did not answer")); }, ms);
    post({ jsonrpc: "2.0", id, method, params });
  });
  const ready = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await request("ui/initialize", { protocolVersion: "2026-01-26", capabilities: {}, clientInfo: { name: "cards", version: "1.0.0" } }, 5000);
    theme(result && result.hostContext);
    post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    new ResizeObserver(() => post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } })).observe(document.body);
  })();
  async function call(name, args = {}) {
    await ready;
    const result = await request("tools/call", { name, arguments: args }, 60000);
    if (!result || result.isError) throw new Error((result && result.content && result.content[0] && result.content[0].text) || "没做成");
    return result.structuredContent || {};
  }

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) key === "class" ? node.className = value : node.setAttribute(key, value);
    for (const child of children) node.append(child);
    return node;
  };
  /** An error as the owner reads it: Ash's sentence in Chinese, never a code. */
  const say = (error) => {
    const message = error && error.message ? String(error.message) : "";
    if (/host did not answer/.test(message)) return "请在「Ash 应用」里打开卡片。";
    return /[一-鿿]/.test(message) ? message : "出了点问题，稍后再试";
  };
  /** 今天 09:30, 昨天 21:00, or 10月6日 08:00. */
  const when = (ts) => {
    if (typeof ts !== "number" || !(ts > 0)) return "";
    const d = new Date(ts), now = new Date();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day(now) - day(d)) / 86400000);
    return ago === 0 ? `今天 ${hm}` : ago === 1 ? `昨天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  };
  const LIFE = { active: ["运行中", "tag-ok"], idle: ["闲置", "tag-mute"], dormant: ["休眠", "tag-her"], closed: ["已收起", "tag-mute"] };
  const whose = (card) => card.app_name || (card.app ? (card.temporary_app ? "一个临时应用" : "一个应用") : "Ash");

  let list, sum, note, busy = false;
  async function act(name, args, done) {
    if (busy) return;
    busy = true;
    for (const button of list.querySelectorAll("button")) button.disabled = true;
    try { await call(name, args); note.textContent = done; }
    catch (error) { note.textContent = `没做成：${say(error)}`; }
    busy = false;
    await load();
  }
  const button = (label, tone, onClick) => { const b = el("button", { type: "button", class: `a-btn btn-sm ${tone}` }, label); b.addEventListener("click", onClick); return b; };
  function row(card) {
    const [life, tone] = LIFE[card.life] || LIFE.idle;
    const sources = Array.isArray(card.sources) ? card.sources.length : 0;
    const seen = when(Math.max(Number(card.last_seen) || 0, Number(card.last_used) || 0));
    const meta = [whose(card), sources ? `实时数据 ${sources} 项` : "", seen ? `上次看到 ${seen}` : ""].filter(Boolean).join(" · ");
    const acts = card.life === "closed" ? [] : [
      card.life === "dormant" ? button("唤醒", "btn-secondary", () => act("cards.wake", { id: card.id }, "已唤醒")) : button("休眠", "btn-neutral", () => act("cards.sleep", { id: card.id }, "已休眠")),
      button(card.pinned ? "取消固定" : "固定", "btn-neutral", () => act("cards.pin", { id: card.id, pinned: !card.pinned }, card.pinned ? "已取消固定" : "已固定，它会一直运行")),
      button("收起", "btn-danger", () => act("cards.close", { id: card.id }, "已收起")),
    ];
    return el("div", { class: "item" },
      el("div", { class: "txt tx-body" }, card.text || "一张卡片"),
      el("div", { class: "tags" }, el("span", { class: `tag ${tone}` }, life), ...(card.pinned ? [el("span", { class: "tag tag-you" }, "已固定")] : []), el("span", { class: "tx-sub" }, meta)),
      ...(acts.length ? [el("div", { class: "acts" }, ...acts)] : []));
  }
  async function load() {
    try {
      const { cards = [], limits = {} } = await call("cards.list");
      const running = cards.filter((card) => card.life === "active").length;
      sum.textContent = cards.length ? `共 ${cards.length} 张，${running} 张在运行${limits.max_active ? `（同时最多 ${limits.max_active} 张）` : ""}` : "";
      list.replaceChildren(...(cards.length ? cards.map(row) : [el("div", { class: "empty-note tx-callout" }, "对话里现在没有在运行的卡片。")]));
    } catch (error) {
      sum.textContent = "";
      list.replaceChildren(el("div", { class: "item tx-callout c-warn" }, `没读到卡片：${say(error)}`));
    }
  }
  document.addEventListener("DOMContentLoaded", () => {
    list = document.getElementById("list"); sum = document.getElementById("sum"); note = document.getElementById("note");
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !busy) load(); });
    load();
  });
})();
