import { SCREEN_REGISTRATION_EVENT, SCREEN_TOKEN_HEADER } from "../../../sdk/src/api.ts";

const QUEUE_KEY = "ash.screen.outbox.v2";
const OUTBOX_VIEW_KEY = "ash.screen.outbox-view.v2";
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

export async function readSse(response, onFrame, signal) {
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
        const block = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        if (block) onFrame(parseSse(block));
      }
      if (pending.length > 2_000_000) throw new Error("stream frame too large");
      if (signal?.aborted) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

function readQueue(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => x && typeof x.client_id === "string" && x.kind === "request" && x.word === "say" && x.to === "agent:main" && typeof x.body?.text === "string") : [];
  } catch { return []; }
}

function readOutbox(storage, queue) {
  let saved = [];
  try { const value = JSON.parse(storage.getItem(OUTBOX_VIEW_KEY) || "[]"); if (Array.isArray(value)) saved = value; } catch { /* recover from queue */ }
  const valid = saved.filter((item) => item && typeof item.client_id === "string" && typeof item.text === "string" && ["unsent", "sending", "accepted", "rejected"].includes(item.status))
    .map((item) => ({ client_id: item.client_id, text: item.text, status: item.status === "sending" ? "unsent" : item.status, id: typeof item.id === "string" ? item.id : null, seq: Number.isSafeInteger(item.seq) ? item.seq : null }));
  const ids = new Set(valid.map((item) => item.client_id));
  for (const wire of queue) if (!ids.has(wire.client_id)) valid.push({ client_id: wire.client_id, text: wire.body.text, status: "unsent", id: null, seq: null });
  return valid;
}

export class ScreenNet {
  constructor({ fetchImpl = globalThis.fetch.bind(globalThis), storage = sessionStorage, label = "Web", onMessage = () => {}, onHistory = () => {}, onState = () => {}, onRegistered = () => {}, onQueue = () => {} } = {}) {
    this.transport = fetchImpl;
    this.storage = storage;
    this.label = label;
    this.onMessage = onMessage;
    this.onHistory = onHistory;
    this.onState = onState;
    this.onRegistered = onRegistered;
    this.onQueue = onQueue;
    this.queue = readQueue(storage);
    this.outbox = readOutbox(storage, this.queue);
    this.seenLedgerIds = new Set();
    this.cursor = null;
    this.token = null;
    this.screen = null;
    this.active = false;
    this.generation = 0;
    this.flushing = false;
    this.bootstrapped = false;
    storage.removeItem(TOKEN_KEY);
  }

  request(url, options = {}) {
    const isStream = /^\/api\/stream(?:\?|$)/.test(url) && (!options.method || options.method === "GET");
    const isSend = url === "/api/send" && options.method === "POST";
    if (!isStream && !isSend) throw new Error("unapproved UI route");
    return this.transport(url, options);
  }

  async catchUp(generation, signal) {
    const initial = !this.bootstrapped;
    let more = true;
    while (more && generation === this.generation && !signal.aborted) {
      const query = initial && this.cursor === null ? "?follow=false&limit=200" : `?follow=false&limit=1000&after=${this.cursor ?? 0}`;
      const response = await this.request(`/api/stream${query}`, { credentials: "same-origin", signal });
      let count = 0;
      const history = [];
      await readSse(response, (frame) => {
        if (frame.type === SCREEN_REGISTRATION_EVENT) return;
        if (/^[1-9][0-9]*$/.test(frame.id)) count++;
        this.frame(frame, generation, true, history);
      }, signal);
      if (generation === this.generation && !signal.aborted && history.length) this.onHistory(history);
      more = !initial && count === 1000;
      if (initial) this.bootstrapped = true;
      if (this.cursor === null) this.cursor = 0;
    }
  }

