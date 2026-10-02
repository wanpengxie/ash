#!/usr/bin/env node
import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// tools/regress-remote.mjs
import { randomUUID } from "node:crypto";

// node_modules/ash-gateway/src/protocol.ts
var PROTOCOL = "ash-gw/1";
var LIMITS = {
  /** HTTP request body. */
  maxBodyBytes: 16 * 1024,
  /** One WebSocket frame (envelope or control). */
  maxFrameBytes: 64 * 1024,
  /** One tunnel frame from the phone (Cloudflare's WebSocket message cap is 1 MiB). */
  maxTunnelFrameBytes: 1024 * 1024 - 1024,
  challengeTtlMs: 6e4,
  sessionTtlMs: 15 * 6e4,
  pairTicketMaxTtlMs: 5 * 6e4,
  pairRequestTtlMs: 10 * 6e4,
  pairTicketMaxAttempts: 5,
  /** Live (unexpired, unused) challenges kept at once; beyond this the gateway refuses new ones. */
  maxLiveChallenges: 256,
  maxDeviceNameLength: 64,
  maxClients: 32,
  /** Browser sessions (devices holding `web_ui`) last a working day; everything else stays short. */
  browserSessionTtlMs: 12 * 60 * 6e4,
  /** Request body accepted for tunneled web requests (uploads go through here). */
  webMaxBodyBytes: 8 * 1024 * 1024,
  /** Raw bytes per tunnel data frame (base64 keeps each frame well under the 1 MiB WebSocket cap). */
  tunnelChunkBytes: 256 * 1024,
  /** How long the gateway waits for the phone to start answering a tunneled request. */
  tunnelHeadTimeoutMs: 3e4
};
function signingInput(purpose, fields) {
  for (const f of [purpose, ...fields]) {
    if (typeof f !== "string" || f.includes("\n") || f.includes("\r")) {
      throw new ProtocolError("bad_field", "signed fields must be strings without line breaks");
    }
  }
  return new TextEncoder().encode([PROTOCOL, purpose, ...fields].join("\n"));
}
var ctx = {
  bootstrapClaim: (origin, nonce, ownerKey) => signingInput("bootstrap-claim", [origin, nonce, ownerKey]),
  auth: (origin, deviceId, nonce) => signingInput("auth", [origin, deviceId, nonce]),
  pairApprove: (origin, requestId, clientId, clientKey, permissions, grantVersion) => signingInput("pair-approve", [
    origin,
    requestId,
    clientId,
    clientKey,
    [...permissions].sort().join(","),
    String(grantVersion)
  ]),
  revoke: (origin, clientId, grantVersion) => signingInput("revoke", [origin, clientId, String(grantVersion)])
};
async function envelopeSigningInput(e) {
  const payloadHash = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(e.payload))));
  return signingInput("msg", [
    String(e.v),
    e.type,
    e.message_id,
    e.from,
    e.to,
    String(e.issued_at),
    String(e.expires_at),
    e.reply_to ?? "",
    payloadHash
  ]);
}
var ProtocolError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
  code;
  status;
};
function utf8(s) {
  return new TextEncoder().encode(s);
}
function b64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new ProtocolError("bad_encoding", "expected base64url");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - s.length % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function randomToken(bytes = 32) {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function sha256b64u(s) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s))));
}
async function deviceIdForKey(spkiB64u) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64u(spkiB64u)));
  return b64u(digest).slice(0, 22);
}
async function importPublicKey(spkiB64u) {
  try {
    return await crypto.subtle.importKey(
      "spki",
      fromB64u(spkiB64u),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    throw new ProtocolError("bad_key", "public key must be a P-256 SPKI in base64url");
  }
}
async function verifySignature(spkiB64u, sigB64u, data) {
  const key = await importPublicKey(spkiB64u);
  let sig;
  try {
    sig = fromB64u(sigB64u);
  } catch {
    return false;
  }
  if (sig.length !== 64) {
    const raw = derToRaw(sig);
    if (!raw) return false;
    sig = raw;
  }
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
}
function derToRaw(der) {
  let i = 0;
  if (der[i++] !== 48) return null;
  let len = der[i++];
  if (len & 128) {
    const n = len & 127;
    if (n !== 1) return null;
    len = der[i++];
  }
  if (len !== der.length - i) return null;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[i++] !== 2) return null;
    let n = der[i++];
    if (n > 33 || i + n > der.length) return null;
    let v = der.slice(i, i + n);
    i += n;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    out.set(v, part * 32 + (32 - v.length));
  }
  return i === der.length ? out : null;
}
async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

