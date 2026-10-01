import type { Message, PostDeliveryChannel, PostDeliverySnapshotV2, PostDeliveryState } from "../../../sdk/src/api";
import type { DatabaseSync } from "node:sqlite";
import type { Ledger } from "./ledger";

type Row = Record<string, unknown>;
export type DeliveryState = "held" | "dispatching" | "done" | "unknown" | "failed" | "dropped";
export interface DeliveryRecord {
  messageId: string;
  kind: "reply" | "offer" | "heads_up" | "approval" | "due";
  channel: PostDeliveryChannel;
  state: DeliveryState;
  releaseAt: number | null;
  error: string | null;
}
const decode = (row: Row): DeliveryRecord => ({ messageId: String(row.message_id), kind: row.kind as DeliveryRecord["kind"],
  channel: row.channel as PostDeliveryChannel, state: row.state as DeliveryState,
  releaseAt: row.release_at === null ? null : Number(row.release_at), error: row.error === null ? null : String(row.error) });

/** The durable presentation journal shares Ledger's SQLite transaction for count snapshots. */
export class PostJournal {
  constructor(private readonly ledger: Ledger) {
    ledger.postWrite((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS post_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS post_deliveries (
          message_id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel TEXT NOT NULL,
          state TEXT NOT NULL, dedupe_key TEXT, created_at INTEGER NOT NULL,
          release_at INTEGER, attempted_at INTEGER, error TEXT, version_seq INTEGER);
        CREATE TABLE IF NOT EXISTS post_dedupe (dedupe_key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);`);
      const columns = db.prepare("PRAGMA table_info(post_deliveries)").all() as Row[];
      if (!columns.some((column) => column.name === "version_seq")) db.exec("ALTER TABLE post_deliveries ADD COLUMN version_seq INTEGER");
    });
  }

  cursor(): number | null {
    const row = this.ledger.postRead((db) => db.prepare("SELECT value FROM post_meta WHERE key='source_cursor'").get()) as Row | undefined;
    if (!row) return null;
    const cursor = Number(row.value);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("invalid durable post cursor");
    return cursor;
  }
  /** First install deliberately excludes already-present historical messages. */
  beginAt(currentSeq: number): Message {
    return this.ledger.postWrite((db, snapshot) => {
      db.prepare("INSERT OR IGNORE INTO post_meta(key,value) VALUES('source_cursor',?)").run(String(currentSeq));
      db.prepare("UPDATE post_deliveries SET state='unknown',error='effect_unknown_after_restart' WHERE state='dispatching'").run();
      return snapshot(this.heldCountIn(db));
    });
  }
  advanceCursor(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError("invalid post cursor");
    this.ledger.postWrite((db) => {
      const old = Number((db.prepare("SELECT value FROM post_meta WHERE key='source_cursor'").get() as Row).value);
      if (seq > old) db.prepare("UPDATE post_meta SET value=? WHERE key='source_cursor'").run(String(seq));
    });
  }

  private heldCountIn(db: DatabaseSync): number {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM post_deliveries WHERE state='held'").get() as Row).n);
  }
  heldCount(): number { return this.ledger.postRead((db) => this.heldCountIn(db)); }
  record(messageId: string): DeliveryRecord | null {
    const row = this.ledger.postRead((db) => db.prepare("SELECT * FROM post_deliveries WHERE message_id=?").get(messageId)) as Row | undefined;
    return row ? decode(row) : null;
  }
  /** The bounded ledger page and current visibility for only its own IDs share one read snapshot. */
  pageSnapshot(query: { after?: number; before?: number; limit?: number }): { page: Message[]; snapshot: PostDeliverySnapshotV2 } {
    return this.ledger.postReadSnapshot((db) => {
      const page = this.ledger.list(query);
      const at_seq = this.ledger.lastSeq();
      const find = db.prepare(`SELECT e.seq,e.body,p.kind,p.state,p.channel FROM post_deliveries p
        JOIN messages e ON e.seq=p.version_seq AND e.word='post.delivery' AND e.kind='event' AND e."from"='service:post' AND e."to"='person:owner'
        WHERE p.message_id=?`);
      const items: PostDeliverySnapshotV2["items"] = [];
      for (const message of page) {
        if (message.kind !== "request" || message.word !== "say" || message.to !== "person:owner" ||
          message.seq <= this.ledger.migration.lastLegacySeq || Object.hasOwn(message.body, "legacy") ||
          (message.body.kind !== "offer" && message.body.kind !== "heads_up")) continue;
        const row = find.get(message.id) as Row | undefined;
        if (!row) continue;
        let body: { message_id?: unknown; state?: unknown } | null;
        try { body = JSON.parse(String(row.body)) as typeof body; } catch { continue; }
        if (!body || typeof body !== "object" || Array.isArray(body) || body.message_id !== message.id ||
          typeof body.state !== "string" || !["held", "released", "dropped"].includes(body.state)) continue;
        const expected = body.state === "held" ? ["held", "held"] : body.state === "dropped" ? ["dropped", "dropped"] : ["done", "inapp"];
        if (row.kind !== message.body.kind || row.state !== expected[0] || row.channel !== expected[1]) continue;
        const version_seq = Number(row.seq);
        if (!Number.isSafeInteger(version_seq) || version_seq < 1 || version_seq > at_seq) continue;
        items.push({ message_id: message.id, state: body.state as PostDeliveryState, version_seq });
      }
      return { page, snapshot: { at_seq, items } };
    });
  }
  /** Persist one classification and its count event before any external presentation. */
  classify(input: { messageId: string; kind: DeliveryRecord["kind"]; channel: Exclude<PostDeliveryChannel, "dropped">;
    dedupeKey?: string; now: number; dedupeMs: number; releaseAt?: number }): { record: DeliveryRecord; snapshot: Message | null; visibility: Message | null; fresh: boolean } {
    return this.ledger.postWrite((db, snapshot, delivery) => {
      const prior = db.prepare("SELECT * FROM post_deliveries WHERE message_id=?").get(input.messageId) as Row | undefined;
      if (prior) return { record: decode(prior), snapshot: null, visibility: null, fresh: false };
      let channel: PostDeliveryChannel = input.channel;
      if (input.dedupeKey !== undefined && input.dedupeMs > 0) {
        db.prepare("DELETE FROM post_dedupe WHERE seen_at<=?").run(input.now - input.dedupeMs);
        const previous = db.prepare("SELECT seen_at FROM post_dedupe WHERE dedupe_key=?").get(input.dedupeKey) as Row | undefined;
        if (previous && input.now - Number(previous.seen_at) < input.dedupeMs) channel = "dropped";
        else db.prepare("INSERT INTO post_dedupe(dedupe_key,seen_at) VALUES(?,?) ON CONFLICT(dedupe_key) DO UPDATE SET seen_at=excluded.seen_at")
          .run(input.dedupeKey, input.now);
      }
      const state: DeliveryState = channel === "held" ? "held" : channel === "notification" ? "dispatching" : channel === "dropped" ? "dropped" : "done";
      db.prepare("INSERT INTO post_deliveries(message_id,kind,channel,state,dedupe_key,created_at,release_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.messageId, input.kind, channel, state, input.dedupeKey ?? null, input.now, channel === "held" ? input.releaseAt ?? null : null);
      const visibility = input.kind === "offer" || input.kind === "heads_up" ? delivery({ message_id: input.messageId,
        state: channel === "held" ? "held" : channel === "dropped" ? "dropped" : "released" }) : null;
      if (visibility) db.prepare("UPDATE post_deliveries SET version_seq=? WHERE message_id=?").run(visibility.seq, input.messageId);
      const row = db.prepare("SELECT * FROM post_deliveries WHERE message_id=?").get(input.messageId) as Row;
      return { record: decode(row), snapshot: channel === "held" ? snapshot(this.heldCountIn(db)) : null, visibility, fresh: true };
    });
  }
  due(now: number): DeliveryRecord[] {
    return this.ledger.postRead((db) => db.prepare("SELECT * FROM post_deliveries WHERE state='held' AND release_at<=? ORDER BY release_at,message_id").all(now) as Row[]).map(decode);
  }
  /** Release a held row before host I/O; count and snapshot are one commit. */
  release(messageId: string): { record: DeliveryRecord; snapshot: Message; visibility: Message } | null {
    return this.ledger.postWrite((db, snapshot, delivery) => {
      const changed = db.prepare("UPDATE post_deliveries SET state='done',channel='inapp' WHERE message_id=? AND state='held' AND kind IN ('offer','heads_up')")
        .run(messageId);
      if (Number(changed.changes) !== 1) return null;
      const visibility = delivery({ message_id: messageId, state: "released" });
      db.prepare("UPDATE post_deliveries SET version_seq=? WHERE message_id=?").run(visibility.seq, messageId);
      const row = db.prepare("SELECT * FROM post_deliveries WHERE message_id=?").get(messageId) as Row;
      return { record: decode(row), snapshot: snapshot(this.heldCountIn(db)), visibility };
    });
  }
  finish(messageId: string, ok: boolean, detail: string | null = null): void {
    this.ledger.postWrite((db) => db.prepare("UPDATE post_deliveries SET state=?,error=? WHERE message_id=? AND state='dispatching'")
      .run(ok ? "done" : "unknown", ok ? null : detail ?? "presentation_outcome_unknown", messageId));
  }
  failKnown(messageId: string, detail: string): void {
    this.ledger.postWrite((db) => db.prepare("UPDATE post_deliveries SET state='failed',error=? WHERE message_id=? AND state='dispatching'")
      .run(detail, messageId));
  }
}
