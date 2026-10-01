import { fold, initialView } from "./project.js";
import { ScreenNet } from "./net.js";

export class Timeline {
  constructor(net, onChange = () => {}) {
    this.net = net;
    this.onChange = onChange;
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch ?? 0) + 1;
    this.pageAbort?.abort();
    this.records = new Map();
    this.view = initialView();
    this.loading = false;
    this.exhausted = false;
    this.onChange(this.view);
  }
  add(message) {
    if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string") return;
    if (this.records.has(message.seq)) return;
    this.records.set(message.seq, message);
    this.view = fold(this.view, message);
    this.onChange(this.view);
  }
  addMany(messages) {
    let changed = false;
    for (const message of messages.sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string" || this.records.has(message.seq)) continue;
      this.records.set(message.seq, message);
      this.view = fold(this.view, message);
      changed = true;
    }
    if (changed) this.onChange(this.view);
  }
  async older() {
    if (this.loading || this.exhausted || !this.records.size) return 0;
    const before = Math.min(...this.records.keys());
    const epoch = this.epoch;
    const controller = new AbortController();
    this.pageAbort = controller;
    this.loading = true;
    try {
      const page = await this.net.page(before, controller.signal);
      if (epoch !== this.epoch) return 0;
      if (page.length < 200) this.exhausted = true;
      this.addMany(page);
      return page.length;
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }
}

function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

export function render(view) {
  const log = document.querySelector("#log");
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const oldHeight = log.scrollHeight;
  const oldTop = log.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!view.conversation.length) text(fragment, "div", "还没有对话。", "hello");
  for (const entry of view.conversation) {
    if (entry.type === "say") {
      const side = entry.side === "owner" ? "me" : "ai";
      if (entry.legacy) {
        text(fragment, "small", `历史记录 · ${entry.legacy.workspace} · ${entry.legacy.member} · 只读`, `from ${side === "me" ? "r" : "l"}`);
      } else if (entry.side === "owner" && entry.origin?.label) {
        text(fragment, "small", `来自 ${entry.origin.label}`, "from r");
      } else if (entry.side === "inbound") {
        text(fragment, "small", `来自 ${entry.from || "未知来源"}`, "from l");
      }
      const bubble = text(fragment, "div", entry.text, `msg ${side}`);
      bubble.dataset.seq = String(entry.seq);
      if (entry.legacy) bubble.dataset.readonly = "true";
    } else if (entry.type === "ask") {
      const card = text(fragment, "div", entry.ask.title, "card ask");
      text(card, "small", entry.ask.detail);
    } else if (entry.type === "card") {
      text(fragment, "div", entry.card.prompt || entry.card.title || entry.card.name || "卡片", "card");
    }
  }
  log.replaceChildren(fragment);
  if (nearEnd) log.scrollTop = log.scrollHeight;
  else log.scrollTop = oldTop + Math.max(0, log.scrollHeight - oldHeight);
  const state = document.querySelector("#state");
  if (view.presence.text) state.title = view.presence.text;
  const avatar = document.querySelector("#face img");
  avatar.src = `/avatars/${view.presence.avatar}.webp`;
}

export function boot() {
  performance.mark("shell.boot");
  const form = document.querySelector("#f");
  const input = document.querySelector("#t");
  const state = document.querySelector("#state");
  const log = document.querySelector("#log");
  const pending = document.querySelector("#pending");
  const suggestions = document.querySelector("#suggestions");
  let presenceProblem = "";
  let lastTyping = 0;
  let timeline;
  const net = new ScreenNet({
    label: sessionStorage.getItem("ash.screen.label.v2")?.trim().slice(0, 80) || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "Phone browser" : "Computer browser"),
    onMessage: (message, context) => {
      timeline.add(message);
      if (context?.historical || message.kind !== "request" || message.word !== "ui.open" || message.to !== net.screen) return;
      const target = message.body?.target;
      const mode = message.body?.mode;
      const targets = { activity: "活动", upcoming: "接下来", approvals: "审批", identity: "身份", memory: "记忆", settings: "设置", turn: "当前任务" };
      if (!Object.hasOwn(targets, target) || !["suggest", "perform"].includes(mode)) return;
      if (mode === "suggest") text(suggestions, "div", `建议查看${targets[target]}（页面尚未接入）`, "chip");
      // None of these destinations has a working page in the shell yet.
      // A suggestion is acknowledged only after it is rendered; an unavailable
      // perform target is explicitly reported as unopened.
      void net.respondOpen(message, false).then((sent) => { if (!sent) state.textContent = "页面请求回执未送达"; }).catch(() => { state.textContent = "页面请求回执未送达"; });
    },
    onHistory: (messages) => { timeline.addMany(messages); performance.mark("shell.history-rendered"); },
    onState: (status, error) => {
      state.textContent = status === "online" ? (presenceProblem || "已连接") : status === "connecting" ? "连接中…" : status === "send-error" ? "消息未送达，等待重试" : "离线，正在重连…";
      if (error) state.title = String(error.message || error);
    },
    onRegistered: () => { if (!document.hidden) void visible(); },
    onQueue: (count) => { pending.textContent = count ? `${count} 条消息等待送达` : ""; },
  });
  timeline = new Timeline(net, render);
  pending.textContent = net.queue.length ? `${net.queue.length} 条消息等待送达` : "";

  async function visible() {
    if (document.hidden || !net.token) return;
    const result = await net.sendEvent("service:post", "visible");
    // A missing service is a pending integration, not proof of presence.
    presenceProblem = result.ok ? "" : result.reason === "HTTP 404" ? "在场服务未就绪" : "在场更新未送达";
    if (net.token) state.textContent = presenceProblem || "已连接";
  }
  async function typing() {
    if (document.hidden || !net.token || !input.value.trim()) return;
    const now = Date.now();
    if (now - lastTyping < 3000) return;
    lastTyping = now;
    await net.sendEvent("agent:main", "typing");
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    net.enqueueSay(value);
    input.value = "";
    log.scrollTop = log.scrollHeight;
  });
  input.addEventListener("input", () => { void typing(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { void visible(); void typing(); }
  });
  const visibleTimer = setInterval(() => { if (!document.hidden) void visible(); }, 30_000);
  const typingTimer = setInterval(() => { if (!document.hidden) void typing(); }, 3_000);
  log.addEventListener("scroll", async () => {
    if (log.scrollTop > 80 || timeline.loading) return;
    const height = log.scrollHeight;
    const top = log.scrollTop;
    try { if (await timeline.older()) log.scrollTop = top + log.scrollHeight - height; }
    catch { state.textContent = "更早记录暂时无法加载"; }
  });
  document.querySelector("#attach").disabled = true;
  document.querySelector("#attach").title = "附件入口待接入";
  document.querySelector("#menu").addEventListener("click", () => document.querySelector("#drawer").classList.toggle("open"));
  text(document.querySelector("#panel"), "p", "更多页面正在接入。", "muted");
  window.addEventListener("pagehide", () => net.stop());
  window.addEventListener("pageshow", (event) => { if (event.persisted) void net.start(); });
  void net.start();
  return { net, timeline };
}

if (typeof document !== "undefined") boot();
