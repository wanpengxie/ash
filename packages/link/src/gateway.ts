/**
 * Reaching the relay (SPEC-03 §8, §10): the owner's side of `ash-gw/1`, built on `ash-gateway/client`. This is the one place
 * the kernel's code meets the relay's client library (ASH-HUB §8.1 rule 2).
 *
 * The owner connects to the relay and stays connected. The relay reports which devices are online; for those the owner
 * opens a `/link` stream (a WebSocket tunnel), which the caller secures end to end before the link server takes it
 * (docs/LINK-E2E.md). The relay serves nothing of the hub's: a browser's request or stream it sends is refused.
 */
import { Connection, DeviceStream, GatewayClient, GatewayError, type DeviceKey } from "ash-gateway/client/client";
import { derToRaw, shortFingerprint, type Permission } from "ash-gateway/src/protocol";
import type { LinkSocket } from "./socket";

/** The owner's key. It signs by asking the host (the private key never leaves the keystore), so it is not a `DeviceKey` that holds one. */
export interface RelayOwner {
  /** `handId` of the public key, the same id the relay knows the owner by. */
  id: string;
  /** SPKI, base64url. */
  publicKey: string;
  /** ECDSA P-256 over [data]; base64url, DER or raw (the relay gets it raw, see [rawSignature]). */
  sign(data: Uint8Array): Promise<string>;
}

/** Why the relay cannot be used, in a fixed vocabulary. Only `unreachable` is retried; the others need the owner. */
export type RelayProblem = "claimed_by_other" | "bad_secret" | "missing_secret" | "unsupported" | "unreachable";
export class RelayError extends Error {
  constructor(readonly problem: RelayProblem, message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = "RelayError"; }
}
/**
 * The signature as 64-byte r||s (what WebCrypto verifies), whatever the keystore gave. The relay takes either form and hands the
 * owner's approval of a pairing to the paired party as it got it: a browser checks it with WebCrypto, which refuses DER (Android's
 * keystore signs DER), so a DER approval made every browser pairing end with "approval signature check failed".
 */
export function rawSignature(sig: string): string {
  const bytes = Buffer.from(sig, "base64url");
  if (bytes.length === 64) return sig;
  const raw = derToRaw(new Uint8Array(bytes));
  if (!raw) throw new Error("the owner's signature is neither raw nor DER");
  return Buffer.from(raw).toString("base64url");
}
/** True when a request to the relay got no answer (a slow or lost connection): the relay is unavailable for now, not broken. */
export const relayUnanswered = (error: unknown): boolean => error instanceof GatewayError && (error.code === "timeout" || error.code === "ws_error");
/** The relay answered and said no (`not_pending`, `stale_grant`, …): its code and words, or null for any other failure. */
export const relayRefused = (error: unknown): { code: string; message: string } | null =>
  error instanceof GatewayError && !relayUnanswered(error) ? { code: error.code, message: error.message } : null;
const problemOf = (error: unknown): RelayProblem => {
  if (error instanceof RelayError) return error.problem;
  if (error instanceof GatewayError) {
    if (error.code === "bad_mac") return "bad_secret";
    if (error.code === "already_claimed") return "claimed_by_other";
  }
  return "unreachable";
};

/**
 * What went wrong reaching the relay, told to a person (and an agent reading `gateway.status`): what happened, why it may be,
 * and what can be done. Nothing the relay or the network said goes in: a relay's answer can be a whole web page (an error page
 * of the host, a 404 of a deleted Worker), so the text is chosen by what kind of failure it was. The HTTP status, when there is
 * one, comes back beside it.
 */
