import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, DeviceKey, GatewayClient } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, type Permission, PERMISSIONS, randomToken, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult, CapabilitySpec, DeviceKind } from "../../../sdk/src/api";
import { DeviceMember } from "../members/device";
import type { EdgeCaller, EdgeResponse, EdgeRouter } from "../server";
import type { DeviceCapability } from "../world/router";

export interface Signer { readonly id: string; readonly publicKey: string; sign(data: Uint8Array): Promise<string> }

export async function fileSigner(stateDir: string): Promise<Signer> {
  const file = join(stateDir, "device.jwk");
  if (existsSync(file)) return DeviceKey.fromJwk(JSON.parse(readFileSync(file, "utf8")));
  const key = await DeviceKey.generate();
  writeFileSync(file, JSON.stringify(await key.exportJwk()), { mode: 0o600 });
  return key;
}

interface Inbound { method: string; path: string; headers: [string, string][]; body: Uint8Array[]; from?: string }
interface Outbound { status: number; chunks: Uint8Array[]; end: (error?: string) => void }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

abstract class Link {
  protected conn: Connection | null = null;
  protected readonly gateway: GatewayClient;
  private stopped = false;
  connected = false;
  lastError = "";
  constructor(url: string, readonly signer: Signer, protected readonly log: (...args: unknown[]) => void) {
    this.gateway = new GatewayClient(url, signer as unknown as DeviceKey);
  }
  protected send(frame: Record<string, unknown>): void {
    if (this.conn?.ws.readyState === WebSocket.OPEN) this.conn.ws.send(JSON.stringify(frame));
  }
  protected abstract onFrame(frame: Record<string, unknown>): void;
  protected async onConnected(_conn: Connection): Promise<void> {}
  protected onDisconnected(): void {}
  async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try {
        const conn = await this.gateway.connect(await this.gateway.authenticate());
        this.conn = conn; this.connected = true; this.lastError = ""; delay = 1000;
        conn.onUnmatched = (frame) => this.onFrame(frame);
        let lastHeard = Date.now();
        let expired!: () => void;
        const silent = new Promise<void>((resolve) => { expired = resolve; });
        conn.ws.addEventListener("message", () => { lastHeard = Date.now(); });
        const beat = setInterval(() => {
          if (conn.ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastHeard > 90_000) { conn.ws.close(4000, "silent"); expired(); }
          else conn.ws.send("ping");
        }, 30_000);
        await this.onConnected(conn);
        await Promise.race([conn.closed, silent]);
        clearInterval(beat);
      } catch (error) { this.conn?.close(); this.lastError = error instanceof Error ? error.message : String(error); this.log("gateway connection failed", this.lastError); }
      this.connected = false; this.conn = null; this.onDisconnected();
      if (this.stopped) break;
      await sleep(delay * (0.5 + Math.random() / 2)); delay = Math.min(delay * 2, 30_000);
    }
  }
  stop(): void { this.stopped = true; this.conn?.close(); }
  protected reply(sid: string, result: EdgeResponse, onStream?: (end: () => void) => () => void): void {
    const headers = Object.entries(result.headers ?? {}).filter(([name]) => !/^(set-cookie|content-length|content-encoding|transfer-encoding|connection)$/i.test(name));
    this.send({ t: "tun", op: "http.head", sid, status: result.status, headers });
    const data = (value: Uint8Array) => {
      for (let i = 0; i < value.length; i += LIMITS.tunnelChunkBytes) this.send({ t: "tun", op: "http.body", sid, data: b64u(new Uint8Array(value.subarray(i, i + LIMITS.tunnelChunkBytes))) });
    };
    if ("stream" in result) {
      let ended = false; const cleanups: (() => void)[] = [];
      const end = () => { if (ended) return; ended = true; for (const cleanup of cleanups) cleanup(); this.send({ t: "tun", op: "http.end", sid }); };
      const timeout = setTimeout(end, 4 * 60_000);
      cleanups.push(() => clearTimeout(timeout));
      const unregister = onStream?.(end);
      if (unregister) cleanups.push(unregister);
      result.stream((chunk) => { if (!ended) data(Buffer.from(chunk)); }, (cleanup) => cleanups.push(cleanup), end);
      return;
    }
    if (result.body !== undefined) data(typeof result.body === "string" ? Buffer.from(result.body) : result.body);
    this.send({ t: "tun", op: "http.end", sid });
  }
}

export interface PendingPairing { request_id: string; client_id: string; name: string; pubkey: string; fingerprint: string; at: number }

