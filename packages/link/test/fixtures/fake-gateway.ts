/**
 * A relay for tests: the owner's side of `ash-gw/1` as `ash-gateway/client` speaks it (health, claim, sign-in, the owner's
 * WebSocket with its control ops), with tunnels to "devices" and browsers that the test drives. It checks what the real relay
 * checks that matters here: the claim secret and the owner's signature, `expose_capability` and the `/link` path for device
 * streams. It never leaves the machine.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { ctx, deviceIdForKey, hmacSha256, verifySignature } from "ash-gateway/src/protocol";
import type { Connector } from "../../src/hand";
import type { RawSocket } from "../../src/socket";

type Frame = Record<string, unknown>;

export interface FakeDevice { id: string; name: string; permissions: string[]; online: boolean; revoked: boolean }

/** One end of a tunnel stream, as the device (or the browser) holds it. */
export class Endpoint {
  readonly received: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  opened = false;
  private readonly early: string[] = [];
  private readonly onMsg: ((text: string) => void)[] = [];
  private readonly onEnd: ((code: number, reason: string) => void)[] = [];
  constructor(private readonly out: { send(text: string): void; close(code: number, reason: string): void }) {}
  send(text: string): void { if (!this.closedWith) this.out.send(text); }
  close(code = 1000, reason = ""): void { if (this.closedWith) return; this.closedWith = { code, reason }; this.out.close(code, reason); for (const cb of this.onEnd) cb(code, reason); }
  /** For the fake itself. */
  deliver(text: string): void { this.received.push(text); if (this.onMsg.length) for (const cb of this.onMsg) cb(text); else this.early.push(text); }
  end(code: number, reason: string): void { if (this.closedWith) return; this.closedWith = { code, reason }; for (const cb of this.onEnd) cb(code, reason); }
  /** Messages that came before anyone listened (a hand starts its connection a moment after the tunnel opens) are held for the first listener. */
  onMessage(cb: (text: string) => void): void { this.onMsg.push(cb); for (const text of this.early.splice(0)) cb(text); }
  onClose(cb: (code: number, reason: string) => void): void { this.onEnd.push(cb); if (this.closedWith) cb(this.closedWith.code, this.closedWith.reason); }
}

/** A hand connector over an endpoint: the hand speaks `ash-link/1` through the tunnel. */
export const connectorOver = (endpoint: Endpoint): Connector => (_url, _headers, events): RawSocket => {
  endpoint.onClose((code, reason) => events.close(code, reason));
  // The hand reads its first frame only once it has the socket in hand: what came earlier is delivered then.
  queueMicrotask(() => { events.open(); endpoint.onMessage((text) => events.message(text, false)); });
  return { send: (data) => endpoint.send(data), close: (code, reason) => endpoint.close(code ?? 1000, reason ?? ""), terminate: () => endpoint.close(1006, "terminated") };
};

export class FakeGateway {
  onMaterial?: (frame:Record<string,unknown>)=>void;
  sendMaterial(frame:Record<string,unknown>):void { this.toOwner(frame); }
  readonly url: string;
  /** The claim secret the deployed relay was given. */
  secret: string | null;
  ownerKey: string | null = null;
  ownerId: string | null = null;
  readonly devices = new Map<string, FakeDevice>();
  /** Every control op the owner sent, in order. */
  readonly ops: Frame[] = [];
  grantVersion = 0;
  requests: Frame[] = [];
  readonly tickets: string[] = [];
  /** Called with each tunnel a device is asked to take. */
  onDeviceStream: ((deviceId: string, endpoint: Endpoint, sid: string) => void) | null = null;
  /** Streams the owner opened, by sid. */
  readonly streams = new Map<string, { device: string; endpoint: Endpoint }>();
  readonly browsers = new Map<string, Endpoint>();
  owner: WebSocket | null = null;
  ownerConnections = 0;
  private readonly challenges = new Map<string, string>();
  private readonly tokens = new Set<string>();

  private constructor(private readonly http: Server, private readonly wss: WebSocketServer, port: number, secret: string | null) {
    this.url = `http://127.0.0.1:${port}`;
    this.secret = secret;
  }

