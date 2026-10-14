/**
 * `service:link` (SPEC-03 §9.5, HUB-MODULES §2.1): the connection layer as a member. The work (handshake, frames) is code and
 * never a word; this is the control side that the owner and agents share: what is connected, why something is not,
 * disconnecting and reconnecting, and the relay (its state, building one in the owner's Cloudflare account, using another).
 *
 * `createLinkControl` builds the whole of it from what the assembly has: the link server, the hand registry, the vault,
 * the host's key. Nothing here returns a credential: the local token and the Cloudflare sign-in are not reachable from a word.
 */
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Db } from "../../../kernel/ledger";
import type { Router, Vault } from "../../../kernel/types";
import type { RelayOptions, Relay } from "../../../../../link/src/gateway";
import type { Devices, PairingGateway } from "../hands/devices";
import type { HandRegistry } from "../hands/registry";
import type { HubLinkServer, LinkConnection, LinkEvent } from "../index";
import { GatewayControl, type OwnerIdentity } from "./gateway";

export const LINK_ID = "service:link";
const SERVICE: Caller = { member: LINK_ID, via: "service", local: true };
const RECENT_REFUSALS = 50;

/** What the close codes of SPEC-03 §7 mean, for the owner and for agents. */
const CODE_MEANING: Record<number, string> = {
  1000: "closed normally",
  4001: "the identity was not proven (wrong token or signature)",
  4003: "the hand has been revoked",
  4008: "the protocol version is not supported; the hand needs updating",
  4009: "a newer connection of the same hand took its place",
  4400: "a frame was malformed",
  4500: "the hub had an internal error",
};
const meaning = (code: number) => CODE_MEANING[code] ?? "closed";

/** Findings that mean something is wrong. The rest only say how things are. */
const PROBLEMS = new Set(["relay.down", "relay.claimed_by_other", "relay.bad_secret", "relay.missing_secret", "relay.unsupported", "tunnel.missing", "hand.offline"]);

interface Disconnect { conn: string; code: number; reason: string; at: number }
interface Refusal { hand?: string; via: string; code: number; reason: string; at: number }

export class LinkMember implements Member {
  readonly id = LINK_ID;
  readonly kind = "service" as const;
  readonly name = "link";
  private readonly last = new Map<string, Disconnect>();
  private readonly refusals: Refusal[] = [];
  private stopObserving: (() => void) | null = null;

  constructor(private readonly d: { router: Router; link: HubLinkServer; hands: HandRegistry; gateway: GatewayControl; now?: () => number }) {}

  words(): WordContract[] { return wordsOf(LINK_ID); }

  /** Starts telling the ledger about connections coming, going and refused. */
  observe(): void {
    this.stopObserving ??= this.d.link.observe((event) => this.onLinkEvent(event));
  }
  stop(): void { this.stopObserving?.(); this.stopObserving = null; }

  private onLinkEvent(event: LinkEvent): void {
    const at = (this.d.now ?? Date.now)();
    if (event.type === "connected") this.emit("connected", { hand: event.conn.hand, conn: event.conn.conn, channels: event.conn.channels });
    else if (event.type === "closed") {
      this.last.set(event.conn.hand, { conn: event.conn.conn, code: event.code, reason: event.reason, at });
      this.emit("disconnected", { hand: event.conn.hand, conn: event.conn.conn, code: event.code, reason: event.reason || meaning(event.code) });
    } else {
      this.refusals.push({ ...(event.hand ? { hand: event.hand } : {}), via: event.via, code: event.code, reason: event.reason, at });
      if (this.refusals.length > RECENT_REFUSALS) this.refusals.shift();
      this.emit("handshake_failed", { ...(event.hand ? { hand: event.hand } : {}), code: event.code, reason: event.reason || meaning(event.code) });
    }
  }

