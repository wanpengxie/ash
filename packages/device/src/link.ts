/**
 * The computer program's connection (SPEC-03): `ash-link/1` with the hub, over the relay.
 *
 * The program is a hand. It signs in to the relay as itself (`GatewayLine`: the relay protocol `ash-gw/1`, unchanged);
 * when the hub wants it, the relay hands over a tunnelled WebSocket for path `/link`, and the hub speaks first
 * (`challenge`). `TunnelPort` makes that tunnel look like the WebSocket `HandClient` (packages/link) opens by itself, so
 * the handshake, the channels, the reconnecting and the manifest are the link package's, not written again here.
 */
import { createPrivateKey, sign as signBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Connection, DeviceKey, DeviceStream, GatewayClient, GatewayError } from "ash-gateway/client/client";
import { shortFingerprint } from "ash-gateway/src/protocol";
import { base64url } from "../../sdk/src/ids";
import type { Connector, SocketEvents } from "../../link/src/hand";
import type { RawSocket } from "../../link/src/socket";
import { readLocalStateFile } from "./collaboration/local-state";
import { LocalStateTransaction } from "./collaboration/local-state-transaction";
import { MAX_PAIR_BYTES, parseCurrentPairing, loadCurrentPairing } from "./collaboration/pairing";
import type { TrustedCallContext } from "./collaboration/authorization";
import { bounded, STEP_MS } from "./bounded";

export { bounded, STEP_MS } from "./bounded";

/** The path the hub's tunnel opens on this program (SPEC-03 §8.1). Any other path is refused. */
export const LINK_PATH = "/link";

// ---------------------------------------------------------------------------------------------------------------------
// who this computer is
// ---------------------------------------------------------------------------------------------------------------------

export interface Signer { readonly id: string; readonly publicKey: string; sign(data: Uint8Array): Promise<string> }

export interface SetupConnectionProof { readonly kind: "setup-current-connection" }
const setupConnections = new WeakMap<SetupConnectionProof, () => undefined>();
export function currentSetupConnectionProof(proof: SetupConnectionProof): undefined {
  const check = setupConnections.get(proof);
  if (!check) throw new Error("Setup connection is unavailable");
  return check();
}
export function captureSetupConnectionProof(context: TrustedCallContext): SetupConnectionProof {
  if (!context.isCurrent()) throw new Error("Setup connection is unavailable");
  const proof = Object.freeze({kind: "setup-current-connection" as const});
  setupConnections.set(proof, () => { if (!context.isCurrent()) throw new Error("Setup connection is stale"); return undefined; });
  return proof;
}

export interface Identity {
  /** The relay's key object (it signs the relay's challenges). */
  readonly key: DeviceKey;
  /** SPKI, base64url: what `hello.hand.public_key` carries. */
  readonly publicKey: string;
  /** The hand id: the first 22 characters of base64url(sha256(SPKI)), the same as the relay's device id. */
  readonly id: string;
  /** Signs the hub's challenge nonce: ECDSA P-256 over its UTF-8 bytes, ASN.1 DER, base64url (SPEC-03 §2.2). */
  signNonce(nonce: string): string;
}

/** The identity key lives in `<stateDir>/device.jwk` (created on first use, owner-only). */
export async function loadIdentity(stateDir: string): Promise<Identity> {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, "device.jwk");
  let jwk: JsonWebKey;
  let key: DeviceKey;
  if (existsSync(file)) {
    jwk = JSON.parse(readFileSync(file, "utf8"));
    key = await DeviceKey.fromJwk(jwk);
  } else {
    key = await DeviceKey.generate();
    jwk = await key.exportJwk();
    writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  }
  const priv: KeyObject = createPrivateKey({ key: jwk as never, format: "jwk" });
  return {
    key, publicKey: key.publicKey, id: key.id,
    signNonce: (nonce) => base64url(signBytes("sha256", Buffer.from(nonce, "utf8"), { key: priv, dsaEncoding: "der" })),
  };
}

/** Existing Codex helpers use the same persisted relay key, without a second identity. */
export async function fileSigner(stateDir: string): Promise<Signer> { return (await loadIdentity(stateDir)).key; }

/** What `hello.hand` says about this program. */
export function helloHand(identity: Identity, o: { name: string; version: string }) {
  return { kind: "computer" as const, name: o.name, version: o.version, platform: `${process.platform}-${process.arch}`, public_key: identity.publicKey };
}

// ---------------------------------------------------------------------------------------------------------------------
// the tunnel as a WebSocket
// ---------------------------------------------------------------------------------------------------------------------

/** What a tunnel said before anything was listening: the hub speaks first, so its challenge may arrive before the client asks. */
class Tunnel {
  private readonly queue: (string | Uint8Array)[] = [];
  private sink: TunnelSocket | null = null;
  private ended: { code: number; reason: string } | null = null;
  constructor(readonly stream: DeviceStream, private readonly dead: (tunnel: Tunnel) => void) {
    stream.onMessage((message) => { if (this.sink) this.sink.deliver(message); else this.queue.push(message); });
    stream.onClose((result) => { this.ended = result; this.dead(this); this.sink?.ended(result); });
  }
  attach(socket: TunnelSocket): void {
    this.sink = socket;
    for (const message of this.queue.splice(0)) socket.deliver(message);
    if (this.ended) socket.ended(this.ended);
  }
  close(code: number, reason: string): void { this.stream.close(code, reason); }
}

