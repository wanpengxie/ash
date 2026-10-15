/**
 * The hand registry (SPEC-01 §8, HUB-MODULES §2.3): which hands the owner has let in (the `hands` and
 * `hand_capabilities` tables), which of them are connected, and the members their manifests become.
 *
 * Every hand is the same here, phone or computer. A manifest becomes `device:<hand_id>`; a computer the owner has
 * bound as a body also gets `body:<hand_id>` (the split is `bodies.ts`, injected). A hand's events are checked
 * against what it declared and handed to the fixed service of their namespace.
 */
import { createHash } from "node:crypto";
import { bodyId, deviceId } from "../../../../../sdk/src/ids";
import type { CapabilitySpec, EventFrame, HandKind, HelloFrame, ManifestFrame } from "../../../../../sdk/src/link";
import { CLOSE_CODES } from "../../../../../sdk/src/link";
import type { Caller, Message } from "../../../../../sdk/src/message";
import type { Risk } from "../../../../../sdk/src/word";
import type { LinkSession, ManifestCheck, SessionHandlers } from "../../../../../link/src/server";
import type { Db } from "../../../kernel/ledger";
import type { Registry, Router } from "../../../kernel/types";
import { EVENT_TARGETS, HandMember } from "./hand-member";

export interface HandRecord {
  id: string;
  name: string;
  kind: HandKind;
  /** SPKI, base64url; empty for a browser or chat channel that has none. */
  public_key: string;
  paired_by: "local" | "gateway";
  tier: "ask" | "full";
  /** The permissions (SPEC-03 §2.2.1); being a body is the third (service:bodies). Only a hand that came through the gateway is held to them. */
  lend: boolean;
  local_agents: boolean;
  version: string | null;
  platform: string | null;
  manifest_rev: number | null;
  manifest_hash: string | null;
  paired_at: number;
  last_seen: number | null;
  revoked_at: number | null;
}

export type NewHand = Pick<HandRecord, "id" | "name" | "kind" | "public_key" | "paired_by"> & Partial<Pick<HandRecord, "tier" | "lend" | "local_agents" | "version" | "platform">>;
export type Access = Partial<Pick<HandRecord, "tier" | "lend" | "local_agents">>;

/** `splitBodyCapabilities` of `bodies.ts`, injected so this module does not know the body rules. */
export type SplitBodyCapabilities = <C extends { name: string }>(
  hand: { id: string; bound: boolean }, capabilities: readonly C[],
) => { hand: C[]; body: C[]; bodyId: string | null };