export function relayErrorInfo(error: unknown): { text: string; status?: number } {
  if (error instanceof RelayError) {
    switch (error.problem) {
      case "claimed_by_other": return { text: "这个中转站已经被另一个主人认领了，这台手机进不去；可以换一个中转站，或重新部署一个自己的。" };
      case "bad_secret": return { text: "认领中转站用的密钥对不上；可以重新部署中转站，或重新填写密钥。" };
      case "missing_secret": return { text: "这个中转站还没被认领，而且手机上没有认领用的密钥；可以重新部署一个中转站。" };
      case "unsupported": return { text: "中转站和这台手机说的不是同一个版本；可以重新部署中转站，或升级 Ash。" };
      default: if (error.cause !== undefined) return relayErrorInfo(error.cause);
    }
  }
  if (error instanceof GatewayError) {
    if (error.code === "bad_mac") return { text: "认领中转站用的密钥对不上；可以重新部署中转站，或重新填写密钥。", status: error.status || undefined };
    if (error.code === "already_claimed") return { text: "这个中转站已经被另一个主人认领了，这台手机进不去；可以换一个中转站，或重新部署一个自己的。", status: error.status || undefined };
    const status = error.status;
    if (status === 404) return { status, text: "中转站地址找不到（404），可能已被删除或地址填错；可以重新部署，或换一个地址。" };
    if (status === 401 || status === 403) return { status, text: `中转站不让这台手机进（${status}），可能是密钥不对或已被别人认领；可以重新认领，或换一个中转站。` };
    if (status === 429) return { status, text: "中转站现在请求太多（429），过一会儿会自动再试。" };
    if (status >= 500) return { status, text: `中转站那边出了问题（${status}），会自动重试；一直不好的话，可以重新部署中转站。` };
    if (status >= 400) return { status, text: `中转站没有接受这次请求（${status}），地址可能不对；可以重新部署，或换一个地址。` };
    if (error.code === "timeout" || error.code === "ws_error") return { text: "连不上中转站，网络不通或太慢；会自动重试，也可以检查网络和地址。" };
  }
  if (error instanceof Error && (/timed out$/.test(error.message) || error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError)) {
    return { text: "连不上中转站，网络不通或太慢；会自动重试，也可以检查网络和地址。" };
  }
  return { text: "连接中转站没成功；会自动重试，一直不好的话，检查地址或重新部署。" };
}

/** A device as the relay lists it: its grants and whether it is connected to the relay now. */
export interface RelayDevice { id: string; name: string; permissions: string[]; online: boolean; revoked: boolean }

/** A new device asked to pair with a ticket. The relay does not say which ticket, only its hash when it can. */
export interface RelayPairRequest { request_id: string; client_id: string; name: string; pubkey: string; fingerprint: string; ticket_hash?: string }

export interface RelayHandlers {
  /** The owner's connection to the relay came up or went down. */
  connection?(connected: boolean): void;
  /** The device list was read again (after connecting, after a presence change, every [refreshMs]). */
  devices?(devices: RelayDevice[]): void;
  pairRequest?(request: RelayPairRequest): void;
}

export interface RelayOptions {
  /** Origin of the relay, e.g. `https://ash.example.workers.dev`. */
  url: string;
  owner: RelayOwner;
  /** The name the relay shows for the owner when it is claimed. */
  name?: string;
  /** The one-time claim secret, read only when the relay is unclaimed. */
  claimSecret?(): string | null;
  handlers?: RelayHandlers;
  log?(message: string, error?: unknown): void;
  /** Re-read the device list this often while connected. Default 30 s. */
  refreshMs?: number;
  /** Keepalive text to the relay. Default 30 s. */
  pingMs?: number;
  /** Reconnect backoff. Default 1 s doubling to 60 s. */
  backoff?: { initialMs: number; maxMs: number };
  /** Per request to the relay. Default 20 s. */
  timeoutMs?: number;
}

const EXPIRES_IN_S = 299;

const timeoutAfter = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
};

/** A stream as the link server's socket: text frames in, close codes out. */
function socketOf(stream: DeviceStream): LinkSocket {
  const messages = new Set<(data: string, isBinary: boolean) => void>();
  const closers = new Set<(code: number, reason: string) => void>();
  stream.onMessage((message) => { for (const listener of messages) listener(typeof message === "string" ? message : new TextDecoder().decode(message), typeof message !== "string"); });
  stream.onClose(({ code, reason }) => { for (const listener of closers) listener(code, reason); });
  return {
    send(data) { try { stream.send(data); } catch { /* the stream has ended; the close event says so */ } },
    close(code, reason) { stream.close(code ?? 1000, reason ?? ""); },
    terminate() { stream.close(1006, "terminated"); },
    on(event, listener) { (event === "message" ? messages : closers).add(listener as never); return undefined; },
  };
}

export class Relay {
  readonly url: string;
  private readonly client: GatewayClient;
  private readonly o: RelayOptions;
  private conn: Connection | null = null;
  private stopped = true;
  private ready = false;
  private claimedByOwner: boolean | null = null;
  private problemNow: RelayProblem | null = null;
  private lastErrorText: string | null = null;
  private lastErrorStatus: number | null = null;
  private list: RelayDevice[] = [];
  private readonly requests = new Map<string, RelayPairRequest>();
  private syncTail: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | null = null;