/** The owner tunnel forwards only authenticated web_ui devices to the v2 edge. */
export class OwnerLink extends Link {
  private readonly incoming = new Map<string, Inbound>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly remoteDevices = new Map<string, { member: DeviceMember; manifest: string }>();
  private readonly streams = new Map<string, { end: () => void; from: string }>();
  private serving = false;
  private ready = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();
  private epoch = 0;
  readonly pending = new Map<string, PendingPairing>();
  constructor(url: string, signer: Signer, private readonly edge: EdgeRouter, log: (...args: unknown[]) => void) { super(url, signer, log); }
  enable(): void { this.serving = true; }

  async waitConnected(timeoutMs = 30_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (!this.ready && Date.now() < until) await sleep(50);
    if (!this.ready) throw new Error("gateway devices and grants unavailable during authorization recovery");
  }

  async claimIfNeeded(secretFile: string, name: string): Promise<void> {
    const health = await this.gateway.health();
    if (health.claimed === true) {
      if (health.owner_id !== this.signer.id) throw new Error("gateway is claimed by a different owner device");
      return;
    }
    if (health.claimed !== false || !existsSync(secretFile)) throw new Error("gateway claim status unavailable or bootstrap secret missing");
    const result = await this.gateway.claim(readFileSync(secretFile, "utf8").trim(), name);
    unlinkSync(secretFile);
    this.log("gateway claimed", result.owner_id);
  }

