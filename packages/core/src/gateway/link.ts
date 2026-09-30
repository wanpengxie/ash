// The gateway link: how this ash core reaches the rest of the owner's world through the
// self-hosted ash gateway (Cloudflare Worker + Durable Object, see the ash-gateway repo).
//
// Owner role (the phone that runs the agents):
//   - claims the gateway once, then keeps an authenticated WebSocket open;
//   - paired devices become members (`device:<gateway id>`); devices granted expose_capability
//     publish a capability manifest, and calls to them travel through the tunnel;
//   - the owner's browsers (web_ui) reach the ash UI and SDK through the tunnel; the gateway
//     authenticates them, ash sees them as the calling device;
//   - pairing (tickets, approvals, revocation) is signed with the owner key.
// Client role (a laptop lending capabilities):
//   - pairs once with a code from the phone, then answers /ash/manifest and /ash/call.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, DeviceKey, GatewayClient, GatewayError } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, type Permission, PERMISSIONS, randomToken, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult, CapabilitySpec, DeviceInfo, DeviceKind } from "../../../sdk/src/api";
import { AshApiError } from "../../../sdk/src/api";
import type { Core } from "../core";
import type { DeviceProvider } from "../devices";
import type { Res, Router } from "../server";

/** A device identity. The phone keeps its key in the Android Keystore (the host signs); laptops use a key file. */
export interface Signer {
  readonly id: string;
  readonly publicKey: string;
  sign(data: Uint8Array): Promise<string>;
}

export async function fileSigner(stateDir: string): Promise<Signer> {
  const file = join(stateDir, "device.jwk");
  if (existsSync(file)) return DeviceKey.fromJwk(JSON.parse(readFileSync(file, "utf8")));
  const key = await DeviceKey.generate();
  writeFileSync(file, JSON.stringify(await key.exportJwk()), { mode: 0o600 });
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Inbound {
  method: string;
  path: string;
  headers: [string, string][];
  body: Uint8Array[];
  from?: string;
}

interface Outbound {
  head(status: number, headers: [string, string][]): void;
  data(b: Uint8Array): void;
  end(err?: string): void;
}

/** Shared connection plumbing for both roles: auth, reconnect with backoff, keepalive. */
abstract class Link {
  protected conn: Connection | null = null;
  connected = false;
  lastError = "";
  private stopped = false;
  protected readonly gw: GatewayClient;

  constructor(
    readonly url: string,
    readonly signer: Signer,
    protected readonly log: (...a: unknown[]) => void,
  ) {
    this.gw = new GatewayClient(url, signer as unknown as DeviceKey);
  }

  protected send(frame: Record<string, unknown>): void {
    const c = this.conn;
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(frame));
  }

  protected abstract onFrame(f: Record<string, unknown>): void;
  protected abstract onConnected(conn: Connection): Promise<void>;
  protected onDisconnected(): void {}

  async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try {
        const conn = await this.gw.connect(await this.gw.authenticate());
        this.conn = conn;
        this.connected = true;
        this.lastError = "";
        delay = 1000;
        conn.onUnmatched = (f) => this.onFrame(f);
        // Liveness: the gateway answers "ping" with "pong" (and relays traffic). A connection that
        // stays silent for 90 s is half-open (network change, NAT timeout): drop it and reconnect.
        let lastHeard = Date.now();
        let giveUp: (v: { code: number; reason: string }) => void = () => {};
        const silent = new Promise<{ code: number; reason: string }>((r) => (giveUp = r));
        conn.ws.addEventListener("message", () => (lastHeard = Date.now()));
        const keepalive = setInterval(() => {
          if (conn.ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastHeard > 90_000) {
            this.log("gateway connection silent for 90 s; reconnecting");
            try {
              conn.ws.close(4000, "silent");
            } catch {
              /* already closing */
            }
            // A half-open socket may never finish its close handshake: do not wait for it.
            giveUp({ code: 4000, reason: "silent" });
            return;
          }
          conn.ws.send("ping");
        }, 30_000);
        await this.onConnected(conn).catch((e) => this.log("gateway: after-connect step failed:", e instanceof Error ? e.message : e));
        const closed = await Promise.race([conn.closed, silent]);
        clearInterval(keepalive);
        this.log("gateway connection closed", closed.code, closed.reason);
        if (closed.code === 4003) this.lastError = "revoked by the owner";
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log("gateway connection failed:", this.lastError);
      }
      this.connected = false;
      this.conn = null;
      this.onDisconnected();
      if (this.stopped) break;
      await sleep(delay * (0.5 + Math.random() / 2));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
  }

  /** Stream a router reply back over the tunnel as http.head / http.body* / http.end. */
  protected reply(sid: string, r: Res, extra: Record<string, unknown> = {}, onClose?: (fn: () => void) => void): void {
    const headers = Object.entries(r.headers ?? {}).filter(([k]) => !/^(set-cookie|content-length|content-encoding|transfer-encoding|connection)$/i.test(k));
    this.send({ t: "tun", op: "http.head", sid, status: r.status, headers, ...extra });
    const chunk = (b: Uint8Array) => {
      for (let i = 0; i < b.length; i += LIMITS.tunnelChunkBytes) this.send({ t: "tun", op: "http.body", sid, data: b64u(new Uint8Array(b.subarray(i, i + LIMITS.tunnelChunkBytes))), ...extra });
    };
    if ("stream" in r) {
      let closed = false;
      const closers: (() => void)[] = [];
      const end = () => {
        if (closed) return;
        closed = true;
        for (const f of closers) f();
        this.send({ t: "tun", op: "http.end", sid, ...extra });
      };
      // Tunneled streams end after a while; the UI reconnects with Last-Event-ID and misses nothing.
      const limit = setTimeout(end, 4 * 60_000);
      closers.push(() => clearTimeout(limit));
      onClose?.(end);
      r.stream(
        (s) => !closed && chunk(Buffer.from(s)),
        (fn) => closers.push(fn),
      );
      return;
    }
    if (r.body !== undefined) chunk(typeof r.body === "string" ? Buffer.from(r.body) : r.body);
    this.send({ t: "tun", op: "http.end", sid, ...extra });
  }
}

