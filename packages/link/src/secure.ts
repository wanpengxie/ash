/**
 * The secure layer under `ash-link/2` on a relay tunnel (docs/LINK-E2E.md): the relay passes on what it can neither read nor
 * change. TLS 1.3 (`node:tls`) runs on the tunnel with a certificate on each side, and each side judges the other only by the
 * public key in its certificate: the hub by the key the device was paired with, the device by the owner's endorsement of the
 * hub's key. Encryption, integrity, replay and reordering, forward secrecy and rekeying are all TLS's.
 *
 * On the tunnel: the hub first sends a version announcement in the clear (a `challenge` frame naming `ash-link/2`, so a device
 * of an older protocol closes with 4008 as it always did); every message after that is a run of TLS bytes as base64 text.
 * Inside TLS: one line per frame. Lines that start with `!` belong to this layer: `!hub` (the endorsement), `!device` (the
 * answer) and `!close` (a close code the other side can trust; a tunnel that ends without one only lost its connection).
 * The connection is handed to the link layer only after both checks passed.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { TLSSocket, connect as tlsConnect, createSecureContext } from "node:tls";
import { CLOSE_CODES, LIMITS } from "../../sdk/src/link";
import { LINK_TUNNEL } from "../../sdk/src/versions";
import { selfSignedCertificate } from "./cert";
import type { Connector, SocketEvents } from "./hand";
import type { LinkSocket, RawSocket } from "./socket";

/** The version announcement, the TLS handshake and both checks together. */
const HANDSHAKE_MS = 20_000;
/** A line holds one frame; a little more for this layer's own lines. */
const MAX_LINE = LIMITS.frameBytes + 64 * 1024;
/** How long a close waits for its `!close` to be written before the tunnel is closed anyway. */
const FLUSH_MS = 1000;

// --- keys, the endorsement, the pairing proof ---------------------------------------------------------------------------

/** A P-256 key as TLS uses it: the private key (PEM), its public key and a self-signed certificate for it. */
export interface LinkKey {
  /** SPKI, base64url. */
  readonly publicKey: string;
  readonly privateKeyPem: string;
  readonly certificate: string;
}
export function linkKey(privateKey: KeyObject): LinkKey {
  return {
    publicKey: createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64url"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certificate: selfSignedCertificate(privateKey),
  };
}

const spki = (key: string): Buffer => createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" }).export({ type: "spki", format: "der" });
/** Whether [a] and [b] (SPKI, base64url) are the same public key. */
export function sameKey(a: string, b: string): boolean {
  try { return spki(a).equals(spki(b)); } catch { return false; }
}

/** ECDSA P-256 over the UTF-8 bytes of [data]; [sig] base64url, DER (the keystore's) or raw r||s. */
export function signatureHolds(publicKey: string, data: string, sig: string): boolean {
  try {
    const bytes = Buffer.from(sig, "base64url");
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(data, "utf8"), { key, dsaEncoding: bytes.length === 64 ? "ieee-p1363" : "der" }, bytes);
  } catch {
    return false;
  }
}

/** The owner's word that [hub_key] is the hub's until [expires_at] (ms). The owner key signs [endorsementText]. */
export interface Endorsement { owner_key: string; hub_key: string; expires_at: number; sig: string }
export const endorsementText = (e: Pick<Endorsement, "owner_key" | "hub_key" | "expires_at">): string =>
  [LINK_TUNNEL, "hub-key", e.owner_key, e.hub_key, String(e.expires_at)].join("\n");

/**
 * Proof of the one-time pairing secret: only the hub that issued it and the computer it was given to know it, and the relay
 * never sees it. Each side MACs the three keys of the connection as it sees them, so a key the relay swapped shows.
 */