  protected async onConnected(conn: Connection): Promise<void> {
    const epoch = ++this.epoch;
    const pending = await conn.request({ op: "pair.pending" }).catch(() => null);
    if (epoch !== this.epoch || this.conn !== conn) return;
    for (const item of (pending?.requests as Record<string, string>[] | undefined) ?? []) await this.addPending(item);
    await this.refreshDevices();
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    this.ready = true;
    this.syncTimer = setInterval(() => void this.refreshDevices().catch(() => {}), 30_000);
  }
  protected onDisconnected(): void {
    this.epoch++;
    this.ready = false;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear(); this.incoming.clear();
    for (const pending of this.outbound.values()) pending.end("device_offline");
    this.outbound.clear();
    for (const entry of this.remoteDevices.values()) entry.member.setOnline(false);
  }
  private async addPending(raw: Record<string, string>): Promise<void> {
    const item: PendingPairing = { request_id: raw.request_id, client_id: raw.client_id, name: raw.name, pubkey: raw.pubkey, fingerprint: await shortFingerprint(raw.pubkey), at: Date.now() };
    this.pending.set(item.request_id, item);
  }
  protected onFrame(frame: Record<string, unknown>): void {
    if (frame.t === "tun" && typeof frame.sid === "string" && this.outbound.has(frame.sid)) { this.onOutbound(frame); return; }
    if (frame.t === "gw") {
      if (frame.op === "pair.request") void this.addPending(frame as Record<string, string>);
      if (frame.op === "device.presence") { void this.revalidateStreams(); void this.refreshDevices().catch(() => {}); }
      return;
    }
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "http.req") this.incoming.set(sid, { method: String(frame.method), path: String(frame.path), headers: (frame.headers as [string, string][]) ?? [], body: [], from: typeof frame.from === "string" ? frame.from : undefined });
    else if (frame.op === "http.reqbody") this.incoming.get(sid)?.body.push(fromB64u(String(frame.data)));
    else if (frame.op === "http.reqend") {
      const inbound = this.incoming.get(sid); this.incoming.delete(sid);
      if (inbound) void this.serve(sid, inbound).catch((error) => this.send({ t: "tun", op: "http.error", sid, message: error instanceof Error ? error.message : "tunnel failed" }));
    } else if (frame.op === "http.abort") { this.streams.get(sid)?.end(); this.streams.delete(sid); }
  }

  private onOutbound(frame: Record<string, unknown>): void {
    const item = this.outbound.get(String(frame.sid))!;
    if (frame.op === "http.head") item.status = Number(frame.status);
    else if (frame.op === "http.body") item.chunks.push(fromB64u(String(frame.data)));
    else if (frame.op === "http.end") item.end();
    else if (frame.op === "http.error") item.end(String(frame.message ?? "tunnel error"));
  }

  /** One authenticated gateway exchange with an exposed, paired client. */
  private requestDevice(to: string, method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
    if (!this.conn || !this.connected || signal?.aborted) return Promise.reject(new Error("device offline or call cancelled"));
    const sid = randomToken(12);
    return new Promise((resolve, reject) => {
      const item: Outbound = { status: 0, chunks: [], end: (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.outbound.delete(sid);
        if (error) reject(new Error(error));
        else resolve({ status: item.status, body: Buffer.concat(item.chunks) });
      } };
      const timer = setTimeout(() => item.end("device timeout"), timeoutMs);
      const abort = () => item.end("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      this.outbound.set(sid, item);
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      this.send({ t: "tun", op: "http.req", sid, to, method, path, headers: data ? [["content-type", "application/json"]] : [] });
      if (data) for (let offset = 0; offset < data.length; offset += LIMITS.tunnelChunkBytes)
        this.send({ t: "tun", op: "http.reqbody", sid, to, data: b64u(new Uint8Array(data.subarray(offset, offset + LIMITS.tunnelChunkBytes))) });
      this.send({ t: "tun", op: "http.reqend", sid, to });
    });
  }

  /** Every presence/grant change queues a fresh list; no update is discarded behind an older sync. */
  refreshDevices(): Promise<void> {
    const epoch = this.epoch;
    const task = this.syncTail.catch(() => {}).then(() => this.syncDevicesOnce(epoch));
    this.syncTail = task;
    return task;
  }

  private async syncDevicesOnce(epoch: number): Promise<void> {
    const conn = this.conn;
    if (!conn || epoch !== this.epoch || !this.connected) return;
    const result = await conn.request({ op: "device.list" });
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    const list = result.devices as { id: string; name: string; permissions: string[]; revoked: boolean; online: boolean }[];
    if (!Array.isArray(list)) throw new Error("gateway device list unavailable");
    const seen = new Set<string>();
    for (const item of list) {
      if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
      if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)) continue;
      const memberId = `device:${item.id}`;
      if (item.revoked || !item.permissions?.includes("expose_capability")) {
        this.edge.members.removeDevice(memberId);
        this.remoteDevices.delete(item.id);
        continue;
      }
      seen.add(item.id);
      const previous = this.remoteDevices.get(item.id);
      if (!item.online) { previous?.member.setOnline(false); continue; }
      try {
        const response = await this.requestDevice(item.id, "GET", "/ash/manifest", undefined, 20_000);
        if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
        if (response.status !== 200) throw new Error("remote manifest unavailable");
        const raw = JSON.parse(response.body.toString("utf8")) as { name?: unknown; capabilities?: unknown };
        if (!raw || !Array.isArray(raw.capabilities) || typeof raw.name !== "string" || !raw.name.trim()) throw new TypeError("invalid remote manifest");
        const capabilities: DeviceCapability[] = raw.capabilities.map((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid remote capability");
          const cap = value as DeviceCapability;
          if (!["none", "outward", "structure"].includes(cap.risk) || typeof cap.label !== "string" || !cap.label.trim()) throw new TypeError("remote capability lacks risk or label");
          // Device claims cannot downgrade owner approval risk; MCP hints are not authority.
          return { ...cap, risk: "structure" as const, label: `Use ${cap.name}` };
        });
        const manifest = JSON.stringify({ name: item.name, capabilities });
        if (previous?.manifest === manifest) { previous.member.setOnline(true); continue; }
        const member = new DeviceMember(memberId, item.name, capabilities, async (message, context) => {
          try {
            const called = await this.requestDevice(item.id, "POST", "/ash/call", { capability: message.word, args: message.body, caller: message.from }, 150_000, context.signal);
            if (called.status !== 200) throw new Error("remote device returned an HTTP error");
            const answer = JSON.parse(called.body.toString("utf8")) as CallResult;
            if (!answer || typeof answer.ok !== "boolean") throw new Error("invalid remote result");
            return answer.ok ? { ok: true, result: { content: answer.content, ...(answer.data === undefined ? {} : { data: answer.data }) } }
              : { ok: false, error: { code: "failed", message: answer.error ?? "remote call failed" } };
          } catch { return { ok: false, error: { code: "offline", message: "remote device unavailable" } }; }
        });
        this.edge.members.replaceDevice(member);
        this.remoteDevices.set(item.id, { member, manifest });
      } catch { if (epoch === this.epoch && this.conn === conn && this.connected) previous?.member.setOnline(false); }
    }
    if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
    for (const id of this.remoteDevices.keys()) if (!seen.has(id)) {
      this.edge.members.removeDevice(`device:${id}`);
      this.remoteDevices.delete(id);
    }
  }

  private async revalidateStreams(): Promise<void> {
    for (const stream of this.streams.values()) {
      try { if (!await this.isBrowserAuthorized(stream.from)) stream.end(); }
      catch { stream.end(); }
    }
  }

  async isBrowserAuthorized(id: string): Promise<boolean> {
    if (!this.conn) return false;
    const list = await this.conn.request({ op: "device.list" });
    const devices = list.devices as { id: string; revoked?: boolean; permissions: string[] }[];
    return devices.some((device) => device.id === id && !device.revoked && device.permissions.includes("web_ui"));
  }
  private async serve(sid: string, inbound: Inbound): Promise<void> {
    if (!this.serving) { this.reply(sid, { status: 503, body: JSON.stringify({ error: "offline", message: "owner edge starting" }) }); return; }
    if (!inbound.from || !await this.isBrowserAuthorized(inbound.from)) {
      this.reply(sid, { status: 403, body: JSON.stringify({ error: "forbidden", message: "web UI permission required" }) });
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of inbound.headers) headers[name.toLowerCase()] = value;
    const caller: EdgeCaller = { member: "person:owner", transportPrincipal: `gateway:${inbound.from}`, pairedDeviceId: inbound.from, local: false, remote: true, ownerProxy: true, transport: "web_ui" };
    const result = await this.edge.handle({ method: inbound.method, url: new URL(inbound.path, "http://ash"), headers, body: inbound.body.length ? Buffer.concat(inbound.body) : null }, caller);
    this.reply(sid, result, (end) => { this.streams.set(sid, { end, from: inbound.from! }); return () => this.streams.delete(sid); });
  }
  private requireConnection(): Connection { if (!this.conn) throw new Error("gateway offline"); return this.conn; }
  async ticket(): Promise<{ ticket: string; expires_in: number; gateway: string }> { return { ticket: await this.gateway.createPairTicket(this.requireConnection()), expires_in: 300, gateway: this.gateway.origin }; }
  async approve(requestId: string, permissions: Permission[]): Promise<void> {
    const item = this.pending.get(requestId); if (!item) throw new Error("unknown pairing request");
    const list = await this.requireConnection().request({ op: "device.list" });
    const version = Number(list.grant_version) + 1;
    const safe = permissions.filter((permission) => (PERMISSIONS as readonly string[]).includes(permission));
    await this.gateway.approve(this.requireConnection(), item, safe, version);
    this.pending.delete(requestId);
  }
  async reject(requestId: string): Promise<void> { await this.requireConnection().request({ op: "pair.reject", request_id: requestId }); this.pending.delete(requestId); }
  async revoke(member: string): Promise<void> {
    const list = await this.requireConnection().request({ op: "device.list" });
    await this.gateway.revoke(this.requireConnection(), member.replace(/^device:/, ""), Number(list.grant_version) + 1);
  }
  state(): Record<string, unknown> { return { connected: this.connected, error: this.lastError || undefined, pending: [...this.pending.values()] }; }
}

