// The page's side of the kernel: one connection (link.js), bounded display snapshots and safe live facts, the owner's own
// messages (queued so that nothing typed is lost offline, sent with a stable `client_id`), and every word the sheets call.
import { openPort, retryable, unwrap, WordFailure } from "./link.js";
import { MAX_WIRE_BYTES, openPendingStore } from "./pending-store.js";
import { safeRecord } from "../../sdk/src/conversation.ts";

const AGENT = /^agent:[a-z][a-z0-9_-]{0,31}$/;
const PAGE = 10;

export const OWNER = "person:owner";
const PRIMARY_KEY = "ash.primary";
const remembered = () => { try { const id = globalThis.localStorage?.getItem(PRIMARY_KEY); return AGENT.test(id ?? "") ? id : null; } catch { return null; } };

export class Net {
  /**
   * [pendingStore], [connector] and [clock] are for tests.
   * The callbacks: onMessage(safeFact), onHistory(displayPage), onCurrent(currentPage), onHistoryReady(), onState(status, detail),
   * onOpen(info) after every (re)connection, onQueue(count, outbox), onPresent(frame) -> {ok, data?, error?},
   * onCardChange({card} | {message}) to read a card again, onCardPatch(card) with a card the hub pushed whole.
   */
  constructor({ label = "网页", pendingStore = null, url, connector, clock, random, onMessage = () => {}, onHistory = () => {},
    onHistoryReady = () => {}, onCurrent = () => {}, historyTarget = () => ({}), onState = () => {}, onOpen = () => {}, onQueue = () => {}, onPresent = async () => ({ ok: false, error: { code: "unavailable", message: "not shown here" } }),
    onCardChange = () => {}, onCardPatch = () => {} } = {}) {
    this.onMessage = onMessage;
    this.onHistory = onHistory;
    this.onHistoryReady = onHistoryReady;
    this.onCurrent = onCurrent;
    this.historyTarget = historyTarget;
    this.onState = onState;
    this.onOpen = onOpen;
    this.onQueue = onQueue;
    this.onPresent = onPresent;
    this.onCardChange = onCardChange;
    this.onCardPatch = onCardPatch;
    /** card.update requests on their way: request id -> card id, until the hub has answered them. */
    this.cardUpdates = new Map();
    this.status = "connecting";
    this.session = null;
    this.client = null;
    this.local = false;
    this.generation = 0;
    /** The hub names the primary agent (`service:agents/list`); until it has, the one it named last time; before that, none. */
    this.primary = remembered();
    this.primaryLoad = null;
    this.queue = [];
    this.outbox = [];
    this.seenOwnIds = new Set();
    this.cursor = null;
    this.history = null;
    this.bootstrapped = false;
    this.tabOwner = crypto.randomUUID();
    this.flushing = false;
    this.visible = null;
    this.pendingReady = Promise.resolve(pendingStore ?? openPendingStore()).catch(() => null);
    this.port = openPort({
      state: (state, info) => this.portState(state, info),
      present: (frame) => this.present(frame),
      log: () => {},
    }, { label, url, connector, clock, random });
  }

  // ---- the connection ----

  start() { this.port.start(); }