export function pairMac(secret: string, side: "hub" | "device", keys: { owner: string; hub: string; device: string }): string {
  return createHmac("sha256", secret).update([LINK_TUNNEL, `pair-${side}`, keys.owner, keys.hub, keys.device].join("\n")).digest("base64url");
}
const macHolds = (want: string, given: unknown): boolean =>
  typeof given === "string" && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));

/** A release of the computer program: its version and the SHA-256 of each platform's package (`darwin-arm64`, ...). */
export interface DeviceRelease { version: string; sha256: Record<string, string> }

/** A secure connection that did not come about: the close code it ended with and why. `pairing`: the pairing secret did not hold. */
export class SecureRefusal extends Error {
  constructor(readonly code: number, message: string, readonly pairing = false) { super(message); this.name = "SecureRefusal"; }
}

// --- the tunnel as bytes, the TLS stream as lines -----------------------------------------------------------------------

/** TLS bytes on a tunnel: each message is a run of them, as base64 text (the relay's text messages pass unchanged). */
class TunnelBytes extends Duplex {
  constructor(private readonly out: (text: string) => void) { super(); }
  feed(text: string): void { this.push(Buffer.from(text, "base64")); }
  ended(): void { this.push(null); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    try { this.out(chunk.toString("base64")); done(); } catch (error) { done(error as Error); }
  }
  override _read(): void {}
}

/** Splits what TLS delivers into lines. */
class LineReader {
  private readonly decoder = new StringDecoder("utf8");
  private parts: string[] = [];
  private size = 0;
  constructor(private readonly onLine: (line: string) => void, private readonly tooLong: () => void) {}
  take(chunk: Buffer): void {
    const text = this.decoder.write(chunk);
    let from = 0;
    for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", from)) {
      this.parts.push(text.slice(from, at));
      const line = this.parts.join("");
      this.parts = []; this.size = 0;
      from = at + 1;
      this.onLine(line);
    }
    if (from < text.length) {
      this.parts.push(text.slice(from));
      this.size += text.length - from;
      if (this.size > MAX_LINE) this.tooLong();
    }
  }
}

// --- one secured tunnel -------------------------------------------------------------------------------------------------

interface Outer { send(text: string): void; close(code: number, reason: string): void }
interface HubSide {
  role: "hub";
  key: LinkKey;
  endorsement: Endorsement;
  kernel: { id: string; version: string };
  /** The key the device was paired with. */
  deviceKey: string;
  /** Set until the device proved the pairing secret on its first connection. */
  pairSecret: string | null;
  /** Named in a 4008 close: the release a device too old for this hub installs. */
  release?: DeviceRelease | null;
}
interface DeviceSide {
  role: "device";
  key: LinkKey;
  /**
   * Read when the hub's announcement arrives (a socket may wait long for its tunnel): the owner key this computer pinned at
   * pairing, and the pairing secret until the hub proved it. Until then the owner key is only what the relay said.
   */
  trust(): { ownerKey: string; pairSecret: string | null };
  now(): number;
  /** The hub proved the pairing secret: [ownerKey] is the owner's, pin it and forget the secret. */
  paired?(ownerKey: string): void;
  /** The hub, proved, closed with 4008 and named the release to install. */
  update?(release: DeviceRelease): void;
}
type Ending = { code: number; reason: string };

const parse = (text: string): Record<string, unknown> | null => {
  try { const value = JSON.parse(text); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; }
};
/** A release as a 4008 names it, or null when it is not one. */
function releaseOf(value: unknown): DeviceRelease | null {
  const r = value as { version?: unknown; sha256?: unknown } | null | undefined;
  if (!r || typeof r.version !== "string" || !/^\d+\.\d+\.\d+$/.test(r.version) || !r.sha256 || typeof r.sha256 !== "object") return null;
  const sha256 = Object.fromEntries(Object.entries(r.sha256 as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && /^[a-f0-9]{64}$/.test(e[1])));
  return { version: r.version, sha256 };
}
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 100);

