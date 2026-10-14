/**
 * The computer program's connection (SPEC-03): `ash-link/2` with the hub, over the relay, secured end to end
 * (docs/LINK-E2E.md).
 *
 * The program is a hand. It signs in to the relay as itself (`GatewayLine`: the relay protocol `ash-gw/1`, unchanged);
 * when the hub wants it, the relay hands over a tunnelled WebSocket for path `/link`. `TunnelPort` makes that tunnel look
 * like the WebSocket `HandClient` (packages/link) opens by itself, and the link package's `secureConnector` runs TLS on it
 * and checks the hub against the owner key pinned in `paired.json` ([PairingFile]) before the handshake begins.
 */
import { createPrivateKey, sign as signBytes, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, DeviceKey, DeviceStream, GatewayClient, GatewayError } from "ash-gateway/client/client";
import { shortFingerprint } from "ash-gateway/src/protocol";
import { base64url } from "../../sdk/src/ids";
import type { Connector, SocketEvents } from "../../link/src/hand";
import { linkKey, type LinkKey } from "../../link/src/secure";
import type { RawSocket } from "../../link/src/socket";
import { bounded, STEP_MS } from "./bounded";

export { bounded, STEP_MS } from "./bounded";

/** The path the hub's tunnel opens on this program (SPEC-03 §8.1). Any other path is refused. */
export const LINK_PATH = "/link";

// ---------------------------------------------------------------------------------------------------------------------
// who this computer is
// ---------------------------------------------------------------------------------------------------------------------

export interface Identity {
  /** The relay's key object (it signs the relay's challenges). */
  readonly key: DeviceKey;
  /** SPKI, base64url: what `hello.hand.public_key` carries. */
  readonly publicKey: string;
  /** The hand id: the first 22 characters of base64url(sha256(SPKI)), the same as the relay's device id. */
  readonly id: string;
  /** Signs the hub's challenge nonce: ECDSA P-256 over its UTF-8 bytes, ASN.1 DER, base64url (SPEC-03 §2.2). */
  signNonce(nonce: string): string;
  /** The same key for TLS, with its certificate. */
  readonly link: LinkKey;
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
    key, publicKey: key.publicKey, id: key.id, link: linkKey(priv),
    signNonce: (nonce) => base64url(signBytes("sha256", Buffer.from(nonce, "utf8"), { key: priv, dsaEncoding: "der" })),
  };
}

/**
 * `<stateDir>/paired.json`: the owner key this computer pinned, the relay's grant, whether it was revoked, and the one-time
 * pairing secret until the hub proved it on the first connection. Until then the owner key is only what the relay said.
 */
export class PairingFile {
  constructor(readonly file: string) {}
  read(): Record<string, unknown> { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; }
  write(value: Record<string, unknown>): void { writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 }); }
  /** What the secure connection checks the hub against. */
  trust(): { ownerKey: string; pairSecret: string | null } {
    const pairing = this.read();
    return { ownerKey: typeof pairing.owner_key === "string" ? pairing.owner_key : "", pairSecret: typeof pairing.secret === "string" ? pairing.secret : null };
  }
  /** The hub proved the pairing secret: [ownerKey] is the owner's. The secret is not needed any more. */
  pin(ownerKey: string): void {
    const { secret: _secret, ...rest } = this.read();
    this.write({ ...rest, owner_key: ownerKey, proved_at: Date.now() });
  }
}

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
 * This is only the road; what travels on it is TLS, and inside it `ash-link/2`.
 */
export class GatewayLine {
  private readonly gateway: GatewayClient;
  private conn: Connection | null = null;
  private stopped = false;
  private pairing?: PairingFile;
  private readonly tunnels = new Map<string, DeviceStream>();
  connected = false;
  lastError = "";

  constructor(url: string, private readonly identity: Identity, private readonly port: TunnelPort, private readonly log: (...args: unknown[]) => void) {
    this.gateway = new GatewayClient(url, identity.key);
  }

  /**
   * Pairs on the first run (the device asks the relay with the code; Ash lets it in); later runs only check that the pairing was
   * not revoked. The owner key the relay names is kept with the secret: the first secure connection proves which key is real.
   */
  async pair(pairing: PairingFile, ask: { code: string; secret: string } | undefined, name: string): Promise<void> {
    this.pairing = pairing;
    if (existsSync(pairing.file) && !ask) {
      if (pairing.read().revoked) throw new Error("Device revoked; explicitly pair again to reconnect");
      return;
    }
    if (!ask) throw new Error("not paired: run the install command Ash gives (setup --pair CODE --secret SECRET) once");
    const request = await this.gateway.requestPairing(ask.code, name);
    this.log("pairing requested", await shortFingerprint(this.identity.publicKey), request.owner_fingerprint);
    const grant = await this.gateway.waitForApproval(request.request_id, request.owner_key, 10 * 60_000);
    pairing.write({ owner_key: request.owner_key, ...grant, secret: ask.secret });
  }

  /** Remember that the owner revoked this computer: it will not reconnect until it is paired again. */
  markRevoked(): void {
    this.stopped = true;
    if (this.pairing && existsSync(this.pairing.file)) this.pairing.write({ ...this.pairing.read(), revoked: true });
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
        conn.onUnmatched = (frame) => this.tunnelFrame(conn, frame);
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
      this.connected = false; this.conn = null;
      for (const stream of this.tunnels.values()) stream.finish({ code: 1006, reason: "relay connection lost" });
      this.tunnels.clear();
      if (this.stopped) break;
      await sleep(delay * (0.5 + Math.random() / 2)); delay = Math.min(delay * 2, 30_000);
    }
  }

  stop(): void { this.stopped = true; this.conn?.close(); this.port.close(); }

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