  stop() {
    this.history?.close();
    this.history = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.historyRetry);
    this.port.stop();
    this.queue = [];
    this.outbox = [];
    this.publishOutbox();
  }

  reconnect() { if (this.status !== "online") this.port.reconnect(); }

  /** A fixed picture of which connection this is; it stops matching when the connection changes. */
  binding() { return { session: this.session, generation: this.generation }; }
  same(binding) { return Boolean(binding?.session) && binding.session === this.session && binding.generation === this.generation; }

  setStatus(status, detail) {
    this.status = status;
    this.onState(status, detail);
  }

  portState(state, info) {
    if (state === "online") {
      this.session = info.session;
      this.client = info.client;
      this.local = info.local === true;
      this.generation++;
      this.cursor = null;
      this.seenOwnIds.clear();
      this.visible = null; // the kernel forgets what a connection said about itself when it ends
      this.setStatus("online");
      void this.refreshPrimary(); // before onOpen: whoever reacts to the opening may wait for `primaryLoad`
      this.onOpen(info);
      this.beginHistory();
      void this.restorePending().then(() => this.flush());
      return;
    }
    this.history = null;
    this.session = null;
    this.client = null;
    this.local = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.historyRetry);
    if (state === "closed") this.setStatus("closed", info?.denied);
    else this.setStatus(state === "connecting" ? "connecting" : "offline");
  }

  refreshPrimary() {
    const binding = this.binding();
    this.primaryLoad = (async () => {
      try {
        const { agents } = unwrap(await this.call("service:agents", "list"));
        const primary = agents?.find((agent) => agent.primary === true);
        if (primary && this.same(binding)) {
          this.primary = primary.id;
          try { globalThis.localStorage?.setItem(PRIMARY_KEY, primary.id); } catch { /* not remembered */ }
        }
      } catch { /* what we had stands */ }
    })();
    return this.primaryLoad;
  }

  // ---- words ----

  /** Calls a word as the owner and waits for its `Reply` (an error is a reply, not an exception). */
  call(to, word, body = {}, options) { return this.port.call(to, word, body, options); }
  /** Calls a word and returns its data; a failed word throws [WordFailure]. */
  async data(to, word, body = {}, options) { return unwrap(await this.call(to, word, body, options)); }
  /** The bytes a `resource` part of a result stands for. */
  stream(sid) { return this.port.stream(sid); }

  /** The bytes of a long attachment of the ledger (`service:blobs/get`). */
  async readBlob(hash) {
    const info = await this.data("service:blobs", "get", { hash });
    return this.stream(info.stream);
  }

  /** The text of a long field of the ledger, in full (`service:blobs/read`, in pieces). */
  async readBlobText(hash, options) {
    let text = "";
    let offset = 0;
    for (let pieces = 0; pieces < 200; pieces++) {
      const piece = await this.data("service:blobs", "read", { hash, offset }, options);
      text += piece.text;
      if (piece.next_offset === null || piece.next_offset === undefined) return text;
      offset = piece.next_offset;
    }
    throw new WordFailure({ code: "too_large", message: "文本太长" });
  }

  // ---- presence ----

  /** Whether this tab is in view. */
  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.port.presence({ visible });
  }

  /** The owner is (or stopped) typing to [agent]. */
  setTyping(typing, agent = this.primary) { if (agent) this.port.presence({ typing, agent }); }

  // ---- history ----

  beginHistory() {
    const binding = this.binding();
    const read = this.historyRead = (this.historyRead ?? 0) + 1;
    void this.openHistory(binding, read).catch(error => {
      if (!this.same(binding) || read !== this.historyRead) return;
      this.onState("history-error", error);
      this.historyRetry = setTimeout(() => { if (this.same(binding)) this.beginHistory(); }, 5000);
    });
  }
  async openHistory(binding, read) {
    this.history?.close();
    const active = () => this.same(binding) && read === this.historyRead;
    // Establish live observation first. Reconnecting always reads a bounded snapshot, never replays an unbounded gap.
    this.bootstrapped = false;
    const buffered = [];
    let bufferedBytes = 0;
    let overflow = false;
    const receive = message => {
      if (!active() || !this.accept(message)) return;
      this.cardChanged(message);
      const fact = safeRecord(message);
      if (!fact) return;
      if (this.bootstrapped) this.onMessage(fact, { historical: false });
      else {
        const bytes = new TextEncoder().encode(JSON.stringify(fact)).byteLength;
        if (buffered.length < 200 && bufferedBytes + bytes <= 256 * 1024) { buffered.push(fact); bufferedBytes += bytes; }
        else overflow = true;
      }
    };
    this.history = this.port.sync({ limit: 1, follow: true, summary: true }, {
      page: (frame) => {
        for (const message of frame.messages) receive(message);
      },
      message: (frame) => receive(frame.message),
      error: () => {},
    });
    const [page, current] = await Promise.all([this.window(this.historyTarget()), this.current()]);
    if (!active()) return;
    this.onHistory(page);
    this.onCurrent(current);
    this.cursor = Math.max(this.cursor ?? 0, page.snapshot_seq);
    this.bootstrapped = true;
    this.onHistoryReady();
    for (const fact of buffered) if (fact.seq > page.snapshot_seq) this.onMessage(fact, { historical: false });
    // Overflow carries no rows into a long-lived cache; ask for a fresh bounded picture instead.
    if (overflow) {
      const [fresh, latest] = await Promise.all([this.window(this.historyTarget()), this.current()]);
      if (active()) { this.onHistory(fresh); this.onCurrent(latest); }
    }
  }

  /** Notes a ledger row (cursor, outbox); false for a row the page cannot use or already has. */
  accept(message) {
    if (!Number.isSafeInteger(message?.seq) || message.seq < 1 || typeof message.id !== "string") return false;
    if (this.cursor !== null && message.seq <= this.cursor) return false;
    this.cursor = Math.max(this.cursor ?? 0, message.seq);
    if (this.flushing && message.from === OWNER && message.origin?.client === this.client) {
      this.seenOwnIds.add(message.id);
      if (this.seenOwnIds.size > 48) this.seenOwnIds.delete(this.seenOwnIds.values().next().value);
    }
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((item) => item.id !== message.id);
    if (this.outbox.length !== before) {
      this.publishOutbox();
      void this.pendingReady.then((store) => store?.removeAccepted(message.id)).catch(() => {});
    }
    return true;
  }

  /**
   * A card in the conversation that changed with no fact of its own: its creator's `card.update` was answered, or a form
   * was answered. `onCardChange({card})` / `onCardChange({message})` names it so its item is read again.
   */
  cardChanged(message) {
    const body = message.body;
    if (message.kind === "request" && message.to === OWNER && message.word === "card.update" && typeof body?.id === "string") {
      this.cardUpdates.set(message.id, body.id);
      if (this.cardUpdates.size > 64) this.cardUpdates.delete(this.cardUpdates.keys().next().value);
    } else if (message.kind === "response" && message.from === OWNER && typeof message.reply_to === "string") {
      if (message.word === "form") this.onCardChange({ message: message.reply_to });
      else if (this.cardUpdates.has(message.reply_to)) { this.onCardChange({ card: this.cardUpdates.get(message.reply_to) }); this.cardUpdates.delete(message.reply_to); }
    }
  }

  window(params = {}, signal) { return this.data("service:history", "window", { limit: PAGE, ...params }, { signal }); }
  current(params = {}, signal) { return this.data("service:history", "current", { limit: PAGE, ...params }, { signal }); }
  page(before, signal) { return this.window({ before }, signal); }

  // ---- the owner's own messages ----

  publishOutbox() {
    this.onQueue(this.queue.length, this.outbox.map((item) => ({ ...item })));
  }

  async restorePending() {
    const load = this.pendingLoad = (this.pendingLoad ?? 0) + 1;
    const binding = this.binding();
    const store = await this.pendingReady;
    if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
    let items = await store.list();
    // Accepted records are never resent. Their bounded set of ids is checked even after the corresponding window was evicted.
    if (this.session) {
      const confirmed = new Set();
      const ids = items.filter(item => item.id).map(item => item.id);
      if (ids.length) {
        try {
          const data = await this.data("service:history", "confirm", { ids });
          if (this.same(binding)) {
            for (const id of data.ids) if (ids.includes(id)) { await store.removeAccepted(id); confirmed.add(id); }
          }
        } catch { /* an unavailable confirmation leaves the durable receipt intact */ }
      }
      items = items.filter(item => !confirmed.has(item.id));
    }
    if (load !== this.pendingLoad || binding.generation !== this.generation) return;
    this.queue = items.filter((item) => item.wire && !item.id).map((item) => item.wire);
    this.outbox = items.map((item) => ({ client_id: item.client_id, text: item.text, attachments: item.attachments,
      in_reply_to: item.wire?.body?.in_reply_to, option_id: item.wire?.body?.option_id,
      status: item.status === "sending" && item.leaseUntil <= Date.now() ? "unsent" : item.status, id: item.id, seq: item.seq }));
    this.publishOutbox();
  }

  setOutbox(clientId, patch) {
    const item = this.outbox.find((entry) => entry.client_id === clientId);
    if (!item) return;
    Object.assign(item, patch);
    this.publishOutbox();
  }

  /** Keeps what the owner typed, then sends it as soon as there is a connection. Returns the message's `client_id`. */
  async enqueueSay(text, attachments = [], option = null, target = null, card = null) {
    if (!target && !this.primary) await this.primaryLoad;
    target ??= this.primary;
    if (!target) throw new Error("还不知道该对谁说话；连上后再试");
    const store = await this.pendingReady;
    if (!store) throw new Error("pending storage unavailable");
    if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("empty message");
    if (option && (typeof option.in_reply_to !== "string" || !option.in_reply_to || typeof option.option_id !== "string" || !option.option_id || attachments.length))
      throw new Error("invalid option reply");
    if (!AGENT.test(target)) throw new Error("invalid agent target");
    if (card && (typeof card.id !== "string" || !card.id || typeof card.action !== "string" || !card.action || option || attachments.length)) throw new Error("invalid card action");
    const body = { text, ...(attachments.length ? { attachments } : {}), ...(option ? { in_reply_to: option.in_reply_to, option_id: option.option_id } : {}), ...(card ? { card } : {}) };
    const message = { to: target, kind: "request", word: "say", body, client_id: crypto.randomUUID() };
    await store.enqueue(message);
    await this.restorePending();
    void this.flush();
    return message.client_id;
  }

  /** The owner answers a question (`ask`) from the card. The kernel records the answer; the first answer counts. */
  async answerAsk(ask, { choice, text }, clientId) {
    const result = await this.port.send({ to: ask.from, kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { data: { choice, ...(text ? { text } : {}) } } }, client_id: clientId });
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
  }

  /**
   * The owner sends or cancels a form card (`person:owner/form`): answered like an `ask`, with word `form`, to the agent that
   * asked, and the same `client_id` when it is sent again. The kernel records the answer; the first one counts.
   */
  async answerForm({ to, reply_to, body, client_id }) {
    const result = await this.port.send({ to, kind: "response", word: "form", reply_to, body, client_id });
    return result.ok ? { ok: true, message: result.message } : { ok: false, error: result.error };
  }

  async flush() {
    if (this.flushing || this.status !== "online") return;
    this.flushing = true;
    const binding = this.binding();
    const retry = (ms) => {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.same(binding)) void this.restorePending().then(() => this.flush()).catch(() => this.onState("send-error", new Error("pending storage unavailable")));
      }, Math.max(100, ms));
      this.retryTimer.unref?.();
    };
    try {
      const store = await this.pendingReady;
      if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
      while (this.same(binding)) {
        const queued = await store.claim(this.tabOwner);
        if (!queued) break;
        if (queued.blockedUntil) { retry(queued.blockedUntil - Date.now() + 20); break; }
        this.setOutbox(queued.client_id, { status: "sending" });
        const leaseTimer = setInterval(() => { void store.renew(queued, this.tabOwner).catch(() => {}); }, 10_000);
        let result;
        try { result = await this.port.send(queued.wire); }
        finally { clearInterval(leaseTimer); }
        if (!result.ok) {
          // Not taken: wait for the connection when it was only lost, otherwise the kernel said no.
          const lost = retryable(result.error);
          const status = lost ? "unsent" : "rejected";
          await store.release(queued, this.tabOwner, status);
          this.setOutbox(queued.client_id, { status });
          this.onState(lost ? "offline" : "send-error", new Error(result.error?.message || "send failed"));
          if (lost) retry(5_000);
          break;
        }
        if (typeof result.message?.id !== "string" || !Number.isSafeInteger(result.message.seq) || result.message.seq < 1) {
          await store.release(queued, this.tabOwner, "unsent");
          this.setOutbox(queued.client_id, { status: "unsent" });
          this.onState("send-error", new Error("send acknowledgement invalid"));
          retry(5_000);
          break;
        }
        await store.accept(queued, this.tabOwner, result.message.id, result.message.seq);
        if (this.seenOwnIds.delete(result.message.id)) await store.removeAccepted(result.message.id);
        await this.restorePending();
      }
    } catch { this.onState("send-error", new Error("pending storage unavailable")); }
    finally {
      this.flushing = false;
      if (this.session && !this.same(binding)) queueMicrotask(() => { void this.flush(); });
    }
  }

  // ---- what the kernel presents on the chat surface ----

  async present(frame) {
    if (frame.surface !== "chat") return { ok: false, error: { code: "unavailable", message: `${frame.surface} is not shown on this page` } };
    if (frame.op === "focus") { globalThis.focus?.(); return { ok: true, data: {} }; }
    // Drawing a card off screen into a picture is the phone's (it draws cards natively); this page cannot.
    if (frame.op === "card.preview") return { ok: false, error: { code: "unavailable", message: "this page cannot draw a card preview; the phone can" } };
    // A card in the conversation, whole, as the hub has it now (live data, a button's state, its lifecycle): not recorded.
    if (frame.op === "card.patch") {
      const card = frame.body?.card;
      if (!card || typeof card !== "object" || Array.isArray(card) || typeof card.id !== "string" || !card.id) return { ok: false, error: { code: "bad_request", message: "no card" } };
      try { this.onCardPatch(card); } catch { /* drawn on the next read of the card */ }
      return { ok: true, data: {} };
    }
    if (frame.op !== "open") return { ok: false, error: { code: "unavailable", message: `chat ${frame.op} is not shown on this page` } };
    // The body is `{target, id?, mode?}` (SPEC-03 §5.4).
    const { target, id, mode } = frame.body;
    if (typeof target !== "string") return { ok: false, error: { code: "bad_request", message: "no target" } };
    return this.onPresent({ target, ...(id !== undefined ? { id } : {}), ...(mode !== undefined ? { mode } : {}) });
  }
}

export { MAX_WIRE_BYTES };
