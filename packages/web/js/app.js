import { ConversationTimeline as Timeline } from "./conversation-timeline.js";
export { ConversationTimeline as Timeline } from "./conversation-timeline.js";
import { HomeFeed } from "./home-feed.js";
import { FullTexts } from "./full-texts.js";
import { IdleExpansion } from "./idle-expansion.js";
import { connectHome } from "./home.js";
import { Net } from "./net.js";
import { installCoworkerNet } from "./coworker-net.js";
import { DesktopWork } from "./desktop-work.js";
import { mountDesktopMaterials } from "./desktop-materials-mount.js";
import { createDesktopMaterialsPort, browserMaterialPicker } from "./desktop-materials-port.js";
import { WindowView } from "./window-view.js";
import { renderProgress } from "./progress.js";
import { presentUiOpen } from "./suggestions.js";
import { composerContext } from "./composer.js";
import { openInlineBlob, prepareUploads } from "./attachments.js";
import { readInlineAttachment } from "./inline-attachment.js";
import { addPicked, attachMenu } from "./attach-menu.js";
import { PresenceBar } from "./presence.js";
import { answerGateAsk } from "./approvals.js";
import { IdentityName } from "./identity-name.js";
import { Files } from "./files.js";
import { framePainter } from "./frame-painter.js";
import { agentPicker } from "./agent-picker.js";
import { addIcon, avatarUrl } from "./chat-ui.js";

/** The pages of her home that the kernel (or the agent) can ask this page to open, by the name it uses; others are aliases. */
const HOME_SECTIONS = new Set(["waiting", "upcoming", "memory", "promises", "hands", "backstage", "identity", "files", "activity",
  "settled", "device", "connect", "browser", "apps", "app", "keys", "model", "usage", "advanced"]);
const TARGET_SECTION = Object.freeze({ approvals: "waiting", turn: "activity" });


function text(parent, tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value ?? "");
  parent.append(node);
  return node;
}

/** Turns of the front lane that ended in an error in the last day and were not followed by anything the owner said: each gets a card. */
export function failedTurns(view, now = Date.now()) {
  if (Array.isArray(view.failures)) return view.failures;
  const last = [...view.conversation].reverse().find((item) => item.type === "say" && item.side === "owner");
  // A failure from yesterday is history, not something to retry.
  return Object.entries(view.turns ?? {})
    .filter(([, turn]) => turn.background !== true && turn.outcome === "error" && Number.isFinite(turn.ended) && now - turn.ended < 86_400_000 && !(last && last.ts > turn.ended))
    .map(([turn, info]) => {
      // What to say again: the owner's last words before the turn began, when they were plain text.
      const said = [...view.conversation].reverse().find(item => item.type === "say" && item.side === "owner" && item.ts <= info.started);
      return { turn, ts: info.ended, retry: said && !said.full && said.text && !(said.attachments?.length) ? { text: said.text, to: said.to } : null };
    });
}

const views = new WeakMap();
const conversationView = log => {
  let view = views.get(log);
  if (!view || view.closed) { view = new WindowView(log); views.set(log, view); }
  return view;
};

export function render(view, outbox = [], openInline, presenceBar, cardActions, dirty = null) {
  const log = document.querySelector("#log");
  const loading = cardActions?.loading?.() === true;
  conversationView(log).update(view.conversation, outbox, { openInline, ...cardActions, loading,
    failures: loading ? [] : failedTurns(view), atStart: cardActions?.atStart?.() === true, atLatest: cardActions?.atLatest?.() !== false,
    herName: cardActions?.herName?.() ?? "Ash", epoch: cardActions?.epoch?.() }, dirty);
  presenceBar?.render(loading ? { state: "unknown" } : view.presence);
}

