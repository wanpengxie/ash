/**
 * The turn journal: a row per turn an agent ran, with how far it got. The ledger holds what happened; this holds what
 * recovery needs in one place (which messages, which session, how often it was already picked up again).
 *
 *   running      the turn is going
 *   done / failed / cancelled   the driver ended it (cancelled: the owner stopped it)
 *   interrupted  the process or the hub went away in the middle of it; recovery decides what happens next
 *   resuming     recovery decided to go on; the new turn has not started yet
 *   resumed      the new turn took over (its row says `resumed_from`)
 *   asked        too old to go on by itself; the owner got a card
 *   given_up     already picked up again as often as allowed
 */
import type { Db } from "../../kernel/ledger";

export type JournalState = "running" | "done" | "failed" | "cancelled" | "interrupted" | "resuming" | "resumed" | "asked" | "given_up";
export interface JournalRow {
  turn: string; agent: string; lane: string; session?: string; ids: string[];
  started_at: number; ended_at?: number; state: JournalState; resumes: number; resumed_from?: string;
}

const SQL = `
CREATE TABLE IF NOT EXISTS turn_journal (
  turn         TEXT PRIMARY KEY,
  agent        TEXT NOT NULL,
  lane         TEXT NOT NULL,
  session      TEXT,
  ids          TEXT NOT NULL DEFAULT '[]',
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  state        TEXT NOT NULL,
  resumes      INTEGER NOT NULL DEFAULT 0,
  resumed_from TEXT
);
CREATE INDEX IF NOT EXISTS turn_journal_agent ON turn_journal(agent, state, started_at);
`;

const rowOf = (r: Record<string, unknown>): JournalRow => ({
  turn: String(r.turn), agent: String(r.agent), lane: String(r.lane), ...(r.session ? { session: String(r.session) } : {}),
  ids: JSON.parse(String(r.ids)) as string[], started_at: Number(r.started_at), ...(r.ended_at == null ? {} : { ended_at: Number(r.ended_at) }),
  state: String(r.state) as JournalState, resumes: Number(r.resumes), ...(r.resumed_from ? { resumed_from: String(r.resumed_from) } : {}),
});

export class Journal {
  constructor(private readonly db: Db) { db.exec(SQL); }

  start(row: { turn: string; agent: string; lane: string; session?: string | null; ids?: string[]; at: number; resumes?: number; resumed_from?: string }): void {
    this.db.prepare("INSERT OR REPLACE INTO turn_journal(turn,agent,lane,session,ids,started_at,state,resumes,resumed_from) VALUES(?,?,?,?,?,?,'running',?,?)")
      .run(row.turn, row.agent, row.lane, row.session ?? null, JSON.stringify(row.ids ?? []), row.at, row.resumes ?? 0, row.resumed_from ?? null);
  }
  get(turn: string): JournalRow | null {
    const r = this.db.prepare("SELECT * FROM turn_journal WHERE turn=?").get(turn) as Record<string, unknown> | undefined;
    return r ? rowOf(r) : null;
  }
  /** Set the state (and the end time, when given) of a turn. */
  set(turn: string, state: JournalState, at?: number): void {
    this.db.prepare("UPDATE turn_journal SET state=?, ended_at=COALESCE(?,ended_at) WHERE turn=?").run(state, at ?? null, turn);
  }
  setResumes(turn: string, resumes: number): void { this.db.prepare("UPDATE turn_journal SET resumes=? WHERE turn=?").run(resumes, turn); }
  running(agent: string): JournalRow[] {
    return (this.db.prepare("SELECT * FROM turn_journal WHERE agent=? AND state='running' ORDER BY started_at").all(agent) as Record<string, unknown>[]).map(rowOf);
  }
  interrupted(agent: string): JournalRow[] {
    return (this.db.prepare("SELECT * FROM turn_journal WHERE agent=? AND state='interrupted' ORDER BY started_at").all(agent) as Record<string, unknown>[]).map(rowOf);
  }
  prune(before: number): void { this.db.prepare("DELETE FROM turn_journal WHERE state NOT IN ('running','interrupted','resuming') AND started_at<?").run(before); }
}