class SecureTunnel {
  private phase: "announce" | "tls" | "check" | "open" | "closed" = "announce";
  private bytes: TunnelBytes | null = null;
  private tls: TLSSocket | null = null;
  private peerKey = "";
  private trusted: { ownerKey: string; pairSecret: string | null } = { ownerKey: "", pairSecret: null };
  private heard: Ending | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle!: { resolve(peerKey: string): void; reject(error: SecureRefusal): void };
  /** Resolves with the peer's key once both checks passed; rejects with the reason it did not. */
  readonly ready = new Promise<string>((resolve, reject) => { this.settle = { resolve, reject }; });
  private readonly early: string[] = [];
  private listener: ((line: string) => void) | null = null;
  onClose: (code: number, reason: string) => void = () => {};

  constructor(private readonly outer: Outer, private readonly side: HubSide | DeviceSide) {
    this.ready.catch(() => {});
  }

  /** The handshake has begun (the hub sent its announcement): it must finish in time. A device may wait long for a tunnel before that. */
  private arm(): void {
    this.timer = setTimeout(() => this.abort(CLOSE_CODES.unauthenticated, "the secure handshake did not finish in time"), HANDSHAKE_MS);
    this.timer.unref?.();
  }

  /** The hub announces its protocol and waits for the device's TLS. */
  start(): void {
    const { kernel } = this.side as HubSide;
    this.arm();
    this.outer.send(JSON.stringify({ t: "challenge", nonce: "secure", kernel: { id: kernel.id, version: kernel.version, protocol: LINK_TUNNEL } }));
    this.beginTls();
  }

  /** A message from the tunnel. */
  received(text: string): void {
    if (this.phase === "closed") return;
    // TLS bytes come as base64, which never holds `{`: a frame in the clear is a device that does not secure its connection.
    if (this.side.role === "hub" && text.startsWith("{")) return this.abort(CLOSE_CODES.badFrame, "the device spoke in the clear; a relay connection must be secured");
    if (this.phase !== "announce") { this.bytes?.feed(text); return; }
    this.arm();
    const announced = parse(text);
    const kernel = announced?.t === "challenge" ? announced.kernel as { protocol?: unknown } | undefined : undefined;
    // Not a reason to stop for good: this is still in the clear, so it may be the relay's.
    if (kernel?.protocol !== LINK_TUNNEL) return this.abort(CLOSE_CODES.badFrame, `the hub announced ${String(kernel?.protocol ?? "nothing").slice(0, 40)}`);
    this.trusted = (this.side as DeviceSide).trust();
    this.beginTls();
  }

  /** The tunnel ended. */
  outerClosed(code: number, reason: string): void {
    if (this.phase === "closed") return;
    this.bytes?.ended();
    if (this.phase === "open") return this.finish(this.heard ?? { code: 1006, reason: `the tunnel closed (${code}${reason ? ` ${reason}` : ""})`.slice(0, 100) });
    // Before TLS: an older device closes with 4008 after the announcement.
    this.finish({ code, reason: reason || "the tunnel closed before the connection was secured" });
  }

  /** Lines for the link layer; those that came before a listener are held for it. */
  onLine(listener: (line: string) => void): void {
    this.listener = listener;
    for (const line of this.early.splice(0)) if (this.phase === "open") listener(line);
  }

  send(line: string): void {
    if (this.phase === "open") this.tls!.write(`${line}\n`);
  }

  /** Closes from this end. */
  close(code: number, reason: string): void {
    if (this.phase !== "open") return this.abort(code, reason);
    this.closeInside(code, reason);
    this.ended({ code, reason });
  }

  /** Ends without a word inside TLS (it is not up, or cannot be trusted any more). */
  abort(code: number, reason: string): void {
    if (this.phase === "closed") return;
    this.tls?.destroy();
    try { this.outer.close(code, reason); } catch { /* already gone */ }
    this.finish({ code, reason });
  }

