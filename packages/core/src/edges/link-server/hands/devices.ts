/**
 * `service:devices` (SPEC-02 §4.1, HUB-MODULES §2.3): who may connect. The owner's view of the hand registry:
 * the list, names, the three permissions and the tier, revoking, and pairing a computer through the relay.
 *
 * The relay's side of pairing (issuing a code, granting a request) is the `PairingGateway` it is given. Every
 * change of a pairing is an event `pair.changed`, and its initiator, if an agent, is told by `tell`.
 */
import { randomBytes } from "node:crypto";
import { DEVICE_ASSETS } from "../../../../../sdk/src/device-assets.generated";
import { OWNER_ID, bodyId, deviceId } from "../../../../../sdk/src/ids";
import { versionBefore } from "../../../../../sdk/src/versions";
import type { HandKind } from "../../../../../sdk/src/link";
import { WordError, type Caller, type ErrorBody, type HandleContext, type Message, type WordResult } from "../../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import type { Router } from "../../../kernel/types";
import type { Access, HandRecord, HandRegistry } from "./registry";

export const DEVICES_ID = "service:devices";

export type PairKind = "computer" | "server";
export type PairState = "waiting" | "requested" | "approved" | "connected" | "rejected" | "expired" | "failed";
export type RelayPermission = "expose_capability";

/** The relay as pairing needs it (the gateway client is behind this; the link control module provides it). */
export interface PairingGateway {
  /**
   * A one-time code a new computer uses to ask to pair, a one-time secret it proves on its first connection (docs/LINK-E2E.md
   * §5), and the command that installs and pairs it, which carries both.
   */
  issue(kind: PairKind): Promise<{ ticket: string; expires_in: number; secret: string; command: string }>;
  /** Lets the device in; [pairing.secret] is kept until the device [pairing.hand] proved it. */
  approve(requestId: string, permissions: RelayPermission[], pairing: { hand: string; secret: string }): Promise<void>;
  reject(requestId: string): Promise<void>;
  revoke(handId: string): Promise<void>;
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
  /** The one-time code the relay knows (by its hash). */
  ticket: string;
  /** The one-time secret the relay never sees; in [command] only. */
  secret: string;
  /** What is run on the new computer: install and pair. Given to whoever starts the pairing, owner or agent. */
  command: string;
  request?: PairRequest;
  device?: string;
  /** Why it failed. */
  reason?: string;
}

export interface DevicesDeps {
  hands: HandRegistry;
  router: Router;
  bodies: { isBound(hand: string): boolean };
  gateway?: PairingGateway;
  now?: () => number;
  /** The primary agent: what a device reports reaches it as well as the owner. */
  primaryAgent?: () => string | null | undefined;
  /** The setting `devices.auto_update` (default on): a computer older than the hub's release is updated when it connects. */
  autoUpdate?: () => boolean;
  log?: (message: string, error?: unknown) => void;
}

/** The release this hub installs on a computer of [platform] (`darwin-arm64`, ...), or null when it has none for it. */
export function releaseFor(platform: string | null | undefined): { version: string; sha256: string } | null {
  const sha256 = platform ? DEVICE_ASSETS.sha256[platform] : undefined;
  return sha256 ? { version: DEVICE_ASSETS.version, sha256 } : null;
}

const SERVICE: Caller = { member: DEVICES_ID, via: "service", local: true };
const PERMISSIONS = ["lend", "local_agents"] as const;

const failure = (error: ErrorBody) => new WordError(error.code, error.message, { detail: error.detail, recovery_hint: error.recovery_hint });

export class Devices implements Member {
  readonly id = DEVICES_ID;
  readonly kind = "service" as const;
  readonly name = "devices";
  readonly pairs = new Map<string, Pair>();
  private readonly config = new Map<string, Record<string, string>>();
  /** The release each computer was last told to install by the automatic update: once per hub run, so a failing one is not retried in a loop. */
  private readonly autoTried = new Map<string, string>();
  /** The release a computer was told to install and has not come back with yet. */
  private readonly updating = new Map<string, string>();
  /** The version a hand had before its current connection, to tell that it came back on another. */
  private readonly before = new Map<string, string | null>();
  private readonly now: () => number;

