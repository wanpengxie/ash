/**
 * A kernel as the hand registry and the link server see it: a database, a registry and router of fakes, a body split
 * that follows `bodies.ts`, and real `packages/link` clients as the phone and the computer.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { base64url, handId } from "../../../../sdk/src/ids";
import { DEVICE_VERSION } from "../../../../sdk/src/versions";
import type { CapabilitySpec } from "../../../../sdk/src/link";
import type { Caller, Outgoing, Reply } from "../../../../sdk/src/message";
import type { Member } from "../../../../sdk/src/word";
import { createNodeClient } from "../../../../link/src/client";
import { HandClient, type Connector, type EventQueue, type HandHandlers } from "../../../../link/src/hand";
import { linkKey, secureConnector, type DeviceRelease, type LinkKey } from "../../../../link/src/secure";
import { memoryPair } from "../../../../link/test/fixtures/memory";
import { endorse, party } from "../../../../link/test/fixtures/secure";
import { createLinkServer, type GatewaySecurity, type HubLinkServer } from "../../../src/edges/link-server";
import { HandRegistry } from "../../../src/edges/link-server/hands/registry";
import type { MemberInfo, Registry, Router } from "../../../src/kernel/types";

/** Every client a test started; the hub stops them so none is left reconnecting. */
const clients = new Set<HandClient>();

export interface Identity { publicKey: string; handId: string; sign(nonce: string): string; /** The same key for TLS on a relay tunnel. */ link: LinkKey }

export async function newIdentity(): Promise<Identity> {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    publicKey: base64url(spki), handId: await handId(spki), link: linkKey(privateKey),
    sign: (nonce) => base64url(signBytes("sha256", Buffer.from(nonce, "utf8"), { key: privateKey, dsaEncoding: "der" })),
  };
}

/** The hub's side of securing relay tunnels in tests: an owner key, the hub's TLS key and the owner's endorsement of it. */
export function relaySecurity(): { ownerKey: string; security: GatewaySecurity } {
  const owner = party(), hub = party();
  return { ownerKey: owner.publicKey, security: { key: hub.key, endorsement: endorse(owner, hub), pairSecret: null } };
}

/**
 * A device's end of a relay tunnel: TLS over [connect]'s socket, the hub checked against [ownerKey] (what the device pinned at
 * pairing), as `ash-device` does.
 */
export const secureDevice = (identity: Identity, ownerKey: string, connect: Connector, update?: (release: DeviceRelease) => void): Connector =>
  secureConnector(connect, { key: identity.link, trust: () => ({ ownerKey, pairSecret: null }), update });

export const cap = (name: string, over: Partial<CapabilitySpec> = {}): CapabilitySpec =>
  ({ name, description: `${name}: a capability of the test hand.`, label: `在${name}`, input_schema: { type: "object" }, effect: "read", risk: "none", ...over });

/** The registry's part this module uses, plus `find` so a test can see what a call would reach. */
export class FakeRegistry implements Registry {
  readonly members = new Map<string, Member>();
  add(m: Member): void { this.members.set(m.id, m); }
  remove(id: string): void { this.members.delete(id); }
  find(to: string, word: string) {
    const member = this.members.get(to);
    const contract = member?.words().find((w) => w.word === word);
    return member && contract ? { member, contract } : null;
  }
  findByWord(word: string): Member[] { return [...this.members.values()].filter((m) => m.words().some((w) => w.word === word)); }
  get(id: string): Member | null { return this.members.get(id) ?? null; }
  listeners(): Member[] { return []; }
  list(): MemberInfo[] { return [...this.members.values()].map((m) => ({ id: m.id, kind: m.kind, name: m.name })); }
  describe(): null { return null; }
  onChange(): () => void { return () => {}; }
}

export interface Sent { msg: Outgoing; caller: Caller }
export class FakeRouter implements Router {
  readonly sent: Sent[] = [];
  /** The answer for `<to>/<word>`; absent = ok. */
  readonly answers = new Map<string, (msg: Outgoing) => Reply>();
  async send(msg: Outgoing, caller: Caller): Promise<Reply> {
    this.sent.push({ msg, caller });
    return this.answers.get(`${msg.to}/${msg.word}`)?.(msg) ?? { ok: true };
  }
  subscribe(): () => void { return () => {}; }
  recover(): void {}
}

/** `splitBodyCapabilities` as bodies.ts defines it. */
export const splitBody = <C extends { name: string }>(hand: { id: string; bound: boolean }, caps: readonly C[]) => {
  const isBody = (c: C) => c.name.startsWith("workspace.") || c.name === "body.info";
  const body = hand.bound ? caps.filter(isBody) : [];
  return { hand: caps.filter((c) => !isBody(c)), body, bodyId: body.length ? `body:${hand.id}` : null };
};

export class FakeBodies {
  readonly bound = new Set<string>();
  readonly forgotten: string[] = [];
  isBound = (hand: string) => this.bound.has(hand);
  forget = (hand: string) => { this.bound.delete(hand); this.forgotten.push(hand); };
}