export interface LocalCapabilities {
  manifest(): Promise<{ name: string; kind: DeviceKind; capabilities: CapabilitySpec[] }>;
  call(capability: string, args: Record<string, unknown>, caller: string): Promise<CallResult>;
}

/** Client role retains the existing gateway manifest/call protocol. */
export class ClientLink extends Link {
  private readonly incoming = new Map<string, Inbound>();
  constructor(url: string, signer: Signer, private readonly local: LocalCapabilities, log: (...args: unknown[]) => void) { super(url, signer, log); }
  async pair(stateDir: string, code: string | undefined, name: string): Promise<void> {
    const file = join(stateDir, "paired.json");
    if (existsSync(file)) return;
    if (!code) throw new Error("not paired: use --pair once");
    const request = await this.gateway.requestPairing(code, name);
    this.log("pairing requested", await shortFingerprint(this.signer.publicKey), request.owner_fingerprint);
    const grant = await this.gateway.waitForApproval(request.request_id, request.owner_key, 10 * 60_000);
    writeFileSync(file, JSON.stringify({ owner_key: request.owner_key, ...grant }), { mode: 0o600 });
  }
  protected onFrame(frame: Record<string, unknown>): void {
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "http.req") this.incoming.set(sid, { method: String(frame.method), path: String(frame.path), headers: (frame.headers as [string, string][]) ?? [], body: [] });
    else if (frame.op === "http.reqbody") this.incoming.get(sid)?.body.push(fromB64u(String(frame.data)));
    else if (frame.op === "http.reqend") {
      const inbound = this.incoming.get(sid); this.incoming.delete(sid);
      if (inbound) void this.serve(sid, inbound).catch((error) => this.send({ t: "tun", op: "http.error", sid, message: error instanceof Error ? error.message : "client failed" }));
    }
  }
  private async serve(sid: string, inbound: Inbound): Promise<void> {
    const path = inbound.path.split("?")[0];
    const json = (status: number, body: unknown): EdgeResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (inbound.method === "GET" && path === "/ash/manifest") {
      const manifest = await this.local.manifest();
      return this.reply(sid, json(200, { ...manifest, capabilities: manifest.capabilities.map((capability) => ({
        ...capability, risk: "structure", label: `Use ${capability.name}`,
      })) }));
    }
    if (inbound.method === "POST" && path === "/ash/call") {
      const input = JSON.parse(Buffer.concat(inbound.body).toString("utf8") || "{}") as { capability?: string; args?: Record<string, unknown>; caller?: string };
      return this.reply(sid, json(200, await this.local.call(String(input.capability ?? ""), input.args ?? {}, String(input.caller ?? "unknown"))));
    }
    this.reply(sid, json(404, { error: "not_found" }));
  }
}
