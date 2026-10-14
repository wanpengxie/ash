/**
 * The secure layer between a hub and a device, with a relay in the middle that a test can turn hostile: it records every
 * message, and it can change, hold back, repeat or swap them.
 */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { base64url } from "../../../sdk/src/ids";
import { CLOSE_CODES } from "../../../sdk/src/link";
import type { Connector, SocketEvents } from "../../src/hand";
import { endorsementText, linkKey, secureHub, type Endorsement, type HubSecureOptions, type LinkKey } from "../../src/secure";
import { createLinkServer, type LinkServer, type LinkSession, type SessionHandlers } from "../../src/server";
import type { LinkSocket, RawSocket } from "../../src/socket";

export interface Party { privateKey: KeyObject; publicKey: string; key: LinkKey; sign(text: string): string }

export function party(): Party {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey, publicKey: base64url(publicKey.export({ type: "spki", format: "der" })), key: linkKey(privateKey),
    sign: (text) => base64url(sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "der" })),
  };
}

/** The owner's endorsement of [hub]'s key, signed by [owner], valid until [expiresAt]. */
export function endorse(owner: Party, hub: Party, expiresAt = Date.now() + 86_400_000): Endorsement {
  const unsigned = { owner_key: owner.publicKey, hub_key: hub.key.publicKey, expires_at: expiresAt };
  return { ...unsigned, sig: owner.sign(endorsementText(unsigned)) };
}

type Dir = "down" | "up";
type Listener = (...args: any[]) => void;

/** One relay tunnel: `down` is hub → device, `up` is device → hub. Messages arrive asynchronously and in order unless [tamper] says otherwise. */
export class Wire {
  readonly log: { dir: Dir; text: string }[] = [];
  /** Decides what reaches the other end; [pass] delivers. Default: everything, unchanged. */
  tamper: ((dir: Dir, text: string, pass: (text: string) => void) => void) | null = null;
  closedWith: { code: number; reason: string } | null = null;
  private readonly hubListeners: Record<string, Listener[]> = { message: [], close: [] };
  private deviceEvents: SocketEvents | null = null;
  private readonly early: string[] = [];

  /** The hub's end, as the relay client hands it over. */
  readonly hub: LinkSocket = {
    send: (data) => this.carry("down", data),
    close: (code = 1000, reason = "") => this.end(code, reason),
    terminate: () => this.end(1006, "terminated"),
    on: (event, listener) => { this.hubListeners[event]!.push(listener); return undefined; },
  };

  /** The device's end, as the device's tunnel port hands it to a connector. */
  device(events: SocketEvents): RawSocket {
    this.deviceEvents = events;
    queueMicrotask(() => { events.open(); for (const text of this.early.splice(0)) events.message(text, false); });
    return { send: (data) => this.carry("up", data), close: (code = 1000, reason = "") => this.end(code, reason), terminate: () => this.end(1006, "terminated") };
  }

  /** Puts [text] on the wire as if one end had sent it (a replay, a forgery). */
  inject(dir: Dir, text: string): void { this.deliver(dir, text); }

  private carry(dir: Dir, text: string): void {
    if (this.closedWith) return;
    this.log.push({ dir, text });
    queueMicrotask(() => {
      if (this.tamper) this.tamper(dir, text, (out) => this.deliver(dir, out));
      else this.deliver(dir, text);
    });
  }
  private deliver(dir: Dir, text: string): void {
    if (this.closedWith) return;
    if (dir === "up") { for (const l of this.hubListeners.message!) l(text, false); return; }
    if (this.deviceEvents) this.deviceEvents.message(text, false);
    else this.early.push(text);
  }
  end(code: number, reason: string): void {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => {
      for (const l of this.hubListeners.close!) l(code, Buffer.from(reason));
      this.deviceEvents?.close(code, reason);
    });
  }
}

export interface SecureWorld {
  owner: Party;
  hub: Party;
  device: Party;
  link: LinkServer;
  sessions: LinkSession[];
  wires: Wire[];
  /** What each secured hub end resolved or was refused with. */
  outcomes: ({ ok: true; peerKey: string } | { ok: false; code: number; reason: string; pairing: boolean })[];
  /** A connector over a fresh wire each time; the hub end is secured with [hubOptions] (asked each time). */
  connector: Connector;
}

/** A hub (link server behind `secureHub`) that a device reaches through [Wire]s. */
export function secureWorld(o: { hubOptions?: (world: Omit<SecureWorld, "connector">) => Partial<HubSecureOptions>; handlers?: (session: LinkSession) => SessionHandlers; onWire?: (wire: Wire) => void } = {}): SecureWorld {
  const owner = party(), hub = party(), device = party();
  const sessions: LinkSession[] = [];
  const link = createLinkServer({
    kernel: { id: "hub-test", version: "0.0.0" },
    // The relay's tunnel carries the TLS peer's key; the hello must name the same key.
    authenticate: (hello, ctx) => hello.hand.public_key === ctx.meta
      ? { ok: true, hand_id: hello.hand.name, channels: { device: { accepted: true } } }
      : { ok: false, code: CLOSE_CODES.unauthenticated, reason: "the key is not the TLS peer's" },
    onSession: (session) => { sessions.push(session); return o.handlers?.(session); },
  });
  const world = { owner, hub, device, link, sessions, wires: [] as Wire[], outcomes: [] as SecureWorld["outcomes"] };
  const connector: Connector = (_url, _headers, events) => {
    const wire = new Wire();
    world.wires.push(wire);
    o.onWire?.(wire);
    const options: HubSecureOptions = { key: hub.key, endorsement: endorse(owner, hub), kernel: { id: "hub-test", version: "0.0.0" }, deviceKey: device.publicKey, pairSecret: null, ...o.hubOptions?.(world) };
    secureHub(wire.hub, options).then(({ socket, peerKey }) => {
      world.outcomes.push({ ok: true, peerKey });
      link.accept(socket, { meta: peerKey });
    }, (error) => world.outcomes.push({ ok: false, code: error.code, reason: error.message, pairing: error.pairing }));
    return wire.device(events);
  };
  return { ...world, connector };
}
