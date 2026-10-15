import { initialView, projectRecords } from "../../sdk/src/conversation.ts";
import { ConversationStore } from "./conversation-store.js";

const MAX_TIMER_MS = 2147483647;
const MAX_CURRENT_RETRY_MS = 30000;

/** Hydrated history and finite current state; live facts never become a retained ledger replay. */
export class ConversationTimeline {
  constructor(net, onChange = () => {}) {
    this.net = net;
    this.onChange = onChange;
    this.store = new ConversationStore();
    this.reset();
  }
  reset() {
    this.epoch = (this.epoch ?? 0) + 1;
    this.pageAbort?.abort();
    this.clearCurrentRefresh();
    this.store.reset();
    this.current = null;
    this.ready = this.loading = false;
    this.targets = new Set();
    this.reloadNeeded = false;
    this.currentDirty = false;
    this.liveScheduled = false;
    this.liveSerial = (this.liveSerial ?? 0) + 1;
    this.unseen = 0;
    this.onChange(this.view, true);
  }
  get exhausted() { return !this.store.hasBefore; }
  get view() {
    const view = initialView();
    view.conversation = this.store.items.filter(item => item.type !== "failed");
    const lastOwner = [...view.conversation].reverse().find(item => item.side === "owner");
    view.failures = this.store.items.filter(item => item.type === "failed" && Date.now() - item.ts < 86400000 && !(lastOwner && lastOwner.ts > item.ts));
    view.presence = this.current?.presence ?? view.presence;
    const asks = new Map(this.store.items.filter(item => item.ask).map(item => [item.ask.id, item.ask]));
    for (const item of this.current?.items ?? []) if (item.ask) asks.set(item.ask.id, item.ask);
    view.asks = [...asks.values()];
    const progress = this.current?.progress;
    if (progress) view.turns = { [progress.id]: progress };
    return view;
  }
  historyReady() { this.ready = true; this.onChange(this.view, true); }
  acceptPage(page, direction = "replace") {
    if (this.store.dataset !== null && this.store.dataset !== page.dataset_id) this.reset();
    const dirty = this.store.apply(page, direction);
    if (direction === "replace") this.unseen = 0;
    this.onChange(this.view, true, dirty);
    return page.items.length;
  }
  acceptCurrent(current) {
    if (this.store.dataset !== null && this.store.dataset !== current.dataset_id) return;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq > current.snapshot_seq) return;
    if (this.current?.dataset_id === current.dataset_id && this.current.snapshot_seq === current.snapshot_seq && Number.isSafeInteger(this.current.as_of) && Number.isSafeInteger(current.as_of) && this.current.as_of > current.as_of) return;
    this.current = current;
    clearTimeout(this.currentTimer);
    this.currentTimer = null;
    const serial = ++this.currentRefreshSerial;
    if (current.next_change_at === null) this.currentRetryMs = 0;
    else {
      // Both timestamps use the server's clock; the device's wall clock may be far ahead or behind it.
      const wait = current.next_change_at - current.as_of;
      const future = Number.isSafeInteger(current.next_change_at) && Number.isSafeInteger(current.as_of) && current.as_of >= 0 && wait > 0;
      this.currentRetryMs = future ? 0 : Math.min(MAX_CURRENT_RETRY_MS, (this.currentRetryMs || 500) * 2);
      const delay = future ? Math.min(MAX_TIMER_MS, wait + 50) : this.currentRetryMs;
      this.currentTimer = setTimeout(() => {
        if (serial !== this.currentRefreshSerial) return;
        this.currentTimer = null;
        this.currentDirty = true;
        this.scheduleLive();
      }, delay);
    }
    this.onCurrent?.(current);
    this.onChange(this.view, false);
  }
  clearCurrentRefresh() {
    clearTimeout(this.currentTimer);
    this.currentTimer = null;
    this.currentRetryMs = 0;
    this.currentRefreshSerial = (this.currentRefreshSerial ?? 0) + 1;
    this.currentDirty = false;
  }
  async read(params, direction) {
    if (this.loading) return 0;
    const epoch = this.epoch;
    const controller = this.pageAbort = new AbortController();
    this.loading = true;
    try {
      const page = await this.net.window(params, controller.signal);
      return epoch === this.epoch ? this.acceptPage(page, direction) : 0;
    } finally { if (epoch === this.epoch) this.loading = false; }
  }
  older() { return this.store.hasBefore && this.store.before && this.store.canPage("before") ? this.read({ before: this.store.before }, "before") : Promise.resolve(0); }
  newer() { return this.store.hasAfter && this.store.after && this.store.canPage("after") ? this.read({ after: this.store.after }, "after") : Promise.resolve(0); }
  locate(params) {
    if (this.store.protected.size) return Promise.reject(new Error("请先结束当前文字选择或卡片输入，再跳转对话。"));
    this.store.anchor = null;
    this.epoch++;
    this.pageAbort?.abort();
    this.loading = false;
    return this.read(params, "replace");
  }
  latest() { return this.locate({}); }
  jump(id) { return this.locate({ around_id: id }); }
  get(id) { return this.store.get(id); }

  /** Simple insertions use one already-safe fact. Relations are hydrated by id, rather than replaying older events. */
  add(fact) {
    const visible = ["owner.say", "agent.say", "show", "ask", "app.card"].includes(fact.type);
    if (visible) {
      if (!this.store.hasAfter) {
        const item = projectRecords([fact]).conversation[0];
        if (item) this.onChange(this.viewAfter(item, fact.seq), true, new Set([item.id]));
        // A card the agent designed arrives as its name and summary; what it shows is read with the item.
        if (item?.type === "card" && item.card?.type === "a2ui" && this.store.get(item.id)) this.queueTarget(item.id);
      } else { this.unseen++; this.onChange(this.view, false); }
    }
    const targets = [fact.reply_to, fact.message_id, fact.in_reply_to, ...(fact.type === "turn.start" ? fact.ids ?? [] : [])];
    for (const id of targets) if (this.store.get(id)) this.queueTarget(id);
    if (fact.type === "turn.start" && !fact.ids?.length) {
      // The ids array can be a blob. Loaded owner rows are bounded; the server's relation index still knows every read id.
      for (const item of this.store.items) if (item.side === "owner" && item.delivery !== "read") this.queueTarget(item.id);
    }
    if (fact.type === "turn.end" && fact.outcome === "error" && !this.store.hasAfter) this.queueTarget(fact.turn);
    if (["ask", "ask.answer", "turn.start", "turn.end", "tool", "activity.request", "activity.response"].includes(fact.type)) this.currentDirty = true;
    this.scheduleLive();
  }
  viewAfter(item, revision) {
    this.store.update(item, revision, true);
    if (!this.store.get(item.id)) { this.store.hasAfter = true; this.unseen++; }
    return this.view;
  }
  /** A card changed on the hub (`{message}` its message id, or `{card}` its card id): its item is read again. */
  refreshCard({ message, card } = {}) {
    const id = message ?? this.store.items.find(item => item.card?.type === "a2ui" && item.card.id === card)?.id;
    if (!id || !this.store.get(id)) return;
    this.queueTarget(id);
    this.scheduleLive();
  }
  /** The hub pushed a card whole (`card.patch`): every item showing it takes it as it is, and only those rows are drawn again. */
  patchCard(card) {
    if (!card || typeof card.id !== "string") return new Set();
    const dirty = new Set();
    for (const item of this.store.items) {
      if (item.type !== "card" || item.card?.type !== "a2ui" || item.card.id !== card.id) continue;
      const entry = this.store.byId.get(item.id);
      const { byte_size: _size, ...rest } = item;
      for (const id of this.store.update({ ...rest, card: { ...card, type: "a2ui" } }, entry?.revision ?? this.store.snapshot)) dirty.add(id);
    }
    if (dirty.size) this.onChange(this.view, true, dirty);
    return dirty;
  }
  queueTarget(id) {
    if (this.targets.size < this.store.maxItems) this.targets.add(id);
    else this.reloadNeeded = true;
  }
  scheduleLive() {
    if (this.liveScheduled || !this.targets.size && !this.currentDirty && !this.reloadNeeded) return;
    this.liveScheduled = true;
    const serial = ++this.liveSerial;
    setTimeout(() => { if (serial === this.liveSerial) void this.flushLive(serial); }, 0);
  }
  async flushLive(serial) {
    const epoch = this.epoch, binding = this.net.binding();
    const ids = [...this.targets].slice(0, 8);
    for (const id of ids) this.targets.delete(id);
    const refreshCurrent = this.currentDirty;
    this.currentDirty = false;
    const reload = this.reloadNeeded;
    this.reloadNeeded = false;
    const dirty = new Set();
    try {
      if (reload) {
        try {
          const page = await this.net.window(this.store.hasAfter && this.store.items[0] ? { around_id: this.store.items[0].id } : {});
          if (epoch === this.epoch && this.net.same(binding)) this.acceptPage(page);
        } catch { /* no retained replay grows while the connection is unavailable */ }
      }
      await Promise.all(ids.map(async id => {
        try {
          const page = await this.net.window({ around_id: id, limit: 1 });
          if (epoch !== this.epoch || !this.net.same(binding)) return;
          for (const item of page.items) for (const changed of this.store.update(item, page.snapshot_seq, item.type === "failed" && !this.store.hasAfter)) dirty.add(changed);
        } catch { /* the next authoritative snapshot can still confirm this item */ }
      }));
      if (refreshCurrent) {
        const currentSerial = this.currentRefreshSerial;
        try {
          const current = await this.net.current();
          if (epoch === this.epoch && this.net.same(binding) && currentSerial === this.currentRefreshSerial) this.acceptCurrent(current);
        } catch { /* connection state tells the owner when the current picture cannot be refreshed */ }
      }
      if (dirty.size && epoch === this.epoch && this.net.same(binding)) this.onChange(this.view, true, dirty);
    } finally { if (serial === this.liveSerial) { this.liveScheduled = false; this.scheduleLive(); } }
  }
}