  async start() {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    let delay = 500;
    while (this.active && generation === this.generation) {
      const controller = new AbortController();
      this.controller = controller;
      this.token = null;
      this.screen = null;
      this.storage.removeItem(TOKEN_KEY);
      this.onState("connecting");
      try {
        await this.catchUp(generation, controller.signal);
        if (controller.signal.aborted || generation !== this.generation) break;
        const url = `/api/stream?follow=true&label=${encodeURIComponent(this.label)}`;
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
    this.token = null;
    this.screen = null;
    this.storage.removeItem(TOKEN_KEY);
    for (const item of this.outbox) if (item.status === "sending") item.status = "unsent";
    this.publishOutbox();
    this.onState("offline");
  }

  frame(frame, generation, historical = false, history = null) {
    if (generation !== this.generation) return;
    if (frame.type === SCREEN_REGISTRATION_EVENT) {
      let registered;
      try { registered = JSON.parse(frame.data); } catch { return; }
      if (!registered || typeof registered.token !== "string" || typeof registered.screen !== "string" || typeof registered.label !== "string") return;
      this.token = registered.token;
      this.screen = registered.screen;
      this.storage.setItem(TOKEN_KEY, registered.token);
      this.onRegistered(registered);
      this.onState("online");
      void this.flush();
      return;
    }
    if ((!this.token && !historical) || !/^[1-9][0-9]*$/.test(frame.id)) return;
    const seq = Number(frame.id);
    if (!Number.isSafeInteger(seq)) return;
    let message;
    try { message = JSON.parse(frame.data); } catch { return; }
    if (message?.seq !== seq) return;
    this.cursor = Math.max(this.cursor ?? 0, seq);
    if (typeof message.id === "string") {
      this.seenLedgerIds.add(message.id);
      const oldLength = this.outbox.length;
      this.outbox = this.outbox.filter((item) => item.id !== message.id);
      if (this.outbox.length !== oldLength) this.publishOutbox();
    }
    if (history) history.push(message);
    else this.onMessage(message, { historical });
  }

  async page(before, signal) {
    if (!Number.isSafeInteger(before) || before < 1) throw new Error("invalid page cursor");
    const response = await this.request(`/api/stream?before=${before}&limit=200&follow=false`, { credentials: "same-origin", signal });
    const records = [];
    await readSse(response, (frame) => {
      if (frame.type === SCREEN_REGISTRATION_EVENT) return;
      if (!/^[1-9][0-9]*$/.test(frame.id)) return;
      try { const message = JSON.parse(frame.data); if (message?.seq === Number(frame.id)) records.push(message); } catch { /* ignore malformed frame */ }
    }, signal);
    return records.sort((a, b) => a.seq - b.seq).filter((item, index, all) => index === 0 || item.seq !== all[index - 1].seq);
  }

  publishOutbox() {
    this.storage.setItem(OUTBOX_VIEW_KEY, JSON.stringify(this.outbox));
    this.onQueue(this.queue.length, this.outbox.map((item) => ({ ...item })));
  }

  setOutbox(clientId, patch) {
    const item = this.outbox.find((entry) => entry.client_id === clientId);
    if (!item) return;
    Object.assign(item, patch);
    this.publishOutbox();
  }

  enqueueSay(text, attachments = []) {
    const body = { text, ...(attachments.length ? { attachments } : {}) };
    const message = { to: "agent:main", kind: "request", word: "say", body, client_id: crypto.randomUUID() };
    this.queue.push(message);
    this.storage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
    this.outbox.push({ client_id: message.client_id, text, status: this.token ? "sending" : "unsent", id: null, seq: null });
    this.publishOutbox();
    void this.flush();
    return message.client_id;
  }

  async sendEvent(to, word) {
    if (!this.token) return { ok: false, reason: "unregistered" };
    try {
      const response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.token }, body: JSON.stringify({ to, kind: "event", word, body: {}, client_id: crypto.randomUUID() }) });
      return response.ok ? { ok: true } : { ok: false, reason: `HTTP ${response.status}` };
    } catch { return { ok: false, reason: "offline" }; }
  }

  async respondOpen(request, opened) {
    if (!this.token || request?.to !== this.screen || request.kind !== "request" || request.word !== "ui.open" || typeof request.from !== "string" || typeof request.id !== "string") return false;
    const response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: this.token }, body: JSON.stringify({ to: request.from, kind: "response", word: "ui.open", reply_to: request.id, body: { ok: true, result: { opened } }, client_id: `ui-open:${request.id}` }) });
    return response.ok;
  }

  async flush() {
    if (this.flushing || !this.token) return;
    this.flushing = true;
    const startingToken = this.token;
    try {
      while (this.token && this.queue.length) {
        const token = this.token;
        const queued = this.queue[0];
        this.setOutbox(queued.client_id, { status: "sending" });
        let response;
        try {
          response = await this.request("/api/send", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", [SCREEN_TOKEN_HEADER]: token }, body: JSON.stringify(this.queue[0]) });
        } catch { this.setOutbox(queued.client_id, { status: "unsent" }); this.onState("offline"); break; }
        if (response.status === 403 && token === this.token) { this.setOutbox(queued.client_id, { status: "unsent" }); this.controller?.abort(); break; }
        if (!response.ok) { this.setOutbox(queued.client_id, { status: response.status < 500 ? "rejected" : "unsent" }); this.onState("send-error", new Error(`send HTTP ${response.status}`)); break; }
        let acknowledgement;
        try { acknowledgement = await response.json(); } catch { /* retry the same client_id */ }
        if (typeof acknowledgement?.id !== "string" || !Number.isSafeInteger(acknowledgement.seq)) {
          this.setOutbox(queued.client_id, { status: "unsent" });
          this.onState("send-error", new Error("send acknowledgement invalid"));
          break;
        }
        if (this.queue.length) this.queue.shift();
        this.storage.setItem(QUEUE_KEY, JSON.stringify(this.queue));
        if (this.seenLedgerIds.has(acknowledgement.id)) this.outbox = this.outbox.filter((item) => item.client_id !== queued.client_id);
        else this.setOutbox(queued.client_id, { status: "accepted", id: acknowledgement.id, seq: acknowledgement.seq });
        this.publishOutbox();
      }
    } finally {
      this.flushing = false;
      if (this.token && this.token !== startingToken && this.queue.length) queueMicrotask(() => { void this.flush(); });
    }
  }
}
