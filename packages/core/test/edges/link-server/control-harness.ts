/**
 * The link control module with a hub around it: the real link server and hand registry, a fake relay (the owner's side of
 * `ash-gw/1`), and devices that reach the hub through that relay's tunnels, secured end to end as `ash-device` does.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { connect, createServer } from "node:net";
import { base64url, handId } from "../../../../sdk/src/ids";
import type { HandKind } from "../../../../sdk/src/link";
import { WordError, type HandleContext, type Message } from "../../../../sdk/src/message";
import type { CapabilitySpec } from "../../../../sdk/src/link";
import { HandClient } from "../../../../link/src/hand";
import { secureConnector, type SecureRefusal } from "../../../../link/src/secure";
import { Endpoint, FakeGateway, connectorOver } from "../../../../link/test/fixtures/fake-gateway";
import { createLinkControl, type LinkControl, type LinkControlDeps } from "../../../src/edges/link-server/control/words";
import type { OwnerIdentity } from "../../../src/edges/link-server/control/gateway";
import { Devices } from "../../../src/edges/link-server/hands/devices";
import { MAX_VALUE_LENGTH, REF_PATTERN } from "../../../src/kernel/vault";
import { startHub, newIdentity, type Hub, type Identity } from "./harness";

export const owner: HandleContext = { signal: new AbortController().signal, caller: { member: "person:owner", via: "human", local: true }, raw: undefined };
export const agent: HandleContext = { ...owner, caller: { member: "agent:main", via: "agent", local: false } };

export const freePort = () => new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)); });
});
/** Whether something accepts connections on the port. */
export const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect(port, "127.0.0.1");
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

/** Takes what the real vault takes: a name it would refuse is refused here too (a ref like `a.b` once passed these tests and failed on a phone). */
export class MemoryVault {
  readonly values = new Map<string, string>();
  set(ref: string, value: string): void {
    if (!REF_PATTERN.test(ref)) throw new TypeError("a credential name is letters, digits and _, starting with a letter or _ (at most 64)");
    if (typeof value !== "string" || !value.trim() || value.length > MAX_VALUE_LENGTH) throw new TypeError("a credential value is a non-empty string of at most 4096 characters");
    this.values.set(ref, value);
  }
  use(ref: string): string | null { return this.values.get(ref) ?? null; }
}

/** The hub's own key, as the host holds it: only signing is asked of it. */
export async function hubKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const identity: OwnerIdentity = {
    key: async () => ({ id: await handId(spki), public_key: base64url(spki) }),
    sign: async (data) => ({ sig: base64url(signBytes("sha256", Buffer.from(data, "base64url"), { key: privateKey, dsaEncoding: "der" })) }),
  };
  return { identity, id: await handId(spki), publicKey: base64url(spki) };
}

let n = 0;
export const msg = (to: string, word: string, body: unknown = {}, from = "person:owner"): Message =>
  ({ seq: ++n, id: `m${n}`, ts: 0, from, to, kind: "request", word, body });

export interface TestDevice {
  identity: Identity;
  clients: HandClient[];
  id: string;
  /** Owner keys it pinned when the hub proved a pairing secret. */
  pinned: string[];
  /** Connections it did not let through, and why. */
  refusals: SecureRefusal[];
}

export interface World {
  hub: Hub;
  gw: FakeGateway;
  /** The hub's own key (what the relay knows the owner by). */
  key: { id: string; publicKey: string };
  vault: MemoryVault;
  control: LinkControl;
  devices: Devices;
  /** Calls a word of `service:link` as the owner (or as [ctx]). */
  link(word: string, body?: unknown, ctx?: HandleContext): Promise<any>;
  /** The error code of a refused call. */
  refused(word: string, body?: unknown, ctx?: HandleContext): Promise<string>;
  /** A device that the owner paired (`lend`: may lend capabilities), known to the relay with [permissions]. It speaks `ash-link/2` in TLS on every tunnel the hub opens to it. */
  device(o: {
    capabilities?: CapabilitySpec[]; name: string; kind?: HandKind; permissions: string[]; lend?: boolean; local_agents?: boolean; online?: boolean;
    identity?: Identity;
    /** False: the hub has no record of it yet (a pairing writes it). */
    register?: boolean;
    /** What the device checks the hub against (default: the hub's own key, no pairing secret). */
    trust?: { ownerKey: string; pairSecret: string | null };
  }): Promise<TestDevice>;
  tell(): { to: string; text: string }[];
  events(word: string): any[];
}

