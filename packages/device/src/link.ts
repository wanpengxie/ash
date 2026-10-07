import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, DeviceKey, GatewayClient, GatewayError } from "ash-gateway/client/client";
import { b64u, fromB64u, LIMITS, shortFingerprint } from "ash-gateway/src/protocol";
import type { CallResult, CapabilitySpec, DeviceKind } from "../../sdk/src/api";
export interface Signer { readonly id: string; readonly publicKey: string; sign(data: Uint8Array): Promise<string> }


export type TunnelResponse = { status: number; headers?: Record<string, string>; body?: string | Buffer } |
  { status: number; headers?: Record<string, string>; stream: (write: (chunk: string) => void, onClose: (fn: () => void) => void, end: () => void) => void };
type EdgeResponse = TunnelResponse;
interface Inbound { method: string; path: string; headers: [string, string][]; body: Uint8Array[]; from?: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function fileSigner(stateDir: string): Promise<Signer> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "device.jwk");
  if (existsSync(file)) return DeviceKey.fromJwk(JSON.parse(readFileSync(file, "utf8")));
  const key = await DeviceKey.generate();
  writeFileSync(file, JSON.stringify(await key.exportJwk()), { mode: 0o600 });
  return key;
}


export abstract class Link {
  protected conn: Connection | null = null;
  protected readonly gateway: GatewayClient;
  protected stopped = false;
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
  protected onRevoked(): void {}
  async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        const health = await this.gateway.health();
        if (health.protocol !== "ash-gw/1") { this.stopped = true; throw new Error("Unsupported gateway protocol"); }
        const conn = await this.gateway.connect(await this.gateway.authenticate());
        this.conn = conn; this.connected = true; this.lastError = ""; delay = 1000;
        conn.onUnmatched = (frame) => this.onFrame(frame);
        let lastHeard = Date.now();
        let expired!: () => void;
        const silent = new Promise<void>((resolve) => { expired = resolve; });
        conn.ws.addEventListener("message", () => { lastHeard = Date.now(); });
        beat = setInterval(() => {
          if (conn.ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastHeard > 90_000) { conn.ws.close(4000, "silent"); expired(); }
          else conn.ws.send("ping");
        }, 30_000);
        await this.onConnected(conn);
        const closed = await Promise.race([conn.closed, silent]);
        if (closed && closed.code === 4003) { this.stopped = true; this.lastError = "Device revoked"; this.onRevoked(); }
      } catch (error) {
        this.conn?.close(); this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof GatewayError && /revoked/i.test(error.message)) { this.stopped = true; this.onRevoked(); }
        this.log("gateway connection failed", this.lastError);
      } finally { if (beat) clearInterval(beat); }
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


export interface LocalCapabilities {
  manifest(): Promise<{ protocol?: string; version?: string; name: string; kind: DeviceKind; capabilities: CapabilitySpec[]; agents?: unknown[] }>;
  call(capability: string, args: Record<string, unknown>, caller: string, signal?: AbortSignal): Promise<CallResult>;
  stream?(stream: import("ash-gateway/client/client").DeviceStream): void;
  update?(version: string, sha256: string): Promise<unknown>;
}

