import { updateA2uiCard } from "./a2ui-card.js";
import { appendConversationRow, conversationRows } from "./conversation.js";
import { appendMarkdown, appendMarkdownInSlices, MarkdownQueue } from "./markdown.js";
import { ScrollPosition } from "./scroll-position.js";

// Projected facts are immutable; compare their small structures without copying text into JSON cache keys.
const equal = (a, b) => a === b || !!a && !!b && typeof a === "object" && typeof b === "object" &&
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
const motion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== true;
const dispose = row => { row.lifetime.disposed = true; for (const cleanup of row.lifetime.cleanup) cleanup(); row.lifetime.cleanup.clear(); };
const context = row => ({ previousDisplay: row.previousDisplay, previous: row.previous && { type: row.previous.type, side: row.previous.side, group: row.previous.group }, next: row.next && { type: row.next.type, side: row.next.side, group: row.next.group } });
const body = (row, options) => {
  const item = row.item;
  if (row.kind === "message" && item.type === "say") {
    const { delivery, reactions, revision, group, byte_size, reactions_more, ...content } = item;
    return { content, shown: item.full && options.fullTexts?.has(item.full, item.id) ? options.fullTexts.get(item.full) : item.text,
      expansion: item.full && !options.fullTexts?.has(item.full, item.id) ? options.fullTexts?.expansionLabel?.(item.id) : null };
  }
  if (row.kind === "message") { const { reactions, byte_size, reactions_more, ...content } = item; return content; }
  return item;
};

/** The card an agent designed that [item] shows; null for any other row. */
const designed = item => item?.type === "card" && item.card?.type === "a2ui" && typeof item.card.id === "string" ? item.card : null;
/** What around a card's row changes how it is drawn: not the row after it, not the page loading. */
const cardChrome = ({ next, loading, ...rest } = {}) => rest;

