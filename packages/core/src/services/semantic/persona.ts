/**
 * `service:persona`: the approved SOUL.md and IDENTITY.md (SPEC-10 §1).
 *
 *   get     {file?}                     the approved version of each file: the only text a session loads
 *   propose {file, content, reason}     a new version. The contract is risk `structure` and is in the gate's
 *                                       always-ask list, so an agent's proposal reaches `handle` only after the
 *                                       owner said yes (the review model cannot say it for them); the owner's own
 *                                       change comes in as a human call and goes straight through.
 *
 * Every approved version is kept in the ledger's database (the first one is the template the hub started with); `get`
 * returns the newest. The files in the main body are never read back and never checked: an agent that edits SOUL.md
 * there changes nothing a session loads. An approved change shows in a session only when that session is opened, that
 * is at the next `session.reload` (the agents module sees the static text changed and opens a new session then).
 * The body's copy is rewritten with the approved text so the file the agent reads is the one in force.
 *
 * It is also the words of the system app 「Ash」 (spec APPS-R1 §4): everything about the primary agent that the owner reads
 * and corrects, the same words for the owner and for her.
 *
 *   versions     {file}                         the approved versions of SOUL.md / IDENTITY.md: when, by whom, why
 *   memory.get   {file?}                        USER.md, MEMORY.md, PROACTIVE.md as they are in the main body, and who wrote
 *                                               them last when that was through memory.set
 *   memory.set   {file, content, reason?}       write one of them (she also edits them herself, as files)
 *   diary.list   {before?, limit?}              her diary days (`memory/YYYY-MM-DD.md`, written by the daily review), newest first
 *   diary.get    {date}                         one day's diary, with the notes on it
 *   note         {about, text}                  a note or a correction on something of hers; the primary agent is woken
 *                                               with it (reason `owner_note`) unless she wrote it herself
 *   note.reply   {id, text}                     her answer to a note (what she changed, or why not)
 *   notes.list   {about?, limit?}               the notes, newest first
 *
 * Every change made through these words is told with the event `persona.changed {part, about, by}` (recorded, so the
 * app sees the ledger move and reads again). Her own file edits in the body are not words and send no event; the app
 * reads again whenever the ledger moves, and her turns move it.
 */
import { createHash, randomUUID } from "node:crypto";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import type { Ledger } from "../../kernel/ledger";
import { DONE_MARK } from "./daily";
import { ask, dataOf, primaryAgent, seedBodyFile, wakeAgent, writeBodyFile, type Sender } from "./shared";

export const PERSONA_ID = "service:persona";
export const PERSONA_FILES = ["SOUL.md", "IDENTITY.md"] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];
/** Her memory of the owner and her notes to herself, and what may come to the owner unasked: plain files of the main body. */
export const MEMORY_FILES = ["USER.md", "MEMORY.md", "PROACTIVE.md"] as const;
export type MemoryFile = (typeof MEMORY_FILES)[number];
const DIARY_DIR = "memory";
const DIARY_NAME = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\.md$/;

export interface PersonaOptions {
  ledger: Pick<Ledger, "db">;
  router: Sender;
  /** The text the first approved version of each file is made from (ash-skills/persona/*.template.md). */
  templates: Record<PersonaFile, string>;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

export interface PersonaVersion { file: PersonaFile; content: string; version: string; approved_at: number; by: string; reason: string }
export interface PersonaNote { id: string; about: string; text: string; by: string; at: number; reply?: string; replied_at?: number; replied_by?: string }

const SQL = `CREATE TABLE IF NOT EXISTS persona_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT NOT NULL, content TEXT NOT NULL, version TEXT NOT NULL,
  approved_at INTEGER NOT NULL, approved_by TEXT NOT NULL, reason TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS persona_versions_file ON persona_versions(file, id);
  CREATE TABLE IF NOT EXISTS persona_notes (
  id TEXT PRIMARY KEY, about TEXT NOT NULL, text TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL,
  reply TEXT, replied_at INTEGER, replied_by TEXT);
  CREATE INDEX IF NOT EXISTS persona_notes_about ON persona_notes(about, at);
  CREATE TABLE IF NOT EXISTS persona_growth (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, why TEXT NOT NULL, did TEXT NOT NULL, effect TEXT NOT NULL, next TEXT NOT NULL,
  evidence TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS persona_writes (file TEXT PRIMARY KEY, version TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL);`;

const versionOf = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 12);

export class PersonaService implements Member {
  readonly id = PERSONA_ID;
  readonly kind = "service" as const;
  readonly name = "Persona";
  private readonly db;
  private readonly now: () => number;
  private bodySeeded = false;