  /** Refuses the other end during the checks: TLS is up, so the code goes inside it. */
  private refuse(code: number, reason: string, pairing = false): void {
    if (this.phase === "closed") return;
    this.closeInside(code, reason);
    this.settle.reject(new SecureRefusal(code, reason, pairing));
  }

  /** The code goes inside TLS first, so the other end can trust it; then the tunnel is closed. */
  private closeInside(code: number, reason: string): void {
    const tls = this.tls!;
    this.phase = "closed";
    clearTimeout(this.timer);
    let done = false;
    const closeOuter = () => { if (done) return; done = true; tls.destroy(); this.outer.close(code, reason); };
    // A device too old for this hub is told which release to install: it can trust this, it is inside TLS.
    const release = code === CLOSE_CODES.unsupported && this.side.role === "hub" ? this.side.release : null;
    tls.write(`!close ${JSON.stringify({ code, reason, ...(release ? { update: release } : {}) })}\n`, () => setImmediate(closeOuter));
    setTimeout(closeOuter, FLUSH_MS).unref?.();
  }

  private finish(end: Ending): void {
    if (this.phase === "closed") return;
    const wasOpen = this.phase === "open";
    this.phase = "closed";
    clearTimeout(this.timer);
    this.tls?.destroy();
    if (wasOpen) this.ended(end);
    else this.settle.reject(new SecureRefusal(end.code, end.reason));
  }

  private ended(end: Ending): void {
    try { this.onClose(end.code, end.reason); } catch { /* the listener's problem */ }
  }

  // --- TLS ---

  private beginTls(): void {
    this.phase = "tls";
    const side = this.side;
    const bytes = new TunnelBytes((text) => this.outer.send(text));
    this.bytes = bytes;
    const credentials = { key: side.key.privateKeyPem, cert: side.key.certificate, minVersion: "TLSv1.3" as const };
    // No CA: each side compares the key in the other's certificate with the one it expects (secured()).
    const tls = side.role === "hub"
      ? new TLSSocket(bytes, { isServer: true, requestCert: true, rejectUnauthorized: false, secureContext: createSecureContext(credentials) })
      : tlsConnect({ socket: bytes, ...credentials, rejectUnauthorized: false, checkServerIdentity: () => undefined });
    this.tls = tls;
    const lines = new LineReader((line) => this.line(line), () => this.abort(CLOSE_CODES.badFrame, "a line longer than a frame"));
    tls.on("data", (chunk: Buffer) => { if (this.phase !== "closed") lines.take(chunk); });
    tls.once(side.role === "hub" ? "secure" : "secureConnect", () => this.secured());
    tls.on("error", (error) => {
      if (this.phase === "open") { this.tls?.destroy(); try { this.outer.close(CLOSE_CODES.badFrame, "TLS failed"); } catch { /* gone */ } this.finish({ code: 1006, reason: `TLS failed: ${reasonOf(error)}` }); }
      else this.abort(CLOSE_CODES.unauthenticated, `TLS failed: ${reasonOf(error)}`);
    });
    tls.on("close", () => { if (this.phase !== "closed") this.finish(this.heard ?? { code: 1006, reason: "the secure connection ended" }); });
  }

  private secured(): void {
    if (this.phase !== "tls") return;
    const certificate = this.tls!.getPeerX509Certificate();
    if (!certificate) return this.abort(CLOSE_CODES.unauthenticated, "no certificate");
    this.peerKey = certificate.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    this.phase = "check";
    const side = this.side;
    if (side.role === "device") return; // the hub speaks first
    if (!sameKey(this.peerKey, side.deviceKey)) return this.refuse(CLOSE_CODES.unauthenticated, "the device's key is not the one that was paired");
    const mac = side.pairSecret ? pairMac(side.pairSecret, "hub", { owner: side.endorsement.owner_key, hub: side.key.publicKey, device: this.peerKey }) : null;
    this.tls!.write(`!hub ${JSON.stringify({ ...side.endorsement, ...(mac ? { pair_mac: mac } : {}) })}\n`);
  }