// ------------------------------------------------------------------ owner

export interface PendingPairing {
  request_id: string;
  client_id: string;
  name: string;
  pubkey: string;
  fingerprint: string;
  at: number;
}

export class OwnerLink extends Link {
  private readonly inbound = new Map<string, Inbound>();
  private readonly streams = new Map<string, () => void>();
  private readonly outbound = new Map<string, Outbound>();
  readonly pending = new Map<string, PendingPairing>();
  private sync: ReturnType<typeof setInterval> | null = null;
  fingerprint = "";

  constructor(
    url: string,
    signer: Signer,
    private readonly core: Core,
    private readonly router: Router,
    log: (...a: unknown[]) => void,
    private readonly onPairingRequest?: (p: PendingPairing) => void,
  ) {
    super(url, signer, log);
  }

  /** One-time claim with the deployment's BOOTSTRAP_SECRET, retried until the gateway answers. */
  async claimIfNeeded(secretFile: string, name: string): Promise<void> {
    this.fingerprint = await shortFingerprint(this.signer.publicKey);
    for (;;) {
      try {
        const h = await this.gw.health();
        if (h.claimed) {
          if (h.owner_id !== this.signer.id) throw new Error(`gateway is owned by another device (${String(h.owner_id)}); reset it from the Cloudflare dashboard (RESET_EPOCH)`);
          return;
        }
        if (!existsSync(secretFile)) throw new Error("gateway is unclaimed: enter its BOOTSTRAP_SECRET in ash settings");
        const r = await this.gw.claim(readFileSync(secretFile, "utf8").trim(), name);
        unlinkSync(secretFile);
        this.log("claimed the gateway as owner", r.owner_id, r.fingerprint);
        return;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log("gateway claim/health:", this.lastError);
        await sleep(15_000);
      }
    }
  }

  protected async onConnected(conn: Connection): Promise<void> {
    this.log("connected to gateway as owner", this.signer.id);
    const pend = await conn.request({ op: "pair.pending" }).catch(() => null);
    for (const r of (pend?.requests as Record<string, string>[] | undefined) ?? []) await this.addPending(r);
    await this.syncDevices();
    this.sync = setInterval(() => void this.syncDevices().catch(() => {}), 30_000);
  }