  constructor(private readonly options: PersonaOptions) {
    this.db = options.ledger.db();
    this.now = options.now ?? Date.now;
    this.db.exec(SQL);
    // The templates are the first approved versions, set down once (not again after a restart, and not over a later version).
    for (const file of PERSONA_FILES) if (!this.current(file)) this.insert(file, options.templates[file], "template", "the starting text shipped with ash");
  }

  words(): WordContract[] { return wordsOf(PERSONA_ID); }

  /** Put the approved files into the main body when they are not there yet. Best effort: the body may not be up; `tick` tries again. */
  async start(): Promise<void> { await this.seedBody(); }
  async tick(): Promise<void> { if (!this.bodySeeded) await this.seedBody(); }

  private async seedBody(): Promise<void> {
    let all = true;
    for (const file of PERSONA_FILES) all = (await seedBodyFile(this.options.router, PERSONA_ID, file, this.current(file)!.content)) && all;
    this.bodySeeded = all;
  }

  // ---- storage ----

  private insert(file: PersonaFile, content: string, by: string, reason: string): PersonaVersion {
    this.db.prepare("INSERT INTO persona_versions (file, content, version, approved_at, approved_by, reason) VALUES (?,?,?,?,?,?)")
      .run(file, content, versionOf(content), this.now(), by, reason);
    return this.current(file)!;
  }

  /** The newest approved version of a file. */
  current(file: PersonaFile): PersonaVersion | null {
    const row = this.db.prepare("SELECT file, content, version, approved_at, approved_by AS by, reason FROM persona_versions WHERE file=? ORDER BY id DESC LIMIT 1").get(file) as PersonaVersion | undefined;
    return row ?? null;
  }

  /** Every approved version of a file, oldest first (for the owner's page and for tests). */
  versions(file: PersonaFile): PersonaVersion[] {
    return this.db.prepare("SELECT file, content, version, approved_at, approved_by AS by, reason FROM persona_versions WHERE file=? ORDER BY id").all(file) as unknown as PersonaVersion[];
  }