// node_modules/ash-gateway/client/client.ts
var DeviceKey = class _DeviceKey {
  constructor(privateKey, publicKey, id) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.id = id;
  }
  privateKey;
  publicKey;
  id;
  static async generate() {
    const pair2 = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return _DeviceKey.fromPair(pair2);
  }
  /** Test helper: persist a key as JWK (a real phone keeps it in the Android Keystore instead). */
  async exportJwk() {
    return await crypto.subtle.exportKey("jwk", this.privateKey);
  }
  static async fromJwk(jwk) {
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const { d: _d, ...pub } = jwk;
    const publicKey = await crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
    return _DeviceKey.fromPair({ privateKey, publicKey });
  }
  static async fromPair(pair2) {
    const spki = b64u(new Uint8Array(await crypto.subtle.exportKey("spki", pair2.publicKey)));
    return new _DeviceKey(pair2.privateKey, spki, await deviceIdForKey(spki));
  }
  async sign(data) {
    return b64u(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, data)));
  }
};
var GatewayError = class extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var GatewayClient = class {
  constructor(baseUrl, key) {
    this.baseUrl = baseUrl;
    this.key = key;
    this.origin = new URL(baseUrl).origin;
  }
  baseUrl;
  key;
  origin;
  async health() {
    return this.call("GET", "/v1/health");
  }
  /** Owner only, once per deployment: prove knowledge of BOOTSTRAP_SECRET and possession of the key. */
  async claim(bootstrapSecret, name = "agent phone") {
    const { nonce } = await this.call("POST", "/v1/bootstrap/challenge", {});
    const data = ctx.bootstrapClaim(this.origin, nonce, this.key.publicKey);
    return this.call("POST", "/v1/bootstrap/claim", {
      owner_key: this.key.publicKey,
      nonce,
      mac: await hmacSha256(bootstrapSecret, data),
      sig: await this.key.sign(data),
      name
    });
  }
  async authenticate() {
    const { nonce } = await this.call("POST", "/v1/auth/challenge", { device_id: this.key.id });
    return this.call("POST", "/v1/auth/session", {
      device_id: this.key.id,
      nonce,
      sig: await this.key.sign(ctx.auth(this.origin, this.key.id, nonce))
    });
  }
  /** New client: submit the ticket scanned from the phone and wait for the owner to decide. */
  async requestPairing(ticket, name) {
    return this.call("POST", "/v1/pair/request", { ticket, pubkey: this.key.publicKey, name });
  }
  async pairingStatus(requestId) {
    return this.call("POST", "/v1/pair/status", { request_id: requestId });
  }
  /**
   * Poll until the owner approves or rejects. On approval the owner's signature is
   * checked against the owner key pinned from the QR code — a forged gateway cannot
   * hand out approvals.
   */
  async waitForApproval(requestId, pinnedOwnerKey, timeoutMs = 6e4) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await this.pairingStatus(requestId);
      if (s.status === "rejected") throw new GatewayError(403, "pair_rejected", "owner rejected the pairing");
      if (s.status === "approved") {
        if (s.owner_key !== pinnedOwnerKey) throw new GatewayError(0, "owner_mismatch", "gateway reports a different owner key");
        const permissions = s.permissions;
        const grant_version = s.grant_version;
        const data = ctx.pairApprove(this.origin, requestId, this.key.id, this.key.publicKey, permissions, grant_version);
        if (!await verifySignature(pinnedOwnerKey, s.approval_sig, data)) {
          throw new GatewayError(0, "bad_approval", "approval is not signed by the pinned owner");
        }
        return { permissions, grant_version };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new GatewayError(0, "timeout", "pairing not decided in time");
  }
  async connect(session) {
    const wsUrl = this.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/v1/ws";
    const ws = new WebSocket(wsUrl, ["ash.v1", `ash.bearer.${session.token}`]);
    const conn = new Connection(ws);
    await conn.opened;
    return conn;
  }
  // ---------------------------------------------------------------- owner ops
  /** Returns the ticket to put in the QR code; the gateway only ever sees its hash. */
  async createPairTicket(conn, ttlMs = 5 * 6e4 - 1e3) {
    const ticket = randomToken(24);
    await conn.request({ op: "pair.ticket", ticket_hash: await sha256b64u(ticket), expires_at: Date.now() + ttlMs });
    return ticket;
  }
  async approve(conn, req, permissions, grantVersion) {
    const sig = await this.key.sign(ctx.pairApprove(this.origin, req.request_id, req.client_id, req.pubkey, permissions, grantVersion));
    return conn.request({ op: "pair.approve", request_id: req.request_id, permissions, grant_version: grantVersion, sig });
  }
  async revoke(conn, clientId, grantVersion) {
    const sig = await this.key.sign(ctx.revoke(this.origin, clientId, grantVersion));
    return conn.request({ op: "device.revoke", client_id: clientId, grant_version: grantVersion, sig });
  }
  // ---------------------------------------------------------------- envelopes
  async envelope(type, to, payload, opts = {}) {
    const now = Date.now();
    const unsigned = {
      v: 1,
      type,
      message_id: opts.messageId ?? randomToken(12),
      from: this.key.id,
      to,
      issued_at: now,
      expires_at: now + (opts.ttlMs ?? 6e4),
      reply_to: opts.replyTo ?? null,
      payload: JSON.stringify(payload)
    };
    return { ...unsigned, sig: await this.key.sign(await envelopeSigningInput(unsigned)) };
  }
  static async verifyEnvelope(e, senderKey) {
    const { sig, ...unsigned } = e;
    return verifySignature(senderKey, sig, await envelopeSigningInput(unsigned));
  }
  // ---------------------------------------------------------------- http
  async call(method, path, body) {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method,
      headers: body === void 0 ? {} : { "content-type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
    }
    if (!res.ok) throw new GatewayError(res.status, String(data.error ?? "http_error"), String(data.message ?? text.slice(0, 200)));
    return data;
  }
};
var Connection = class {
  constructor(ws) {
    this.ws = ws;
    this.opened = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new GatewayError(0, "ws_error", "websocket failed to open")), { once: true });
    });
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }), { once: true });
    });
    ws.addEventListener("message", (ev) => {
      const text = String(ev.data);
      if (text === "pong") return;
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      const i = this.waiters.findIndex((w) => w.pred(frame));
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(frame);
      else if (this.onUnmatched) this.onUnmatched(frame);
      else this.frames.push(frame);
    });
  }
  ws;
  opened;
  closed;
  frames = [];
  waiters = [];
  seq = 0;
  /** Long-lived connections: frames no waiter wants go here instead of piling up in the buffer. */
  onUnmatched = null;
  send(frame) {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }
  next(pred, timeoutMs = 1e4) {
    const i = this.frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (f) => (clearTimeout(timer), resolve(f)) };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new GatewayError(0, "timeout", "no matching frame"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
  /** Send a gateway control op and wait for its ".ok" (or error) answer. */
  async request(frame) {
    const id = `r${++this.seq}`;
    this.send({ t: "gw", id, ...frame });
    const answer = await this.next((f) => f.t === "gw" && f.ref === id);
    if (answer.op === "error") throw new GatewayError(0, String(answer.code), String(answer.message));
    return answer;
  }
  close() {
    this.ws.close(1e3, "bye");
  }
};