export interface Hub {
  db: DatabaseSync;
  registry: FakeRegistry;
  router: FakeRouter;
  bodies: FakeBodies;
  hands: HandRegistry;
  server: HubLinkServer;
  /** How relay tunnels to this hub are secured, and the owner key devices pin. */
  relay: { ownerKey: string; security: GatewaySecurity };
  handoffs: { port: number; token: string }[];
  port: number;
  token: string;
  url: string;
  stop(): Promise<void>;
}

export async function startHub(): Promise<Hub> {
  const db = new DatabaseSync(":memory:");
  const registry = new FakeRegistry();
  const router = new FakeRouter();
  const bodies = new FakeBodies();
  const hands = new HandRegistry({ db, registry, router, bodies, splitBodyCapabilities: splitBody });
  const handoffs: { port: number; token: string }[] = [];
  const server = createLinkServer({
    hands,
    hostClient: { handsHandoff: async (port: number, token: string) => { handoffs.push({ port, token }); return { supported: false } as const; } },
  });
  const { port, token } = await server.start();
  return { db, registry, router, bodies, hands, server, relay: relaySecurity(), handoffs, port, token, url: `ws://127.0.0.1:${port}/link`, stop: async () => { for (const c of clients) c.stop(); clients.clear(); await server.stop(); } };
}

export interface HandOptions {
  identity?: Identity;
  kind?: "phone" | "computer" | "browser";
  name?: string;
  channels?: { device?: object; human?: object; agent?: object };
  token?: string | null;
  handlers?: HandHandlers;
  signWith?: Identity;
  url?: string;
  eventQueue?: EventQueue;
  /** The program version the hand says (default: the hub's own release of the computer program through the relay, 0.0.1 locally). */
  version?: string;
  platform?: string;
}

export interface TestHand {
  client: HandClient;
  identity: Identity;
  /** `device:<hand_id>` */
  member: string;
  closes: { code: number; reason: string; willReconnect: boolean }[];
}

/** A hand on the local link. Started, not waited for. */
export async function connect(hub: Pick<Hub, "url" | "token">, o: HandOptions = {}): Promise<TestHand> {
  const identity = o.identity ?? await newIdentity();
  const closes: TestHand["closes"] = [];
  const client = createNodeClient({
    url: o.url ?? hub.url,
    headers: (): Record<string, string> => (o.token === null ? {} : { authorization: `Bearer ${o.token ?? hub.token}` }),
    hand: { kind: o.kind ?? "phone", name: o.name ?? "test hand", version: o.version ?? "0.0.1", platform: o.platform ?? "test", public_key: identity.publicKey },
    channels: (o.channels ?? { device: {} }) as never,
    sign: (nonce) => (o.signWith ?? identity).sign(nonce),
    eventQueue: o.eventQueue,
    handlers: { ...o.handlers, closed: (info) => { closes.push(info); o.handlers?.closed?.(info); } },
  });
  clients.add(client);
  client.start();
  return { client, identity, member: `device:${identity.handId}`, closes };
}

/** A hand that is connected and has sent its manifest. */
export async function connected(hub: Pick<Hub, "url" | "token">, o: HandOptions & { capabilities?: CapabilitySpec[]; events?: string[] } = {}) {
  const hand = await connect(hub, o);
  await hand.client.ready();
  const ack = await hand.client.setManifest(o.capabilities ?? [], (o.events ?? []).map((word) => ({ word, description: `${word} from the test hand` })));
  return { ...hand, ack };
}

/** A hand that reaches the hub through a relay tunnel for device [from]: secured end to end, then judged by the hand's record. */
export function connectViaRelay(hub: Pick<Hub, "server" | "relay">, from: string, identity: Identity, o: Omit<HandOptions, "identity" | "token"> & { update?: (release: DeviceRelease) => void } = {}): TestHand {
  const closes: TestHand["closes"] = [];
  const client = new HandClient({
    url: "relay://tunnel/link",
    connector: secureDevice(identity, hub.relay.ownerKey, (_url, _headers, events) => {
      const pair = memoryPair();
      pair.hand.on("message", (data: string) => events.message(data, false));
      pair.hand.on("close", (code: number, reason: Buffer) => events.close(code, reason.toString()));
      hub.server.acceptGateway(pair.server, from, hub.relay.security);
      queueMicrotask(() => events.open());
      return pair.hand;
    }, o.update),
    hand: { kind: o.kind ?? "computer", name: o.name ?? "relay hand", version: o.version ?? DEVICE_VERSION, platform: "test", public_key: identity.publicKey },
    channels: (o.channels ?? { device: {} }) as never,
    sign: (nonce) => identity.sign(nonce),
    eventQueue: o.eventQueue,
    handlers: { ...o.handlers, closed: (info) => { closes.push(info); o.handlers?.closed?.(info); } },
  });
  clients.add(client);
  client.start();
  return { client, identity, member: `device:${identity.handId}`, closes };
}
