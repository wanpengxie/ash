import { Link, type Signer } from "../../../device/src/link";
import { RemoteAgents } from "../../../device/src/agents/remote";
export { ClientLink, fileSigner, type LocalCapabilities, type Signer } from "../../../device/src/link";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Connection, GatewayError } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, type Permission, PERMISSIONS, randomToken, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult } from "../../../sdk/src/api";
import { isWordEffect } from "../../../sdk/src/words";
import { DeviceMember } from "../members/device";
import type { EdgeCaller, EdgeResponse, EdgeRouter } from "../server";
import type { DeviceCapability } from "../world/router";

/** A paired device's own name, safe to show inside owner-facing labels. */
function deviceLabel(name: unknown): string {
  return String(name ?? "").replace(/[\p{C}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 40) || "另一台设备";
}

/**
 * Capabilities a paired device lends. Only a read-only claim (risk none) is honoured; any other claim, or
 * none at all, is structure risk. The owner writes every label, naming the device and the capability.
 */
export function borrowedCapabilities(raw: unknown[], deviceName: unknown): DeviceCapability[] {
  const device = deviceLabel(deviceName);
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid remote capability");
    const cap = value as DeviceCapability;
    if (typeof cap.name !== "string" || !cap.name.trim() || typeof cap.description !== "string" || !cap.input_schema || typeof cap.input_schema !== "object")
      throw new TypeError("invalid remote capability");
    const name = cap.name.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, 80);
    // A lent effect is believed only when it is not a read: another device can never make a call look harmless.
    const effect = cap.risk === "none" ? "read" as const : isWordEffect(cap.effect) && cap.effect !== "read" ? cap.effect : "write" as const;
    return { ...cap, risk: cap.risk === "none" ? "none" as const : "structure" as const, effect, label: `在${device}上用 ${name}` };
  });
}

interface Inbound { method: string; path: string; headers: [string, string][]; body: Uint8Array[]; from?: string }
interface Outbound { device: string; status: number; chunks: Uint8Array[]; end: (error?: string) => void }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why the gateway cannot be used, in a fixed vocabulary the owner's screen explains. Only `unreachable` is retried;
 * the others need the owner (a new claim secret, a reset gateway, a newer gateway).
 */
export type GatewayProblem = "claimed_by_other" | "bad_secret" | "missing_secret" | "unsupported" | "unreachable";
class GatewayRefused extends Error { constructor(readonly problem: GatewayProblem, message: string) { super(message); } }
export function gatewayProblem(error: unknown): GatewayProblem {
  if (error instanceof GatewayRefused) return error.problem;
  if (error instanceof GatewayError) {
    if (error.code === "bad_mac") return "bad_secret";
    if (error.code === "already_claimed") return "claimed_by_other";
  }
  if (error instanceof Error && /unsupported gateway protocol/i.test(error.message)) return "unsupported";
  return "unreachable";
}

export interface PendingPairing { request_id: string; client_id: string; name: string; pubkey: string; fingerprint: string; at: number }

/** The owner tunnel forwards only authenticated web_ui devices to the v2 edge. */
export class OwnerLink extends Link {
  private readonly incoming = new Map<string, Inbound>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly remoteDevices = new Map<string, { member: DeviceMember; manifest: string; details: { protocol?: string; version?: string; agents?: unknown[]; workdir?: string } }>();
  private deviceName: (id: string, fallback: string) => string = (_id, fallback) => fallback;
  private agentsAllowed: (id: string) => boolean = () => false;
  setDeviceManagement(name: (id: string, fallback: string) => string, agentsAllowed: (id: string) => boolean): void {
    this.deviceName = name; this.agentsAllowed = agentsAllowed;
  }
  private readonly agentChannels = new Map<string, { peer: RemoteAgents; connection?: Connection; stream?: import("ash-gateway/client/client").DeviceStream }>();
  /** Every paired, unrevoked device as the gateway lists it (browsers included), for listing and revoking. */
  private paired: { id: string; name: string; permissions: string[]; online: boolean }[] = [];
  private readonly streams = new Map<string, { end: () => void; from: string }>();
  private serving = false;
  private ready = false;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncTail: Promise<void> = Promise.resolve();
  private epoch = 0;
  readonly pending = new Map<string, PendingPairing>();
  /** Set while claiming fails; a refusal other than `unreachable` stops the link until the owner changes the gateway. */
  problem: GatewayProblem | null = null;
  private readonly halted = new AbortController();
  constructor(url: string, signer: Signer, private readonly edge: EdgeRouter, log: (...args: unknown[]) => void) { super(url, signer, log); }
  enable(): void { this.serving = true; }