export async function startWorld(t: { after(fn: () => unknown): void }, o: { gateway?: boolean; /** A relay nobody has claimed yet. */ fresh?: boolean; control?: Partial<LinkControlDeps> } = {}): Promise<World> {
  const hub = await startHub();
  const key = await hubKey();
  const gw = await FakeGateway.start(o.fresh ? { secret: null } : { claimedBy: { id: key.id, key: key.publicKey } });
  const vault = new MemoryVault();
  const control = createLinkControl({
    db: hub.db, router: hub.router, link: hub.server, hands: hub.hands, vault, identity: key.identity, retryMs: 20,
    ...o.control,
  });
  const devices = new Devices({ hands: hub.hands, router: hub.router, bodies: hub.bodies, gateway: control.pairing });
  control.bindDevices(devices);
  const clients: HandClient[] = [];
  t.after(async () => { for (const c of clients) c.stop(); control.stop(); await gw.stop(); await hub.stop(); });
  await control.start();
  if (o.gateway !== false) {
    await control.gateway.use(gw.url);
    if (!await control.gateway.connected(5000)) throw new Error("the hub did not connect to the fake relay");
  }

  const identities = new Map<string, TestDevice & { kind: HandKind; name: string; capabilities?: CapabilitySpec[]; trust: { ownerKey: string; pairSecret: string | null } }>();
  gw.onDeviceStream = (id, endpoint: Endpoint) => {
    const who = identities.get(id);
    if (!who) return endpoint.close(4404, "no such device");
    const client = new HandClient({
      url: "relay://tunnel/link",
      connector: secureConnector(connectorOver(endpoint), {
        key: who.identity.link, trust: () => who.trust,
        paired: (ownerKey) => { who.pinned.push(ownerKey); who.trust = { ownerKey, pairSecret: null }; },
        refused: (refusal) => who.refusals.push(refusal),
      }),
      hand: { kind: who.kind, name: who.name, version: "0.0.1", platform: "test", public_key: who.identity.publicKey },
      channels: { device: {} }, sign: (nonce) => who.identity.sign(nonce),
    });
    clients.push(client);
    who.clients.push(client);
    endpoint.onClose(() => client.stop());
    client.start();
    if (who.capabilities) void client.ready().then(() => client.setManifest(who.capabilities!)).catch(() => {});
  };

  const call = async (word: string, body: unknown, ctx: HandleContext) => ((await control.member.handle(msg("service:link", word, body), ctx)) as { data: any } | void)?.data;
  return {
    hub, gw, key, vault, control, devices,
    link: (word, body = {}, ctx = owner) => call(word, body, ctx),
    async refused(word, body = {}, ctx = owner) {
      try { await call(word, body, ctx); } catch (error) { if (error instanceof WordError) return error.code; throw error; }
      return "none";
    },
    async device(d) {
      const identity = d.identity ?? await newIdentity();
      const kind = d.kind ?? "computer";
      if (d.register !== false) hub.hands.register({ id: identity.handId, name: d.name, kind, public_key: identity.publicKey, paired_by: "gateway", lend: d.lend ?? true, local_agents: d.local_agents ?? false });
      const who = { identity, id: identity.handId, kind, name: d.name, clients: [] as HandClient[], pinned: [] as string[], refusals: [] as SecureRefusal[], capabilities: d.capabilities, trust: d.trust ?? { ownerKey: key.publicKey, pairSecret: null } };
      identities.set(identity.handId, who);
      gw.setDevice(identity.handId, { name: d.name, permissions: d.permissions, online: d.online ?? true });
      return who;
    },
    tell: () => hub.router.sent.filter((s) => s.msg.word === "tell").map((s) => ({ to: s.msg.to!, text: String((s.msg.body as { text: string }).text) })),
    events: (word) => hub.router.sent.filter((s) => s.msg.kind === "event" && s.msg.to === "service:link" && s.msg.word === word).map((s) => s.msg.body),
  };
}
