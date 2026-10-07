import { AUTH_SCOPE_EVENT, MESSAGE_SUMMARY_EVENT, POST_DELIVERY_SNAPSHOT_EVENT, SCREEN_REGISTRATION_EVENT, SCREEN_TOKEN_HEADER, STREAM_ERROR_EVENT, STREAM_PAGE_END_EVENT, isAuthScopeControlV2, isMessageSummaryV2, isScreenRegistration, isStreamErrorV2, isStreamPageEndV2 } from "../../../sdk/src/api.ts";
import { postDeliverySnapshotErrors } from "../../../sdk/src/words.ts";
import { openPendingStore } from "./pending-store.js";
import { browserUiTransport } from "./ui-transport.js";

const TOKEN_KEY = "ash.screen.token.v2";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseSse(block) {
  const event = { type: "message", id: "", data: "" };
  const data = [];
  for (const line of block.replaceAll("\r\n", "\n").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (name === "event") event.type = value;
    else if (name === "id") event.id = value;
    else if (name === "data") data.push(value);
  }
  event.data = data.join("\n");
  return event;
}

export async function readSse(response, onFrame, signal, maxFrameBytes = 2_000_000) {
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let parts = [];
  let pendingBytes = 0;
  let tail = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const piece = decoder.decode(value, { stream: true });
      if (!/\r?\n\r?\n/.test(tail + piece)) {
        parts.push(piece);
        pendingBytes += value.byteLength;
        tail = (tail + piece).slice(-3);
      } else {
        let pending = parts.join("") + piece;
        parts = [];
        pendingBytes = 0;
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
          const block = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (new TextEncoder().encode(block).byteLength > maxFrameBytes) throw new Error("stream frame too large");
          if (block) onFrame(parseSse(block));
        }
        parts.push(pending);
        pendingBytes = new TextEncoder().encode(pending).byteLength;
        tail = pending.slice(-3);
      }
      if (pendingBytes > maxFrameBytes) throw new Error("stream frame too large");
      if (signal?.aborted) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export class ScreenNet {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), uiTransport, storage = sessionStorage, pendingStore = null, endpoint = globalThis.location?.origin || "http://local.test", label = "Web", onMessage = () => {}, onHistory = () => {}, onSnapshot = () => {}, onReset = () => {}, onState = () => {}, onRegistered = () => {}, onQueue = () => {} } = {}) {
    this.uiTransport = uiTransport ?? browserUiTransport(fetchImpl);
    if (this.uiTransport.embedded && endpoint !== (globalThis.location?.origin || "http://local.test") && endpoint !== this.uiTransport.endpoint) throw new Error("conflicting logical core endpoint");
    this.storage = storage;
    this.label = label;
    this.onMessage = onMessage;
    this.onHistory = onHistory;
    this.onSnapshot = onSnapshot;
    this.onReset = onReset;
    this.onState = onState;
    this.onRegistered = onRegistered;
    this.onQueue = onQueue;
    this.endpoint = this.uiTransport.embedded ? this.uiTransport.endpoint : endpoint;
    this.pendingReady = this.uiTransport.whenReady().then(() => pendingStore ?? openPendingStore()).catch(() => null);
    this.tabOwner = crypto.randomUUID();
    this.currentScope = null;
    this.queue = [];
    this.outbox = [];
    this.seenLedgerIds = new Set();
    this.cursor = null;
    this.token = null;
    this.screen = null;
    this.localManagement = false;
    this.adminIntent = null;
    this.active = false;
    this.generation = 0;
    this.flushing = false;
    this.bootstrapped = false;
    this.scopeVersion = 0;
    storage.removeItem(TOKEN_KEY);
  }

  request(url, options = {}) {
    return this.uiTransport.request(url, options);
  }

  async catchUp(generation, signal) {
    let more = true;
    while (more && generation === this.generation && !signal.aborted) {
      const initial = !this.bootstrapped;
      const query = initial && this.cursor === null ? "?follow=false&summary=true&limit=200" : `?follow=false&summary=true&limit=1000&after=${this.cursor ?? 0}`;
      const response = await this.request(`/api/stream${query}`, { credentials: "same-origin", signal });
      const history = [];
      const snapshots = [];
      let scopeSeen = false;
      let endFrame = null;
      let scopeVersion = this.scopeVersion;
      let staleScope = false;
      await readSse(response, (frame) => {
        if (!scopeSeen) {
          if (frame.type !== AUTH_SCOPE_EVENT || frame.id) throw new Error("history missing authentication scope");
          let control;
          try { control = JSON.parse(frame.data); } catch { throw new Error("invalid history scope"); }
          if (!isAuthScopeControlV2(control)) throw new Error("invalid history scope");
          const prior = this.currentScope;
          this.acceptScope(control.auth_scope);
          staleScope = prior !== null && prior !== control.auth_scope;
          if (!staleScope) scopeVersion = this.scopeVersion;
          scopeSeen = true;
          return;
        }
        if (this.scopeVersion !== scopeVersion) return;
        if (frame.type === STREAM_PAGE_END_EVENT) {
          let control;
          try { control = JSON.parse(frame.data); } catch { throw new Error("invalid page end"); }
          if (frame.id || !isStreamPageEndV2(control)) throw new Error("invalid page end");
          endFrame = control;
          return;
        }
        this.frame(frame, generation, true, history, snapshots);
      }, signal);
      if (!scopeSeen) throw new Error("incomplete history page");
      if (staleScope) continue;
      if (!endFrame) throw new Error("incomplete history page");
      if (generation === this.generation && !signal.aborted && (history.length || snapshots.length)) this.onHistory(history, snapshots);
      more = !initial && endFrame.has_more;
      if (initial) this.bootstrapped = true;
      if (this.cursor === null) this.cursor = 0;
    }
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    await this.uiTransport.whenReady();
    if (!this.active || generation !== this.generation) return;
    let delay = 500;
    while (this.active && generation === this.generation) {
      const controller = new AbortController();
      this.controller = controller;
      this.token = null;
      this.screen = null;
      this.localManagement = false;
      this.adminIntent = null;
      this.storage.removeItem(TOKEN_KEY);
      this.onState("connecting");
      try {
        await this.catchUp(generation, controller.signal);
        if (controller.signal.aborted || generation !== this.generation) break;
        const url = `/api/stream?follow=true&summary=true&label=${encodeURIComponent(this.label)}`;
        const headers = { "Last-Event-ID": String(this.cursor ?? 0) };
        const response = await this.request(url, { headers, credentials: "same-origin", signal: controller.signal });
        await readSse(response, (frame) => this.frame(frame, generation), controller.signal);
        delay = 500;
      } catch (error) {
        if (!controller.signal.aborted && generation === this.generation) this.onState("offline", error);
      }
      if (!this.active || generation !== this.generation) break;
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  stop() {
    this.active = false;
    this.generation++;
    this.controller?.abort();
    this.sendController?.abort();
    clearTimeout(this.retryTimer);
    this.token = null;
    this.screen = null;
    this.localManagement = false;
    this.adminIntent = null;
    this.storage.removeItem(TOKEN_KEY);
    this.queue = [];
    this.outbox = [];
    this.publishOutbox();
    this.onState("offline");
  }

  reconnect() {
    if (this.active) this.controller?.abort();
  }

  acceptScope(scope, abortLive = false) {
    if (this.currentScope === scope) return false;
    const changed = this.currentScope !== null;
    if (changed) {
      this.sendController?.abort();
      clearTimeout(this.retryTimer);
      this.token = null;
      this.screen = null;
      this.localManagement = false;
      this.adminIntent = null;
      this.storage.removeItem(TOKEN_KEY);
      this.queue = []; this.outbox = []; this.publishOutbox();
      this.seenLedgerIds.clear();
      this.cursor = null;
      this.bootstrapped = false;
      this.onReset();
      if (abortLive) this.controller?.abort();
    }
    this.currentScope = scope;
    this.scopeVersion++;
    return changed;
  }

  frame(frame, generation, historical = false, history = null, snapshots = null) {
    if (generation !== this.generation) return;
    if (frame.type === STREAM_ERROR_EVENT && frame.id === "") {
      let error;
      try { error = JSON.parse(frame.data); } catch { throw new Error("invalid stream error frame"); }
      if (!isStreamErrorV2(error)) throw new Error("invalid stream error frame");
      throw new Error(`stream ${error.code}`);
    }
    if (frame.type === SCREEN_REGISTRATION_EVENT) {
      let registered;
      try { registered = JSON.parse(frame.data); } catch { return; }
      if (!isScreenRegistration(registered)) { this.localManagement = false; this.adminIntent = null; this.onState("send-error", new Error("screen credential scope unavailable")); return; }
      if (this.acceptScope(registered.auth_scope, true)) return;
      if (this.token !== registered.token || this.screen !== registered.screen || this.localManagement !== (registered.local_management === true)) this.adminIntent = null;
      this.token = registered.token;
      this.screen = registered.screen;
      this.localManagement = registered.local_management === true;
      this.currentScope = registered.auth_scope;
      this.storage.setItem(TOKEN_KEY, registered.token);
      this.onRegistered(registered);
      this.onState("online");
      void this.restorePending(registered.auth_scope).then(() => this.flush());
      return;
    }
    if (frame.type === POST_DELIVERY_SNAPSHOT_EVENT && frame.id === "") {
      let snapshot;
      try { snapshot = JSON.parse(frame.data); } catch { return; }
      if (postDeliverySnapshotErrors(snapshot).length) return;
      if (snapshots) snapshots.push(snapshot);
      else this.onSnapshot(snapshot);
      return;
    }
    if ((!this.token && !historical) || !/^[1-9][0-9]*$/.test(frame.id)) return;
    const seq = Number(frame.id);
    if (!Number.isSafeInteger(seq)) return;
    let message;
    try { message = JSON.parse(frame.data); } catch { return; }
    if (frame.type !== MESSAGE_SUMMARY_EVENT || !isMessageSummaryV2(message) || message.seq !== seq) return;
    this.cursor = Math.max(this.cursor ?? 0, seq);
    if (typeof message.id === "string") {
      this.seenLedgerIds.add(message.id);
      const oldLength = this.outbox.length;
      this.outbox = this.outbox.filter((item) => item.id !== message.id);
      if (this.outbox.length !== oldLength) this.publishOutbox();
      if (this.currentScope) void this.pendingReady.then((store) => store?.removeAccepted(this.endpoint, this.currentScope, message.id)).catch(() => {});
    }
    if (history) history.push(message);
    else this.onMessage(message, { historical });
  }

  async page(before, signal) {
    if (!Number.isSafeInteger(before) || before < 1) throw new Error("invalid page cursor");
    const response = await this.request(`/api/stream?before=${before}&limit=200&follow=false&summary=true`, { credentials: "same-origin", signal });
    const records = [];
    const snapshots = [];
    let scopeSeen = false;
    let endFrame = null;
    let scopeVersion = this.scopeVersion;
    let staleScope = false;
    await readSse(response, (frame) => {
      if (!scopeSeen) {
        if (frame.type !== AUTH_SCOPE_EVENT || frame.id) throw new Error("history missing authentication scope");
        let control;
        try { control = JSON.parse(frame.data); } catch { throw new Error("invalid history scope"); }
        if (!isAuthScopeControlV2(control)) throw new Error("invalid history scope");
        const prior = this.currentScope;
        this.acceptScope(control.auth_scope, true);
        staleScope = prior !== null && prior !== control.auth_scope;
        if (!staleScope) scopeVersion = this.scopeVersion;
        scopeSeen = true;
        return;
      }
      if (this.scopeVersion !== scopeVersion) return;
      if (frame.type === STREAM_PAGE_END_EVENT) {
        let control;
        try { control = JSON.parse(frame.data); } catch { throw new Error("invalid page end"); }
        if (frame.id || !isStreamPageEndV2(control)) throw new Error("invalid page end");
        endFrame = control;
        return;
      }
      if (frame.type === POST_DELIVERY_SNAPSHOT_EVENT) {
        try { const snapshot = JSON.parse(frame.data); if (!postDeliverySnapshotErrors(snapshot).length) snapshots.push(snapshot); } catch { /* ignore malformed control */ }
        return;
      }
      if (!/^[1-9][0-9]*$/.test(frame.id) || frame.type !== MESSAGE_SUMMARY_EVENT) return;
      try { const message = JSON.parse(frame.data); if (isMessageSummaryV2(message) && message.seq === Number(frame.id)) records.push(message); } catch { /* ignore malformed frame */ }
    }, signal);
    if (!scopeSeen) throw new Error("incomplete history page");
    if (staleScope) return { messages: [], snapshots: [], end: { has_more: false } };
    if (!endFrame) throw new Error("incomplete history page");
    return { messages: records.sort((a, b) => a.seq - b.seq).filter((item, index, all) => index === 0 || item.seq !== all[index - 1].seq), snapshots, end: endFrame };
  }

  /** One authenticated original ledger row is fetched only on an attachment click. */
  async fetchOriginalAttachment(summary, descriptor) {
    if (!isMessageSummaryV2(summary) || !descriptor || !Number.isSafeInteger(descriptor.index) || !this.currentScope) throw new Error("attachment reference unavailable");
    const expectedScope = this.currentScope;
    const response = await this.request(`/api/stream?before=${summary.seq + 1}&limit=1&follow=false`, { credentials: "same-origin" });
    let scopeSeen = false;
    let original = null;
    await readSse(response, (frame) => {
      if (!scopeSeen) {
        if (frame.type !== AUTH_SCOPE_EVENT || frame.id) throw new Error("raw page missing authentication scope");
        let control;
        try { control = JSON.parse(frame.data); } catch { throw new Error("invalid raw scope"); }
        if (!isAuthScopeControlV2(control)) throw new Error("invalid raw scope");
        if (control.auth_scope !== expectedScope) { this.acceptScope(control.auth_scope, true); throw new Error("authentication scope changed"); }
        scopeSeen = true;
        return;
      }
      if (frame.type !== "message") return;
      if (original) throw new Error("raw page returned multiple rows");
      let message;
      try { message = JSON.parse(frame.data); } catch { throw new Error("invalid raw message"); }
      if (frame.id !== String(summary.seq) || message?.seq !== summary.seq || message?.id !== summary.id || message?.from !== summary.from || message?.to !== summary.to || message?.kind !== summary.kind || message?.word !== summary.word || message?.summary === true || !message?.body || typeof message.body !== "object") throw new Error("raw message does not match summary");
      original = message;
    }, undefined, 33 * 1024 * 1024);
    if (!scopeSeen || !original) throw new Error("raw message unavailable");
    const item = original.body.attachments?.[descriptor.index];
    if (!item || item.name !== descriptor.name || item.mime_type !== descriptor.mime_type || typeof item.data !== "string") throw new Error("raw attachment does not match summary");
    return item;
  }

  publishOutbox() {
    this.onQueue(this.queue.length, this.outbox.map((item) => ({ ...item })));
  }

  async restorePending(scope) {
    const store = await this.pendingReady;
    if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
    const items = (await store.list(this.endpoint, scope)).filter((item) => {
      if (!item.id || !this.seenLedgerIds.has(item.id)) return true;
      void store.removeAccepted(this.endpoint, scope, item.id).catch(() => {});
      return false;
    });
    if (scope !== this.currentScope) return;
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

  async enqueueSay(text, attachments = [], option = null, target = "agent:main") {
    if (!this.uiTransport.isReady()) throw new Error("native transport not ready");
    const scope = this.currentScope;
    if (!scope) throw new Error("connect once before storing an offline message");
    const store = await this.pendingReady;
    if (!store) throw new Error("pending storage unavailable");
    if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("empty message");
    if (option && (typeof option.in_reply_to !== "string" || !option.in_reply_to || typeof option.option_id !== "string" || !option.option_id || attachments.length))
      throw new Error("invalid option reply");
    const body = { text, ...(attachments.length ? { attachments } : {}), ...(option ? { in_reply_to: option.in_reply_to, option_id: option.option_id } : {}) };
    if (!/^agent:[a-z][a-z0-9_-]*$/.test(target)) throw new Error("invalid agent target");
    const message = { to: target, kind: "request", word: "say", body, client_id: crypto.randomUUID() };
    await store.enqueue(this.endpoint, scope, message);
    await this.restorePending(scope);
    if (scope === this.currentScope) void this.flush();
    return message.client_id;
  }

  async sendEvent(to, word) {
    if (!this.token) return { ok: false, reason: "unregistered" };
    try {
      const response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.token }, body: JSON.stringify({ to, kind: "event", word, body: {}, client_id: crypto.randomUUID() }) });
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status}` };
    } catch { return { ok: false, reason: "offline" }; }
  }

  /** Online-only control/read, shared by agent picker and work-thread controls. */
  async agentRequest(word, body = {}) {
    const response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.token },
      body: JSON.stringify({ to: "service:agents", kind: "request", word, body, client_id: crypto.randomUUID(), wait: true }) });
    const accepted = await response.json();
    const reply = accepted?.reply;
    if (!response.ok || reply?.reply_to !== accepted.id || reply?.from !== "service:agents" || reply?.word !== word || reply?.body?.ok !== true) throw new Error(reply?.body?.error?.message || "Agent service unavailable");
    return reply.body.result;
  }

  /** A confirmed local-screen action; no offline queue or optimistic success. */
  async sendAdmin(word) {
    if (!this.localManagement || !this.token || !this.screen || !this.currentScope || !["pause", "resume"].includes(word))
      return { ok: false, reason: "unregistered" };
    const token = this.token;
    const screen = this.screen;
    const scope = this.currentScope;
    if (this.adminIntent?.word !== word || this.adminIntent?.token !== token || this.adminIntent?.screen !== screen || this.adminIntent?.scope !== scope)
      this.adminIntent = { word, token, screen, scope, clientId: crypto.randomUUID() };
    const client_id = this.adminIntent.clientId;
    try {
      const response = await this.request("/api/send", { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token },
        body: JSON.stringify({ to: "service:admin", kind: "request", word,
          body: word === "resume" ? { confirmed: true } : {}, client_id, wait: true }) });
      if (this.token !== token || this.screen !== screen || this.currentScope !== scope || !this.localManagement)
        return { ok: false, reason: "screen-changed" };
      if (!response.ok) {
        if (response.status === 403 && this.adminIntent?.clientId === client_id) this.adminIntent = null;
        return { ok: false, reason: `HTTP ${response.status}` };
      }
      const accepted = await response.json();
      const reply = accepted?.reply;
      const paused = word === "pause";
      if (typeof accepted?.id !== "string" || reply?.kind !== "response" || reply?.reply_to !== accepted.id ||
        reply?.from !== "service:admin" || reply?.to !== "person:owner" || reply?.word !== word ||
        reply?.body?.ok !== true || reply?.body?.result?.paused !== paused)
        return { ok: false, reason: "unconfirmed" };
      if (this.token !== token || this.screen !== screen || this.currentScope !== scope || !this.localManagement)
        return { ok: false, reason: "screen-changed" };
      if (this.adminIntent?.clientId === client_id) this.adminIntent = null;
      return { ok: true, paused };
    } catch { return { ok: false, reason: "offline" }; }
  }

  async respondOpen(request, opened) {
    if (!this.token || request?.to !== this.screen || request.kind !== "request" || request.word !== "ui.open" || typeof request.from !== "string" || typeof request.id !== "string") return false;
    const response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.token }, body: JSON.stringify({ to: request.from, kind: "response", word: "ui.open", reply_to: request.id, body: { ok: true, result: { opened } }, client_id: `ui-open:${request.id}` }) });
    return response.ok;
  }

  async flush() {
    if (this.flushing || !this.uiTransport.isReady() || !this.uiTransport.allowsQueueFlush() || !this.token || !this.currentScope) return;
    this.flushing = true;
    const startingToken = this.token;
    const startingScope = this.currentScope;
    const retry = (ms) => {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        if (this.token && this.currentScope === startingScope) {
          void this.restorePending(startingScope).then(() => this.flush()).catch(() => this.onState("send-error", new Error("pending storage unavailable")));
        }
      }, Math.max(100, ms));
      this.retryTimer.unref?.();
    };
    try {
      const store = await this.pendingReady;
      if (!store) { this.onState("send-error", new Error("pending storage unavailable")); return; }
      while (this.token && this.currentScope === startingScope) {
        const token = this.token;
        const queued = await store.claim(this.endpoint, startingScope, this.tabOwner);
        if (!queued) break;
        if (queued.blockedUntil) { retry(queued.blockedUntil - Date.now() + 20); break; }
        this.setOutbox(queued.client_id, { status: "sending" });
        let response;
        const sending = new AbortController();
        this.sendController = sending;
        const leaseTimer = setInterval(() => { void store.renew(queued, this.tabOwner).catch(() => sending.abort()); }, 10_000);
        try {
          response = await this.request("/api/send", { method: "POST", credentials: "same-origin", signal: sending.signal, headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token }, body: JSON.stringify(queued.wire) });
        } catch { await store.release(queued, this.tabOwner, "unsent"); this.setOutbox(queued.client_id, { status: "unsent" }); this.onState("offline"); retry(5_000); break; }
        finally { clearInterval(leaseTimer); if (this.sendController === sending) this.sendController = null; }
        if (response.status === 403 && token === this.token) { await store.release(queued, this.tabOwner, "unsent"); this.setOutbox(queued.client_id, { status: "unsent" }); this.controller?.abort(); break; }
        if (!response.ok) {
          const status = response.status < 500 ? "rejected" : "unsent";
          await store.release(queued, this.tabOwner, status);
          this.setOutbox(queued.client_id, { status }); this.onState("send-error", new Error(`send HTTP ${response.status}`));
          if (status === "unsent") retry(5_000);
          break;
        }
        let acknowledgement;
        try { acknowledgement = await response.json(); } catch { /* retry the same client_id */ }
        if (typeof acknowledgement?.id !== "string" || !Number.isSafeInteger(acknowledgement.seq) || acknowledgement.seq < 1) {
          await store.release(queued, this.tabOwner, "unsent");
          this.setOutbox(queued.client_id, { status: "unsent" });
          this.onState("send-error", new Error("send acknowledgement invalid"));
          retry(5_000);
          break;
        }
        await store.accept(queued, this.tabOwner, acknowledgement.id, acknowledgement.seq);
        if (this.seenLedgerIds.has(acknowledgement.id)) await store.removeAccepted(this.endpoint, startingScope, acknowledgement.id);
        await this.restorePending(startingScope);
      }
    } catch { this.onState("send-error", new Error("pending storage unavailable")); }
    finally {
      this.flushing = false;
      if (this.token && this.token !== startingToken && this.currentScope === startingScope) queueMicrotask(() => { void this.flush(); });
    }
  }
}