  private line(line: string): void {
    if (this.phase === "closed") return;
    if (line.startsWith("!close ")) {
      const said = parse(line.slice("!close ".length));
      this.heard = { code: Number.isInteger(said?.code) ? said!.code as number : 1000, reason: typeof said?.reason === "string" ? said.reason.slice(0, 100) : "" };
      // Only from a hub that proved itself (the connection is open), and only with 4008.
      const release = releaseOf(said?.update);
      if (this.phase === "open" && this.side.role === "device" && this.heard.code === CLOSE_CODES.unsupported && release) {
        try { this.side.update?.(release); } catch { /* the listener's problem */ }
      }
      try { this.outer.close(this.heard.code, this.heard.reason); } catch { /* gone */ }
      return this.finish(this.heard);
    }
    if (this.phase === "check") return this.side.role === "hub" ? this.checkDevice(line) : this.checkHub(line);
    if (this.phase !== "open" || line.startsWith("!")) return;
    if (this.listener) this.listener(line);
    else this.early.push(line);
  }

  /** The device reads the hub's endorsement. */
  private checkHub(line: string): void {
    const side = this.side as DeviceSide;
    const e = line.startsWith("!hub ") ? parse(line.slice("!hub ".length)) : null;
    if (!e || typeof e.owner_key !== "string" || typeof e.hub_key !== "string" || typeof e.expires_at !== "number" || typeof e.sig !== "string") return this.refuse(CLOSE_CODES.unauthenticated, "the hub sent no endorsement");
    const endorsement = e as unknown as Endorsement;
    if (!sameKey(endorsement.hub_key, this.peerKey)) return this.refuse(CLOSE_CODES.unauthenticated, "the hub's certificate is not the key its endorsement names");
    const keys = { owner: endorsement.owner_key, hub: this.peerKey, device: side.key.publicKey };
    const { ownerKey, pairSecret } = this.trusted;
    if (pairSecret) {
      if (!macHolds(pairMac(pairSecret, "hub", keys), e.pair_mac)) return this.refuse(CLOSE_CODES.unauthenticated, "the hub could not prove the pairing secret: the relay may have swapped the owner's key", true);
    } else if (!sameKey(endorsement.owner_key, ownerKey)) {
      return this.refuse(CLOSE_CODES.unauthenticated, "the hub's endorsement is not from the owner this computer was paired with");
    }
    if (!signatureHolds(endorsement.owner_key, endorsementText(endorsement), endorsement.sig)) return this.refuse(CLOSE_CODES.unauthenticated, "the owner's signature on the hub's key does not hold");
    if (endorsement.expires_at <= side.now()) return this.refuse(CLOSE_CODES.unauthenticated, "the owner's endorsement of the hub's key has expired");
    if (pairSecret) side.paired?.(endorsement.owner_key);
    this.tls!.write(`!device ${JSON.stringify(pairSecret ? { pair_mac: pairMac(pairSecret, "device", keys) } : {})}\n`);
    this.opened();
  }

  /** The hub reads the device's answer: the pairing proof, on its first connection. */
  private checkDevice(line: string): void {
    const side = this.side as HubSide;
    const answer = line.startsWith("!device ") ? parse(line.slice("!device ".length)) : null;
    if (!answer) return this.refuse(CLOSE_CODES.unauthenticated, "the device did not answer the endorsement");
    if (side.pairSecret) {
      const want = pairMac(side.pairSecret, "device", { owner: side.endorsement.owner_key, hub: side.key.publicKey, device: this.peerKey });
      if (!macHolds(want, answer.pair_mac)) return this.refuse(CLOSE_CODES.unauthenticated, "the device could not prove the pairing secret: the relay may have swapped the device's key", true);
    }
    this.opened();
  }

  private opened(): void {
    this.phase = "open";
    clearTimeout(this.timer);
    this.settle.resolve(this.peerKey);
  }
}

