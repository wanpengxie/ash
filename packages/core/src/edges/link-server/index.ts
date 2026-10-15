/**
 * link-server (HUB-MODULES §2.1): the one HTTP server of the kernel on 127.0.0.1, and on it `/link`, where hands and
 * channels of people connect with `ash-link/2`. It proves who connects, decides which channels are open
 * (SPEC-03 §2.2.1) and hands each open channel to the module that owns it: the device channel to the hand
 * registry, the others to whatever is mounted with `onChannel`. Other paths (`/mcp`, the web page) are mounted with
 * `mount`; none of them is reachable from the relay.
 *
 * Two ways in (docs/LINK-E2E.md §2): the local link on 127.0.0.1, in the clear, with the local token and the hand's
 * signature; and the relay's tunnels, through `acceptGateway` only, which secures each one (TLS, the owner's endorsement,
 * the paired key) before the link server sees a frame. The relay passes on what it cannot read.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handId } from "../../../../sdk/src/ids";
import { CLOSE_CODES, type HandKind, type HelloFrame, type LinkChannel } from "../../../../sdk/src/link";
import { DEVICE_ASSETS } from "../../../../sdk/src/device-assets.generated";
import { DEVICE_MIN_VERSION, MCP_SERVER_VERSION, versionBefore } from "../../../../sdk/src/versions";
import { SecureRefusal, sameKey, secureHub, type Endorsement, type LinkKey } from "../../../../link/src/secure";
import {
  createLinkServer as createLink, type AuthContext, type AuthResult, type LinkServer, type LinkSession, type SessionHandlers,
} from "../../../../link/src/server";
import type { LinkSocket } from "../../../../link/src/socket";
import { bearerIs, signatureHolds, spkiBytes } from "./auth";
import type { HandConnection, HandRegistry } from "./hands/registry";

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** What a channel module is told about a connection whose channel is open. */
export type ChannelContext = HandConnection;
/** Takes one open channel of one connection; the handlers it returns get that channel's frames. */
export type ChannelAttach = (session: LinkSession, ctx: ChannelContext) => SessionHandlers | void;

export interface LinkServerOptions {
  hostClient: { handsHandoff(port: number, token: string): Promise<unknown> };
  hands: HandRegistry;
  kernel?: { id: string; version: string };
  /** 0 or absent: any free port. */
  port?: number;
  log?: (message: string, error?: unknown) => void;
}

export interface Started { port: number; token: string }

/** One live connection of a hand: which channels are open on it and how it arrived. */
export interface LinkConnection {
  /** The session id. */
  conn: string;
  hand: string;
  name: string;
  kind: HandKind;
  /** The channels the owner's rules opened (not the ones the hand only asked for). */
  channels: LinkChannel[];
  /** Every channel with the grant it got (the reason when refused). */
  grants: Partial<Record<LinkChannel, { accepted: boolean; reason?: string }>>;
  via: "local" | "gateway";
  since: number;
}

/** What `observe` reports: connections coming and going, and handshakes that were refused. */
export type LinkEvent =
  | { type: "connected"; conn: LinkConnection }
  | { type: "closed"; conn: LinkConnection; code: number; reason: string }
  | { type: "refused"; hand?: string; via: "local" | "gateway"; code: number; reason: string };

export interface HubLinkServer {
  /** Opens the port on 127.0.0.1, makes the local token and tells the host both. */
  start(): Promise<Started>;
  stop(): Promise<void>;
  /** Routes `path` and everything under it to [handler] on 127.0.0.1; `/` takes what no other mount does. `/link` is not available. */
  mount(path: string, handler: HttpHandler): void;
  /** Gives a channel to the module that owns it. `device` belongs to the hand registry. */
  onChannel(channel: Exclude<LinkChannel, "device">, attach: ChannelAttach): void;
  /**
   * A tunnel the hub opened through the relay to device [from]. It is secured first ([GatewaySecurity]); only then does the
   * handshake begin, and the connection is judged like any other, by the hand's record and the key it proved.
   */
  acceptGateway(tunnel: LinkSocket, from: string, security: GatewaySecurity): void;
  /** The live connections, oldest first. */
  connections(): LinkConnection[];
  /** Closes one connection by its session id; false when it is not there. */
  closeConnection(conn: string, code: number, reason: string): boolean;
  /** Told of every connection, close and refused handshake. Returns the stopper. */
  observe(listener: (event: LinkEvent) => void): () => void;
}

/** What securing a relay tunnel needs from the hub (the gateway control module keeps it). */
export interface GatewaySecurity {
  /** The hub's TLS key and the owner's endorsement of it. */
  key: LinkKey;
  endorsement: Endorsement;
  /** Set until the device proved the one-time pairing secret on its first connection. */
  pairSecret: string | null;
  /** The device proved it. */
  paired?(): void;
  /** The connection was not secured; [refusal.pairing]: the pairing secret did not hold (a key was swapped on the way). */
  refused?(refusal: SecureRefusal): void;
}