  private emit(word: string, body: Record<string, unknown>): void {
    void this.d.router.send({ to: LINK_ID, kind: "event", word, body }, SERVICE).catch(() => {});
  }

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const input = (msg.body ?? {}) as Record<string, any>;
    switch (msg.word) {
      case "list": return { data: { connections: this.d.link.connections().map((c) => this.info(c)) } };
      case "describe": return { data: this.describe(input) };
      case "diagnose": return { data: this.diagnose(input.hand) };
      case "disconnect": {
        const reason = typeof input.reason === "string" && input.reason ? input.reason.slice(0, 100) : "closed by the owner";
        return { data: { closed: this.d.link.closeConnection(input.conn, 1000, reason) } };
      }
      case "reconnect": return { data: { requested: this.cycle(input.hand, "reconnect requested", false) } };
      case "refresh_manifest": return { data: { requested: this.cycle(input.hand, "the hub asked for the capability list again", true) } };
      case "gateway.status": return { data: this.d.gateway.status() };
      case "gateway.use": return { data: { url: await this.d.gateway.use(input.url, typeof input.claim_secret === "string" ? { claimSecret: input.claim_secret } : {}) } };
      case "env.changed": this.d.gateway.reconnectRelay(); return;
      case "connected": case "disconnected": case "handshake_failed": return;
      default: throw new WordError("not_found", `${LINK_ID} has no word ${msg.word}`);
    }
  }

  // ---- connections -----------------------------------------------------------------------------------------------------

  private info(c: LinkConnection) {
    return { conn: c.conn, hand: c.hand, name: c.name, kind: c.kind, channels: c.channels, via: c.via, since: c.since };
  }

  private describe(input: { hand?: string; conn?: string }) {
    if (!input.hand && !input.conn) throw new WordError("bad_request", "give a hand or a conn", { recovery_hint: "Use service:link/list to see both." });
    const all = this.d.link.connections();
    const found = input.conn
      ? all.find((c) => c.conn === input.conn)
      : [...all.filter((c) => c.hand === input.hand)].sort((a, b) => Number(b.channels.some((ch) => ch !== "human")) - Number(a.channels.some((ch) => ch !== "human")))[0];
    if (!found) {
      const hand = input.hand ?? undefined;
      const last = hand ? this.last.get(hand) : undefined;
      throw new WordError("not_found", input.conn ? `no connection ${input.conn}` : `${hand} is not connected`, {
        ...(last ? { detail: { last_disconnect: this.disconnect(last) } } : {}),
        recovery_hint: "Use service:link/diagnose to see why a hand is not connected.",
      });
    }
    const last = this.last.get(found.hand);
    return { ...this.info(found), grants: found.grants, ...(last ? { last_disconnect: this.disconnect(last) } : {}) };
  }

  private disconnect(d: Disconnect) { return { conn: d.conn, code: d.code, reason: d.reason, meaning: meaning(d.code), at: d.at }; }

  /**
   * Closes the hand's connections normally so it connects again (a hand reconnects by itself and sends its capability list
   * anew), and for a hand behind the relay opens a fresh tunnel at once. [deviceOnly]: only connections that carry the device channel.
   */
  private cycle(hand: string, reason: string, deviceOnly: boolean): boolean {
    if (!this.d.hands.get(hand)) throw new WordError("not_found", `no hand ${hand}`, { recovery_hint: "Use service:devices/list." });
    let did = this.d.gateway.reopen(hand);
    for (const c of this.d.link.connections()) {
      if (c.hand !== hand || (deviceOnly && !c.channels.includes("device"))) continue;
      did = this.d.link.closeConnection(c.conn, 1000, reason) || did;
    }
    return did;
  }

  private diagnose(hand?: string) {
    if (hand && !this.d.hands.get(hand)) throw new WordError("not_found", `no hand ${hand}`, { recovery_hint: "Use service:devices/list." });
    const findings: { code: string; message: string }[] = [];
    const add = (code: string, message: string) => findings.push({ code, message });
    const gw = this.d.gateway.snapshot();
    if (!gw.configured) add("relay.none", "No relay is set up: only hands on this machine can connect.");
    else if (gw.connected) add("relay.connected", "The hub is connected to the relay.");
    else add("relay.down", `The hub is not connected to the relay${gw.last_error ? `: ${gw.last_error}` : ""}.`);
    if (gw.problem && gw.problem !== "unreachable") add(`relay.${gw.problem}`, gw.problem.replace(/_/g, " "));

    const nameOf = (id: string) => this.d.hands.get(id)?.name ?? id;
    for (const device of gw.devices) {
      if (hand && device.id !== hand) continue;
      if (device.revoked) continue;
      const exposed = device.permissions.includes("expose_capability");
      if (device.online && exposed && !device.tunnel) add("tunnel.missing", `${nameOf(device.id)} is online at the relay and may be reached but has no tunnel.`);
      else if (device.tunnel) add("tunnel.open", `${nameOf(device.id)} has a tunnel.`);
      else if (device.online && !exposed) add("tunnel.not_allowed", `${nameOf(device.id)} is online at the relay but holds only web permissions, so no tunnel is opened.`);
    }
    if (hand && !this.d.link.connections().some((c) => c.hand === hand)) {
      const last = this.last.get(hand);
      add("hand.offline", `${nameOf(hand)} is not connected${last ? `; it last closed with ${last.code} (${meaning(last.code)})` : ""}.`);
    }
    for (const r of this.refusals.filter((x) => !hand || x.hand === hand).slice(-10)) {
      add(`handshake.${r.code}`, `${r.via} handshake${r.hand ? ` of ${nameOf(r.hand)}` : ""} refused: ${meaning(r.code)}${r.reason ? ` (${r.reason})` : ""}.`);
    }
    return { ok: !findings.some((f) => PROBLEMS.has(f.code)), findings };
  }
}

export interface LinkControlDeps {
  db: Db;
  router: Router;
  link: HubLinkServer;
  hands: HandRegistry;
  /** Holds a claim secret the owner set for their own relay. */
  vault: Pick<Vault, "set" | "use">;
  /** The hub's key in the host's keystore. */
  identity: OwnerIdentity;
  ownerName?: string;
  // Tests:
  retryMs?: number;
  relay?: (options: RelayOptions) => Relay;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface LinkControl {
  /** The member `service:link`; add it to the registry. */
  member: LinkMember;
  /** The relay's side of pairing, for `new Devices({ gateway })`. */
  pairing: PairingGateway;
  gateway: GatewayControl;
  /** `service:devices` is made with `pairing`, so it is given back here to be told of pairing requests. */
  bindDevices(devices: Pick<Devices, "pairs" | "pairingRequested">): void;
  /** Starts observing connections and connects to the relay that was set before. Never throws. */
  start(): Promise<void>;
  stop(): void;
}

export function createLinkControl(deps: LinkControlDeps): LinkControl {
  const gateway = new GatewayControl({ db: deps.db, link: deps.link, hands: deps.hands, vault: deps.vault, identity: deps.identity, relay: deps.relay, ownerName: deps.ownerName, retryMs: deps.retryMs, log: deps.log });
  const member = new LinkMember({ router: deps.router, link: deps.link, hands: deps.hands, gateway, now: deps.now });
  return {
    member, pairing: gateway.pairing, gateway,
    bindDevices: (devices) => gateway.bindDevices(devices),
    async start() {
      member.observe();
      await gateway.start().catch((error) => deps.log?.("the relay could not be started", error));
    },
    stop() { member.stop(); gateway.stop(); },
  };
}