  static async start(o: { secret?: string | null; claimedBy?: { id: string; key: string } } = {}): Promise<FakeGateway> {
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true, handleProtocols: () => "ash.v1" });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const gw = new FakeGateway(http, wss, (http.address() as AddressInfo).port, o.secret === undefined ? randomBytes(12).toString("base64url") : o.secret);
    if (o.claimedBy) { gw.ownerId = o.claimedBy.id; gw.ownerKey = o.claimedBy.key; }
    http.on("request", (req, res) => void gw.route(req, res));
    http.on("upgrade", (req, socket, head) => {
      const token = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim()).find((s) => s.startsWith("ash.bearer."))?.slice("ash.bearer.".length);
      if (req.url !== "/v1/ws" || !token || !gw.tokens.has(token)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => gw.attach(ws));
    });
    return gw;
  }

  async stop(): Promise<void> {
    this.owner?.terminate();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  get claimed(): boolean { return this.ownerId !== null; }

  // ---- HTTP ----------------------------------------------------------------------------------------------------------------

  private async route(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: Record<string, any> = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { /* empty */ }
    const reply = (status: number, data: unknown): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data)); };
    const fail = (status: number, error: string, message = error): void => reply(status, { error, message });
    const origin = this.url;
    switch (`${req.method} ${req.url}`) {
      case "GET /v1/health": return reply(200, { ok: true, protocol: "ash-gw/1", claimed: this.claimed, ...(this.ownerId ? { owner_id: this.ownerId } : {}) });
      case "POST /v1/bootstrap/challenge": {
        if (!this.secret) return fail(503, "bootstrap_not_configured");
        const nonce = randomBytes(16).toString("base64url"); this.challenges.set(nonce, "bootstrap"); return reply(200, { nonce });
      }
      case "POST /v1/bootstrap/claim": {
        if (this.claimed) return fail(409, "already_claimed");
        if (!this.secret || this.challenges.get(body.nonce) !== "bootstrap") return fail(400, "bad_nonce");
        this.challenges.delete(body.nonce);
        const data = ctx.bootstrapClaim(origin, body.nonce, body.owner_key);
        if (body.mac !== await hmacSha256(this.secret, data)) return fail(401, "bad_mac");
        if (!(await verifySignature(body.owner_key, body.sig, data))) return fail(401, "bad_signature");
        this.ownerKey = body.owner_key;
        this.ownerId = await deviceIdForKey(body.owner_key);
        return reply(200, { owner_id: this.ownerId, fingerprint: "FAKE" });
      }
      case "POST /v1/auth/challenge": {
        const nonce = randomBytes(16).toString("base64url"); this.challenges.set(nonce, String(body.device_id)); return reply(200, { nonce });
      }
      case "POST /v1/auth/session": {
        if (!this.ownerKey || this.challenges.get(body.nonce) !== body.device_id || body.device_id !== this.ownerId) return fail(401, "unauthorized");
        this.challenges.delete(body.nonce);
        if (!(await verifySignature(this.ownerKey, body.sig, ctx.auth(origin, body.device_id, body.nonce)))) return fail(401, "bad_signature");
        const token = randomBytes(24).toString("base64url"); this.tokens.add(token);
        return reply(200, { token, expires_at: Date.now() + 900_000, device_id: body.device_id, role: "owner" });
      }
      default: return fail(404, "not_found");
    }
  }

  // ---- the owner's WebSocket ---------------------------------------------------------------------------------------------

  private attach(ws: WebSocket): void {
    this.owner = ws;
    this.ownerConnections++;
    ws.send(JSON.stringify({ t: "gw", op: "hello", device_id: this.ownerId, role: "owner", owner_id: this.ownerId, owner_online: true }));
    ws.on("message", (data) => void this.onOwner(ws, String(data)));
    ws.on("close", () => { if (this.owner === ws) this.owner = null; });
  }

  private toOwner(frame: Frame): void { this.owner?.send(JSON.stringify(frame)); }

  private async onOwner(ws: WebSocket, text: string): Promise<void> {
    if (text === "ping") return void ws.send("pong");
    let f: Frame;
    try { f = JSON.parse(text); } catch { return; }
    if (f.v === 1 && typeof f.type === "string" && f.type.startsWith("ash.material.")) { this.onMaterial?.(f); return; }
    if (f.t === "tun") return this.onTunnel(f);
    if (f.t !== "gw") return;
    this.ops.push(f);
    const ok = (op: string, extra: Frame = {}) => ws.send(JSON.stringify({ t: "gw", op, ref: f.id, ...extra }));
    switch (f.op) {
      case "device.list": return ok("device.list.ok", { grant_version: this.grantVersion, devices: [...this.devices.values()].map((d) => ({ ...d, grant_version: this.grantVersion, created_at: 0 })) });
      case "pair.pending": return ok("pair.pending.ok", { requests: this.requests });
      case "pair.ticket": this.tickets.push(String(f.ticket_hash)); return ok("pair.ticket.ok");
      case "pair.reject": this.requests = this.requests.filter((r) => r.request_id !== f.request_id); return ok("pair.reject.ok");
      case "pair.approve": {
        const request = this.requests.find((r) => r.request_id === f.request_id);
        if (!request || Number(f.grant_version) <= this.grantVersion) return ws.send(JSON.stringify({ t: "gw", op: "error", ref: f.id, code: request ? "stale_grant" : "unknown_request", message: "no" }));
        this.grantVersion = Number(f.grant_version);
        this.devices.set(String(request.client_id), { id: String(request.client_id), name: String(request.name), permissions: f.permissions as string[], online: false, revoked: false });
        this.requests = this.requests.filter((r) => r !== request);
        return ok("pair.approve.ok");
      }
      case "device.permissions": {
        const d = this.devices.get(String(f.client_id));
        if (!d || Number(f.grant_version) <= this.grantVersion) return ws.send(JSON.stringify({ t: "gw", op: "error", ref: f.id, code: "stale_grant", message: "no" }));
        this.grantVersion = Number(f.grant_version);
        d.permissions = f.permissions as string[];
        this.closeStreams(d.id, 4001, "permissions changed");
        return ok("device.permissions.ok", { client_id: d.id });
      }
      case "device.revoke": {
        const d = this.devices.get(String(f.client_id));
        if (!d) return;
        this.grantVersion = Number(f.grant_version);
        d.revoked = true;
        this.closeStreams(d.id, 4003, "revoked");
        return ok("device.revoke.ok", { client_id: d.id });
      }
    }
  }

  private closeStreams(device: string, code: number, reason: string): void {
    for (const [sid, s] of [...this.streams]) if (s.device === device) { this.streams.delete(sid); this.toOwner({ t: "tun", op: "ws.close", sid, from: device, code, reason }); s.endpoint.end(code, reason); }
  }

  // ---- tunnels ---------------------------------------------------------------------------------------------------------------

  private onTunnel(f: Frame): void {
    const sid = String(f.sid);
    const to = String(f.to ?? "");
    if (f.op === "ws.open") {
      const device = this.devices.get(to);
      const refuse = (reason: string) => this.toOwner({ t: "tun", op: "ws.close", sid, from: to, code: 4404, reason });
      if (f.path !== "/link") return refuse("path_not_allowed");
      if (!device || device.revoked || !device.online || !device.permissions.includes("expose_capability")) return refuse("device_offline_or_forbidden");
      for (const [old, s] of [...this.streams]) if (s.device === to) { this.streams.delete(old); this.toOwner({ t: "tun", op: "ws.close", sid: old, from: to, code: 4409, reason: "replaced" }); s.endpoint.end(4409, "replaced"); }
      const endpoint = new Endpoint({
        send: (text) => this.toOwner({ t: "tun", op: "ws.msg", sid, from: to, text }),
        close: (code, reason) => { this.streams.delete(sid); this.toOwner({ t: "tun", op: "ws.close", sid, from: to, code, reason }); },
      });
      this.streams.set(sid, { device: to, endpoint });
      endpoint.opened = true;
      this.onDeviceStream?.(to, endpoint, sid);
      return;
    }
    const stream = this.streams.get(sid);
    if (stream) {
      if (f.op === "ws.msg" && typeof f.text === "string") stream.endpoint.deliver(f.text);
      else if (f.op === "ws.close") { this.streams.delete(sid); stream.endpoint.end(Number(f.code) || 1000, String(f.reason ?? "")); }
      return;
    }
    const browser = this.browsers.get(sid);
    if (browser) {
      if (f.op === "ws.opened") browser.opened = true;
      else if (f.op === "ws.msg" && typeof f.text === "string") browser.deliver(f.text);
      else if (f.op === "ws.close") { this.browsers.delete(sid); browser.end(Number(f.code) || 1000, String(f.reason ?? "")); }
    }
  }

  // ---- what a test drives ----------------------------------------------------------------------------------------------------

  /** A device registered with the relay; tells the owner when it is online. */
  setDevice(id: string, o: Partial<Omit<FakeDevice, "id">> = {}): FakeDevice {
    const was = this.devices.get(id);
    const d: FakeDevice = { id, name: o.name ?? was?.name ?? id, permissions: o.permissions ?? was?.permissions ?? [], online: o.online ?? was?.online ?? false, revoked: o.revoked ?? was?.revoked ?? false };
    this.devices.set(id, d);
    if (was?.online !== d.online) this.toOwner({ t: "gw", op: "device.presence", device_id: id, online: d.online });
    return d;
  }

  /** A new device asks to pair. */
  pairRequest(request: { request_id: string; client_id: string; name: string; pubkey: string; ticket_hash?: string }): void {
    const frame = { ...request, fingerprint: "AAAA-BBBB-CCCC-DDDD" };
    this.requests.push(frame);
    this.toOwner({ t: "gw", op: "pair.request", ...frame });
  }

  /** A browser of device [from] asks for a WebSocket at [path]. */
  openBrowser(from: string, path: string): Endpoint {
    const sid = randomBytes(9).toString("base64url");
    const endpoint = new Endpoint({
      send: (text) => this.toOwner({ t: "tun", op: "ws.msg", sid, text, more: false }),
      close: (code, reason) => { this.browsers.delete(sid); this.toOwner({ t: "tun", op: "ws.close", sid, code, reason }); },
    });
    this.browsers.set(sid, endpoint);
    this.toOwner({ t: "tun", op: "ws.open", sid, path, from });
    return endpoint;
  }

  /** A browser's HTTP request through the tunnel, as the relay sends it (head, body pieces, end), and the owner's answer put back together. */
  browserHttp(from: string, o: { method?: string; path?: string; headers?: [string, string][]; body?: Uint8Array; abortAfterMs?: number } = {}): Promise<{ status?: number; headers?: [string, string][]; body: Buffer; ended: boolean; error?: string; bodyFrames: number }> {
    const sid = randomBytes(9).toString("base64url");
    const owner = this.owner!;
    const out = { body: Buffer.alloc(0), ended: false, bodyFrames: 0 } as { status?: number; headers?: [string, string][]; body: Buffer; ended: boolean; error?: string; bodyFrames: number };
    const done = new Promise<typeof out>((resolve) => {
      const listener = (data: unknown) => {
        const f = JSON.parse(String(data));
        if (f.t !== "tun" || f.sid !== sid) return;
        if (f.op === "http.head") { out.status = f.status; out.headers = f.headers; }
        else if (f.op === "http.body") { out.bodyFrames++; out.body = Buffer.concat([out.body, Buffer.from(f.data, "base64url")]); }
        else if (f.op === "http.end") { out.ended = true; owner.off("message", listener); resolve(out); }
        else if (f.op === "http.error") { out.error = f.message; owner.off("message", listener); resolve(out); }
      };
      owner.on("message", listener);
    });
    this.toOwner({ t: "tun", op: "http.req", sid, method: o.method ?? "GET", path: o.path ?? "/", headers: o.headers ?? [], from });
    const body = o.body ?? new Uint8Array();
    for (let i = 0; i < body.length; i += 100_000) this.toOwner({ t: "tun", op: "http.reqbody", sid, data: Buffer.from(body.subarray(i, i + 100_000)).toString("base64url") });
    if (o.abortAfterMs !== undefined) setTimeout(() => this.toOwner({ t: "tun", op: "http.abort", sid }), o.abortAfterMs);
    else this.toOwner({ t: "tun", op: "http.reqend", sid });
    return done;
  }
}