// --- the two ends -------------------------------------------------------------------------------------------------------

export interface HubSecureOptions {
  key: LinkKey;
  endorsement: Endorsement;
  kernel: { id: string; version: string };
  deviceKey: string;
  pairSecret: string | null;
  /** The release a device this hub closes with 4008 is told to install. */
  release?: DeviceRelease | null;
}

/**
 * The hub's end of a relay tunnel it opened: announce, TLS, the checks. Resolves with a socket the link server takes like any
 * other, and the device's key (its certificate's); rejects with a [SecureRefusal] (the tunnel is closed by then).
 */
export async function secureHub(tunnel: LinkSocket, o: HubSecureOptions): Promise<{ socket: LinkSocket; peerKey: string }> {
  const secure = new SecureTunnel({ send: (text) => tunnel.send(text), close: (code, reason) => tunnel.close(code, reason) }, { role: "hub", ...o });
  tunnel.on("message", (data: unknown) => secure.received(typeof data === "string" ? data : String(data)));
  tunnel.on("close", (code: number, reason: unknown) => secure.outerClosed(code, String(reason ?? "")));
  secure.start();
  const peerKey = await secure.ready;
  const closers: ((code: number, reason: string) => void)[] = [];
  secure.onClose = (code, reason) => { for (const listener of closers) listener(code, reason); };
  const socket: LinkSocket = {
    send: (data) => secure.send(data),
    close: (code, reason) => secure.close(code ?? 1000, reason ?? ""),
    terminate: () => secure.abort(1006, "terminated"),
    on(event, listener) {
      if (event === "message") secure.onLine((line) => listener(line, false));
      else closers.push(listener);
      return undefined;
    },
  };
  return { socket, peerKey };
}

export interface DeviceSecureOptions {
  key: LinkKey;
  /** Asked at every handshake: the pinned owner key, and the pairing secret until the first connection proved it. */
  trust(): { ownerKey: string; pairSecret: string | null };
  /** The hub proved the pairing secret: pin [ownerKey], forget the secret. */
  paired?(ownerKey: string): void;
  /** A connection did not come about, and why. */
  refused?(error: SecureRefusal): void;
  /** The hub (proved) closed with 4008 and named the release to install. */
  update?(release: DeviceRelease): void;
  now?: () => number;
}

/**
 * The device's end: wraps the connector the hub's tunnels arrive on. The link client sees `open` only once the hub has proved
 * itself, then plain frames; a close code reaches it only if it came inside TLS (otherwise the connection was just lost).
 */
export function secureConnector(inner: Connector, o: DeviceSecureOptions): Connector {
  return (url, headers, events): RawSocket => {
    let raw: RawSocket | null = null;
    const pending: Ending[] = [];
    const secure = new SecureTunnel({
      send: (text) => raw!.send(text),
      close: (code, reason) => { if (raw) raw.close(code, reason); else pending.push({ code, reason }); },
    }, { role: "device", key: o.key, trust: o.trust, now: o.now ?? Date.now, paired: o.paired, update: o.update });
    let told = false;
    const tell = (code: number, reason: string) => { if (!told) { told = true; events.close(code, reason); } };
    secure.onClose = tell;
    secure.ready.then(() => { secure.onLine((line) => events.message(line, false)); events.open(); }, (error: SecureRefusal) => {
      o.refused?.(error);
      tell(1006, error.message);
    });
    const plain: SocketEvents = {
      open: () => {},
      message: (data) => secure.received(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8")),
      close: (code, reason) => secure.outerClosed(code, reason),
    };
    raw = inner(url, headers, plain);
    for (const end of pending.splice(0)) raw.close(end.code, end.reason);
    return {
      send: (data) => secure.send(data),
      close: (code = 1000, reason = "") => secure.close(code, reason),
      terminate: () => secure.abort(1006, "terminated"),
    };
  };
}
