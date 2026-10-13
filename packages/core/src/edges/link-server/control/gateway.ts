/**
 * The hub's connection to its relay (HUB-MODULES §2.1 "网关", SPEC-03 §8): the owner stays connected to the relay, opens a
 * `/link` tunnel to every device it reports online that may be reached, and takes the browsers the relay lets in. It also
 * is the relay's side of pairing (`PairingGateway`, which `service:devices` uses).
 *
 * Which device gets a tunnel: the relay holds one permission, `expose_capability`, for everything that is not the web
 * page, and at pairing the hub grants it when any of lending capabilities, serving as a body or running local agents is
 * allowed. So "has `expose_capability`" is the relay's word for "has a non-web permission". The kernel's own record
 * decides which channels open at the handshake (lend, body, local agents); this module only skips devices it has no record of
 * or that are revoked. It also carries a browser's HTTP request for the web page to the link server (`relayHttp`).
 */
import { createHash } from "node:crypto";
import { WordError } from "../../../../../sdk/src/message";
import type { Db } from "../../../kernel/ledger";
import type { Vault } from "../../../kernel/types";
import { Relay, RelayError, relayUnanswered, type BrowserOpen, type RelayDevice, type RelayHttpRequest, type RelayHttpResponse, type RelayOptions, type RelayPairRequest } from "../../../../../link/src/gateway";
import type { LinkSocket } from "../../../../../link/src/socket";
import type { Devices, PairKind, PairingGateway, RelayPermission } from "../hands/devices";
import type { HandRegistry } from "../hands/registry";
import type { HubLinkServer } from "../index";

/** Where the vault keeps a claim secret the owner set for an unclaimed relay they run themselves. */
export const BOOTSTRAP_REF = "GATEWAY_BOOTSTRAP";

/** The hub's key. It lives in the host's keystore; only signing is asked of it. */
export interface OwnerIdentity {
  key(): Promise<{ id: string; public_key: string }>;
  /** [data] base64url; the signature is ECDSA P-256, base64url. */
  sign(data: string): Promise<{ sig: string }>;
}

export interface GatewayControlDeps {
  db: Db;
  link: Pick<HubLinkServer, "acceptGateway" | "relayHttp">;
  hands: Pick<HandRegistry, "get">;
  vault: Pick<Vault, "use">;
  identity: OwnerIdentity;
  /** The relay client; replaced in tests. */
  relay?: (options: RelayOptions) => Relay;
  /** The name the relay shows for this hub. */
  ownerName?: string;
  /** The first wait before looking again after a tunnel closed; doubles while it keeps happening. Default 1 s. */
  retryMs?: number;
  log?: (message: string, error?: unknown) => void;
}

