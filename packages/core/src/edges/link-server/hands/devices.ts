/**
 * `service:devices` (SPEC-02 §4.1, HUB-MODULES §2.3): who may connect. The owner's view of the hand registry:
 * the list, names, the three permissions and the tier, revoking, and pairing a computer or browser through the relay.
 *
 * The relay's side of pairing (issuing a code, granting a request) is the `PairingGateway` it is given. Every
 * change of a pairing is an event `pair.changed`, and its initiator, if an agent, is told by `tell`.
 */
import { randomBytes } from "node:crypto";
import { OWNER_ID, bodyId, deviceId } from "../../../../../sdk/src/ids";
import type { HandKind } from "../../../../../sdk/src/link";
import { WordError, type Caller, type ErrorBody, type HandleContext, type Message, type WordResult } from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Router } from "../../../kernel/types";
import type { Access, HandRecord, HandRegistry } from "./registry";

export const DEVICES_ID = "service:devices";

export type PairKind = "computer" | "server" | "browser";
export type PairState = "waiting" | "requested" | "approved" | "connected" | "rejected" | "expired";
export type RelayPermission = "chat" | "web_ui" | "expose_capability";

/** The relay as pairing needs it (the gateway client is behind this; the link control module provides it). */
export interface PairingGateway {
  /** A one-time code a new computer or browser uses to ask to pair, and the address where it is entered. */
  issue(kind: PairKind): Promise<{ ticket: string; expires_in: number; url?: string }>;
  approve(requestId: string, permissions: RelayPermission[]): Promise<void>;
  reject(requestId: string): Promise<void>;
  revoke(handId: string): Promise<void>;
  setWebUi(handId: string, allow: boolean): Promise<void>;
  /**
   * The relay only knows `expose_capability` (it keeps the tunnel from reaching a device that may not be reached). It is held
   * while the device may lend capabilities, serve as a body or run local agents, and not otherwise.
   */
  setExpose(handId: string, allow: boolean): Promise<void>;
}

/** A new device asked to pair with a code (the relay tells the kernel). */
export interface PairRequest {
  request_id: string;
  /** The device id the relay knows it by; it is also its `hand_id`. */
  hand_id: string;
  name: string;
  kind: HandKind;
  public_key: string;
  fingerprint: string;
  /** The code it used. */
  ticket: string;
}

export interface Pair {
  pair_id: string;
  kind: PairKind;
  name: string;
  state: PairState;
  expires_at: number;
  /** Who asked for the pairing (a member id), to be told when it moves on. */
  initiator: string;
  /** The one-time code: given to whoever starts the pairing, owner or agent; the owner's approval card is the gate. */
  ticket: string;
  /** Where the code is entered (the relay's install page). */
  url?: string;
  request?: PairRequest;
  device?: string;
}

export interface DevicesDeps {
  hands: HandRegistry;
  router: Router;
  bodies: { isBound(hand: string): boolean };
  gateway?: PairingGateway;
  now?: () => number;
}

const SERVICE: Caller = { member: DEVICES_ID, via: "service", local: true };
const PERMISSIONS = ["lend", "local_agents", "web_ui"] as const;

const failure = (error: ErrorBody) => new WordError(error.code, error.message, { detail: error.detail, recovery_hint: error.recovery_hint });

export class Devices implements Member {
  readonly id = DEVICES_ID;
  readonly kind = "service" as const;
  readonly name = "devices";
  readonly pairs = new Map<string, Pair>();
  private readonly config = new Map<string, Record<string, string>>();
  private readonly now: () => number;

  constructor(private readonly d: DevicesDeps) {
    this.now = d.now ?? Date.now;
    d.hands.onOnline((id) => {
      for (const pair of this.pairs.values()) if (pair.state === "approved" && pair.device === deviceId(id)) this.move(pair, "connected");
    });
  }

  words(): WordContract[] { return wordsOf(DEVICES_ID); }