/** Stable entities own sibling nodes, so the existing flex layout/selection remains intact. */
export class WindowView {
  constructor(root) {
    this.root = root;
    this.rows = new Map();
    this.position = new ScrollPosition(root);
    this.markdown = new MarkdownQueue({ before: () => this.position.capture(), after: () => this.position.changed() });
    this.newest = 0;
    this.fresh = false;
    this.closed = false;
    this.retry = () => {
      if (this.closed || this.retryQueued || !this.latest || ![...this.rows.values()].some(row => row.deferred)) return;
      this.retryQueued = true;
      // Focus/selection events can be emitted inside a DOM write; reconcile after it finishes.
      queueMicrotask(() => { this.retryQueued = false; if (!this.closed && this.latest) this.update(...this.latest); });
    };
    root.ownerDocument.addEventListener("selectionchange", this.retry);
    root.addEventListener("focusout", this.retry);
  }
  protected(row, keepFocus = true) {
    const selected = this.root.ownerDocument.getSelection();
    return row.nodes.some(node => keepFocus && node.contains(this.root.ownerDocument.activeElement) || selected?.rangeCount && !selected.isCollapsed && selected.containsNode(node, true));
  }
  pinnedIds() { return [...this.rows.values()].filter(row => this.protected(row)).map(row => row.descriptor.item?.id ?? row.descriptor.item?.ask?.id ?? row.descriptor.item?.turn).filter(Boolean); }
  reset() {
    for (const row of this.rows.values()) { this.position.unobserve(row.nodes); dispose(row); }
    this.rows.clear(); this.root.replaceChildren(); this.position.anchor = null;
    this.position.pendingJump = null;
    this.newest = 0; this.fresh = false; this.latest = null;
  }
  update(entries, outbox = [], options = {}, dirty = null) {
    if (options.epoch !== undefined && options.epoch !== this.epoch) { this.reset(); this.epoch = options.epoch; }
    this.latest = [entries, outbox, options];
    // A loaded range's bottom is not the history's tail. Old-message jumps stay reading anchors through later slices.
    this.position.followTail = options.atLatest !== false;
    const plan = conversationRows(entries, options);
    for (const item of outbox) if (typeof item.client_id === "string" && typeof item.text === "string" && ["unsent", "sending", "accepted", "rejected"].includes(item.status)) plan.push({ key: `outbox:${item.client_id}`, kind: "outbox", item });
    const keys = new Set(plan.map(row => row.key));
    // A selected/focused entity stays at its ordered position until its interaction ends.
    for (const [key, row] of this.rows) if (!keys.has(key) && this.protected(row)) {
      const empty = plan.findIndex(item => item.kind === "state"); if (empty >= 0) plan.splice(empty, 1);
      const after = plan.findIndex(item => item.item?.seq > row.descriptor.item?.seq);
      plan.splice(after < 0 ? plan.length : after, 0, row.descriptor);
      keys.add(key); row.deferred = true;
    }
    const oldLocal = [...this.rows.values()].filter(row => row.descriptor.kind === "outbox").length;
    let settled = oldLocal;
    this.position.capture();
    // First paint owns the root, including any shell placeholder left before boot.
    if (!this.rows.size) this.root.replaceChildren();
    for (const [key, row] of this.rows) if (!keys.has(key)) {
      this.position.unobserve(row.nodes); dispose(row); for (const node of row.nodes) node.remove(); this.rows.delete(key);
    }
    let cursor = this.root.firstChild;
    for (const descriptor of plan) {
      let row = this.rows.get(descriptor.key);
      const item = descriptor.item;
      const candidate = !row || dirty === null || dirty.has(item?.id ?? item?.ask?.id ?? item?.turn) || descriptor.kind !== "message";
      const chrome = { ...context(descriptor), group: item?.group, primary: options.primary, name: options.herName,
        fromName: (item?.from ?? item?.ask?.from) && options.agentName?.(item.from ?? item.ask.from), toName: item?.to && options.agentName?.(item.to),
        loading: options.loading, day: new Date(options.now ?? Date.now()).toDateString() };
      const intent = item?.ask ? { ...options.askIntents?.get(item.ask.id) } : null;
      const expired = item?.ask?.state === "pending" && item.ask.expires_at <= (options.now ?? Date.now());
      const pending = options.optionPending?.has(item?.id) === true;
      const content = candidate ? body(descriptor, options) : row?.content;
      const sameBody = row && !row.lifetime.controller?.signal.aborted && equal(row.content, content);
      const state = item?.type === "say" ? { delivery: item.delivery, reactions: item.reactions } : null;
      const changed = !row || !sameBody || !equal(row.state, state) || !equal(row.chrome, chrome) || !equal(row.intent, intent) || row.expired !== expired || row.pending !== pending;
      const decided = item?.type === "ask" && (item.ask.state !== "pending" || expired) || item?.type === "card" && item.locked;
      const expanded = row && item?.type === "say" && row.content?.shown !== content?.shown && item.full && options.fullTexts?.has(item.full, item.id);
      // A card an agent designed is patched where it is, component by component, focused or not: an input the owner is
      // editing keeps its text, caret and composition, a mini app is not reloaded (js/a2ui-card.js).
      const card = changed && row && designed(item);
      const patched = card && designed(row.descriptor.item)?.id === card.id && equal(row.state, state) && equal(cardChrome(row.chrome), cardChrome(chrome)) &&
        equal(row.intent, intent) && row.expired === expired && row.pending === pending && this.patchCard(row, item, options);
      if (patched) Object.assign(row, { descriptor, content, chrome, deferred: false });
      else if (changed && row && this.protected(row, !decided && !expanded)) row.deferred = true;
      else if (changed) {
        const reuse = sameBody && descriptor.kind === "message" && item.type === "say";
        const lifetime = reuse ? row.lifetime : { disposed: false, cleanup: new Set() };
        const fragment = document.createDocumentFragment();
        appendConversationRow(fragment, descriptor, { ...options, omitContent: reuse, lifetime,
          renderMarkdown: (parent, source, markdownOptions, message) => {
            const controller = new AbortController();
            lifetime.controller = controller;
            const cancel = () => controller.abort(); lifetime.cleanup.add(cancel);
            const expanded = message.full && options.fullTexts?.has(message.full, message.id);
            const preview = expanded ? appendMarkdown(parent, message.text, markdownOptions) : null;
            const shouldBuild = expanded ? () => this.latest?.[2].shouldBuild?.(message.id) !== false : undefined;
            lifetime.completion = appendMarkdownInSlices(parent, source, { ...markdownOptions, queue: this.markdown, signal: controller.signal, shouldBuild, onStart: () => preview?.remove() });
            if (expanded) {
              const progress = document.createElement("small"); progress.className = "meta"; progress.textContent = "正在展开…"; parent.append(progress);
              lifetime.completion.then(() => { if (!controller.signal.aborted && !lifetime.disposed) { preview?.remove(); progress.remove(); } });
            }
            lifetime.completion.finally(() => { lifetime.cleanup.delete(cancel); });
          },
        });
        let nodes = Array.from(fragment.childNodes);
        const before = row?.nodes.find(node => node.matches?.(".ask"))?.offsetHeight;
        if (reuse) {
          nodes = nodes.map(node => {
            const saved = node.matches?.(".msg") ? row.nodes.find(old => old.matches?.(".msg")) : node.matches?.(".atts") ? row.nodes.find(old => old.matches?.(".atts")) : null;
            if (!saved) return node;
            saved.className = node.className;
            if (saved.matches(".msg")) {
              saved.querySelector(".reactions")?.remove();
              const reactions = node.querySelector(".reactions"); if (reactions) saved.append(reactions);
            }
            return saved;
          });
        }
        if (row) {
          this.position.unobserve(row.nodes);
          if (!reuse) dispose(row);
          for (const node of row.nodes) if (!nodes.includes(node)) { if (node === cursor) cursor = node.nextSibling; node.remove(); }
        }
        row = { descriptor, content, state, chrome, intent, expired, pending, nodes, lifetime, before };
        this.rows.set(descriptor.key, row);
        for (const node of nodes) if (node.nodeType === 1) node.dataset.rowKey = descriptor.key;
        this.position.observe(nodes);
        const seq = Number(item?.seq);
        if (this.fresh && motion() && (!Number.isFinite(seq) || seq > this.newest) && !before) {
          const localCopy = descriptor.kind === "message" && item.side === "owner" && settled > 0;
          if (localCopy) settled--;
          else if (descriptor.kind !== "state" && descriptor.kind !== "intro") for (const node of nodes) if (node.matches?.(".msg,.a-card")) node.classList.add("enter");
        }
        if (Number.isFinite(seq)) this.newest = Math.max(this.newest, seq);
      }
      // Reuse nodes in place; detaching a selected subtree into a fragment would destroy the range.
      for (const node of row.nodes) { if (node !== cursor) this.root.insertBefore(node, cursor); cursor = node.nextSibling; }
      if (row.before !== undefined) {
        const card = row.nodes.find(node => node.matches?.(".ask"));
        const height = card?.offsetHeight;
        if (motion() && row.before > height + 4) {
          const css = getComputedStyle(document.documentElement);
          card.animate?.([{ height: `${row.before}px`, overflow: "hidden" }, { height: `${height}px`, overflow: "hidden" }], { duration: parseInt(css.getPropertyValue("--dur-resolve"), 10) || 300, easing: css.getPropertyValue("--ease").trim() || "ease" });
        }
        delete row.before;
      }
    }
    this.fresh ||= entries.length > 0 || outbox.length > 0;
    this.root.setAttribute("aria-busy", options.loading ? "true" : "false");
    this.position.changed();
  }
  patchCard(row, item, options) {
    const root = row.nodes.find(node => node.matches?.(".a2ui"));
    return !!root && updateA2uiCard(root, item, options.a2ui ?? null);
  }
  jump(id) { const row = this.rows.get(`message:${id}`) ?? this.rows.get(`failure:${id}`); return this.position.jump(row?.nodes.find(node => node.matches?.(".msg,.a-card,.atts")) ?? row?.nodes[0]); }
  settled(id) { return id ? this.rows.get(`message:${id}`)?.lifetime.completion ?? Promise.resolve() : Promise.all([...this.rows.values()].map(row => row.lifetime.completion)); }
  cancelExpansion(id) { this.rows.get(`message:${id}`)?.lifetime.controller?.abort(); }

  dispose() {
    this.markdown.dispose();
    this.closed = true; this.position.dispose();
    this.root.ownerDocument.removeEventListener("selectionchange", this.retry); this.root.removeEventListener("focusout", this.retry);
    for (const row of this.rows.values()) dispose(row); this.rows.clear(); this.latest = null;
  }
}

/** Changed stable entities; the future window store can supply these IDs directly. */
export function changedIds(messages) {
  const ids = new Set();
  for (const message of messages) {
    for (const id of [message.id, message.reply_to, message.body?.message_id, message.body?.in_reply_to, message.turn, message.body?.turn]) if (typeof id === "string") ids.add(id);
    for (const id of message.word === "turn.started" && Array.isArray(message.body?.ids) ? message.body.ids : []) if (typeof id === "string") ids.add(id);
  }
  return ids;
}