  protected onDisconnected(): void {
    if (this.sync) clearInterval(this.sync);
    this.sync = null;
    for (const close of this.streams.values()) close();
    this.streams.clear();
    this.inbound.clear();
    for (const o of this.outbound.values()) o.end("device_offline");
    this.outbound.clear();
    for (const d of this.core.devices.list()) if (d.via === "gateway") this.core.devices.setOnline(d.id, false);
  }

  private async addPending(r: Record<string, string>): Promise<void> {
    const p: PendingPairing = { request_id: r.request_id, client_id: r.client_id, name: r.name, pubkey: r.pubkey, fingerprint: await shortFingerprint(r.pubkey), at: Date.now() };
    const fresh = !this.pending.has(p.request_id);
    this.pending.set(p.request_id, p);
    if (fresh) this.onPairingRequest?.(p);
  }

  protected onFrame(f: Record<string, unknown>): void {
    if (f.t === "tun" && typeof f.sid === "string" && this.outbound.has(f.sid)) return this.onOutbound(f);
    if (f.t === "gw") {
      if (f.op === "pair.request") void this.addPending(f as Record<string, string>);
      if (f.op === "device.presence") void this.syncDevices().catch(() => {});
      return;
    }
    if (f.t !== "tun") return;
    const sid = String(f.sid);
    switch (f.op) {
      case "http.req":
        this.inbound.set(sid, { method: String(f.method), path: String(f.path), headers: (f.headers as [string, string][]) ?? [], body: [], from: typeof f.from === "string" ? f.from : undefined });
        return;
      case "http.reqbody":
        this.inbound.get(sid)?.body.push(fromB64u(String(f.data)));
        return;
      case "http.reqend": {
        const req = this.inbound.get(sid);
        this.inbound.delete(sid);
        if (req) void this.serve(sid, req).catch((e) => this.send({ t: "tun", op: "http.error", sid, message: String(e?.message ?? e) }));
        return;
      }
      case "http.abort":
        this.streams.get(sid)?.();
        this.streams.delete(sid);
        return;
      case "ws.open":
        // The ash UI needs no WebSockets (it streams with Server-Sent Events).
        this.send({ t: "tun", op: "ws.error", sid, message: "websockets are not served by ash" });
        return;
    }
  }

