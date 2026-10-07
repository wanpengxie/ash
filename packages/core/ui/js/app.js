import { drawsConversation, fold, foldPostSnapshot, initialView } from "./project.js";
import { ScreenNet } from "./net.js";
import { appendConversation, appendOutbox } from "./conversation.js";
import { renderProgress } from "./progress.js";
import { presentUiOpen } from "./suggestions.js";
import { composerContext } from "./composer.js";
import { openInlineBlob, prepareUploads } from "./attachments.js";
import { SettingsControls } from "./settings.js";
import { PresenceBar } from "./presence.js";
import { AgentSheet } from "./sheet-agent.js";
import { answerGateAsk, approvalSections } from "./sheet-approvals.js";
import { IdentityName } from "./identity-name.js";
import { embeddedUiTransport, readWorkspaceFile } from "./ui-transport.js";
import { Files } from "./files.js";
import { framePainter } from "./frame-painter.js";
import { agentPicker } from "./agent-picker.js";

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
    this.byId = new Map();
    this.view = initialView();
    this.loading = false;
    this.exhausted = false;
    this.ready = false;
    this.onChange(this.view, true);
  }
  /** The first history page has been applied; an empty conversation is now genuinely empty. */
  historyReady() {
    if (this.ready) return;
    this.ready = true;
    this.onChange(this.view, true);
  }
  add(message) {
    if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string") return;
    if (this.records.has(message.seq)) return;
    this.records.set(message.seq, message);
    this.byId.set(message.id, message);
    this.view = fold(this.view, message);
    this.onChange(this.view, drawsConversation(message));
  }
  addMany(messages, snapshots = []) {
    let changed = false;
    let conversation = false;
    for (const message of messages.sort((a, b) => a.seq - b.seq)) {
      if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string" || this.records.has(message.seq)) continue;
      this.records.set(message.seq, message);
      this.byId.set(message.id, message);
      this.view = fold(this.view, message);
      changed = true;
      if (!conversation && drawsConversation(message)) conversation = true;
    }
    for (const snapshot of snapshots) {
      const next = foldPostSnapshot(this.view, snapshot);
      if (next !== this.view) { this.view = next; changed = true; conversation = true; }
    }
    if (changed) this.onChange(this.view, conversation);
  }
  snapshot(snapshot) {
    const next = foldPostSnapshot(this.view, snapshot);
    if (next !== this.view) { this.view = next; this.onChange(this.view, true); }
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
      if (!page.end?.has_more) this.exhausted = true;
      this.addMany(page.messages, page.snapshots);
      return page.messages.length;
    } finally {
      if (epoch === this.epoch) this.loading = false;
    }
  }

  inlineAttachment(messageId, index) {
    const message = this.byId.get(messageId);
    if (!message || message.kind !== "request" || message.word !== "say" || !((message.from === "person:owner" && message.to === "agent:main") || (message.from === "agent:main" && message.to === "person:owner")) || Object.hasOwn(message.body_summary || message.body || {}, "legacy") || !Number.isSafeInteger(index) || index < 0) return null;
    if (message.summary === true) {
      const descriptor = message.inline_attachments?.find((item) => item.index === index);
      return descriptor ? { summary: message, descriptor } : null;
    }
    const item = message.body?.attachments?.[index];
    return item && typeof item.name === "string" && typeof item.mime_type === "string" && typeof item.data === "string" ? { item } : null;
  }
}

function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

export function render(view, outbox = [], openInline, presenceBar, openWorkspaceFile, cardActions) {
  const log = document.querySelector("#log");
  const progressRoot = document.querySelector("#progress");
  const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
  const oldHeight = log.scrollHeight;
  const oldTop = log.scrollTop;
  const fragment = document.createDocumentFragment();
  const expanded = new Set([...(log.querySelectorAll?.("details.work-thread[open]") ?? [])].map(node => node.dataset.thread));
  appendConversation(fragment, view.conversation, { openInline, openWorkspaceFile, ...cardActions, loading: cardActions?.loading?.() === true });
  appendOutbox(fragment, outbox);
  log.replaceChildren(fragment);
  for (const node of log.querySelectorAll?.("details.work-thread") ?? []) if (expanded.has(node.dataset.thread)) node.open = true;
  if (nearEnd) log.scrollTop = log.scrollHeight;
  else log.scrollTop = oldTop + Math.max(0, log.scrollHeight - oldHeight);
  presenceBar?.render(view.presence);
}