  constructor(options: RelayOptions) {
    this.o = options;
    this.url = new URL(options.url).origin;
    const { owner } = options;
    // GatewayClient only reads `id`, `publicKey` and `sign` of its key.
    this.client = new GatewayClient(this.url, { id: owner.id, publicKey: owner.publicKey, sign: async (data: Uint8Array) => rawSignature(await owner.sign(data)) } as unknown as DeviceKey);
  }

  private get timeoutMs(): number { return this.o.timeoutMs ?? 20_000; }
  private log(message: string, error?: unknown): void { this.o.log?.(message, error); }

  // ---- state -------------------------------------------------------------------------------------------------------

  /** The owner is connected to the relay and has read its devices. */
  get connected(): boolean { return this.ready && !this.stopped; }
  /** Whether this owner has claimed the relay, as last seen; null until the relay was reached. */
  get claimed(): boolean | null { return this.claimedByOwner; }
  /** Set when the relay refused in a way retrying cannot help. */
  get problem(): RelayProblem | null { return this.problemNow; }
  /** Why the last attempt failed, in words for a person ([relayErrorInfo]); null while connected. */
  get lastError(): string | null { return this.lastErrorText; }
  /** The HTTP status the relay answered with in the last failure, when it answered. */
  get lastStatus(): number | null { return this.lastErrorStatus; }
  devices(): RelayDevice[] { return this.list.map((d) => ({ ...d, permissions: [...d.permissions] })); }

  // ---- reaching the relay ----------------------------------------------------------------------------------------------

  /**
   * Reads the relay's health and claims it with the saved secret when it is unclaimed. Throws a [RelayError]: the
   * caller can tell "cannot be reached" (try again) from "someone else owns it" or "no secret to claim with".
   */
  /**
   * What would stop [ensureClaimed], without claiming: null when this owner holds the relay or could claim it now
   * (it answers, it is unclaimed and there is a claim secret). Asked before the owner is asked to approve a claim.
   */
  async check(): Promise<{ problem: RelayProblem; detail: string } | null> {
    let health: Record<string, unknown>;
    try { health = await timeoutAfter(this.client.health(), this.timeoutMs, "relay health"); }
    catch (error) { return { problem: problemOf(error), detail: error instanceof Error ? error.message : String(error) }; }
    if (health.protocol !== undefined && health.protocol !== "ash-gw/1") return { problem: "unsupported", detail: String(health.protocol) };
    if (health.claimed === true) return health.owner_id === this.o.owner.id ? null : { problem: "claimed_by_other", detail: "claimed by another owner" };
    if (health.claimed !== false) return { problem: "unreachable", detail: "the relay did not say whether it is claimed" };
    return this.o.claimSecret?.() ? null : { problem: "missing_secret", detail: "no claim secret" };
  }

  async ensureClaimed(): Promise<void> {
    let health: Record<string, unknown>;
    try { health = await timeoutAfter(this.client.health(), this.timeoutMs, "relay health"); }
    catch (error) { throw new RelayError(problemOf(error), error instanceof Error ? error.message : String(error), error); }
    if (health.protocol !== undefined && health.protocol !== "ash-gw/1") throw new RelayError("unsupported", "the relay speaks a protocol this hub does not");
    if (health.claimed === true) {
      if (health.owner_id !== this.o.owner.id) { this.claimedByOwner = false; throw new RelayError("claimed_by_other", "the relay is claimed by another owner"); }
      this.claimedByOwner = true;
      return;
    }
    if (health.claimed !== false) throw new RelayError("unreachable", "the relay did not say whether it is claimed");
    const secret = this.o.claimSecret?.();
    if (!secret) throw new RelayError("missing_secret", "the relay is not claimed and there is no claim secret to claim it with");
    try { await timeoutAfter(this.client.claim(secret, this.o.name ?? "ash"), this.timeoutMs, "relay claim"); }
    catch (error) { throw new RelayError(problemOf(error), error instanceof Error ? error.message : String(error), error); }
    this.claimedByOwner = true;
  }