export interface GatewayStatus {
  configured: boolean;
  url?: string;
  claimed?: boolean;
  connected: boolean;
  account_email?: string;
  /** Why the relay could not be reached, in words for a person; never what the relay sent back. */
  last_error?: string;
  /** The HTTP status the relay answered with in that failure, when it answered. */
  last_error_status?: number;
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS link_gateway (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
/** The relay closes a tunnel with these when retrying cannot help: revoked, unknown stream, offline or not allowed, replaced, device gone. */
const NO_REOPEN = new Set([4003, 4403, 4404, 4409, 4410]);
const sha256b64u = (text: string) => createHash("sha256").update(text).digest("base64url");
const WEB: readonly string[] = ["web_ui", "chat"];

const PROBLEM_TEXT: Record<string, string> = {
  claimed_by_other: "The relay is claimed by another owner.",
  bad_secret: "The relay did not accept the claim secret.",
  missing_secret: "The relay is not claimed and there is no claim secret; set one in the vault as GATEWAY_BOOTSTRAP.",
  unsupported: "The relay speaks a protocol this hub does not.",
  unreachable: "The relay cannot be reached.",
};

export class GatewayControl {
  private relay: Relay | null = null;
  private devices: Pick<Devices, "pairs" | "pairingRequested"> | null = null;
  private readonly tunnels = new Map<string, { socket: LinkSocket; at: number; failures: number }>();
  private readonly failures = new Map<string, number>();
  private retry = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly d: GatewayControlDeps) {
    d.db.exec(SCHEMA);
  }

  /** Captures the real relay instance and current kernel pairing, never page-supplied keys. */
  material(id:string) {
    const relay=this.relay,hand=this.d.hands.get(id);
    if(!relay||!hand||hand.revoked_at||!hand.lend||!hand.public_key)throw new WordError("forbidden","Coworker material permission_denied");
    const stamp=JSON.stringify([hand.public_key,hand.paired_at]),peer=relay.material(id,hand.public_key);
    const current=()=>{const now=this.d.hands.get(id);if(this.relay!==relay||!now||now.revoked_at||!now.lend||JSON.stringify([now.public_key,now.paired_at])!==stamp)throw new WordError("forbidden","Coworker material permission_denied");};
    return {...peer,current,transport:{capture:async()=>{current();const value=await peer.transport.capture();current();return value;},current:(value:Parameters<typeof peer.transport.current>[0])=>{current();return peer.transport.current(value);},send:(value:Parameters<typeof peer.transport.send>[0])=>{current();return peer.transport.send(value);}}};
  }

  // ---- settings ------------------------------------------------------------------------------------------------------------

  private get(key: string): string | undefined {
    return (this.d.db.prepare("SELECT value FROM link_gateway WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }
  private put(key: string, value: string | undefined): void {
    if (value === undefined) this.d.db.prepare("DELETE FROM link_gateway WHERE key = ?").run(key);
    else this.d.db.prepare("INSERT INTO link_gateway (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- the connection ------------------------------------------------------------------------------------------------------

  /** Connects to the relay that was set before, if any. Never throws: an unreachable relay is retried. */
  async start(): Promise<void> {
    const url = this.get("url");
    if (url) await this.begin(url);
  }

  stop(): void { this.end(); }

  /**
   * Makes [url] the relay: reaches it, claims it with [claimSecret] (or the vault's `GATEWAY_BOOTSTRAP`) when it is
   * unclaimed, remembers it and connects. Throws a `WordError` saying what is wrong when it cannot be reached or claimed.
   */
  async use(url: string, opts: { claimSecret?: string; account?: { email?: string } } = {}): Promise<string> {
    const origin = this.normalize(url);
    const relay = await this.build(origin, () => opts.claimSecret ?? this.d.vault.use(BOOTSTRAP_REF));
    try { await relay.ensureClaimed(); }
    catch (error) {
      relay.stop();
      const problem = error instanceof RelayError ? error.problem : "unreachable";
      throw new WordError(problem === "claimed_by_other" || problem === "missing_secret" || problem === "bad_secret" ? "forbidden" : "unavailable", PROBLEM_TEXT[problem] ?? "The relay cannot be used.", {
        recovery_hint: problem === "missing_secret" ? "Store the relay's claim secret with service:vault/set (ref GATEWAY_BOOTSTRAP), then use it again." : "Check the address, or build a new relay with gateway.setup.start.",
      });
    }
    this.end();
    this.relay = relay;
    this.put("url", origin);
    this.put("account_email", opts.account?.email);
    relay.start();
    return origin;
  }

  private async begin(url: string): Promise<void> {
    this.relay = await this.build(url, () => this.d.vault.use(BOOTSTRAP_REF));
    this.relay.start();
  }

  private end(): void {
    this.relay?.stop();
    this.relay = null;
    for (const timer of this.retry.values()) clearTimeout(timer);
    this.retry.clear();
    const open = [...this.tunnels.values()];
    this.tunnels.clear();
    for (const t of open) t.socket.close(1000, "the relay changed");
  }

  private normalize(url: string): string {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new WordError("bad_request", "the relay address is not a URL"); }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new WordError("bad_request", "the relay address must be https");
    if (parsed.username || parsed.password) throw new WordError("bad_request", "the relay address must not carry credentials");
    return parsed.origin;
  }

  private async build(url: string, claimSecret: () => string | null): Promise<Relay> {
    const key = await this.d.identity.key();
    const options: RelayOptions = {
      url, name: this.d.ownerName ?? "ash",
      owner: {
        id: key.id, publicKey: key.public_key,
        sign: async (data) => (await this.d.identity.sign(Buffer.from(data).toString("base64url"))).sig,
      },
      claimSecret, log: this.d.log,
      handlers: {
        devices: (list) => this.reconcile(list),
        pairRequest: (request) => this.pairRequest(request),
        browser: (open) => this.browser(open),
        http: (request) => this.web(request),
      },
    };
    return (this.d.relay ?? ((o) => new Relay(o)))(options);
  }

  // ---- what the words ask --------------------------------------------------------------------------------------------------

  status(): GatewayStatus {
    const url = this.get("url");
    const email = this.get("account_email");
    const claimed = this.relay?.claimed;
    return {
      configured: Boolean(url), ...(url ? { url } : {}), ...(claimed !== null && claimed !== undefined ? { claimed } : {}),
      connected: this.relay?.connected ?? false, ...(email ? { account_email: email } : {}),
      ...(this.relay?.lastError ? { last_error: this.relay.lastError } : {}),
      ...(this.relay?.lastStatus ? { last_error_status: this.relay.lastStatus } : {}),
    };
  }

  /** True once the hub is connected to the relay, waiting at most [timeoutMs]. */
  async connected(timeoutMs: number): Promise<boolean> { return this.relay ? this.relay.waitConnected(timeoutMs) : false; }

  /** The network changed: connect again at once. */
  reconnectRelay(): void { this.relay?.reconnect(); }

  /** What `diagnose` reports about the relay and its tunnels. */
  snapshot() {
    return {
      ...this.status(), problem: this.relay?.problem ?? null,
      devices: (this.relay?.devices() ?? []).map((d) => ({ id: d.id, online: d.online, revoked: d.revoked, permissions: d.permissions, tunnel: this.tunnels.has(d.id) })),
    };
  }

  /** Opens a fresh tunnel to the device (the relay closes the old one); false when the device cannot be reached through the relay now. */
  reopen(handId: string): boolean {
    const relay = this.relay;
    const device = relay?.devices().find((d) => d.id === handId);
    if (!relay?.connected || !device || !this.reachable(device)) return false;
    this.open(handId);
    return true;
  }

  // ---- tunnels -------------------------------------------------------------------------------------------------------------

  private reachable(device: RelayDevice): boolean {
    if (device.revoked || !device.online || !device.permissions.includes("expose_capability")) return false;
    // Which channels open is for the handshake to judge (lend, body, local agents).
    const hand = this.d.hands.get(device.id);
    return Boolean(hand && !hand.revoked_at);
  }

  /** The relay's device list was read: every device that is online and may be reached has a tunnel. */
  private reconcile(list: RelayDevice[]): void {
    for (const device of list) {
      if (this.reachable(device)) { if (!this.tunnels.has(device.id)) this.open(device.id); }
      else if (!device.online || device.revoked) this.tunnels.delete(device.id);
    }
  }

  private open(handId: string): void {
    const relay = this.relay;
    if (!relay) return;
    let socket: LinkSocket;
    try { socket = relay.openLink(handId); }
    catch (error) { this.d.log?.(`could not open a tunnel to ${handId}`, error); return; }
    const entry = { socket, at: Date.now(), failures: this.failures.get(handId) ?? 0 };
    this.tunnels.set(handId, entry);
    socket.on("close", (code: number) => {
      if (this.tunnels.get(handId) !== entry) return; // a newer tunnel took its place
      this.tunnels.delete(handId);
      if (NO_REOPEN.has(code) || this.relay !== relay) return;
      // Closed by the hub or by a fault: look again soon (the relay says whether the device is still there), backing off if it keeps happening.
      const quick = Date.now() - entry.at < 30_000;
      const failures = quick ? entry.failures + 1 : 0;
      this.failures.set(handId, failures);
      clearTimeout(this.retry.get(handId));
      const timer = setTimeout(() => { this.retry.delete(handId); void relay.refreshDevices().catch(() => {}); }, Math.min((this.d.retryMs ?? 1000) * 2 ** failures, 30_000));
      timer.unref();
      this.retry.set(handId, timer);
    });
    this.d.link.acceptGateway(socket, handId);
  }

  /** A browser the relay let in: only `/link`, and only the human channel. */
  private browser(open: BrowserOpen): void {
    let pathname = "";
    try { pathname = new URL(open.path, "http://browser.invalid").pathname; } catch { /* refused below */ }
    if (pathname !== "/link") return open.reject(4404, "path_not_allowed");
    this.d.link.acceptGateway(open.accept(), open.from, { humanOnly: true });
  }

  /** A browser's request for the web page: the same rule as the web socket, the device must be one the owner allowed web access. */
  private async web(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const hand = this.d.hands.get(request.from);
    if (!hand || hand.revoked_at || !hand.web_ui) {
      return { status: 403, headers: [["content-type", "application/json"]], body: Buffer.from('{"error":"forbidden","message":"web access is not allowed for this device"}') };
    }
    return this.d.link.relayHttp(request);
  }

  // ---- pairing -------------------------------------------------------------------------------------------------------------

  /** `service:devices` is built with the pairing side of this module, so it is given back afterwards. */
  bindDevices(devices: Pick<Devices, "pairs" | "pairingRequested">): void { this.devices = devices; }

  /**
   * A device asked to pair. The relay does not say with which code, so the hub finds the pairing: by the code's hash when
   * the relay gives it, otherwise the only pairing that is waiting. With several waiting and no hash it cannot tell, and
   * leaves the request pending at the relay.
   */
  private pairRequest(request: RelayPairRequest): void {
    const devices = this.devices;
    if (!devices) return;
    const waiting = [...devices.pairs.values()].filter((p) => p.state === "waiting");
    const pair = request.ticket_hash ? waiting.find((p) => sha256b64u(p.ticket) === request.ticket_hash) : waiting.length === 1 ? waiting[0] : undefined;
    if (!pair) { this.d.log?.(`pairing request ${request.request_id} cannot be matched to a pairing (${waiting.length} waiting)`); return; }
    devices.pairingRequested({
      request_id: request.request_id, hand_id: request.client_id, name: request.name, kind: pair.kind === "browser" ? "browser" : "computer",
      public_key: request.pubkey, fingerprint: request.fingerprint, ticket: pair.ticket,
    });
  }

  readonly pairing: PairingGateway = {
    // A computer opens the install page that carries the code; a browser opens the relay's front page and types the code in.
    issue: (kind: PairKind) => this.asked(async () => {
      const issued = await this.ready().ticket();
      return { ticket: issued.ticket, expires_in: issued.expires_in, url: kind === "browser" ? `${issued.origin}/` : `${issued.origin}/p/${issued.ticket}` };
    }),
    approve: (requestId: string, permissions: RelayPermission[]) => this.asked(() => this.ready().approve(requestId, permissions)),
    reject: (requestId: string) => this.asked(() => this.ready().reject(requestId)),
    revoke: (handId: string) => this.asked(async () => { await this.ready().revoke(handId); this.tunnels.get(handId)?.socket.close(4003, "revoked"); }),
    setWebUi: (handId: string, allow: boolean) => this.asked(() => this.ready().setPermissions(handId, (cur) => [...cur.filter((p) => !WEB.includes(p)), ...(allow ? ["web_ui", "chat"] : [])])),
    setExpose: (handId: string, allow: boolean) => this.asked(() => this.ready().setPermissions(handId, (cur) => [...cur.filter((p) => p !== "expose_capability"), ...(allow ? ["expose_capability"] : [])])),
  };

  /**
   * A request to the relay that gets no answer (a slow or lossy network, the relay restarting) is the relay being unavailable for
   * now, not a fault of the hub: it is told as such, with the advice to try again.
   */
  private async asked<T>(call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      if (relayUnanswered(error)) {
        throw new WordError("unavailable", "the relay did not answer in time", { recovery_hint: "稍后重试：the connection to the relay is slow or was interrupted; try again in a moment." });
      }
      throw error;
    }
  }

  private ready(): Relay {
    if (!this.relay?.connected) throw new WordError("unavailable", this.relay ? "the hub is not connected to the relay right now" : "no relay is set up", { recovery_hint: "Check service:link/gateway.status." });
    return this.relay;
  }
}