/** Marks a socket as one that came through a secured relay tunnel; only `acceptGateway` makes one. [peerKey] is the key the device proved. */
class FromGateway { constructor(readonly from: string, readonly peerKey: string) {} }

const refuse = (code: number, reason: string): AuthResult => ({ ok: false, code, reason });
const newClient = () => `client:${randomBytes(9).toString("base64url")}`;

export function createLinkServer(options: LinkServerOptions): HubLinkServer {
  const { hands, hostClient } = options;
  const log = options.log ?? (() => {});
  const channels = new Map<Exclude<LinkChannel, "device">, ChannelAttach>();
  const mounts = new Map<string, HttpHandler>();
  /** Whether each handshake came over the local link, until its session is made (the server hands the same `hello` object on). */
  const locals = new WeakMap<HelloFrame, boolean>();
  const open = new Map<string, LinkConnection>();
  const listeners = new Set<(event: LinkEvent) => void>();
  const tell = (event: LinkEvent) => { for (const l of listeners) try { l(event); } catch (error) { log("observer failed", error); } };
  let token = "";
  let http: Server | null = null;
  let port = 0;

  async function authenticate(hello: HelloFrame, ctx: AuthContext): Promise<AuthResult> {
    const relay = ctx.meta instanceof FromGateway ? ctx.meta : null;
    let who: string | undefined = relay?.from;
    const verdict = await judge(hello, ctx, relay, (id) => { who = id; });
    if (!verdict.ok) tell({ type: "refused", ...(who ? { hand: who } : {}), via: relay ? "gateway" : "local", code: verdict.code, reason: verdict.reason ?? "" });
    return verdict;
  }

  async function judge(hello: HelloFrame, ctx: AuthContext, relay: FromGateway | null, known: (id: string) => void): Promise<AuthResult> {
    const key = hello.hand.public_key;
    if (!relay && !bearerIs(ctx.headers.authorization, token)) return refuse(CLOSE_CODES.unauthenticated, "bad token");
    if (!relay && (!key || !hello.sig)) return refuse(CLOSE_CODES.unauthenticated, "the identity was not proven");
    if (relay && !key) return refuse(CLOSE_CODES.unauthenticated, "the identity was not proven");
    if (key && (!hello.sig || !spkiBytes(key) || !signatureHolds(key, ctx.nonce, hello.sig))) return refuse(CLOSE_CODES.unauthenticated, "the signature does not hold");
    // Through the relay, the hello must name the key the device proved in TLS.
    if (relay && !sameKey(key!, relay.peerKey)) return refuse(CLOSE_CODES.unauthenticated, "the key is not the one the connection was secured with");
    const id = await handId(spkiBytes(key!)!);
    if (relay && id !== relay.from) return refuse(CLOSE_CODES.unauthenticated, "the key is not the device's");
    known(id);
    // Too old to talk with: closed with 4008 inside TLS, which also names the release to install (secure.ts).
    if (relay && hello.hand.kind === "computer" && versionBefore(hello.hand.version, DEVICE_MIN_VERSION)) {
      return refuse(CLOSE_CODES.unsupported, `this computer's program ${hello.hand.version.slice(0, 20)} is older than ${DEVICE_MIN_VERSION}; it updates itself`);
    }

    const hand = hands.get(id);
    if (hand?.revoked_at) return refuse(CLOSE_CODES.revoked, "revoked");
    locals.set(hello, !relay);
    if (relay) {
      // A hand that came through the relay is held to what the owner allowed it (SPEC-03 §2.2.1).
      if (!hand) return refuse(CLOSE_CODES.unauthenticated, "unknown device");
      return {
        ok: true, hand_id: id,
        channels: {
          // The device channel carries the manifest, which a body needs even when the hand itself lends nothing.
          device: hand.lend || hands.isBound(id) ? { accepted: true } : { accepted: false, reason: "the owner has not allowed this device to lend capabilities or serve as a body" },
          human: { accepted: false, reason: "a device's own page is not served through the relay yet" },
          agent: hand.local_agents && hand.kind === "computer" ? { accepted: true } : { accepted: false, reason: "the owner has not allowed this computer to run local agents" },
        },
      };
    }
    if (!hand) hands.registerLocal(id, hello.hand);
    return {
      ok: true, hand_id: id,
      channels: {
        device: { accepted: true },
        human: { accepted: true, client: newClient(), local: true },
        agent: { accepted: false, reason: "agents on this machine are driven by the kernel, not over the link" },
      },
    };
  }

  const granted = (session: LinkSession, channel: LinkChannel): boolean => {
    const grant = session.channels[channel];
    return Boolean(grant && (channel === "human" ? "client" in grant : (grant as { accepted: boolean }).accepted));
  };

  const describe = (session: LinkSession, local: boolean): LinkConnection => {
    const grants: LinkConnection["grants"] = {};
    for (const channel of Object.keys(session.channels) as LinkChannel[]) {
      const grant = session.channels[channel] as { accepted?: boolean; reason?: string; client?: string };
      grants[channel] = granted(session, channel) ? { accepted: true } : { accepted: false, ...(grant?.reason ? { reason: grant.reason } : {}) };
    }
    return {
      conn: session.id, hand: session.handId, name: session.hello.hand.name, kind: session.hello.hand.kind, grants,
      channels: (Object.keys(grants) as LinkChannel[]).filter((c) => grants[c]?.accepted), via: local ? "local" : "gateway", since: Date.now(),
    };
  };

  const kernel = options.kernel ?? { id: "ash-hub", version: MCP_SERVER_VERSION };
  const link: LinkServer = createLink({
    kernel,
    authenticate,
    log,
    refused: ({ code, reason, meta }) => tell({ type: "refused", ...(meta instanceof FromGateway ? { hand: meta.from } : {}), via: meta instanceof FromGateway ? "gateway" : "local", code, reason }),
    onSession(session) {
      const ctx: ChannelContext = { handId: session.handId, hello: session.hello, local: locals.get(session.hello) ?? false };
      const parts: SessionHandlers[] = [];
      if (granted(session, "device")) parts.push(hands.attach(session, ctx));
      for (const [channel, attach] of channels) if (granted(session, channel)) { const handlers = attach(session, ctx); if (handlers) parts.push(handlers); }
      hands.touch(session.handId, session.hello.hand);
      const conn = describe(session, ctx.local);
      open.set(session.id, conn);
      tell({ type: "connected", conn });
      return { ...handlersOf(parts), closed: (code, reason) => { for (const part of parts) part.closed?.(code, reason); open.delete(session.id); tell({ type: "closed", conn, code, reason }); } };
    },
  });
  hands.bindLink({
    closeHand: (id, code, reason) => { for (const s of link.sessions()) if (s.handId === id) s.close(code, reason); },
  });

  const route = (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://link.invalid").pathname;
    const match = mountFor(path);
    if (!match) { res.writeHead(404).end(); return; }
    mounts.get(match)!(req, res);
  };
  const mountFor = (path: string) => [...mounts.keys()].filter((m) => m === "/" || path === m || path.startsWith(`${m}/`)).sort((a, b) => b.length - a.length)[0];

  const self: HubLinkServer = {
    async start() {
      token = randomBytes(32).toString("base64url");
      const server = createServer(route);
      http = server;
      link.attach(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
      port = (server.address() as AddressInfo).port;
      try {
        await hostClient.handsHandoff(port, token);
      } catch (error) {
        await self.stop();
        throw error;
      }
      return { port, token };
    },
    async stop() {
      link.close();
      const server = http;
      http = null;
      port = 0;
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    mount(path, handler) {
      if (!path.startsWith("/") || path === "/link" || path.startsWith("/link/")) throw new Error(`cannot mount ${path}`);
      if (mounts.has(path)) throw new Error(`${path} is already mounted`);
      mounts.set(path, handler);
    },
    onChannel(channel, attach) {
      if (channels.has(channel)) throw new Error(`the ${channel} channel already has an owner`);
      channels.set(channel, attach);
    },
    acceptGateway(tunnel, from, security) {
      const refused = (code: number, reason: string) => tell({ type: "refused", hand: from, via: "gateway", code, reason });
      // Without a key on record there is nothing to secure the tunnel against. A revoked hand is still secured, so that it
      // hears 4003 from the hub itself (inside TLS) and stops; a close code in the clear could be the relay's.
      const hand = hands.get(from);
      if (!hand?.public_key) {
        refused(CLOSE_CODES.unauthenticated, "unknown device");
        tunnel.close(CLOSE_CODES.unauthenticated, "unknown device");
        return;
      }
      secureHub(tunnel, { key: security.key, endorsement: security.endorsement, kernel, deviceKey: hand.public_key, pairSecret: security.pairSecret, release: DEVICE_ASSETS }).then(({ socket, peerKey }) => {
        if (security.pairSecret) security.paired?.();
        link.accept(socket, { meta: new FromGateway(from, peerKey) });
      }, (error: unknown) => {
        const refusal = error instanceof SecureRefusal ? error : new SecureRefusal(CLOSE_CODES.internal, error instanceof Error ? error.message : String(error));
        refused(refusal.code, refusal.message);
        security.refused?.(refusal);
      });
    },
    connections: () => [...open.values()],
    closeConnection: (conn, code, reason) => link.closeSession(conn, code, reason),
    observe(listener) { listeners.add(listener); return () => void listeners.delete(listener); },
  };
  return self;
}

/** One handler set from the sets of the channels: each kind of frame belongs to one channel, streams go to all. */
function handlersOf(parts: SessionHandlers[]): SessionHandlers {
  const first = <K extends keyof SessionHandlers>(key: K): SessionHandlers[K] => parts.find((p) => p[key])?.[key];
  return {
    manifest: first("manifest"), event: first("event"), human: first("human"), agent: first("agent"),
    stream: (stream) => { for (const part of parts) part.stream?.(stream); },
  };
}