/** The socket `HandClient` is given: it is open as soon as the relay's tunnel is bound to it. */
class TunnelSocket implements RawSocket {
  private tunnel: Tunnel | null = null;
  constructor(private readonly events: SocketEvents, private readonly gone: (socket: TunnelSocket) => void) {}
  get peer(): string | null { return this.tunnel?.stream.peer ?? null; }
  bind(tunnel: Tunnel): void {
    this.tunnel = tunnel;
    this.events.open();
    tunnel.attach(this);
  }
  deliver(message: string | Uint8Array): void { this.events.message(message, typeof message !== "string"); }
  ended({ code, reason }: { code: number; reason: string }): void { this.gone(this); this.events.close(code, reason); }
  send(data: string): void { if (!this.tunnel) throw new Error("the tunnel is not open yet"); this.tunnel.stream.send(data); }
  close(code = 1000, reason = ""): void {
    if (this.tunnel) this.tunnel.close(code, reason);
    else this.gone(this);
  }
  terminate(): void { this.close(1006, "terminated"); }
}

/**
 * Brings the hub's tunnels to the link client. The client asks for a socket (`connector`) whenever it wants to connect;
 * the hub decides when a tunnel arrives (`adopt`). Whichever comes first waits for the other.
 */
export class TunnelPort {
  private waiting: TunnelSocket | null = null;
  private active: TunnelSocket | null = null;
  private stash: Tunnel | null = null;
  /** Set by the owner of the client: a tunnel arrived while the client sleeps between attempts. */
  onIdleTunnel: () => void = () => {};

  readonly connector: Connector = (_url, _headers, events) => {
    const socket = new TunnelSocket(events, (gone) => {
      if (this.waiting === gone) this.waiting = null;
      if (this.active === gone) this.active = null;
    });
    if (this.stash) {
      const tunnel = this.stash;
      this.stash = null;
      this.active = socket;
      queueMicrotask(() => socket.bind(tunnel));
    } else {
      this.waiting = socket;
    }
    return socket;
  };

  /** The hub opened a tunnel on `/link`. */
  adopt(stream: DeviceStream): void {
    const tunnel = new Tunnel(stream, (dead) => { if (this.stash === dead) this.stash = null; });
    if (this.waiting) {
      const socket = this.waiting;
      this.waiting = null;
      this.active = socket;
      socket.bind(tunnel);
      return;
    }
    // A hand has one executor (SPEC-03 §2.2.2): a newer tunnel replaces the one in use. The client reconnects onto it.
    this.stash?.close(1000, "replaced by a newer tunnel");
    this.stash = tunnel;
    if (this.active) this.active.close(1000, "replaced by a newer tunnel");
    else this.onIdleTunnel();
  }

  /** Relay authenticated peer plus current local pairing, never request-supplied identity. */
  captureContext(stateDir: string, ready: () => boolean): TrustedCallContext {
    const pairPath = join(stateDir, "paired.json"), held = readLocalStateFile(pairPath, MAX_PAIR_BYTES);
    const socket = this.active, pairing = loadCurrentPairing(pairPath);
    if (!held || !socket || !pairing || pairing.fingerprint !== held.raw || pairing.revoked || socket.peer !== pairing.ownerId || !ready()) throw new Error("Hub connection is unavailable");
    const context = Object.freeze({ transportOwnerId: pairing.ownerId, isCurrent: () => {
      try {
        const current = readLocalStateFile(pairPath, MAX_PAIR_BYTES);
        return this.active === socket && socket.peer === pairing.ownerId && ready() && current?.identity === held.identity;
      } catch { return false; }
    } });
    return context;
  }