  /** A request from one of the owner's browsers, through the gateway (which checked web_ui). */
  private async serve(sid: string, req: Inbound): Promise<void> {
    if (!req.from) return this.reply(sid, { status: 403, body: "no caller" });
    const member = `device:${req.from}`;
    if (!this.core.devices.get(member)) await this.syncDevices();
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k.toLowerCase()] = v;
    const res = await this.router.handle({ method: req.method, url: new URL(req.path, "http://ash"), headers, body: req.body.length ? Buffer.concat(req.body) : null }, { member, local: false });
    this.reply(sid, res, {}, (end) => this.streams.set(sid, end));
  }

  private onOutbound(f: Record<string, unknown>): void {
    const o = this.outbound.get(String(f.sid))!;
    switch (f.op) {
      case "http.head":
        return o.head(Number(f.status), (f.headers as [string, string][]) ?? []);
      case "http.body":
        return o.data(fromB64u(String(f.data)));
      case "http.end":
        this.outbound.delete(String(f.sid));
        return o.end();
      case "http.error":
        this.outbound.delete(String(f.sid));
        return o.end(String(f.message ?? "tunnel error"));
    }
  }

  /** One HTTP exchange with a paired device through the gateway. */
  request(to: string, method: string, path: string, body: unknown, timeoutMs = 150_000, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
    if (!this.conn) return Promise.reject(new Error("not connected to the gateway"));
    const sid = randomToken(12);
    return new Promise((resolve, reject) => {
      let status = 0;
      const chunks: Uint8Array[] = [];
      const timer = setTimeout(() => this.outbound.get(sid)?.end("device did not answer in time"), timeoutMs);
      const abort = () => this.outbound.get(sid)?.end("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      this.outbound.set(sid, {
        head: (s) => (status = s),
        data: (b) => chunks.push(b),
        end: (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          this.outbound.delete(sid);
          if (err) reject(new Error(err === "device_offline" ? "device is offline" : err));
          else resolve({ status, body: Buffer.concat(chunks) });
        },
      });
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      this.send({ t: "tun", op: "http.req", sid, to, method, path, headers: data ? [["content-type", "application/json"]] : [] });
      if (data) for (let i = 0; i < data.length; i += LIMITS.tunnelChunkBytes) this.send({ t: "tun", op: "http.reqbody", sid, to, data: b64u(new Uint8Array(data.subarray(i, i + LIMITS.tunnelChunkBytes))) });
      this.send({ t: "tun", op: "http.reqend", sid, to });
    });
  }

  /** Mirror the gateway's device list into ash members; fetch manifests of devices that expose capabilities. */
  async syncDevices(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const list = (await conn.request({ op: "device.list" })).devices as { id: string; name: string; permissions: string[]; revoked: boolean; online: boolean }[];
    const seen = new Set<string>();
    for (const d of list) {
      const id = `device:${d.id}`;
      if (d.revoked) {
        this.core.devices.remove(id);
        continue;
      }
      seen.add(id);
      const exposes = d.permissions.includes("expose_capability");
      const prev = this.core.devices.get(id);
      const kind: DeviceKind = exposes ? "laptop" : d.permissions.includes("web_ui") ? "browser" : "other";
      let capabilities: CapabilitySpec[] = prev?.capabilities ?? [];
      if (exposes && d.online && (!prev?.online || !capabilities.length)) {
        try {
          const r = await this.request(d.id, "GET", "/ash/manifest", undefined, 20_000);
          const m = JSON.parse(r.body.toString("utf8")) as { capabilities?: CapabilitySpec[]; kind?: DeviceKind };
          capabilities = Array.isArray(m.capabilities) ? m.capabilities : [];
        } catch (e) {
          this.log(`gateway: manifest of ${d.name} failed:`, e instanceof Error ? e.message : e);
        }
      }
      const info: DeviceInfo = { id, name: d.name, kind, online: d.online, via: "gateway", permissions: d.permissions, capabilities: exposes ? capabilities : [] };
      this.core.devices.upsert(info, exposes ? this.provider(d.id) : null);
    }
    for (const d of this.core.devices.list()) if (d.via === "gateway" && !seen.has(d.id)) this.core.devices.remove(d.id);
  }

  private provider(gatewayId: string): DeviceProvider {
    return {
      call: async (capability, args, ctx) => {
        const r = await this.request(gatewayId, "POST", "/ash/call", { capability, args, caller: ctx.caller }, 150_000, ctx.signal);
        try {
          return JSON.parse(r.body.toString("utf8")) as CallResult;
        } catch {
          return { ok: false, content: [{ type: "text", text: `device answered ${r.status}` }], error: `http_${r.status}` };
        }
      },
    };
  }

  // ---------------------------------------------------------------- owner operations (local UI)

  private requireConn(): Connection {
    if (!this.conn) throw new AshApiError(503, "offline", "not connected to the gateway");
    return this.conn;
  }

  private async nextGrant(): Promise<number> {
    return Number((await this.requireConn().request({ op: "device.list" })).grant_version) + 1;
  }

  async ticket(): Promise<{ ticket: string; expires_in: number; gateway: string }> {
    return { ticket: await this.gw.createPairTicket(this.requireConn()), expires_in: 300, gateway: this.gw.origin };
  }

  async approve(requestId: string, permissions: Permission[]): Promise<void> {
    const r = this.pending.get(requestId);
    if (!r) throw new AshApiError(404, "unknown_request", "no such pending request");
    const perms = permissions.filter((p) => (PERMISSIONS as readonly string[]).includes(p));
    await this.gw.approve(this.requireConn(), r, perms, await this.nextGrant()).catch(rethrow);
    this.pending.delete(requestId);
    await this.syncDevices();
  }

  async reject(requestId: string): Promise<void> {
    await this.requireConn().request({ op: "pair.reject", request_id: requestId }).catch(rethrow);
    this.pending.delete(requestId);
  }

  async revoke(member: string): Promise<void> {
    const clientId = member.replace(/^device:/, "");
    await this.gw.revoke(this.requireConn(), clientId, await this.nextGrant()).catch(rethrow);
    this.core.devices.remove(`device:${clientId}`);
  }

  state(): Record<string, unknown> {
    return {
      configured: true,
      role: "owner",
      gateway: this.gw.origin,
      connected: this.connected,
      error: this.lastError || undefined,
      owner_id: this.signer.id,
      fingerprint: this.fingerprint,
      pending: [...this.pending.values()],
      devices: this.core.devices.list().filter((d) => d.via === "gateway"),
    };
  }
}