// tools/regress-remote.mjs
var [cmd] = process.argv.slice(2);
var GW = (process.env.GATEWAY_URL ?? "").replace(/\/$/, "");
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var stdin = async () => JSON.parse(await new Promise((resolve) => {
  let value = "";
  process.stdin.on("data", (chunk) => {
    value += chunk;
  }).on("end", () => resolve(value));
}));
async function admin(word, body) {
  const response = await fetch(`${process.env.ASH_URL}/api/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.ASH_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "service:admin", kind: "request", word, body, wait: true, client_id: randomUUID() })
  });
  if (!response.ok) throw new Error(`local ${word}: HTTP ${response.status}`);
  const reply = (await response.json()).reply?.body;
  if (reply?.ok !== true) throw new Error(`local ${word} was not accepted`);
  return reply.result;
}
async function pair(name) {
  if (!process.env.GATEWAY_TICKET) throw new Error("GATEWAY_TICKET is required");
  const key = await DeviceKey.generate();
  const gateway = new GatewayClient(GW, key);
  const request = await gateway.requestPairing(process.env.GATEWAY_TICKET, name);
  let pending;
  for (let attempt = 0; attempt < 40 && !pending; attempt++) {
    pending = (await admin("gateway.state", {}))?.pending?.find((item) => item.request_id === request.request_id);
    if (!pending) await sleep(500);
  }
  if (!pending) throw new Error("pairing request not seen by owner");
  await admin("gateway.op", { op: "approve", request_id: pending.request_id, permissions: ["chat", "web_ui"] });
  await gateway.waitForApproval(request.request_id, request.owner_key);
  return { id: key.id, jwk: await key.exportJwk() };
}
async function cookieFor(pairing) {
  const key = await DeviceKey.fromJwk(pairing.jwk);
  const session = await new GatewayClient(GW, key).authenticate();
  return `ash_session=${session.token}`;
}
async function* frames(response) {
  if (!response.ok || !response.body) throw new Error(`stream HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const lines = buffer.slice(0, boundary).split("\n");
      buffer = buffer.slice(boundary + 2);
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (!data) continue;
      yield {
        type: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message",
        id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "",
        data: JSON.parse(data)
      };
    }
  }
}
async function latestSeq(cookie) {
  const response = await fetch(`${GW}/api/stream?follow=false&limit=1`, { headers: { cookie, accept: "text/event-stream" } });
  let last = 0;
  for await (const frame of frames(response)) if (frame.id && Number.isSafeInteger(Number(frame.id))) last = Math.max(last, Number(frame.id));
  return last;
}
async function web() {
  const pairing = await pair(`regress browser ${Date.now() % 1e5}`);
  const controller = new AbortController();
  try {
    const cookie = await cookieFor(pairing);
    const page = await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } });
    if (page.status !== 200 || !(await page.text()).includes("<title>Ash</title>")) throw new Error(`UI HTTP ${page.status}`);
    const after = await latestSeq(cookie);
    const stream = await fetch(`${GW}/api/stream?follow=true&after=${after}&label=Regression`, {
      headers: { cookie, accept: "text/event-stream" },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24e4)])
    });
    const events = frames(stream)[Symbol.asyncIterator]();
    let registration;
    while (!registration) {
      const event = await events.next();
      if (event.done) throw new Error("screen stream ended before registration");
      if (event.value.type === "screen.registered") registration = event.value.data;
    }
    if (!registration?.token || !registration?.screen || registration.local_management !== false) throw new Error("bad remote screen registration");
    const sent = await fetch(`${GW}/api/send`, {
      method: "POST",
      headers: { cookie, origin: new URL(GW).origin, "content-type": "application/json", "Ash-Screen": registration.token },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "\u53EA\u56DE\u590D\u4E24\u4E2A\u5B57\uFF1A\u6536\u5230" }, client_id: randomUUID() })
    });
    if (!sent.ok) throw new Error(`remote send HTTP ${sent.status}`);
    const id = (await sent.json()).id;
    if (!id) throw new Error("remote message not accepted");
    let turn = "", answer = "", ended;
    while (!ended) {
      const event = await events.next();
      if (event.done) throw new Error("screen stream ended before reply");
      const row = event.value.data;
      if (row.word === "turn.start" && row.body?.ids?.includes(id)) turn = row.body.turn;
      if (turn && row.turn === turn && row.from === "agent:main" && row.to === "person:owner" && row.word === "say") answer += row.body?.text ?? "";
      if (turn && row.word === "turn.end" && row.body?.turn === turn) ended = row;
    }
    if (!answer) throw new Error(`remote turn ended without answer (${ended.body?.reason})`);
    console.log(`    streamed answer: ${answer.slice(0, 80)} (screen: ${registration.screen})`);
  } finally {
    controller.abort();
    await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` }).catch(() => {
    });
  }
}
if (cmd === "web") await web();
else if (cmd === "pair") console.log(JSON.stringify(await pair(`regress offline ${Date.now() % 1e5}`)));
else if (cmd === "status") {
  const pairing = await stdin();
  const cookie = await cookieFor(pairing).catch(() => "");
  console.log((await fetch(`${GW}/`, { headers: { cookie, accept: "text/html" } })).status);
} else if (cmd === "unpair") {
  const pairing = await stdin();
  await admin("gateway.op", { op: "revoke", device: `device:${pairing.id}` });
} else {
  console.error("usage: regress-remote.mjs web|pair|status|unpair");
  process.exitCode = 1;
}