export function boot({ uiTransport } = {}) {
  performance.mark("shell.boot");
  const form = document.querySelector("#f");
  const input = document.querySelector("#t");
  let agentSheet;
  let identityName;
  const presenceBar = new PresenceBar(document, { onOpen: () => {
    document.querySelector("#drawer").classList.remove("open");
    agentSheet?.open();
  } });
  const connection = document.querySelector("#connection");
  const progressRoot = document.querySelector("#progress");
  const log = document.querySelector("#log");
  const pending = document.querySelector("#pending");
  const pendingNote = document.querySelector(".pending-note");
  const suggestions = document.querySelector("#suggestions");
  const contextRoot = document.querySelector("#context");
  const context = composerContext(contextRoot, input);
  const fileInput = document.querySelector("#file");
  const attachButton = document.querySelector("#attach");
  const selected = document.querySelector("#selected");
  const sendButton = document.querySelector("#send");
  let presenceProblem = "";
  let lastTyping = 0;
  let timeline;
  let settings;
  let recipient;
  let files;
  const askIntents = new Map();
  const optionPending = new Set();
  const cardActions = {
    agentName: id => recipient?.name(id) ?? id.replace(/^agent:/, ""),
    loading: () => !timeline?.ready,
    onStopThread: async id => net.agentRequest("thread.stop", { thread: id }),
    onOpenFile: (ref) => files.open(ref),
    onFileLink: (href) => files.openLink(href),
    optionPending,
    askIntents,
    onPermission: /\bAshApp\//.test(navigator.userAgent) ? (permission) => {
      if (!/^[a-z][a-z0-9_]{0,47}$/.test(permission)) return;
      location.href = `ash://permission/${permission}`;
    } : undefined,
    onSelect: async (item, option) => {
      if (item.locked || optionPending.has(item.id)) return;
      optionPending.add(item.id);
      try { await net.enqueueSay(option.text, [], { in_reply_to: item.id, option_id: option.id }); }
      catch (error) { optionPending.delete(item.id); throw error; }
    },
    onAnswerAsk: async (ask, choice, answerText) => {
      const fresh = approvalSections(timeline.view).pending.find((item) => item.id === ask.id);
      if (!fresh || fresh.seq !== ask.seq) throw new Error("待批请求已失效。");
      let intent = askIntents.get(ask.id);
      if (intent?.choice && (intent.choice !== choice || intent.answerText !== answerText || intent.status === "pending" || intent.status === "confirmed" || intent.status === "rejected")) return;
      if (!intent?.choice) { intent = { choice, answerText, customDraft: intent?.customDraft, clientId: crypto.randomUUID(), status: "pending" }; askIntents.set(ask.id, intent); }
      else intent.status = "pending";
      const binding = { token: net.token, screen: net.screen, scope: net.currentScope, generation: net.generation };
      const current = () => binding.token === net.token && binding.screen === net.screen && binding.scope === net.currentScope && binding.generation === net.generation;
      try {
        await answerGateAsk(net, current, fresh, choice, intent.clientId, (id) => timeline.byId.get(id), { answerText });
        intent.status = "confirmed";
      } catch (error) {
        intent.status = /无权|被拒绝|已失效|不可用/.test(error?.message || "") ? "rejected" : "uncertain";
        connection.textContent = error instanceof Error ? error.message : "审批结果未知；只能原样重试。";
      }
      render(timeline.view, net.outbox, openInline, presenceBar, openWorkspaceFile, cardActions);
    },
  };
  const clearContext = context.clear;
  const progress = () => renderProgress(progressRoot, timeline?.view, { onOpen: () => {
    if (agentSheet?.open()) void agentSheet.show("activity");
  } });
  const openUiTarget = async (target) => {
    if (!net.token || !net.screen) return false;
    if (target === "settings") {
      if (!net.localManagement) return false;
      if (!agentSheet.close()) return false;
      document.querySelector("#drawer").classList.add("open");
      settings.opened();
      return true;
    }
    const tab = target === "turn" ? "activity" : target;
    if (!agentSheet.open()) return false;
    document.querySelector("#drawer").classList.remove("open");
    await agentSheet.show(tab);
    return agentSheet.activeTab === tab;
  };
  const openInline = async (messageId, index) => {
    const ref = timeline.inlineAttachment(messageId, index);
    if (!ref) return null;
    if (ref.item) return openInlineBlob(ref.item);
    const item = await net.fetchOriginalAttachment(ref.summary, ref.descriptor);
    return openInlineBlob(item, ref.descriptor);
  };
  const openWorkspaceFile = uiTransport?.embedded ? (ref) => readWorkspaceFile(uiTransport, ref) : undefined;
  const net = new ScreenNet({
    uiTransport,
    label: sessionStorage.getItem("ash.screen.label.v2")?.trim().slice(0, 80) || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "手机浏览器" : "电脑浏览器"),
    onMessage: (message, context) => {
      timeline.add(message);
      identityName?.changed(message, context?.historical);
      if (context?.historical || message.kind !== "request" || message.word !== "ui.open" || message.to !== net.screen) return;
      void presentUiOpen(suggestions, message, { open: openUiTarget,
        respond: async (request, opened) => {
          if (!await net.respondOpen(request, opened)) connection.textContent = "页面请求回执未送达";
        } }).catch(() => { connection.textContent = "页面请求回执未送达"; });
    },
    onHistory: (messages, snapshots) => { timeline.addMany(messages, snapshots); performance.mark("shell.history-rendered"); },
    onHistoryReady: () => { timeline.historyReady(); },
    onSnapshot: (snapshot) => { timeline.snapshot(snapshot); },
    onReset: () => { files?.root.close(); askIntents.clear(); optionPending.clear(); timeline.reset(); suggestions.replaceChildren(); clearContext(); settings?.reset(); agentSheet?.reset(); identityName?.reset(); },
    onState: (status, error) => {
      settings?.network(status);
      agentSheet?.network(status);
      if (status !== "online") identityName?.reset();
      presenceBar.network(status, status === "online" ? presenceProblem : "");
      if (error) connection.title = String(error.message || error);
    },
    onRegistered: (frame) => { settings?.registration(frame); agentSheet?.registration(frame); void identityName?.refresh(); void recipient?.refresh(); if (!document.hidden) void visible(); },
    onQueue: (count, outbox) => {
      pending.textContent = count ? `${count} 条消息等待送达` : "";
      pendingNote.hidden = !count; // the storage notice matters only while something waits to be sent
      for (const item of outbox) if (item.in_reply_to && item.status === "rejected") optionPending.delete(item.in_reply_to);
      for (const item of outbox) if (item.in_reply_to && item.status !== "rejected") optionPending.add(item.in_reply_to);
      if (timeline) render(timeline.view, outbox, openInline, presenceBar, openWorkspaceFile, cardActions);
    },
  });
  files = new Files({ request: (path, options) => net.request(path, options) }, {
    embedded: uiTransport?.embedded === true,
    save: uiTransport?.embedded ? (ref) => globalThis.__ashFileSave(ref) : null,
  });
  document.querySelector("#files").onclick = () => files.browse();
  // Pages are counted in ledger records, and a page of background events can hold no conversation at all. Older pages
  // otherwise load only by scrolling to the top, which a short page cannot do: keep reading back until the conversation
  // fills the screen or the history ends.
  let filling = false;
  const fillScreen = async () => {
    if (filling || !timeline) return;
    filling = true;
    try {
      const log = document.querySelector("#log");
      for (let pages = 0; pages < 20 && !timeline.exhausted && log && log.scrollHeight <= log.clientHeight + 80; pages++) {
        if (!await timeline.older()) break;
      }
    } catch { /* the scroll handler can still load older pages */ }
    finally { filling = false; }
  };
  const paintView = framePainter((view, conversation) => {
    if (conversation) render(view, net.outbox, openInline, presenceBar, openWorkspaceFile, cardActions);
    else presenceBar?.render(view.presence);
    progress();
    agentSheet?.update();
    setTimeout(fillScreen, 0);
  });
  timeline = new Timeline(net, paintView);
  identityName = new IdentityName(net, (name) => {
    presenceBar.setName(name);
    document.querySelector("#agentSheetHeader h2").textContent = name;
    agentSheet?.setName(name);
    settings?.setName(name);
  });
  settings = new SettingsControls(document.querySelector("#panel"), net,
    { onClose: () => document.querySelector("#drawer").classList.remove("open") });
  agentSheet = new AgentSheet(document.querySelector("#agentSheet"), net, { getView: () => timeline.view,
    getLedgerMessage: (id) => timeline.byId.get(id), onAskAbout: ({ turn, text: prefill }) => {
      if (!agentSheet.close()) return;
      context.askAbout({ turn, text: prefill });
    }, onPrefill: (prefill) => {
      if (!agentSheet.close()) return;
      clearContext();
      input.value = prefill;
      input.focus();
    } });
  pending.textContent = net.queue.length ? `${net.queue.length} 条消息等待送达` : "";
  pendingNote.hidden = !net.queue.length;

  async function visible() {
    if (document.hidden || !net.token) return;
    const result = await net.sendEvent("service:post", "visible");
    // A missing service is a pending integration, not proof of presence.
    presenceProblem = result.ok ? "" : result.reason === "HTTP 404" ? "在场服务未就绪" : "在场更新未送达";
    if (net.token) presenceBar.network("online", presenceProblem);
  }
  async function typing() {
    if (document.hidden || !net.token || !input.value.trim()) return;
    const now = Date.now();
    if (now - lastTyping < 3000) return;
    lastTyping = now;
    await net.sendEvent("agent:main", "typing");
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const files = [...fileInput.files];
    if (!value && !files.length) return;
    sendButton.disabled = true;
    try {
      const attachments = await prepareUploads(files, value);
      await net.enqueueSay(value, attachments, null, recipient.target());
      input.value = "";
      clearContext();
      fileInput.value = "";
      selected.textContent = "";
      log.scrollTop = log.scrollHeight;
    } catch (error) { connection.textContent = `未发送：${error.message || "无法保存待发送消息"}`; }
    finally { sendButton.disabled = false; }
  });
  input.addEventListener("input", () => { void typing(); });
  recipient = agentPicker(form, input, net, () => { if (timeline) render(timeline.view, net.outbox, openInline, presenceBar, openWorkspaceFile, cardActions); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { void visible(); void typing(); }
    // Leaving the app must not keep deliveries in-app for the rest of the presence window.
    else if (net.token) void net.sendEvent("service:post", "hidden");
  });
  const visibleTimer = setInterval(() => { if (!document.hidden) void visible(); }, 30_000);
  const typingTimer = setInterval(() => { if (!document.hidden) void typing(); }, 3_000);
  const progressTimer = setInterval(() => {
    if (document.hidden) return;
    if (!progressRoot.hidden) progress();
    if (timeline.view.asks.some((ask) => ask.state === "pending" && ask.expires_at <= Date.now()))
      render(timeline.view, net.outbox, openInline, presenceBar, openWorkspaceFile, cardActions);
  }, 1_000);
  log.addEventListener("scroll", async () => {
    if (log.scrollTop > 80 || timeline.loading) return;
    const height = log.scrollHeight;
    const top = log.scrollTop;
    try { if (await timeline.older()) log.scrollTop = top + log.scrollHeight - height; }
    catch { connection.textContent = "更早记录暂时无法加载"; }
  });
  attachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = [...fileInput.files];
    selected.textContent = files.length ? `${files.length} 个附件，${files.map((file) => file.name).join("、").slice(0, 120)}` : "";
  });
  document.querySelector("#menu").addEventListener("click", () => {
    if (!agentSheet.close()) return;
    if (document.querySelector("#drawer").classList.toggle("open")) settings.opened();
  });
  window.addEventListener("pagehide", () => { clearInterval(progressTimer); net.stop(); });
  window.addEventListener("offline", () => agentSheet.reset());
  window.addEventListener("online", () => net.reconnect());
  window.addEventListener("pageshow", (event) => { if (event.persisted) void net.start(); });
  void net.start();
  return { net, timeline };
}

// A packaged asset page must wait for an explicitly injected native transport.
if (typeof document !== "undefined" && globalThis.location?.origin !== "https://appassets.androidplatform.net" &&
    !document.documentElement?.hasAttribute("data-native-transport")) boot();
else if (typeof document !== "undefined" && globalThis.location?.origin === "https://appassets.androidplatform.net") {
  globalThis.__ashNativeBoot = (request, endpoint) => {
    const transport = embeddedUiTransport({ request, endpoint });
    transport.authorizeReady();
    return boot({ uiTransport: transport });
  };
}