export function boot() {
  performance.mark("shell.boot");
  const form = document.querySelector("#f");
  const input = document.querySelector("#t");
  let identityName;
  let desktopWork;
  const presenceBar = new PresenceBar(document, { onOpen: () => openHome({ agent: recipient?.picked() }) });
  const connection = document.querySelector("#connection");
  const progressRoot = document.querySelector("#progress");
  const log = document.querySelector("#log");
  const historyNav = document.querySelector("#historyNav");
  const returnLatest = document.querySelector("#returnLatest");
  const suggestions = document.querySelector("#suggestions");
  const contextRoot = document.querySelector("#context");
  const context = composerContext(contextRoot, input);
  const fileInput = document.querySelector("#file");
  const attachButton = document.querySelector("#attach");
  const selected = document.querySelector("#selected");
  const sendButton = document.querySelector("#send");
  const appsButton = document.querySelector("#apps");
  addIcon(appsButton, "grid");
  addIcon(attachButton, "plus");
  addIcon(sendButton, "up");
  addIcon(document.querySelector("#netBannerIcon"), "wifioff", "i-s");
  /** Files chosen so far (photos, videos, files), sent with the next message. */
  let picked = [];
  /** The send button is the coral one only when there is something to send. */
  const sendable = () => { sendButton.classList.toggle("idle", !input.value.trim() && !picked.length); };
  const showPicked = () => {
    selected.replaceChildren();
    selected.hidden = !picked.length;
    sendable();
    if (!picked.length) return;
    const chip = document.createElement("span");
    chip.className = "ctx";
    chip.title = picked.map((file) => file.name).join("、").slice(0, 200);
    chip.append(`${picked.length} 个附件`);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "chip-clear";
    clear.setAttribute("aria-label", "移除附件");
    addIcon(clear, "x", "i-xs");
    clear.addEventListener("click", () => { picked = []; showPicked(); });
    chip.append(clear);
    selected.append(chip);
  };
  const homeFeed = new HomeFeed();
  let timeline;
  let restorer;
  let recipient;
  let files;
  /** Ask for her home, or for the apps page (`page: "apps"`): whoever owns that page answers the event. */
  const openHome = ({ page = "home", agent, section } = {}) => window.dispatchEvent(new CustomEvent("ash:open",
    { cancelable: true, detail: { page, ...(agent ? { agent } : {}), ...(section ? { section } : {}) } }));
  const askIntents = homeFeed.intents;
  const optionPending = new Set();
  /** Long texts read from the ledger on demand, by blob hash. */
  const fullTexts = new FullTexts();
  const discardText = (hash, id) => {
    fullTexts.hide(id);
    const pins = new Set(conversationView(log).pinnedIds());
    for (const item of timeline.store.items) if (item.id === id && item.full === hash && !pins.has(id)) timeline.store.collapse(item.id);
    fullTexts.retain(timeline.store.items);
  };
  const redraw = () => { if (timeline) paintView(timeline.view, true); };
  let navigation = null, navigationSerial = 0;
  const applyNavigation = () => {
    if (!navigation) return;
    const view = conversationView(log);
    if (navigation.latest) { view.position.latest(); navigation = null; }
    else if (view.jump(navigation.id)) navigation = null;
  };
  const retainReadingAnchor = () => {
    const anchor = views.get(log)?.position.capture();
    timeline.store.anchor = anchor && !anchor.bottom && anchor.key?.replace(/^(message|failure):/, "") || null;
  };
  const locate = async id => {
    const serial = ++navigationSerial;
    await (id ? timeline.jump(id) : timeline.latest());
    if (serial !== navigationSerial) return false;
    navigation = id ? { id } : { latest: true };
    restorer?.scroll(); // Navigation starts a fresh quiet interval; an earlier idle deadline must not admit a heavy body immediately.
    redraw(); return true;
  };
  const disclosureCharges = new Map();
  const readDisclosure = async (ask, field, signal) => {
    const dataset = timeline.store.dataset, hash = ask[field];
    const text = await net.readBlobText(hash, { signal });
    if (signal?.aborted || dataset !== timeline.store.dataset || timeline.get(ask.id)?.ask?.[field] !== hash) throw new Error("这段文字已经离开当前对话。");
    const charges = disclosureCharges.get(ask.id) ?? new Set();
    const charge = new TextEncoder().encode(text).byteLength;
    // Each simultaneous disclosure owns its own charge and releases it exactly once.
    const entry = { bytes: charge }; charges.add(entry);
    retainReadingAnchor();
    const total = [...charges].reduce((sum, value) => sum + value.bytes, 0);
    const dirty = timeline.store.expand(ask.id, total);
    if (!dirty) { charges.delete(entry); throw new Error("请先结束当前文字选择，再查看完整文字。"); }
    disclosureCharges.set(ask.id, charges);
    paintView(timeline.view, true, dirty);
    let released = false;
    return { text, release: () => {
      if (released) return; released = true; charges.delete(entry);
      if (disclosureCharges.get(ask.id) !== charges) return;
      if (!charges.size) disclosureCharges.delete(ask.id);
      if (dataset === timeline.store.dataset) {
        const remaining = [...charges].reduce((sum, value) => sum + value.bytes, 0);
        if (remaining) timeline.store.expand(ask.id, remaining); else timeline.store.collapse(ask.id);
      }
    } };
  };
  const cardActions = {
    agentName: id => recipient?.name(id) ?? id.replace(/^agent:/, ""),
    get primary() { return net.primary; },
    loading: () => !timeline?.ready,
    epoch: () => timeline?.store.dataset,
    atStart: () => timeline?.store.intro === true,
    atLatest: () => !timeline?.store.hasAfter,
    get previous() { return timeline?.store.previous; },
    get next() { return timeline?.store.next; },
    shouldBuild: id => restorer?.active?.item.id !== id || restorer.idle(),
    herName: () => presenceBar.title.textContent || "Ash",
    onRetry: async (failure) => {
      await net.enqueueSay(failure.retry.text, [], null, failure.retry.to ?? recipient.target());
      if (timeline.store.hasAfter) await locate().catch(error => presenceBar.problem(error.message)); else conversationView(log).position.latest();
    },
    onOpenFile: (ref) => files.open(ref),
    onFileLink: (href) => files.openLink(href),
    onReadOriginal: (ask, signal) => readDisclosure(ask, "original_full", signal),
    onReadAnswer: (ask, signal) => readDisclosure(ask, "answer_full", signal),
    fullTexts,
    onExpand: async (hash, id, { automatic = false, signal, mounted = () => {} } = {}) => {
      id ??= timeline.store.items.find(item => item.full === hash)?.id;
      if (!id || !timeline.get(id)) return;
      if (!automatic) { restorer.cancel(); await fullTexts.pending.get(hash)?.catch(() => {}); }
      const dataset = timeline.store.dataset;
      retainReadingAnchor();
      const entry = await fullTexts.load(id, hash, value => net.readBlobText(value, { signal }));
      if (!entry || signal?.aborted || dataset !== timeline.store.dataset || timeline.get(id)?.full !== hash) { if (signal?.aborted) discardText(hash, id); fullTexts.retain(timeline.store.items); return; }
      const dirty = timeline.store.expand(id, entry.bytes);
      if (!dirty) { discardText(hash, id); throw new Error("结束当前文字选择后，再展开这条消息。"); }
      fullTexts.retain(timeline.store.items);
      const view = conversationView(log), cancel = () => view.cancelExpansion(id);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        mounted();
        paintView(timeline.view, true, dirty);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const lifetime = view.rows.get(`message:${id}`)?.lifetime;
        if (lifetime) lifetime.cleanup.add(lifetime.sourceBudgetRelease ??= () => {
          if (dataset === timeline.store.dataset && timeline.get(id)?.full === hash && !fullTexts.has(hash, id)) timeline.store.collapse(id);
        });
        // Native selection can defer replacing the preview; keep automatic ownership until the actual body exists.
        while (!signal?.aborted && view.rows.get(`message:${id}`)?.deferred) await new Promise(resolve => setTimeout(resolve, 50));
        if (signal?.aborted) cancel();
        await view.settled(id);
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (automatic && (signal?.aborted || !timeline.get(id))) { discardText(hash, id); redraw(); }
      }
    },
    optionPending,
    askIntents,
    onSelect: async (item, option) => {
      if (item.locked || optionPending.has(item.id)) return;
      optionPending.add(item.id);
      try { await net.enqueueSay(option.text, [], { in_reply_to: item.id, option_id: option.id }); }
      catch (error) { optionPending.delete(item.id); throw error; }
    },
    onAnswerAsk: async (ask, choice, answerText) => {
      const fresh = timeline.view.asks.find((item) => item.id === ask.id);
      if (!fresh || fresh.seq !== ask.seq || fresh.state !== "pending") throw new Error("这个问题已经过期，不用再回答了。");
      let intent = askIntents.get(ask.id);
      if (intent?.choice && (intent.choice !== choice || intent.answerText !== answerText || intent.status === "pending" || intent.status === "confirmed" || intent.status === "rejected")) return;
      if (!intent?.choice) { intent = { choice, answerText, customDraft: intent?.customDraft, clientId: crypto.randomUUID(), status: "pending" }; askIntents.set(ask.id, intent); }
      else intent.status = "pending";
      const binding = net.binding();
      try {
        if (!net.same(binding)) throw new Error("连接刚换过，回答没有送出，请再点一次。");
        await answerAsk(net, fresh, choice, intent.clientId, { answerText });
        intent.status = "confirmed";
      } catch (error) {
        intent.status = /无权|被拒绝|已失效|不可用|已经过期|没有这个选项|没被接受/.test(error?.message || "") ? "rejected" : "uncertain";
        presenceBar.problem(error instanceof Error ? error.message : "回答有没有送到还不知道，请再点一次。");
      }
      redraw();
    },
  };
  const clearContext = context.clear;
  const progress = () => renderProgress(progressRoot, timeline?.view, { onOpen: () => { openHome({ section: "activity" }); } });
  /** The kernel (or the agent) asks the page to open a page: her home or one of its pages, a file... */
  const openUiTarget = async (target, request = {}) => {
    if (!net.session) return false;
    if (target === "file") {
      if (typeof request.id !== "string" || !request.id) return false;
      void files.open({ workspace: "main", path: request.id });
      return true;
    }
    if (target === "message" && typeof request.id === "string") return locate(request.id);
    const section = TARGET_SECTION[target] ?? (HOME_SECTIONS.has(target) ? target : undefined);
    if (target !== "settings" && !section) return false;
    // The answer is whether the home page took the event.
    return !openHome({ section });
  };
  const openInline = async (messageId, index) => {
    const attachment = await readInlineAttachment(net, timeline.get(messageId), messageId, index);
    return attachment ? openInlineBlob(attachment) : null;
  };
  const net = new Net({
    label: sessionStorage.getItem("ash.web.label")?.trim().slice(0, 80) || (/Android|iPhone|iPad/i.test(navigator.userAgent) ? "手机浏览器" : "电脑浏览器"),
    onMessage: (message) => { timeline.add(message); },
    onHistory: (page) => { timeline.acceptPage(page); performance.mark("shell.history-rendered"); },
    onCurrent: (current) => { timeline.acceptCurrent(current); },
    historyTarget: () => {
      if (!timeline?.ready || !timeline.store.hasAfter) return {};
      const first = [...log.querySelectorAll("[data-seq]")].find(node => node.getBoundingClientRect().bottom > log.getBoundingClientRect().top);
      const id = first?.dataset.rowKey?.replace(/^message:/, "") || first?.dataset.messageId;
      return id ? { around_id: id } : timeline.store.items[0] ? { around_id: timeline.store.items[0].id } : {};
    },
    onHistoryReady: () => { timeline.historyReady(); },
    onPresent: async (request) => {
      const opened = await presentUiOpen(suggestions, request, openUiTarget).catch(() => false);
      return { ok: true, data: { opened } };
    },
    onState: (status, detail) => {
      desktopWork?.network(status);
      if (status === "closed") { net.acceptScope?.(null); desktopWork?.reset(); }
      if (["connecting", "offline", "closed"].includes(status)) timeline?.clearCurrentRefresh();
      window.dispatchEvent(new CustomEvent("ash:net-state", { detail: { net, event: "onState" } }));
      if (status !== "online") identityName?.reset();
      presenceBar.network(status, status === "closed" ? detail : "");
      if (status === "send-error" && detail) connection.title = String(detail.message || detail);
      if (status === "online" || status === "connecting") sendable();
    },
    onOpen: () => {
      void net.refreshCoworkerScope?.().then(() => desktopWork?.network("online")).catch(() => {});
      timeline?.clearCurrentRefresh();
      homeFeed.reset();
      window.dispatchEvent(new CustomEvent("ash:net-state", { detail: { net, event: "onOpen" } }));
      void identityName?.refresh();
      void recipient?.refresh();
      net.setVisible(!document.hidden);
    },
    onQueue: (count, outbox) => {
      for (const item of outbox) if (item.in_reply_to && item.status === "rejected") optionPending.delete(item.in_reply_to);
      for (const item of outbox) if (item.in_reply_to && item.status !== "rejected") optionPending.add(item.in_reply_to);
      if (timeline) paintView(timeline.view, true, new Set(outbox.map(item => item.in_reply_to).filter(Boolean)));
    },
  });
  installCoworkerNet(net);
  const desktopRoot = document.createElement("section");
  desktopRoot.id = "desktopWork"; desktopRoot.hidden = true;
  desktopRoot.setAttribute("aria-label", "电脑会话"); document.body.append(desktopRoot);
  const materialsPanel = document.createElement("section"); materialsPanel.id = "desktopMaterials"; materialsPanel.hidden = true; materialsPanel.setAttribute("aria-label", "材料与回答");
  const materialsClose = document.createElement("button"); materialsClose.id = "desktopMaterialsClose"; materialsClose.type = "button"; materialsClose.textContent = "关闭";
  const materialsBody = document.createElement("div"); materialsBody.id = "desktopMaterialsBody"; materialsPanel.append(materialsClose, materialsBody); document.body.append(materialsPanel);
  const materialsButton = document.createElement("button"); materialsButton.id = "desktopMaterialsOpen"; materialsButton.type = "button"; materialsButton.textContent = "材料"; materialsButton.className = "btn ghost"; appsButton.before(materialsButton);
  const materials = mountDesktopMaterials({ document, net, picker: browserMaterialPicker(net) });
  desktopWork = new DesktopWork(desktopRoot, net, { onMaterials: work => materials.open(work), imagePortFactory: () => createDesktopMaterialsPort(net, { picker: browserMaterialPicker(net) }) });
  const desktopButton = document.createElement("button");
  desktopButton.type = "button"; desktopButton.textContent = "电脑";
  desktopButton.className = "btn ghost";
  desktopButton.onclick = () => desktopWork.open();
  appsButton.before(desktopButton);
  connectHome(net, homeFeed);
  files = new Files(net);
  // Visible-item pages cannot be drowned by background ledger events; fill a short viewport from finite older pages.
  let filling = false;
  const fillScreen = async () => {
    if (filling || !timeline) return;
    filling = true;
    try {
      const log = document.querySelector("#log");
      for (let pages = 0; pages < 20 && !timeline.exhausted && timeline.store.items.length < timeline.store.maxItems && timeline.store.bytes < timeline.store.maxBytes && log && log.scrollHeight <= log.clientHeight + 80; pages++) {
        retainReadingAnchor();
        if (!await timeline.older()) break;
      }
    } catch { /* the scroll handler can still load older pages */ }
    finally { filling = false; }
  };
  const paintView = framePainter((view, conversation, dirty) => {
    // A dataset reset drops texts and transient choices before any new entity is painted.
    if (fullTexts.dataset !== timeline.store.dataset) {
      fullTexts.reset(); fullTexts.dataset = timeline.store.dataset;
      restorer?.reset();
      askIntents.clear(); optionPending.clear();
    }
    const active = new Set(timeline.store.items.map(item => item.id));
    askIntents.prune(active);
    for (const id of optionPending) if (!active.has(id) && !net.outbox.some(item => item.in_reply_to === id)) optionPending.delete(id);
    fullTexts.retain(timeline.store.items);
    if (conversation) render(timeline.view, net.outbox, openInline, presenceBar, cardActions, dirty);
    else presenceBar?.render(timeline?.ready ? view.presence : { state: "unknown" });
    progress();
    historyNav.hidden = !timeline.store.hasAfter && !timeline.unseen;
    returnLatest.textContent = timeline.unseen ? `回到最新 · ${timeline.unseen} 条新消息` : "回到最新";
    applyNavigation();
    restorer?.wake();
    setTimeout(fillScreen, 0);
  });
  timeline = new Timeline(net, paintView);
  timeline.store.expandedSize = item => item.full && fullTexts.has(item.full, item.id) ? fullTexts.values.get(item.full)?.bytes ?? 0 : 0;
  timeline.onCurrent = current => homeFeed.setCurrent(current);
  restorer = new IdleExpansion({
    contains: id => Boolean(timeline.get(id)),
    near: id => {
      const row = views.get(log)?.rows.get(`message:${id}`)?.nodes.find(node => node.matches?.(".msg"));
      if (!row) return false;
      const bounds = log.getBoundingClientRect(), rect = row.getBoundingClientRect();
      return Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0) < log.clientHeight / 2;
    },
    candidates: () => {
      const bounds = log.getBoundingClientRect(), rows = views.get(log)?.rows;
      return timeline.store.items.filter(item => item.full && fullTexts.expanded(item.id) && !fullTexts.has(item.full, item.id))
        .map(item => {
          const row = rows?.get(`message:${item.id}`)?.nodes.find(node => node.matches?.(".msg"));
          const rect = row?.getBoundingClientRect();
          return { item, distance: rect ? Math.max(bounds.top - rect.bottom, rect.top - bounds.bottom, 0) : Infinity };
        }).filter(candidate => candidate.distance < log.clientHeight / 2).sort((a, b) => a.distance - b.distance).map(candidate => candidate.item);
    },
    restore: async (item, signal, mounted) => {
      try { await cardActions.onExpand(item.full, item.id, { automatic: true, signal, mounted }); }
      catch (error) { redraw(); throw error; }
    },
  });
  returnLatest.addEventListener("click", () => { void locate().catch(error => presenceBar.problem(error.message)); });
  window.addEventListener("ash:jump", event => {
    if (event.defaultPrevented || typeof event.detail?.id !== "string") return;
    event.preventDefault(); void locate(event.detail.id).catch(error => presenceBar.problem(error.message));
  });
  const navigationObserver = new MutationObserver(applyNavigation);
  navigationObserver.observe(log, { childList: true });
  const protectWindow = () => {
    const selection = document.getSelection();
    const ids = [...log.querySelectorAll("[data-row-key]")].filter(node => node.contains(document.activeElement) || selection?.rangeCount && !selection.isCollapsed && selection.containsNode(node, true))
      .map(node => node.dataset.rowKey.replace(/^(message|failure):/, ""));
    timeline.store.protect(ids);
  };
  document.addEventListener("selectionchange", protectWindow);
  log.addEventListener("focusin", protectWindow);
  log.addEventListener("focusout", protectWindow);
  identityName = new IdentityName(net, (name) => {
    presenceBar.setName(name);
  });
  // Her home puts words in the box with `ash:compose` ({text, turn?}); with a turn they come as a question about that turn.
  window.addEventListener("ash:compose", (event) => {
    const { text: words, turn } = event.detail ?? {};
    if (typeof words !== "string" || event.defaultPrevented) return;
    event.preventDefault();
    if (typeof turn === "string" && turn) context.askAbout({ turn, text: words });
    else { clearContext(); input.value = words; input.focus(); }
    sendable();
  });

  // The owner is typing to an agent: said while there is text, every few seconds, and unsaid when it is sent or cleared.
  let lastTyping = 0;
  let typingTo = null;
  function typing() {
    if (document.hidden || !input.value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (typingTo && now - lastTyping < 3000) return;
    lastTyping = now;
    typingTo = recipient.target();
    net.setTyping(true, typingTo);
  }
  function stopTyping() {
    if (!typingTo) return;
    net.setTyping(false, typingTo);
    typingTo = null;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const files = addPicked(picked, fileInput.files);
    if (!value && !files.length) return;
    sendButton.disabled = true;
    try {
      const attachments = await prepareUploads(files, value);
      await net.enqueueSay(value, attachments, null, recipient.target());
      input.value = "";
      input.style.height = "";
      stopTyping();
      clearContext();
      fileInput.value = "";
      picked = [];
      showPicked();
      if (timeline.store.hasAfter) await locate().catch(error => presenceBar.problem(error.message)); else conversationView(log).position.latest();
    } catch (error) { presenceBar.problem(`没发出去：${error.message || "这台设备存不下待发送的消息"}`); }
    finally { sendButton.disabled = false; sendable(); }
  });
  input.addEventListener("input", typing);
  input.addEventListener("input", sendable);
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`; });
  recipient = agentPicker(form, input, net, redraw, { field: document.querySelector("#field") });
  document.addEventListener("visibilitychange", () => {
    net.setVisible(!document.hidden);
    if (!document.hidden) typing(); else stopTyping();
  });
  const typingTimer = setInterval(() => { if (!document.hidden && typingTo) typing(); }, 3_000);
  const progressTimer = setInterval(() => {
    if (document.hidden) return;
    if (!progressRoot.hidden) progress();
    if (timeline.view.asks.some((ask) => ask.state === "pending" && ask.expires_at <= Date.now())) redraw();
  }, 1_000);
  // The whole field is the target of a tap, not only the text line.
  document.querySelector("#field").addEventListener("click", (event) => { if (event.target === event.currentTarget) input.focus(); });
  log.addEventListener("scroll", async event => {
    if (views.get(log)?.position.compensations.has(event)) return;
    restorer.scroll();
    if (timeline.loading) return;
    retainReadingAnchor();
    try {
      if (log.scrollTop < 80) await timeline.older();
      else if (log.scrollHeight - log.scrollTop - log.clientHeight < 100 && timeline.store.hasAfter) await timeline.newer();
    } catch { presenceBar.problem("这段对话暂时加载不出来，稍后再翻一次。"); }
  }, { passive: true });
  log.addEventListener("wheel", () => restorer.scroll(), { passive: true });
  log.addEventListener("touchstart", () => restorer.scroll(), { passive: true });
  attachMenu(document.querySelector("#attachMenu"), attachButton, fileInput);
  fileInput.addEventListener("change", () => {
    picked = addPicked(picked, fileInput.files);
    fileInput.value = "";
    showPicked();
  });
  appsButton.addEventListener("click", () => openHome({ page: "apps" }));
  window.addEventListener("pagehide", () => { timeline.clearCurrentRefresh(); clearInterval(progressTimer); clearInterval(typingTimer); restorer.dispose(); navigationObserver.disconnect(); views.get(log)?.dispose(); net.stop(); });
  window.addEventListener("online", () => net.reconnect());
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    restorer.closed = false; restorer.reset();
    navigationObserver.observe(log, { childList: true });
    net.start();
  });
  net.start();
  return { net, timeline };
}

/**
 * The owner answers a question card. Approval cards (from the gate) are checked as approvals; any other question is answered
 * with one of its options, or with free text when the card allows it.
 */
async function answerAsk(net, ask, choice, clientId, { answerText } = {}) {
  if (ask.from === "service:gate") return answerGateAsk(net, ask, choice, clientId, { answerText });
  const custom = ask.allow_custom && choice === "custom" && typeof answerText === "string" && answerText.trim();
  if (!custom && !ask.options.some((option) => option.id === choice)) throw new Error("这个问题已经过期，或没有这个选项。");
  const result = await net.answerAsk(ask, { choice: custom ? "custom" : choice, ...(custom ? { text: answerText } : {}) }, clientId);
  if (result.ok) return result.message;
  throw new Error(["offline", "unavailable", "timeout", "result_unknown", "internal"].includes(result.error.code)
    ? "回答有没有送到还不知道，请再点一次同一个选项。" : "回答没被接受，这个问题可能已经过期。");
}

// Module initialization (including Markdown grammar) must finish before DOM/connection setup starts its own task.
if (typeof document !== "undefined") setTimeout(() => boot(), 0);