  /**
   * Claim the gateway when needed, then stay connected. Never throws: ash runs without the gateway, an unreachable one is
   * tried again with backoff, and a refusal is kept in `problem` for the owner to see.
   */
  async start(secretFile: string, name: string): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      try { await this.claimIfNeeded(secretFile, name); this.problem = null; this.lastError = ""; break; }
      catch (error) {
        this.problem = gatewayProblem(error); this.lastError = error instanceof Error ? error.message : String(error);
        this.log("gateway unavailable", this.problem, this.lastError);
        if (this.problem !== "unreachable") return;
        try { await pause(delay * (0.5 + Math.random() / 2), undefined, { signal: this.halted.signal }); } catch { return; }
        delay = Math.min(delay * 2, 60_000);
      }
    }
    if (!this.stopped) await this.run().catch((error) => this.log("gateway link stopped", error));
  }

  /** Bounded: true once devices and grants are current, false as soon as the gateway is known to be unavailable. */
  async waitConnected(timeoutMs = 30_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.ready && !this.problem && !this.lastError && !this.stopped && Date.now() < until) await sleep(50);
    return this.ready;
  }

  async claimIfNeeded(secretFile: string, name: string): Promise<void> {
    const health = await this.gateway.health();
    if (health.protocol !== undefined && health.protocol !== "ash-gw/1") throw new GatewayRefused("unsupported", "Unsupported gateway protocol");
    if (health.claimed === true) {
      if (health.owner_id !== this.signer.id) throw new GatewayRefused("claimed_by_other", "gateway is claimed by a different owner device");
      return;
    }
    if (health.claimed !== false) throw new Error("gateway claim status unavailable");
    if (!existsSync(secretFile)) throw new GatewayRefused("missing_secret", "gateway is unclaimed and no bootstrap secret is saved");
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
  /** Internal entry point: AgentSystem must check local_agents permission before calling this. */
  openAgentChannel(member: string, handlers: ConstructorParameters<typeof RemoteAgents>[0]): RemoteAgents {
    const id = member.replace(/^device:/, "");
    const device = this.paired.find(d => d.id === id);
    if (!device?.online || !device.permissions.includes("expose_capability") || !this.agentsAllowed(`device:${id}`)) throw new Error("device offline or local agents not authorized");
    const existing = this.agentChannels.get(id); if (existing) return existing.peer;
    const entry = { peer: new RemoteAgents({ ...handlers, manifestChanged: () => { handlers.manifestChanged?.(); void this.refreshDevices().catch(() => {}); } }) };
    this.agentChannels.set(id, entry); this.connectAgentChannel(id); return entry.peer;
  }
  closeAgentChannel(member: string): void {
    const id = member.replace(/^device:/, "");
    this.agentChannels.get(id)?.peer.close(); this.agentChannels.delete(id);
  }
  private connectAgentChannel(id: string): void {
    const entry = this.agentChannels.get(id), conn = this.conn;
    if (!entry || !conn || entry.stream) return;
    const stream = conn.openStream(id);
    entry.connection = conn; entry.stream = stream;
    stream.onClose(() => { if (entry.stream === stream) entry.stream = undefined; });
    entry.peer.attach(stream);
  }
  override stop(): void {
    for (const entry of this.agentChannels.values()) entry.peer.close();
    this.agentChannels.clear(); this.halted.abort(); super.stop();
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
    if (frame.from !== item.device) return;
    if (frame.op === "http.head") item.status = Number(frame.status);
    else if (frame.op === "http.body") {
      item.chunks.push(fromB64u(String(frame.data)));
      if (item.chunks.reduce((n, b) => n + b.byteLength, 0) > 8 * 1024 * 1024) {
        this.send({ t: "tun", op: "http.abort", sid: frame.sid, to: item.device }); item.end("remote response exceeds 8 MiB");
      }
    }
    else if (frame.op === "http.end") item.end();
    else if (frame.op === "http.error") item.end(String(frame.message ?? "tunnel error"));
  }

  /** One authenticated gateway exchange with an exposed, paired client. */
  private requestDevice(to: string, method: string, path: string, body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
    if (!this.conn || !this.connected || signal?.aborted) return Promise.reject(new Error("device offline or call cancelled"));
    const sid = randomToken(12);
    return new Promise((resolve, reject) => {
      let settled = false;
      const item: Outbound = { device: to, status: 0, chunks: [], end: (error) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.outbound.delete(sid);
        if (error) reject(new Error(error));
        else resolve({ status: item.status, body: Buffer.concat(item.chunks) });
      } };
      const cancel = (reason: string) => { this.send({ t: "tun", op: "http.abort", sid, to }); item.end(reason); };
      const timer = setTimeout(() => cancel("device timeout"), timeoutMs);
      const abort = () => cancel("cancelled");
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
    this.paired = list.filter((item) => typeof item.id === "string" && /^[A-Za-z0-9_-]+$/.test(item.id) && !item.revoked)
      .map((item) => ({ id: item.id, name: this.deviceName(`device:${item.id}`, String(item.name ?? item.id)), permissions: Array.isArray(item.permissions) ? item.permissions.map(String) : [], online: Boolean(item.online) }));
    for (const id of this.agentChannels.keys()) {
      const item = this.paired.find(device => device.id === id);
      if (!item?.permissions.includes("expose_capability")) this.closeAgentChannel(id);
      else if (item.online) this.connectAgentChannel(id);
    }
    const seen = new Set<string>();
    for (const item of list) {
      if (epoch !== this.epoch || this.conn !== conn || !this.connected) return;
      if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.id)) continue;
      const memberId = `device:${item.id}`;
      item.name = this.deviceName(memberId, String(item.name ?? item.id));
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
        const raw = JSON.parse(response.body.toString("utf8")) as { name?: unknown; capabilities?: unknown; protocol?: string; version?: string; agents?: unknown[]; workdir?: string };
        if (!raw || !Array.isArray(raw.capabilities) || typeof raw.name !== "string" || !raw.name.trim()) throw new TypeError("invalid remote manifest");
        if (raw.protocol && raw.protocol !== "ash-dev/1") throw new Error("Device protocol needs updating");
        const capabilities = borrowedCapabilities(raw.capabilities, item.name);
        const details = { protocol: raw.protocol, version: raw.version, agents: raw.agents, workdir: raw.workdir };
        const manifest = JSON.stringify({ name: item.name, capabilities, details });
        if (previous?.manifest === manifest) { previous.member.setOnline(true); continue; }
        const member = new DeviceMember(memberId, item.name, capabilities, async (message, context) => {
          try {
            const called = await this.requestDevice(item.id, "POST", "/ash/call", { capability: message.word, args: message.body, caller: message.from }, 150_000, context.signal);
            if (called.status !== 200) throw new Error("remote device returned an HTTP error");
            const answer = JSON.parse(called.body.toString("utf8")) as CallResult;
            if (!answer || typeof answer.ok !== "boolean") throw new Error("invalid remote result");
            return answer.ok ? { ok: true, result: { content: answer.content, ...(answer.data === undefined ? {} : { data: answer.data }) } }
              : { ok: false, error: { code: "failed", message: answer.error ?? "remote call failed", detail: { content: answer.content, data: answer.data } } };
          } catch (e) {
            const message = e instanceof Error ? e.message : "remote device unavailable";
            return { ok: false, error: { code: /offline/.test(message) ? "offline" : /timeout/.test(message) ? "timeout" : /cancelled/.test(message) ? "cancelled" : "failed", message } };
          }
        });
        this.edge.members.replaceDevice(member);
        this.remoteDevices.set(item.id, { member, manifest, details });
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
  async setWebUi(member: string, allow: boolean): Promise<void> {
    const id = member.replace(/^device:/, ""), conn = this.requireConnection();
    const list = await conn.request({ op: "device.list" });
    const item = (list.devices as { id: string; revoked: boolean; permissions: Permission[] }[]).find(d => d.id === id && !d.revoked);
    if (!item) throw new Error("unknown device");
    const permissions: Permission[] = item.permissions.filter(p => p !== "web_ui" && p !== "chat");
    if (allow) permissions.push("web_ui", "chat");
    await this.gateway.permissions(conn, id, permissions, Number(list.grant_version) + 1);
    await this.revalidateStreams(); await this.refreshDevices();
  }
  /** The owner-facing reason the gateway is not usable now, or undefined while connected. */
  private error(): GatewayProblem | undefined {
    if (this.problem) return this.problem;
    return this.connected || !this.lastError ? undefined : gatewayProblem(new Error(this.lastError));
  }
  state(): Record<string, unknown> { return { connected: this.connected, error: this.error(),
    pending: [...this.pending.values()],
    devices: this.paired.map((item) => ({ id: `device:${item.id}`, name: item.name, online: this.remoteDevices.get(item.id)?.member.online ?? item.online,
      permissions: item.permissions, lends: this.remoteDevices.has(item.id), capabilities: this.remoteDevices.get(item.id)?.member.capabilities().length ?? 0,
      capability_specs: this.remoteDevices.get(item.id)?.member.capabilities().map(c => ({ word: c.name, effect: c.effect, label: c.label })) ?? [],
      ...this.remoteDevices.get(item.id)?.details })) }; }
  async updateDevice(member: string, version: string, sha256: string): Promise<unknown> {
    const id = member.replace(/^device:/, "");
    if (!this.paired.some(item => item.id === id && item.online && item.permissions.includes("expose_capability"))) throw new Error("Device offline or revoked");
    const response = await this.requestDevice(id, "POST", "/ash/update", { version, sha256 }, 180_000);
    const result = JSON.parse(response.body.toString("utf8"));
    if (response.status !== 200 || !result.ok) throw new Error(String(result.error ?? "Device update failed"));
    return result.result;
  }
}