  /** The relay connection went away, or the program is stopping. */
  close(): void {
    this.stash?.close(1000, "closing");
    this.stash = null;
    this.waiting?.close(1000, "closing");
    this.active?.close(1000, "closing");
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Signs in to the relay (`ash-gw/1`) and stays signed in, handing every tunnel the hub opens on `/link` to [port].
 * This is only the road; what travels on it is `ash-link/1`.
 */
export class GatewayLine {
  protected readonly gateway: GatewayClient;
  private conn: Connection | null = null;
  private stopped = false;
  private pairFile?: string;
  private pairedIdentity?: string;
  private readonly tunnels = new Map<string, DeviceStream>();
  /** Side protocols use authenticated relay envelopes, outside ash-link/1. */
  onConnected: (connection: Connection) => void = () => {};
  onFrame: (frame: Record<string, unknown>) => void = () => {};
  onDisconnected: () => void = () => {};
  connected = false;
  lastError = "";

  constructor(url: string, private readonly identity: Identity, private readonly port: TunnelPort, private readonly log: (...args: unknown[]) => void) {
    this.gateway = new GatewayClient(url, identity.key);
  }

  /** Pairs on the first run (the owner approves on their side); later runs only check that the pairing was not revoked. */
  async pair(stateDir: string, code: string | undefined, name: string): Promise<void> {
    const state = new LocalStateTransaction(stateDir);
    const file = join(state.stateDir, "paired.json"); this.pairFile = file;
    try {
      const before = state.capture(), original = before.files["paired.json"];
      if (!code) {
        const pair = original ? parseCurrentPairing(original.raw) : null;
        if (!pair) throw new Error("not paired: use --pair once");
        if (pair.revoked) throw new Error("Device revoked; explicitly pair again to reconnect");
        this.pairedIdentity = original!.identity; return;
      }
      const request = await this.gateway.requestPairing(code, name);
      state.assertCurrent(before);
      this.log("pairing requested", await shortFingerprint(this.identity.publicKey), request.owner_fingerprint);
      state.assertCurrent(before);
      const grant = await this.gateway.waitForApproval(request.request_id, request.owner_key, 10 * 60_000);
      if (this.stopped) throw new Error("Pairing stopped");
      const raw = JSON.stringify({owner_key: request.owner_key, ...grant});
      if (!parseCurrentPairing(raw)) throw new Error("Invalid approved pairing");
      const committed = state.write("paired.json", raw, before); this.pairedIdentity = committed.files["paired.json"]!.identity;
    } finally { state.close(); }
  }

  /** A late revoke cannot alter a replacement owner's pairing. */
  markRevoked(): void {
    this.stopped = true;
    if (!this.pairFile || !this.pairedIdentity) return;
    const state = new LocalStateTransaction(resolve(this.pairFile, ".."));
    try {
      const before = state.capture(), file = before.files["paired.json"];
      const pair = file ? parseCurrentPairing(file.raw) : null;
      if (!file || file.identity !== this.pairedIdentity || !pair || pair.revoked) return;
      state.write("paired.json", JSON.stringify({...JSON.parse(file.raw), revoked:true}), before);
    } catch { /* A changed or unprovable pairing remains untouched. */ }
    finally {state.close();}
  }

  async run(): Promise<void> {
    let delay = 1000;
    while (!this.stopped) {
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        const health = await bounded(this.gateway.health(), STEP_MS, "gateway health");
        if (health.protocol !== "ash-gw/1") { this.stopped = true; throw new Error("Unsupported gateway protocol"); }
        const session = await bounded(this.gateway.authenticate(), STEP_MS, "gateway sign-in");
        const conn = await bounded(this.gateway.connect(session), STEP_MS, "gateway connection", (late) => late.close());
        this.conn = conn; this.connected = true; this.lastError = ""; delay = 1000;
        conn.onUnmatched = (frame) => { if (this.conn !== conn || conn.ws.readyState !== WebSocket.OPEN) return; this.tunnelFrame(conn, frame); this.onFrame(frame); };
        this.onConnected(conn);
        let lastHeard = Date.now();
        let expired!: () => void;
        const silent = new Promise<void>((resolve) => { expired = resolve; });
        conn.ws.addEventListener("message", () => { lastHeard = Date.now(); });
        beat = setInterval(() => {
          if (conn.ws.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastHeard > 90_000) { conn.ws.close(4000, "silent"); expired(); }
          else conn.ws.send("ping");
        }, 30_000);
        const closed = await Promise.race([conn.closed, silent]);
        if (closed && closed.code === 4003) { this.log("the relay says this device was revoked"); this.markRevoked(); }
      } catch (error) {
        this.conn?.close();
        this.lastError = error instanceof Error ? error.message : String(error);
        if (error instanceof GatewayError && /revoked/i.test(error.message)) this.markRevoked();
        this.log("gateway connection failed", this.lastError);
      } finally { if (beat) clearInterval(beat); }
      this.connected = false; this.conn = null; this.onDisconnected();
      for (const stream of this.tunnels.values()) stream.finish({ code: 1006, reason: "relay connection lost" });
      this.tunnels.clear();
      if (this.stopped) break;
      await sleep(delay * (0.5 + Math.random() / 2)); delay = Math.min(delay * 2, 30_000);
    }
  }

  stop(): void { this.stopped = true; this.conn?.close(); this.port.close(); this.onDisconnected(); }

  /** The relay's tunnel frames that its client library did not route. */
  private tunnelFrame(conn: Connection, frame: Record<string, unknown>): void {
    if (frame.t !== "tun" || typeof frame.sid !== "string") return;
    const sid = frame.sid;
    if (frame.op === "ws.open") {
      if (frame.path !== LINK_PATH) { conn.send({ t: "tun", op: "ws.error", sid, message: "unsupported path" }); return; }
      const stream = new DeviceStream(sid, String(frame.from), LINK_PATH, (out) => conn.send(out), () => this.tunnels.delete(sid));
      this.tunnels.set(sid, stream);
      conn.send({ t: "tun", op: "ws.opened", sid });
      this.take(stream);
      return;
    }
    const stream = this.tunnels.get(sid);
    if (stream && (frame.op !== "ws.msg" || frame.from === stream.peer)) stream.accept(frame);
  }

  private take(stream: DeviceStream): void { this.port.adopt(stream); }
}
