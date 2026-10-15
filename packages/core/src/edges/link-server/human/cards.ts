/**
 * Cards in the conversation (docs/GENUI.md): what `person:owner/show {a2ui}`, `card.update`, `card.draft` and `form` keep.
 * One row per card in `owner_cards`, in the ledger's database: its source (a2ui), its data model (what the owner entered
 * so far included), the plan the owner's screens draw (`checkChatCard`), its plain text, and whether it is still open.
 * `service:history/window` reads the row of a card's message to draw the newest version where the card was first shown.
 */
import type { DatabaseSync } from "node:sqlite";
import { CardError, checkChatCard, pointer, setPointer, type ChatRender } from "../../../../../sdk/src/card";
import { WordError } from "../../../../../sdk/src/message";

/** What a form card waits for: the request it answers, its fields and which of them go to the vault. */
export interface FormInfo {
  request: string;
  fields: Record<string, { type: string; title: string; enum?: unknown[] }>;
  required: string[];
  /** field -> vault name */
  secret: Record<string, string>;
  expires_at: number;
}

export type CardState = "open" | "sent" | "cancelled" | "expired" | "closed";

export interface CardRow {
  id: string;
  /** The message that showed it (the place in the conversation). */
  message: string;
  /** Who showed it: the only one who may change it, and who hears its actions. */
  owner: string;
  a2ui: Record<string, unknown>;
  data: Record<string, unknown>;
  text: string;
  state: CardState;
  form: FormInfo | null;
  plan: ChatRender;
  updated_at: number;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS owner_cards (
  id TEXT PRIMARY KEY, message TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, a2ui TEXT NOT NULL, data TEXT NOT NULL, text TEXT NOT NULL,
  state TEXT NOT NULL, form TEXT, plan TEXT NOT NULL, updated_at INTEGER NOT NULL)`;
/** The most a card's data model may hold (what the owner entered travels with every action). */
export const MAX_DATA_BYTES = 64 * 1024;

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Checks a card for the conversation; a card that cannot be drawn is the caller's `bad_request`. */
export function planOf(a2ui: unknown, data?: Record<string, unknown>): ChatRender {
  try { return checkChatCard(data === undefined ? a2ui : { ...(a2ui as Record<string, unknown>), data }); } catch (error) {
    if (error instanceof CardError) throw new WordError("bad_request", error.message, { recovery_hint: "Fix the card and show it again; widget.card.validate {a2ui, surface: \"chat\"} checks it without showing it." });
    throw error;
  }
}

/** The card's plain text when the agent gave none: its first texts, for notifications and screens that cannot draw it. */
export function textOf(plan: ChatRender): string {
  const texts = plan.components.filter((c) => (c.component === "Text" || c.component === "Badge") && c.text).map((c) => c.text!.replace(/[*_`#>~]/g, "").trim());
  const out = texts.filter(Boolean).slice(0, 3).join(" · ");
  return out.length > 200 ? `${out.slice(0, 199)}…` : out || "一张卡片";
}

export class Cards {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number) {
    db.exec(SCHEMA);
  }

  private decode(r: Record<string, unknown> | undefined): CardRow | null {
    if (!r) return null;
    return {
      id: String(r.id), message: String(r.message), owner: String(r.owner), a2ui: JSON.parse(String(r.a2ui)), data: JSON.parse(String(r.data)),
      text: String(r.text), state: String(r.state) as CardState, form: r.form ? JSON.parse(String(r.form)) as FormInfo : null,
      plan: JSON.parse(String(r.plan)) as ChatRender, updated_at: Number(r.updated_at),
    };
  }

  get(id: string): CardRow | null { return this.decode(this.db.prepare("SELECT * FROM owner_cards WHERE id=?").get(id) as Record<string, unknown> | undefined); }

  private save(row: CardRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO owner_cards(id,message,owner,a2ui,data,text,state,form,plan,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.message, row.owner, JSON.stringify(row.a2ui), JSON.stringify(row.data), row.text, row.state, row.form ? JSON.stringify(row.form) : null, JSON.stringify(row.plan), row.updated_at);
  }

  /** A new card [id] shown by message [message]. */
  put(o: { id: string; message: string; owner: string; a2ui: Record<string, unknown>; text?: string; form?: FormInfo }): CardRow {
    const plan = planOf(o.a2ui);
    const row: CardRow = { id: o.id, message: o.message, owner: o.owner, a2ui: o.a2ui, data: plan.data, text: o.text?.trim() || textOf(plan), state: "open",
      form: o.form ?? null, plan, updated_at: this.now() };
    this.save(row);
    return row;
  }

  /**
   * The creator changes its card: a new layout keeps what the owner entered at the paths its inputs write (unless the new
   * data sets them), then `data` ({pointer: value}) is merged in.
   */
  update(row: CardRow, change: { a2ui?: Record<string, unknown>; data?: Record<string, unknown>; text?: string }): CardRow {
    const a2ui = change.a2ui ?? row.a2ui;
    let data = clone(change.a2ui ? (plain(change.a2ui.data) ? change.a2ui.data : {}) : row.data);
    if (change.a2ui) for (const path of row.plan.binds) {
      const old = pointer(row.data, path);
      if (old !== undefined && pointer(data, path) === undefined) setPointer(data, path, clone(old));
    }
    for (const [path, value] of Object.entries(change.data ?? {})) {
      if (path === "" || path === "/") { if (plain(value)) data = clone(value); continue; }
      if (!setPointer(data, path.startsWith("/") ? path : `/${path}`, clone(value))) throw new WordError("bad_request", `data ${path} cannot be set (a JSON pointer into objects, or into an existing array element)`);
    }
    const plan = planOf(a2ui, data);
    const next: CardRow = { ...row, a2ui, data: plan.data, plan, text: change.text?.trim() || (change.a2ui && !change.text ? textOf(plan) : row.text), updated_at: this.now() };
    this.save(next);
    return next;
  }

  /** The owner's entries so far (the whole data model): kept, and the card drawn with them. A password is never part of it. */
  draft(row: CardRow, data: Record<string, unknown>): CardRow {
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DATA_BYTES) throw new WordError("too_large", `a card's data can hold at most ${MAX_DATA_BYTES / 1024} KB`);
    const plan = planOf(row.a2ui, data);
    const next: CardRow = { ...row, data: plan.data, plan, updated_at: this.now() };
    this.save(next);
    return next;
  }

  setState(id: string, state: CardState, data?: Record<string, unknown>): void {
    const row = this.get(id);
    if (!row) return;
    if (data) { try { this.draft(row, data); } catch { /* the values stay as they were */ } }
    this.db.prepare("UPDATE owner_cards SET state=?, updated_at=? WHERE id=?").run(state, this.now(), id);
  }
}