/** Client role retains the existing gateway manifest/call protocol. */
export class ClientLink extends Link {
  private readonly incoming = new Map<string, Inbound>();
  private readonly calls = new Map<string, AbortController>();
  private pairFile?: string;
  protected override async onConnected(conn: Connection): Promise<void> {
    conn.onStream(stream => this.local.stream ? this.local.stream(stream) : stream.close(4404, "Device agents unavailable"));
  }
  protected override onDisconnected(): void {
    this.incoming.clear();
    for (const call of this.calls.values()) call.abort();
    this.calls.clear();
  }
  protected override onRevoked(): void {
    if (this.pairFile && existsSync(this.pairFile)) {
      const old = JSON.parse(readFileSync(this.pairFile, "utf8"));
      writeFileSync(this.pairFile, JSON.stringify({ ...old, revoked: true }), { mode: 0o600 });
    }
  }
  constructor(url: string, signer: Signer, private readonly local: LocalCapabilities, log: (...args: unknown[]) => void) { super(url, signer, log); }
  async pair(stateDir: string, code: string | undefined, name: string): Promise<void> {
    const file = join(stateDir, "paired.json");
    this.pairFile = file;
    if (existsSync(file) && !code) {
      if (JSON.parse(readFileSync(file, "utf8")).revoked) throw new Error("Device revoked; explicitly pair again to reconnect");
      return;
    }
    if (!code) throw new Error("not paired: use --pair once");
    const request = await this.gateway.requestPairing(code, name);
    this.log("pairing requested", await shortFingerprint(this.signer.publicKey), request.owner_fingerprint);
    const grant = await this.gateway.waitForApproval(request.request_id, request.owner_key, 10 * 60_000);
    writeFileSync(file, JSON.stringify({ owner_key: request.owner_key, ...grant }), { mode: 0o600 });
  }
  protected onFrame(frame: Record<string, unknown>): void {
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "http.abort") { this.incoming.delete(sid); this.calls.get(sid)?.abort(); return; }
    if (frame.op === "http.req") this.incoming.set(sid, { method: String(frame.method), path: String(frame.path), headers: (frame.headers as [string, string][]) ?? [], body: [] });
    else if (frame.op === "http.reqbody") {
      const inbound = this.incoming.get(sid);
      if (inbound) {
        inbound.body.push(fromB64u(String(frame.data)));
        if (inbound.body.reduce((n, b) => n + b.byteLength, 0) > 8 * 1024 * 1024) {
          this.incoming.delete(sid); this.reply(sid, { status: 413, body: "Request too large" });
        }
      }
    }
    else if (frame.op === "http.reqend") {
      const inbound = this.incoming.get(sid); this.incoming.delete(sid);
      if (inbound) {
        const controller = new AbortController(); this.calls.set(sid, controller);
        void this.serve(sid, inbound, controller.signal)
          .catch((error) => { if (!controller.signal.aborted) this.send({ t: "tun", op: "http.error", sid, message: error instanceof Error ? error.message : "client failed" }); })
          .finally(() => this.calls.delete(sid));
      }
    }
  }
  private async serve(sid: string, inbound: Inbound, signal: AbortSignal): Promise<void> {
    const path = inbound.path.split("?")[0];
    const json = (status: number, body: unknown): EdgeResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (inbound.method === "POST" && path === "/ash/update") {
      const input = JSON.parse(Buffer.concat(inbound.body).toString("utf8") || "{}");
      if (!this.local.update || typeof input.version !== "string" || !/^v?\d+\.\d+\.\d+$/.test(input.version) || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) return this.reply(sid, json(400, { ok: false, error: "Invalid approved update" }));
      try { return this.reply(sid, json(200, { ok: true, result: await this.local.update(input.version, input.sha256) })); }
      catch (error) { return this.reply(sid, json(409, { ok: false, error: error instanceof Error ? error.message : "Update failed" })); }
    }
    if (inbound.method === "GET" && path === "/ash/manifest") {
      const manifest = await this.local.manifest();
      return this.reply(sid, json(200, { ...manifest, capabilities: manifest.capabilities.map((capability) => ({
        ...capability, risk: capability.risk === "none" ? "none" : "structure", label: `Use ${capability.name}`,
      })) }));
    }
    if (inbound.method === "POST" && path === "/ash/call") {
      const input = JSON.parse(Buffer.concat(inbound.body).toString("utf8") || "{}") as { capability?: string; args?: Record<string, unknown>; caller?: string };
      if (typeof input.caller !== "string" || !/^(agent:[a-z][a-z0-9_-]{0,31}|person:owner)$/.test(input.caller)) return this.reply(sid, json(403, { error: "Invalid caller" }));
      const answer = await this.local.call(String(input.capability ?? ""), input.args ?? {}, input.caller, signal);
      if (!signal.aborted) this.reply(sid, json(200, answer));
      return;
    }
    this.reply(sid, json(404, { error: "not_found" }));
  }
}