export interface HandsDeps {
  /** The ledger's database; the two tables are created in it. */
  db: Db;
  registry: Registry;
  router: Router;
  bodies: { isBound(hand: string): boolean; forget(hand: string): void };
  splitBodyCapabilities: SplitBodyCapabilities;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

/** How a connection reached the kernel (the link server fills it in). */
export interface HandConnection { handId: string; local: boolean; hello: HelloFrame }

/** What the link server gives the registry to reach connections that do not carry the device channel. */
export interface LinkControl { closeHand(handId: string, code: number, reason: string): void }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hands (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, public_key TEXT NOT NULL, paired_by TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'ask', lend INTEGER NOT NULL DEFAULT 0, local_agents INTEGER NOT NULL DEFAULT 0,
  version TEXT, platform TEXT, manifest_rev INTEGER, manifest_hash TEXT,
  paired_at INTEGER NOT NULL, last_seen INTEGER, revoked_at INTEGER);
CREATE TABLE IF NOT EXISTS hand_capabilities (
  hand TEXT NOT NULL, name TEXT NOT NULL, spec TEXT NOT NULL, PRIMARY KEY (hand, name));`;

/** The service was not there or failed: the event is not acked, the hand sends it again. Any other refusal is final. */
const RETRY_CODES = new Set(["offline", "unavailable", "internal", "timeout"]);
/** Event ids remembered per hand, to drop a resend. */
const SEEN_PER_HAND = 2048;

interface Live {
  session: LinkSession;
  local: boolean;
  capabilities: CapabilitySpec[];
  events: Set<string>;
}

const row = (r: Record<string, unknown> | undefined): HandRecord | null => r ? ({
  ...r, lend: r.lend === 1, local_agents: r.local_agents === 1,
}) as unknown as HandRecord : null;

export class HandRegistry {
  private readonly live = new Map<string, Live>();
  private readonly members = new Map<string, HandMember>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly onlineListeners = new Set<(handId: string) => void>();
  private readonly manifestListeners = new Set<(handId: string) => void>();
  private link: LinkControl | null = null;
  private readonly now: () => number;

  constructor(private readonly d: HandsDeps) {
    d.db.exec(SCHEMA);
    this.now = d.now ?? Date.now;
  }

  /** Set by the link server: revoking must close connections that carry only the human channel too. */
  bindLink(link: LinkControl): void { this.link = link; }

  // ---- records -----------------------------------------------------------------------------------------------------

  get(id: string): HandRecord | null { return row(this.d.db.prepare("SELECT * FROM hands WHERE id = ?").get(id)); }
  list(): HandRecord[] { return (this.d.db.prepare("SELECT * FROM hands ORDER BY paired_at, id").all() as Record<string, unknown>[]).map((r) => row(r)!); }

  /** A paired, unrevoked hand as `service:bodies` wants to see it. */
  view(id: string): { id: string; name: string; kind: string; online: boolean } | null {
    const hand = this.get(id);
    return hand && !hand.revoked_at ? { id, name: hand.name, kind: hand.kind, online: this.live.has(id) } : null;
  }

  /** Writes a hand (or, for a hand that is known, its name, kind, key and permissions again). Never un-revokes. */
  register(hand: NewHand): HandRecord {
    this.d.db.prepare(`INSERT INTO hands (id, name, kind, public_key, paired_by, tier, lend, local_agents, version, platform, paired_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, public_key = excluded.public_key, paired_by = excluded.paired_by,
        tier = excluded.tier, lend = excluded.lend, local_agents = excluded.local_agents`)
      .run(hand.id, hand.name, hand.kind, hand.public_key, hand.paired_by, hand.tier ?? "ask", hand.lend ? 1 : 0, hand.local_agents ? 1 : 0,
        hand.version ?? null, hand.platform ?? null, this.now());
    return this.get(hand.id)!;
  }

  /** The first time this machine's own hand connects (`paired_by=local`, tier `ask`). */
  registerLocal(id: string, hello: HelloFrame["hand"]): HandRecord {
    return this.register({ id, name: hello.name, kind: hello.kind, public_key: hello.public_key ?? "", paired_by: "local", lend: true, version: hello.version, platform: hello.platform });
  }

  /** A connection of this hand is up: when it was last seen, which version it runs. */
  touch(id: string, hand: { version: string; platform: string }): void {
    this.d.db.prepare("UPDATE hands SET last_seen = ?, version = ?, platform = ? WHERE id = ?").run(this.now(), hand.version, hand.platform, id);
  }

  rename(id: string, name: string): void { this.d.db.prepare("UPDATE hands SET name = ? WHERE id = ?").run(name, id); this.refresh(id); }

  setAccess(id: string, access: Access): void {
    const next = { ...this.get(id)!, ...access };
    this.d.db.prepare("UPDATE hands SET tier = ?, lend = ?, local_agents = ? WHERE id = ?").run(next.tier, next.lend ? 1 : 0, next.local_agents ? 1 : 0, id);
  }

  /** The record stays (it is how a later connection from this machine is refused); connections close with 4003. */
  revoke(id: string): void {
    this.d.db.prepare("UPDATE hands SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.now(), id);
    this.link?.closeHand(id, CLOSE_CODES.revoked, "revoked");
    this.dropMembers(id);
    this.d.bodies.forget(id);
  }

  /** Closes the hand's connections with a normal close; it reconnects and is judged again (a permission was taken away). */
  disconnect(id: string, reason: string): void { this.link?.closeHand(id, CLOSE_CODES.normal, reason); }

  /** The owner lets a revoked hand in again (the hand reconnects by itself or is paired anew). */
  restore(id: string): void { this.d.db.prepare("UPDATE hands SET revoked_at = NULL WHERE id = ?").run(id); }

  /** The tier for a member id (`device:<id>`, `body:<id>`); `body:main` and anything unknown ask. */
  tier(target: string): "ask" | "full" {
    const colon = target.indexOf(":");
    return (colon > 0 && target.slice(0, colon) !== "service" && this.get(target.slice(colon + 1))?.tier) || "ask";
  }

  // ---- live state --------------------------------------------------------------------------------------------------

  online(id: string): boolean { return this.live.has(id); }
  /** How the connected hand arrived. */
  via(id: string): "local" | "gateway" | null { const l = this.live.get(id); return l ? (l.local ? "local" : "gateway") : null; }
  /** The capability names of the last manifest, connected or not. */
  capabilities(id: string): string[] {
    return (this.d.db.prepare("SELECT name FROM hand_capabilities WHERE hand = ? ORDER BY name").all(id) as { name: string }[]).map((r) => r.name);
  }
  onOnline(listener: (handId: string) => void): () => void { this.onlineListeners.add(listener); return () => void this.onlineListeners.delete(listener); }
  /** A connected hand's manifest was taken: its capabilities can be called now. */
  onManifest(listener: (handId: string) => void): () => void { this.manifestListeners.add(listener); return () => void this.manifestListeners.delete(listener); }

  /** The risk of one call, asked of the hand that will run it (`GateDeps.assess`); null = the declared risk stands. */
  assess(msg: Message): Promise<Risk | null> {
    return msg.to ? (this.members.get(msg.to)?.assess(msg) ?? Promise.resolve(null)) : Promise.resolve(null);
  }

  /** Whether the computer is bound as a body (the link server opens its device channel for that too). */
  isBound(id: string): boolean { return this.d.bodies.isBound(id); }

  /** `service:bodies` bound or unbound this computer: register the new split of its last manifest. */
  rebind(id: string): void { if (this.live.has(id)) this.registerMembers(id); }

  // ---- the device channel of one connection --------------------------------------------------------------------------

  /** The device channel opened on [session]: take its manifests and events. */
  attach(session: LinkSession, conn: HandConnection): SessionHandlers {
    const id = conn.handId;
    const mine = (): Live | null => { const l = this.live.get(id); return l?.session === session ? l : null; };
    this.live.set(id, { session, local: conn.local, capabilities: [], events: new Set() });
    for (const listener of this.onlineListeners) listener(id);

    return {
      manifest: (frame, check) => {
        const l = mine();
        if (!l) return { accepted: false };
        l.capabilities = check.capabilities;
        l.events = new Set(frame.events.map((e) => e.word));
        this.registerMembers(id);
        this.persist(id, frame, check);
        for (const listener of this.manifestListeners) try { listener(id); } catch (error) { this.d.log?.("manifest listener failed", error); }
      },
      event: (frame) => this.onEvent(session, conn, mine(), frame),
      closed: () => {
        if (!mine()) return; // a newer connection already took this hand's place
        this.live.delete(id);
        this.dropMembers(id);
        this.d.db.prepare("UPDATE hands SET last_seen = ? WHERE id = ?").run(this.now(), id);
      },
    };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  /** The manifest becomes members. `registry.add` with the same id replaces, so a change is never seen half done. */
  private registerMembers(id: string): void {
    const l = this.live.get(id)!;
    const hand = this.get(id)!;
    const split = this.d.splitBodyCapabilities({ id, bound: this.d.bodies.isBound(id) }, l.capabilities);
    const make = (memberId: string, kind: "device" | "body", capabilities: CapabilitySpec[]) => {
      const member = new HandMember({ id: memberId, kind, name: hand.name, capabilities, ...(kind === "device" ? { events: [...l.events] } : {}), local: l.local, session: () => { const now = this.live.get(id); return now && !now.session.closed ? now.session : null; }, now: this.d.now });
      this.members.set(memberId, member);
      this.d.registry.add(member);
    };
    // A hand the owner has not let lend capabilities (only serving as a body, say) is not a `device:` member.
    if (hand.lend) make(deviceId(id), "device", split.hand);
    else this.dropMember(deviceId(id));
    if (split.bodyId && split.body.length) make(split.bodyId, "body", split.body);
    else this.dropMember(bodyId(id));
  }

  private dropMember(memberId: string): void { if (this.members.delete(memberId)) this.d.registry.remove(memberId); }
  private dropMembers(id: string): void { this.dropMember(deviceId(id)); this.dropMember(bodyId(id)); }
  /** The name changed: the members carry it. */
  private refresh(id: string): void { if (this.live.has(id)) this.registerMembers(id); }

  private persist(id: string, frame: ManifestFrame, check: ManifestCheck): void {
    const hash = createHash("sha256").update(JSON.stringify(check.capabilities)).digest("hex");
    const db = this.d.db;
    db.exec("SAVEPOINT manifest");
    try {
      db.prepare("DELETE FROM hand_capabilities WHERE hand = ?").run(id);
      const insert = db.prepare("INSERT INTO hand_capabilities (hand, name, spec) VALUES (?, ?, ?)");
      for (const cap of check.capabilities) insert.run(id, cap.name, JSON.stringify(cap));
      db.prepare("UPDATE hands SET manifest_rev = ?, manifest_hash = ? WHERE id = ?").run(frame.rev, hash, id);
      db.exec("RELEASE manifest");
    } catch (error) {
      db.exec("ROLLBACK TO manifest; RELEASE manifest");
      throw error;
    }
  }

  /** SPEC-03 §4.3: declared in the manifest, routed by namespace to one fixed service, once per event id. */
  private async onEvent(session: LinkSession, conn: HandConnection, l: Live | null, frame: EventFrame): Promise<void> {
    if (!l) return;
    const refuse = (code: "forbidden" | "bad_request", message: string) => void session.send({ t: "error", id: frame.id, code, message });
    // The reply to a refusal is an error frame; the event is still acked, so a hand that queues events does not keep sending it.
    if (!l.events.has(frame.word)) return refuse("forbidden", `${frame.word} is not declared in the manifest`);
    const to = EVENT_TARGETS[frame.word.slice(0, frame.word.indexOf("."))];
    if (!to) return refuse("bad_request", `${frame.word} has no destination`);
    const seen = this.seen.get(conn.handId) ?? new Set<string>();
    this.seen.set(conn.handId, seen);
    if (seen.has(frame.id)) return;
    seen.add(frame.id);
    if (seen.size > SEEN_PER_HAND) seen.delete(seen.values().next().value!);
    const caller: Caller = { member: deviceId(conn.handId), via: "hand", local: conn.local };
    const reply = await this.d.router.send({ to, kind: "event", word: frame.word, body: frame.body }, caller);
    if (reply.ok) return;
    if (RETRY_CODES.has(reply.error.code)) {
      seen.delete(frame.id);
      throw new Error(`${frame.word} could not be delivered (${reply.error.code}); the hand will send it again`);
    }
    this.d.log?.(`event ${frame.word} from ${conn.handId} refused: ${reply.error.code} ${reply.error.message}`);
  }
}