function rethrow(e: unknown): never {
  if (e instanceof GatewayError) throw new AshApiError(e.status || 502, e.code, e.message);
  throw e;
}

// ------------------------------------------------------------------ client

export interface LocalCapabilities {
  manifest(): Promise<{ name: string; kind: DeviceKind; capabilities: CapabilitySpec[] }>;
  call(capability: string, args: Record<string, unknown>, caller: string): Promise<CallResult>;
}

export class ClientLink extends Link {
  private readonly reqs = new Map<string, Inbound>();

  constructor(
    url: string,
    signer: Signer,
    private readonly local: LocalCapabilities,
    log: (...a: unknown[]) => void,
  ) {
    super(url, signer, log);
  }

  /** Pair once with the code from the phone; the owner's approval is verified against the pinned owner key. */
  async pair(stateDir: string, code: string | undefined, name: string): Promise<void> {
    const pairedFile = join(stateDir, "paired.json");
    if (existsSync(pairedFile)) return;
    if (!code) throw new Error("not paired yet: run once with --pair <code from the phone>");
    const fp = await shortFingerprint(this.signer.publicKey);
    const pr = await this.gw.requestPairing(code, name);
    this.log(`pairing requested. Confirm on the phone: this device ${fp}, phone ${pr.owner_fingerprint}`);
    const grant = await this.gw.waitForApproval(pr.request_id, pr.owner_key, 10 * 60_000);
    writeFileSync(pairedFile, JSON.stringify({ owner_key: pr.owner_key, ...grant }), { mode: 0o600 });
    this.log("paired with permissions", grant.permissions.join(", "));
    if (!grant.permissions.includes("expose_capability")) this.log("note: the phone did not grant expose_capability, so its agents cannot call this device");
  }

  protected async onConnected(): Promise<void> {
    const m = await this.local.manifest();
    this.log(`connected to gateway as ${this.signer.id}; offering ${m.capabilities.length} capabilities`);
  }

  protected onFrame(f: Record<string, unknown>): void {
    if (f.t !== "tun") return;
    const sid = String(f.sid);
    if (f.op === "http.req") this.reqs.set(sid, { method: String(f.method), path: String(f.path), headers: (f.headers as [string, string][]) ?? [], body: [] });
    else if (f.op === "http.reqbody") this.reqs.get(sid)?.body.push(fromB64u(String(f.data)));
    else if (f.op === "http.reqend") {
      const req = this.reqs.get(sid);
      this.reqs.delete(sid);
      if (req) void this.serve(sid, req).catch((e) => this.send({ t: "tun", op: "http.error", sid, message: String(e?.message ?? e) }));
    }
  }

  private async serve(sid: string, req: Inbound): Promise<void> {
    const json = (status: number, body: unknown): Res => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const path = req.path.split("?")[0];
    if (req.method === "GET" && path === "/ash/manifest") return this.reply(sid, json(200, await this.local.manifest()));
    if (req.method === "POST" && path === "/ash/call") {
      const b = JSON.parse(Buffer.concat(req.body).toString("utf8") || "{}") as { capability?: string; args?: Record<string, unknown>; caller?: string };
      return this.reply(sid, json(200, await this.local.call(String(b.capability ?? ""), b.args ?? {}, String(b.caller ?? "unknown"))));
    }
    this.reply(sid, json(404, { error: "not_found" }));
  }
}