  /** A device asked to pair with a code: the pairing that issued it now waits for the owner. */
  pairingRequested(request: PairRequest): Pair | null {
    const pair = [...this.pairs.values()].find((p) => p.ticket === request.ticket && this.stateOf(p) === "waiting");
    if (!pair) return null;
    pair.request = request;
    this.move(pair, "requested");
    return pair;
  }

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const input = (msg.body ?? {}) as Record<string, any>;
    switch (msg.word) {
      case "list": return { data: { devices: this.d.hands.list().map((h) => this.info(h)) } };
      case "describe": return { data: this.describe(this.hand(input.device)) };
      case "pair_start": return { data: this.pairStart(input.kind, input.name, ctx.caller.member, await this.gateway().issue(input.kind)) };
      case "pair_code": {
        const pair = this.pair(input.pair_id);
        if (!this.d.gateway) throw new WordError("unavailable", "no relay is set up");
        if (this.stateOf(pair) !== "waiting") throw new WordError("conflict", `pairing ${pair.pair_id} is ${pair.state}; its code can no longer be used`);
        return { data: { code: pair.ticket, ...(pair.url ? { url: pair.url } : {}), expires_at: pair.expires_at } };
      }
      case "pair_status": return { data: this.pairInfo(this.pair(input.pair_id)) };
      case "pair_pending": return { data: { pairs: [...this.pairs.values()].filter((p) => this.stateOf(p) === "requested").map((p) => this.pairInfo(p)) } };
      case "pair_approve": return { data: await this.pairApprove(this.pair(input.pair_id), input) };
      case "pair_reject": {
        const pair = this.requested(input.pair_id);
        await this.gateway().reject(pair.request!.request_id);
        this.move(pair, "rejected");
        return { data: this.pairInfo(pair) };
      }
      case "revoke": {
        const hand = this.hand(input.device);
        this.d.hands.revoke(hand.id);
        if (hand.paired_by === "gateway") await this.d.gateway?.revoke(hand.id);
        return { data: { revoked: true } };
      }
      case "restore": {
        const hand = this.hand(input.device);
        const was = hand.revoked_at !== null;
        this.d.hands.restore(hand.id);
        return { data: { restored: was } };
      }
      case "rename": {
        const hand = this.live(input.device);
        this.d.hands.rename(hand.id, input.name.trim());
        return { data: { device: deviceId(hand.id), name: input.name.trim() } };
      }
      case "access_set": return { data: await this.accessSet(this.live(input.device), input) };
      case "update": {
        const hand = this.live(input.device);
        const reply = await this.d.router.send({ to: deviceId(hand.id), kind: "request", word: "x.ash.update", body: { version: input.version, sha256: input.sha256 } }, SERVICE);
        if (!reply.ok) throw failure(reply.error);
        return { data: { started: true } };
      }
      case "pair.changed": return;
      case "config.changed": {
        const hand = msg.from.startsWith("device:") ? msg.from.slice("device:".length) : null;
        if (hand) this.config.set(hand, { ...this.config.get(hand), [String(input.item)]: String(input.state) });
        return;
      }
      case "codex.turn_ended":
      case "codex.approval_pending": {
        // A computer's Codex app needs the owner: a short message, once per event (the hand's event id is the key).
        const title = typeof input.title === "string" && input.title ? `「${input.title}」` : "";
        const text = msg.word === "codex.turn_ended"
          ? `Codex ${title}做完了一轮${input.said ? `：${input.said}` : ""}`
          : `Codex ${title}在等你批准${input.summary ? `：${input.summary}` : ""}`;
        const key = `codex-${msg.word === "codex.turn_ended" ? "end" : "ask"}-${String(msg.id).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80)}`;
        await this.d.router.send({ to: OWNER_ID, kind: "request", word: "say", body: { text, kind: "heads_up", dedupe_key: key } }, SERVICE);
        return;
      }
      default: throw new WordError("not_found", `${DEVICES_ID} has no word ${msg.word}`);
    }
  }

  // ---- hands ---------------------------------------------------------------------------------------------------------

  private info(h: HandRecord) {
    return {
      device: deviceId(h.id), name: h.name, kind: h.kind, online: this.d.hands.online(h.id), tier: h.tier,
      lend: h.lend, body: this.d.bodies.isBound(h.id), local_agents: h.local_agents, web_ui: h.web_ui,
      via: this.d.hands.via(h.id) ?? h.paired_by,
      ...(h.last_seen !== null ? { last_seen: h.last_seen } : {}), ...(h.revoked_at !== null ? { revoked_at: h.revoked_at } : {}),
    };
  }

  private describe(h: HandRecord) {
    return {
      ...this.info(h), version: h.version, platform: h.platform, paired_at: h.paired_at, manifest_rev: h.manifest_rev,
      capabilities: this.d.hands.capabilities(h.id), config: this.config.get(h.id) ?? {},
    };
  }

  private hand(device: string): HandRecord {
    const hand = this.d.hands.get(device.slice("device:".length));
    if (!hand) throw new WordError("not_found", `${device} is not a hand this hub knows`);
    return hand;
  }
  /** A hand that has not been revoked: the owner restores it first. */
  private live(device: string): HandRecord {
    const hand = this.hand(device);
    if (hand.revoked_at !== null) throw new WordError("conflict", `${hand.name} is revoked; restore it first`);
    return hand;
  }

  private async accessSet(hand: HandRecord, input: Record<string, any>) {
    const access: Access = {};
    for (const key of ["tier", "lend", "local_agents", "web_ui"] as const) if (input[key] !== undefined) (access as Record<string, unknown>)[key] = input[key];
    if (hand.kind === "browser" && (access.lend || access.local_agents || access.tier === "full")) throw new WordError("forbidden", "a browser cannot lend capabilities, run local agents or have full tier");
    this.d.hands.setAccess(hand.id, access);
    if (access.web_ui !== undefined && access.web_ui !== hand.web_ui && hand.paired_by === "gateway") await this.d.gateway?.setWebUi(hand.id, access.web_ui);
    const exposed = hand.lend || hand.local_agents || this.d.bodies.isBound(hand.id);
    if (input.body !== undefined && input.body !== this.d.bodies.isBound(hand.id)) await this.bindBody(hand.id, input.body);
    const exposing = (access.lend ?? hand.lend) || (access.local_agents ?? hand.local_agents) || this.d.bodies.isBound(hand.id);
    if (exposing !== exposed && hand.paired_by === "gateway") await this.d.gateway?.setExpose(hand.id, exposing);
    // A connection is judged once, at the handshake: when a permission changes the connection ends and the hand is judged again when it returns.
    if (hand.paired_by === "gateway" && PERMISSIONS.some((key) => access[key] !== undefined && access[key] !== hand[key])) this.d.hands.disconnect(hand.id, "permissions changed");
    return this.info(this.hand(deviceId(hand.id)));
  }

  /** Bind or unbind the computer as a body. Sent as this service: the owner's approval of the permission change covers it. */
  private async bindBody(handId: string, on: boolean): Promise<void> {
    const reply = await this.d.router.send(on
      ? { to: "service:bodies", kind: "request", word: "bind", body: { hand: handId } }
      : { to: "service:bodies", kind: "request", word: "unbind", body: { body: bodyId(handId) } }, SERVICE);
    if (!reply.ok) throw failure(reply.error);
  }

  // ---- pairing -------------------------------------------------------------------------------------------------------

  private gateway(): PairingGateway {
    if (!this.d.gateway) throw new WordError("unavailable", "no relay is set up, so computers and browsers cannot be paired");
    return this.d.gateway;
  }

  private pairStart(kind: PairKind, name: string, initiator: string, issued: { ticket: string; expires_in: number; url?: string }) {
    const pair: Pair = { pair_id: `p_${randomBytes(6).toString("base64url")}`, kind, name, state: "waiting", expires_at: this.now() + issued.expires_in * 1000, initiator, ticket: issued.ticket, ...(issued.url ? { url: issued.url } : {}) };
    this.pairs.set(pair.pair_id, pair);
    return { pair_id: pair.pair_id, expires_at: pair.expires_at, code: pair.ticket, ...(pair.url ? { url: pair.url } : {}) };
  }

  private pair(pairId: string): Pair {
    const pair = this.pairs.get(pairId);
    if (!pair) throw new WordError("not_found", `no pairing ${pairId}`);
    return pair;
  }
  private requested(pairId: string): Pair {
    const pair = this.pair(pairId);
    if (this.stateOf(pair) !== "requested") throw new WordError("conflict", `pairing ${pairId} is ${this.stateOf(pair)}, not waiting for the owner`);
    return pair;
  }

  private stateOf(pair: Pair): PairState {
    if ((pair.state === "waiting" || pair.state === "requested") && this.now() >= pair.expires_at) this.move(pair, "expired");
    return pair.state;
  }
  private move(pair: Pair, state: PairState): void {
    if (pair.state === state) return;
    pair.state = state;
    const name = pair.name || pair.kind;
    void this.d.router.send({ to: DEVICES_ID, kind: "event", word: "pair.changed", body: { pair_id: pair.pair_id, state, ...(pair.device ? { device: pair.device } : {}) } }, SERVICE).catch(() => {});
    if (pair.initiator.startsWith("agent:")) {
      const outcome: Record<PairState, string> = {
        waiting: "is waiting for the code", requested: "has a device asking to pair; the owner decides", approved: "was approved; the device can connect now",
        connected: "is done: the device has connected", rejected: "was rejected by the owner", expired: "ran out of time before it finished",
      };
      void this.d.router.send({ to: pair.initiator, kind: "request", word: "tell", body: { text: `Pairing ${pair.pair_id} (${name}) ${outcome[state]}. Use service:devices/pair_status to look.` } }, SERVICE).catch(() => {});
    }
  }

  private pairInfo(pair: Pair) {
    return { pair_id: pair.pair_id, state: this.stateOf(pair), name: pair.name, kind: pair.kind, expires_at: pair.expires_at, ...(pair.device ? { device: pair.device } : {}) };
  }

  private async pairApprove(pair: Pair, input: Record<string, any>) {
    this.requested(pair.pair_id);
    const request = pair.request!;
    const browser = pair.kind === "browser";
    if (browser && (input.lend || input.local_agents || input.body || input.tier === "full")) throw new WordError("forbidden", "a browser cannot lend capabilities, run local agents or have full tier");
    const access = { tier: input.tier ?? "ask", lend: !browser && input.lend !== false, local_agents: !browser && input.local_agents === true, web_ui: browser || input.web_ui === true };
    // The relay has one permission for everything that is not the web page: any of the three non-web ones needs a tunnel to the device.
    const exposed = access.lend || access.local_agents || input.body === true;
    const permissions: RelayPermission[] = [...(exposed ? ["expose_capability" as const] : []), ...(access.web_ui ? ["chat" as const, "web_ui" as const] : [])];
    // Registered first: the device connects the moment the relay lets it, and must already be known.
    this.d.hands.register({ id: request.hand_id, name: (input.name ?? pair.name).trim(), kind: browser ? "browser" : "computer", public_key: request.public_key, paired_by: "gateway", ...access });
    await this.gateway().approve(request.request_id, permissions);
    pair.device = deviceId(request.hand_id);
    this.move(pair, "approved");
    if (input.body === true) await this.bindBody(request.hand_id, true);
    return this.pairInfo(pair);
  }
}