  constructor(private readonly d: DevicesDeps) {
    this.now = d.now ?? Date.now;
    d.hands.onManifest((id) => { this.cameBack(id); void this.autoUpdate(id); });
    d.hands.onOnline((id) => {
      this.before.set(id, d.hands.get(id)?.version ?? null);
      for (const pair of this.pairs.values()) if (pair.state === "approved" && pair.device === deviceId(id)) this.move(pair, "connected");
    });
  }

  words(): WordContract[] { return wordsOf(DEVICES_ID); }

  /**
   * The device that was let in could not prove the pairing secret on its first connection: the key that connected is not the
   * one that asked to pair (the relay swapped it). Its record is revoked and the pairing fails, with [reason].
   */
  pairingFailed(handId: string, reason: string): void {
    this.d.hands.revoke(handId);
    this.changed(handId, "revoked", DEVICES_ID);
    void this.d.gateway?.revoke(handId).catch(() => {});
    const pair = [...this.pairs.values()].find((p) => p.device === deviceId(handId) && (p.state === "approved" || p.state === "connected"));
    if (pair) { pair.reason = reason; this.move(pair, "failed"); }
  }

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
      case "list": {
        // Revoked hands stay on record (restore brings one back) but are listed only when asked for.
        const shown = (h: HandRecord) => h.revoked_at === null || input.include_revoked === true;
        return { data: { devices: this.d.hands.list().filter(shown).map((h) => this.info(h)), release: DEVICE_ASSETS.version } };
      }
      case "describe": return { data: this.describe(this.hand(input.device)) };
      case "pair_start": return { data: this.pairStart(input.kind, input.name, ctx.caller.member, await this.gateway().issue(input.kind)) };
      case "pair_code": {
        const pair = this.pair(input.pair_id);
        if (!this.d.gateway) throw new WordError("unavailable", "no relay is set up");
        if (this.stateOf(pair) !== "waiting") throw new WordError("conflict", `pairing ${pair.pair_id} is ${pair.state}; its command can no longer be used`);
        return { data: { command: pair.command, expires_at: pair.expires_at } };
      }
      case "pair_status": return { data: this.pairInfo(this.pair(input.pair_id)) };
      case "pair_pending": return { data: { pairs: [...this.pairs.values()].filter((p) => this.stateOf(p) === "requested").map((p) => this.pairInfo(p)) } };
      case "pair_approve": return { data: await this.pairApprove(this.pair(input.pair_id), input, ctx.caller.member) };
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
        this.changed(hand.id, "revoked", ctx.caller.member);
        return { data: { revoked: true } };
      }
      case "restore": {
        const hand = this.hand(input.device);
        const was = hand.revoked_at !== null;
        this.d.hands.restore(hand.id);
        if (was) this.changed(hand.id, "restored", ctx.caller.member);
        return { data: { restored: was } };
      }
      case "rename": {
        const hand = this.live(input.device);
        this.d.hands.rename(hand.id, input.name.trim());
        this.changed(hand.id, "renamed", ctx.caller.member);
        return { data: { device: deviceId(hand.id), name: input.name.trim() } };
      }
      case "access_set": {
        const hand = this.live(input.device);
        const info = await this.accessSet(hand, input);
        this.changed(hand.id, "access", ctx.caller.member);
        return { data: info };
      }
      case "update": {
        const hand = this.live(input.device);
        const release = this.release(hand, input.version, input.sha256);
        const reply = await this.d.router.send({ to: deviceId(hand.id), kind: "request", word: "x.ash.update", body: release }, SERVICE);
        if (!reply.ok) throw failure(reply.error);
        this.updating.set(hand.id, release.version);
        this.changed(hand.id, "updating", ctx.caller.member, { version: release.version });
        return { data: { started: true, ...release } };
      }
      case "pair.changed": case "device.changed": return;
      case "config.changed": {
        const hand = msg.from.startsWith("device:") ? msg.from.slice("device:".length) : null;
        if (hand) this.config.set(hand, { ...this.config.get(hand), [String(input.item)]: String(input.state) });
        return;
      }
      case "codex.turn_ended":
      case "codex.approval_pending": {
        // The owner's own Codex App: he is told on his phone, outside the conversation, and the notification opens the
        // Codex page. It is his workbench, so neither the conversation nor Ash's context carries its turns.
        const hand = msg.from.startsWith("device:") ? this.d.hands.get(msg.from.slice("device:".length)) : undefined;
        const title = typeof input.title === "string" && input.title ? `「${input.title}」` : "";
        const text = msg.word === "codex.turn_ended"
          ? `${title}做完了一轮${input.said ? `：${input.said}` : ""}`
          : `${title}在等你批准${input.summary ? `：${input.summary}` : ""}`;
        const key = `codex-${msg.word === "codex.turn_ended" ? "end" : "ask"}-${String(msg.id).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80)}`;
        await this.d.router.send({ to: OWNER_ID, kind: "request", word: "notice", body: { title: `Codex${hand ? ` · ${hand.name}` : ""}`.slice(0, 60), text: text.slice(0, 500), open: "codex", dedupe_key: key } }, SERVICE);
        return;
      }
      default: throw new WordError("not_found", `${DEVICES_ID} has no word ${msg.word}`);
    }
  }

  // ---- updating a computer -----------------------------------------------------------------------------------------

  /** What `update` installs: what was asked, else the hub's release for the computer's platform. */
  private release(hand: HandRecord, version?: string, sha256?: string): { version: string; sha256: string } {
    if (version && sha256) return { version, sha256 };
    const own = releaseFor(hand.platform);
    if (version && version.replace(/^v/, "") !== own?.version) {
      throw new WordError("bad_request", `the hub only knows the checksums of release ${DEVICE_ASSETS.version}`, { recovery_hint: `Give sha256 too: the line for ash-device-${hand.platform ?? "<platform>"}.tar.gz in SHA256SUMS of the device-v${version.replace(/^v/, "")} release on GitHub.` });
    }
    if (!own) throw new WordError("unavailable", `the hub has no package for ${hand.platform ?? "this computer's platform"}`, { recovery_hint: "Give version and sha256 from the release's SHA256SUMS on GitHub." });
    return own;
  }

  /** A computer connected with a program older than the hub's release: update it, when the owner's setting allows (default on). */
  private async autoUpdate(id: string): Promise<void> {
    const hand = this.d.hands.get(id);
    if (!hand || hand.revoked_at || hand.kind !== "computer" || (this.d.autoUpdate && !this.d.autoUpdate())) return;
    const release = releaseFor(hand.platform);
    if (!release || !versionBefore(hand.version, release.version) || this.autoTried.get(id) === release.version) return;
    this.autoTried.set(id, release.version);
    const reply = await this.d.router.send({ to: deviceId(id), kind: "request", word: "x.ash.update", body: release }, SERVICE).catch((error: unknown) => {
      this.d.log?.(`updating ${hand.name} failed`, error);
      return null;
    });
    if (reply && !reply.ok) this.d.log?.(`updating ${hand.name} to ${release.version} was refused: ${reply.error.code} ${reply.error.message}`);
    if (reply?.ok) {
      this.updating.set(id, release.version);
      this.changed(id, "updating", DEVICES_ID, { version: release.version });
    }
  }

  /** A hand's manifest came in: if it is back on another version than before, it was updated. */
  private cameBack(id: string): void {
    const hand = this.d.hands.get(id);
    if (!hand || !this.before.has(id)) return;
    const was = this.before.get(id);
    this.before.delete(id);
    const target = this.updating.get(id);
    if (target && !versionBefore(hand.version, target)) this.updating.delete(id);
    if (hand.version && was && hand.version !== was) this.changed(id, "updated", deviceId(id), { version: hand.version });
  }

  /**
   * `device.changed`: what changed on one device and who did it (recorded, so every screen on the ledger refreshes). Coming and
   * going online is `service:link connected / disconnected`; a pairing is `pair.changed`.
   */
  private changed(handId: string, change: string, by: string, extra: Record<string, unknown> = {}): void {
    void this.d.router.send({ to: DEVICES_ID, kind: "event", word: "device.changed", body: { device: deviceId(handId), change, by, ...extra } }, SERVICE).catch(() => {});
  }

  // ---- hands ---------------------------------------------------------------------------------------------------------

  private info(h: HandRecord) {
    return {
      device: deviceId(h.id), name: h.name, kind: h.kind, online: this.d.hands.online(h.id), tier: h.tier,
      lend: h.lend, body: this.d.bodies.isBound(h.id), local_agents: h.local_agents,
      via: this.d.hands.via(h.id) ?? h.paired_by,
      ...(h.version ? { version: h.version } : {}), ...(h.platform ? { platform: h.platform } : {}),
      // Whether the computer runs the hub's release (null: the hub has no package for it, e.g. a phone), and the release on its way.
      ...(releaseFor(h.platform) ? { latest: !versionBefore(h.version, DEVICE_ASSETS.version) } : {}),
      ...(this.updating.has(h.id) ? { updating: this.updating.get(h.id) } : {}),
      capabilities: this.d.hands.capabilities(h.id),
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
    for (const key of ["tier", "lend", "local_agents"] as const) if (input[key] !== undefined) (access as Record<string, unknown>)[key] = input[key];
    if (hand.kind === "browser" && (access.lend || access.local_agents || access.tier === "full")) throw new WordError("forbidden", "a browser cannot lend capabilities, run local agents or have full tier");
    this.d.hands.setAccess(hand.id, access);
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
    if (!this.d.gateway) throw new WordError("unavailable", "no relay is set up, so computers cannot be paired");
    return this.d.gateway;
  }

  private pairStart(kind: PairKind, name: string, initiator: string, issued: { ticket: string; expires_in: number; secret: string; command: string }) {
    const pair: Pair = { pair_id: `p_${randomBytes(6).toString("base64url")}`, kind, name, state: "waiting", expires_at: this.now() + issued.expires_in * 1000, initiator, ticket: issued.ticket, secret: issued.secret, command: issued.command };
    this.pairs.set(pair.pair_id, pair);
    return { pair_id: pair.pair_id, expires_at: pair.expires_at, command: pair.command };
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
    void this.d.router.send({ to: DEVICES_ID, kind: "event", word: "pair.changed", body: { pair_id: pair.pair_id, state, ...(pair.device ? { device: pair.device } : {}), ...(pair.reason ? { reason: pair.reason } : {}) } }, SERVICE).catch(() => {});
    if (pair.initiator.startsWith("agent:")) {
      const outcome: Record<PairState, string> = {
        waiting: "is waiting for the command to be run", requested: "has a device asking to join: let it in now with device_pair_approve {pair_id, lend, body, local_agents} (what the owner wants it for; skill connect-device)", approved: "was approved; the device can connect now",
        connected: "is done: the device has connected", rejected: "was rejected by the owner", expired: "ran out of time before it finished",
        failed: `failed: ${pair.reason ?? "the pairing secret did not hold"}. Its record was revoked; start a new pairing`,
      };
      void this.d.router.send({ to: pair.initiator, kind: "request", word: "tell", body: { text: `Pairing ${pair.pair_id} (${name}) ${outcome[state]}. Use service:devices/pair_status to look.` } }, SERVICE).catch(() => {});
    }
  }

  private pairInfo(pair: Pair) {
    return { pair_id: pair.pair_id, state: this.stateOf(pair), name: pair.name, kind: pair.kind, expires_at: pair.expires_at, ...(pair.device ? { device: pair.device } : {}), ...(pair.reason ? { reason: pair.reason } : {}) };
  }

  private async pairApprove(pair: Pair, input: Record<string, any>, by: string) {
    this.requested(pair.pair_id);
    const request = pair.request!;
    const access = { tier: input.tier ?? "ask", lend: input.lend !== false, local_agents: input.local_agents === true };
    // The relay has one permission: any of the three needs a tunnel to the device.
    const exposed = access.lend || access.local_agents || input.body === true;
    const permissions: RelayPermission[] = exposed ? ["expose_capability"] : [];
    // Registered first: the device connects the moment the relay lets it, and must already be known.
    this.d.hands.register({ id: request.hand_id, name: (input.name ?? pair.name).trim(), kind: "computer", public_key: request.public_key, paired_by: "gateway", ...access });
    await this.gateway().approve(request.request_id, permissions, { hand: request.hand_id, secret: pair.secret });
    pair.device = deviceId(request.hand_id);
    this.move(pair, "approved");
    this.changed(request.hand_id, "paired", by);
    if (input.body === true) await this.bindBody(request.hand_id, true);
    return this.pairInfo(pair);
  }
}