  // ---- words ----

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
    const body = (msg.body ?? {}) as Record<string, unknown>;
    switch (msg.word) {
      case "get": return { data: this.get(body.file as PersonaFile | undefined) };
      case "propose": return { data: await this.propose(body, ctx) };
      case "versions": return { data: { versions: this.versions(body.file as PersonaFile).map(({ content: _c, ...v }) => v).reverse() } };
      case "memory.get": return { data: await this.memoryGet(body.file as MemoryFile | undefined) };
      case "memory.set": return { data: await this.memorySet(body, ctx) };
      case "growth.list": return { data: { items: this.db.prepare("SELECT * FROM persona_growth ORDER BY at DESC, rowid DESC LIMIT ?").all(Number(body.limit ?? 50)).map((r: any) => ({ ...r, evidence: JSON.parse(r.evidence) })) } };
      case "growth.put": return { data: this.growthPut(body, ctx) };
      case "diary.set": return { data: await this.diarySet(body, ctx) };
      case "diary.list": return { data: await this.diaryList(body) };
      case "diary.get": return { data: await this.diaryGet(String(body.date)) };
      case "note": return { data: await this.note(body, ctx) };
      case "note.reply": return { data: this.noteReply(body, ctx) };
      case "notes.list": return { data: { notes: this.notes(body.about as string | undefined, Number(body.limit ?? 50)) } };
      default: throw new WordError("not_found", `service:persona has no word ${msg.word}`);
    }
  }

  /** `persona.changed`: recorded, so whoever shows these things hears the ledger move. */
  private changed(part: "identity" | "memory" | "notes" | "diary" | "growth", about: string, by: string): void {
    this.options.router.send({ to: null, kind: "event", word: "persona.changed", body: { part, about, by } }, { member: PERSONA_ID, via: "service", local: true })
      .then((reply) => { if (!reply.ok) this.options.log?.(`persona.changed: ${reply.error.code}: ${reply.error.message}`); }, (error) => this.options.log?.("persona.changed failed", error));
  }

  // ---- memory files ----

  /** Never offer a truncated document for whole-file editing. */
  private async readContent(path: string): Promise<{ ok: true; text: string } | { ok: false; missing: boolean; message: string }> {
    const reply = await ask(this.options.router, PERSONA_ID, "body:main", "workspace.read", { path, limit: 100000 });
    if (!reply.ok) return { ok: false, missing: reply.error.code === "not_found", message: reply.error.message };
    const data = dataOf<{ text?: unknown; truncated?: boolean }>(reply);
    if (data?.truncated) throw new WordError("too_large", `the whole ${path} could not be read; do not overwrite a partial document`);
    if (typeof data?.text !== "string") throw new WordError("offline", `could not read ${path}`);
    return { ok: true, text: data.text };
  }

  private async memoryGet(file?: MemoryFile) {
    const files = [];
    for (const f of file ? [file] : MEMORY_FILES) {
      const read = await this.readContent(f);
      // Who wrote it last, when it is still what memory.set wrote (an edit she made in her body since is not known here).
      const last = read.ok ? this.db.prepare("SELECT version, by, at FROM persona_writes WHERE file=?").get(f) as { version: string; by: string; at: number } | undefined : undefined;
      if (read.ok) files.push({ file: f, content: read.text, ...(last && last.version === versionOf(read.text) ? { by: last.by, at: last.at } : {}) });
      else if (read.missing) files.push({ file: f, content: "", missing: true });
      else throw new WordError("offline", `could not read ${f}: ${read.message}`);
    }
    return { files };
  }

  private async memorySet(body: Record<string, unknown>, ctx: HandleContext) {
    const file = body.file as MemoryFile;
    const reply = await ask(this.options.router, PERSONA_ID, "body:main", "workspace.write", { path: file, content: String(body.content ?? "") });
    if (!reply.ok) throw new WordError(reply.error.code === "too_large" ? "too_large" : "offline", `could not write ${file}: ${reply.error.message}`);
    this.db.prepare("INSERT OR REPLACE INTO persona_writes (file, version, by, at) VALUES (?,?,?,?)").run(file, versionOf(String(body.content ?? "")), ctx.caller.member, this.now());
    this.changed("memory", `memory:${file}`, ctx.caller.member);
    return { saved: true };
  }

  // Growth is a record of a learned change, not another task or theme store. Work in progress stays in service:tasks.
  private growthPut(body: Record<string, unknown>, ctx: HandleContext) {
    const id = String(body.id);
    this.db.prepare(`INSERT INTO persona_growth (id,title,why,did,effect,next,evidence,at,by) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,why=excluded.why,did=excluded.did,effect=excluded.effect,
      next=excluded.next,evidence=excluded.evidence,at=excluded.at,by=excluded.by`).run(id, String(body.title), String(body.why ?? ""),
      String(body.did), String(body.effect ?? ""), String(body.next ?? ""), JSON.stringify(body.evidence ?? []), this.now(), ctx.caller.member);
    this.changed("growth", `growth:${id}`, ctx.caller.member);
    return { id, saved: true };
  }

  // ---- diary ----

  private async diarySet(body: Record<string, unknown>, ctx: HandleContext) {
    const date = String(body.date);
    if (!DIARY_NAME.test(`${date}.md`) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
      throw new WordError("bad_request", "date must be a calendar date YYYY-MM-DD");
    const result = await ask(this.options.router, PERSONA_ID, "body:main", "workspace.write", { path: `${DIARY_DIR}/${date}.md`, content: String(body.content) });
    if (!result.ok) throw new WordError(result.error.code === "too_large" ? "too_large" : "offline", `could not write diary: ${result.error.message}`);
    this.changed("diary", `diary:${date}`, ctx.caller.member);
    return { saved: true };
  }

  private async diaryList(body: Record<string, unknown>) {
    const limit = Number(body.limit ?? 14);
    const before = typeof body.before === "string" ? body.before : null;
    const listed = await ask(this.options.router, PERSONA_ID, "body:main", "workspace.ls", { path: DIARY_DIR, limit: 1000 });
    if (!listed.ok && listed.error.code !== "not_found") throw new WordError("offline", `could not list the diary: ${listed.error.message}`);
    const dates = (dataOf<{ entries?: { name?: string; type?: string }[] }>(listed)?.entries ?? [])
      .map((e) => (e.type === "file" ? DIARY_NAME.exec(e.name ?? "")?.[1] : undefined)).filter((d): d is string => !!d && (!before || d < before))
      .sort().reverse();
    const days = [];
    for (const date of dates.slice(0, limit)) {
      const read = await this.readContent(`${DIARY_DIR}/${date}.md`);
      if (!read.ok) throw new WordError(read.missing ? "not_found" : "offline", `could not read diary ${date}: ${read.message}`);
      const text = read.text;
      days.push({ date, excerpt: excerptOf(text), done: text.includes(DONE_MARK), notes: this.notes(`diary:${date}`, 100).length });
    }
    return { days, ...(dates.length > limit ? { next_before: dates[limit - 1] } : {}) };
  }

  private async diaryGet(date: string) {
    const read = await this.readContent(`${DIARY_DIR}/${date}.md`);
    if (!read.ok) throw new WordError(read.missing ? "not_found" : "offline", read.missing ? `no diary for ${date}` : read.message);
    return { date, content: read.text, done: read.text.includes(DONE_MARK), notes: this.notes(`diary:${date}`, 100).reverse() };
  }

  // ---- notes ----

  private async note(body: Record<string, unknown>, ctx: HandleContext) {
    const id = typeof body.id === "string" ? body.id : `n_${randomUUID()}`;
    const old = this.db.prepare("SELECT about, text, by FROM persona_notes WHERE id=?").get(id) as { about: string; text: string; by: string } | undefined;
    if (old) {
      if (old.about !== body.about || old.text !== body.text || old.by !== ctx.caller.member) throw new WordError("bad_request", "this note id is already in use with different content");
      return { id, told: false };
    }
    const note: PersonaNote = { id, about: String(body.about), text: String(body.text).slice(0, 4000), by: ctx.caller.member, at: this.now() };
    this.db.prepare("INSERT INTO persona_notes (id, about, text, by, at) VALUES (?,?,?,?,?)").run(note.id, note.about, note.text, note.by, note.at);
    this.changed("notes", note.about, note.by);
    // She is told, on her back lane, so she can fix what the note is about and answer it (skill owner-notes).
    const agent = await primaryAgent(this.options.router, PERSONA_ID);
    let told = false;
    if (agent && agent !== note.by) {
      const woke = await wakeAgent(this.options.router, PERSONA_ID, agent, "owner_note", { note: note.id, about: note.about, text: note.text, by: note.by });
      told = woke.ok;
      if (!woke.ok) this.options.log?.(`persona: could not wake ${agent} for note ${note.id}: ${woke.error.message}`);
    }
    return { id: note.id, told };
  }

  private noteReply(body: Record<string, unknown>, ctx: HandleContext) {
    const id = String(body.id);
    const done = this.db.prepare("UPDATE persona_notes SET reply=?, replied_at=?, replied_by=? WHERE id=?").run(String(body.text).slice(0, 4000), this.now(), ctx.caller.member, id);
    if (done.changes === 0) throw new WordError("not_found", `no note ${id}`);
    const about = (this.db.prepare("SELECT about FROM persona_notes WHERE id=?").get(id) as { about: string }).about;
    this.changed("notes", about, ctx.caller.member);
    return { replied: true };
  }

  /** Notes, newest first (on one thing, or all). */
  notes(about: string | undefined, limit: number): PersonaNote[] {
    const rows = (about
      ? this.db.prepare("SELECT * FROM persona_notes WHERE about=? ORDER BY at DESC, rowid DESC LIMIT ?").all(about, limit)
      : this.db.prepare("SELECT * FROM persona_notes ORDER BY at DESC, rowid DESC LIMIT ?").all(limit)) as unknown as Record<string, unknown>[];
    return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) as unknown as PersonaNote);
  }

  private get(file?: PersonaFile) {
    const files = (file ? [file] : [...PERSONA_FILES]).map((f) => this.current(f)).filter((v): v is PersonaVersion => v !== null)
      .map(({ file, content, version, approved_at }) => ({ file, content, version, approved_at }));
    return { files };
  }

  private async propose(body: Record<string, unknown>, ctx: HandleContext) {
    const file = body.file as PersonaFile;
    const content = body.content as string;
    if (!PERSONA_FILES.includes(file)) throw new WordError("bad_request", "file must be SOUL.md or IDENTITY.md");
    if (!String(body.reason ?? "").trim()) throw new WordError("bad_request", "reason is required: say why the change is wanted");
    if (this.current(file)?.content === content) return { proposed: false, applied: false };
    // Reaching here means the gate let the call through: the owner made it, or the owner approved it.
    this.insert(file, content, ctx.caller.member, String(body.reason).slice(0, 500));
    this.changed("identity", `identity:${file}`, ctx.caller.member);
    if (!(await writeBodyFile(this.options.router, PERSONA_ID, file, content))) this.options.log?.(`persona: could not write ${file} into the body; the approved version is in force anyway`);
    return { proposed: true, applied: true };
  }
}


/** The first few lines of a diary day that say something (headings, the done mark and empty lines left out), for the list. */
export function excerptOf(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("<!--"))
    .slice(0, 2).map((l) => l.replace(/^(?:[-*+]|\d+[.)])\s+/, "")).join(" ").slice(0, 160);
}