  /** Connects and stays connected until [stop]; never throws. A refusal retrying cannot fix is kept in [problem] and ends the loop. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.problemNow = null;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
    this.conn?.close();
  }

  /** Drops the connection and connects again at once (the network changed). */
  reconnect(): void {
    this.wake?.();
    this.conn?.close();
  }

  async waitConnected(timeoutMs = 30_000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.ready && !this.problemNow && !this.stopped && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    return this.ready;
  }

  private async run(): Promise<void> {
    const { initialMs, maxMs } = this.o.backoff ?? { initialMs: 1000, maxMs: 60_000 };
    let delay = initialMs;
    while (!this.stopped) {
      try {
        await this.ensureClaimed();
        const session = await timeoutAfter(this.client.authenticate(), this.timeoutMs, "relay sign-in");
        const conn = await timeoutAfter(this.client.connect(session), this.timeoutMs, "relay connect");
        this.problemNow = null;
        this.lastErrorText = null; this.lastErrorStatus = null;
        await this.serve(conn);
        delay = initialMs;
      } catch (error) {
        const info = relayErrorInfo(error);
        this.lastErrorText = info.text; this.lastErrorStatus = info.status ?? null;
        this.problemNow = problemOf(error);
        this.log("relay unavailable", error);
        if (this.problemNow !== "unreachable") return;
        this.problemNow = null;
      }
      if (this.stopped) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay * (0.5 + Math.random() / 2));
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = null;
      delay = Math.min(delay * 2, maxMs);
    }
  }

  /** One connection's life: read the state, relay its events, return when it ends. */
  private async serve(conn: Connection): Promise<void> {
    this.conn = conn;
    conn.onUnmatched = (frame) => this.onFrame(conn, frame);
    const timers: ReturnType<typeof setInterval>[] = [];
    try {
      const pending = await conn.request({ op: "pair.pending" }).catch(() => null);
      for (const item of (pending?.requests as Record<string, string>[] | undefined) ?? []) await this.addRequest(item);
      await this.refreshDevices();
      if (this.conn !== conn) return;
      this.ready = true;
      this.o.handlers?.connection?.(true);
      // A connection a lossy network has left half open stays "open" and answers nothing: two unanswered device lists in a
      // row end it, and a new one is made.
      let misses = 0;
      let markDead!: () => void;
      const dead = new Promise<void>((resolve) => { markDead = resolve; });
      timers.push(setInterval(() => void this.refreshDevices().then(() => { misses = 0; }, (e) => {
        this.log("device list failed", e);
        if (relayUnanswered(e) && ++misses === 2) { this.log("the relay connection answers nothing; connecting again"); markDead(); }
      }), this.o.refreshMs ?? 30_000));
      timers.push(setInterval(() => { try { conn.send("ping"); } catch { /* closing */ } }, this.o.pingMs ?? 30_000));
      for (const timer of timers) timer.unref();
      await Promise.race([conn.closed, dead]);
    } finally {
      try { conn.close(); } catch { /* already closed */ }
      for (const timer of timers) clearInterval(timer);
      const was = this.ready;
      this.ready = false;
      if (this.conn === conn) this.conn = null;
      if (was) this.o.handlers?.connection?.(false);
    }
  }

  // ---- what the relay says -------------------------------------------------------------------------------------------

  private onFrame(conn: Connection, frame: Record<string, unknown>): void {
    if (this.conn !== conn) return;
    if (frame.t === "gw") {
      if (frame.op === "device.presence") void this.refreshDevices().catch((e) => this.log("device list failed", e));
      else if (frame.op === "pair.request") void this.addRequest(frame as Record<string, string>);
      return;
    }
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    // The relay serves nothing of the hub's (docs/LINK-E2E.md §7): a browser's stream or request is refused, not left hanging.
    if (frame.op === "ws.open") conn.send({ t: "tun", op: "ws.close", sid: frame.sid, code: 4404, reason: "not served through the relay" });
    else if (frame.op === "http.req") conn.send({ t: "tun", op: "http.error", sid: frame.sid, message: "not served through the relay" });
  }

  private async addRequest(raw: Record<string, string>): Promise<void> {
    if (!raw.request_id || !raw.client_id || !raw.pubkey) return;
    const request: RelayPairRequest = {
      request_id: raw.request_id, client_id: raw.client_id, name: raw.name ?? "", pubkey: raw.pubkey,
      fingerprint: raw.fingerprint || await shortFingerprint(raw.pubkey), ...(raw.ticket_hash ? { ticket_hash: raw.ticket_hash } : {}),
    };
    const fresh = !this.requests.has(request.request_id);
    this.requests.set(request.request_id, request);
    if (fresh) try { this.o.handlers?.pairRequest?.(request); } catch (error) { this.log("pairing notice failed", error); }
  }

  /** Reads the relay's device list; one read at a time, in order. */
  refreshDevices(): Promise<RelayDevice[]> {
    const task = this.syncTail.catch(() => {}).then(async () => {
      const conn = this.requireConn();
      const answer = await conn.request({ op: "device.list" });
      const devices = answer.devices;
      if (!Array.isArray(devices)) throw new Error("the relay's device list is unavailable");
      this.list = devices.filter((d: { id?: unknown }) => typeof d.id === "string" && /^[A-Za-z0-9_-]+$/.test(d.id as string)).map((d: Record<string, unknown>) => ({
        id: d.id as string, name: String(d.name ?? d.id), permissions: Array.isArray(d.permissions) ? d.permissions.map(String) : [],
        online: Boolean(d.online), revoked: Boolean(d.revoked),
      }));
      if (this.conn === conn) this.o.handlers?.devices?.(this.devices());
      return this.devices();
    });
    this.syncTail = task;
    return task;
  }

  // ---- tunnels ---------------------------------------------------------------------------------------------------------

  /** A `/link` stream to [deviceId]. The relay closes it with 4404 when the device is offline or may not be reached. */
  openLink(deviceId: string): LinkSocket {
    return socketOf(this.requireConn().openStream(deviceId, "/link"));
  }

  // ---- the owner's acts on the relay -------------------------------------------------------------------------------------

  /** A one-time pairing code and the address where it is entered (the install page). */
  async ticket(): Promise<{ ticket: string; expires_in: number; origin: string }> {
    return { ticket: await this.client.createPairTicket(this.requireConn()), expires_in: EXPIRES_IN_S, origin: this.url };
  }

  async approve(requestId: string, permissions: string[]): Promise<void> {
    let item = this.requests.get(requestId);
    if (!item) {
      const pending = await this.requireConn().request({ op: "pair.pending" });
      for (const raw of (pending.requests as Record<string, string>[] | undefined) ?? []) await this.addRequest(raw);
      item = this.requests.get(requestId);
    }
    if (!item) throw new Error("unknown pairing request");
    const grant = await this.grantVersion();
    try {
      await this.client.approve(this.requireConn(), { request_id: item.request_id, client_id: item.client_id, pubkey: item.pubkey }, permissions as Permission[], grant + 1);
    } catch (error) {
      // An earlier approve whose answer was lost (a slow network) did reach the relay: only this hub's key signs approvals, so it is done.
      if (!(error instanceof GatewayError && error.code === "not_pending" && /approved/.test(error.message))) throw error;
    }
    this.requests.delete(requestId);
  }

  async reject(requestId: string): Promise<void> {
    try { await this.requireConn().request({ op: "pair.reject", request_id: requestId }); }
    catch (error) { if (!(error instanceof GatewayError && error.code === "not_pending" && /rejected/.test(error.message))) throw error; }
    this.requests.delete(requestId);
  }

  async revoke(deviceId: string): Promise<void> {
    await this.client.revoke(this.requireConn(), deviceId, (await this.grantVersion()) + 1);
    await this.refreshDevices().catch(() => {});
  }

  /** Replaces a device's grants with what [change] makes of the current ones. */
  async setPermissions(deviceId: string, change: (current: string[]) => string[]): Promise<void> {
    const conn = this.requireConn();
    const answer = await conn.request({ op: "device.list" });
    const device = (answer.devices as { id: string; revoked: boolean; permissions: string[] }[]).find((d) => d.id === deviceId && !d.revoked);
    if (!device) throw new Error("unknown device");
    await this.client.permissions(conn, deviceId, change([...device.permissions]) as Permission[], Number(answer.grant_version) + 1);
    await this.refreshDevices().catch(() => {});
  }

  private async grantVersion(): Promise<number> {
    return Number((await this.requireConn().request({ op: "device.list" })).grant_version);
  }

  private requireConn(): Connection {
    if (!this.conn) throw new Error("the relay is not connected");
    return this.conn;
  }
}
