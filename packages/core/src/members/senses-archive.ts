import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../../../sdk/src/api";
import { localDate, parseLine, senseLines, type ActivityLine, type GeofenceLine, type HealthLine, type LocationLine, type SenseKind } from "./senses-facts";

type Line = LocationLine | ActivityLine | HealthLine | GeofenceLine;
type LineOf<K extends SenseKind> = K extends "location" ? LocationLine : K extends "activity" ? ActivityLine : K extends "health" ? HealthLine : GeofenceLine;
export interface SenseArchiveOptions { home: string; timeZone?: string }

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
}

/**
 * Phone facts as monthly JSON-lines files in the owner's home workspace (senses/<kind>-YYYY-MM.jsonl), plus the
 * daily summaries (senses/daily-YYYY-MM-DD.json). Pure code: nothing here reaches a model. A batch already present
 * in a month file is never appended to that file again; a torn line is skipped on read.
 */
export class SenseArchive {
  readonly timeZone: string;
  private readonly home: string;
  /** Batch ids per month file, valid while the file keeps the identity and size this process last saw. */
  private readonly seen = new Map<string, { ino: bigint; size: bigint; ids: Set<string> }>();

  constructor(options: SenseArchiveOptions) {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(options.home);
    this.timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** senses/ under the home, refusing any alias that would lead writes elsewhere. */
  private dir(): string {
    const dir = join(this.home, "senses");
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(dir).isDirectory()) throw new Error("senses archive is not a plain directory");
    return dir;
  }

  private month(at: number): string { return localDate(at, this.timeZone).slice(0, 7); }
  private file(kind: SenseKind, month: string): string { return join(this.dir(), `${kind}-${month}.jsonl`); }

  private ids(path: string): Set<string> {
    let stat: ReturnType<typeof lstatSync> & { ino: bigint; size: bigint };
    try { stat = lstatSync(path, { bigint: true }) as typeof stat; } catch { this.seen.delete(path); return new Set(); }
    if (!stat.isFile()) throw new Error("senses archive file is not a plain file");
    const cached = this.seen.get(path);
    if (cached && cached.ino === stat.ino && cached.size === stat.size) return cached.ids;
    const ids = new Set<string>();
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      if (!raw) continue;
      try { const id = (JSON.parse(raw) as { batch_id?: unknown }).batch_id; if (typeof id === "string") ids.add(id); } catch { /* torn line */ }
    }
    this.seen.set(path, { ino: stat.ino, size: stat.size, ids });
    return ids;
  }

  /** Archive one validated phone sense event. Returns the number of lines written (0 for a repeat or another word). */
  record(message: Pick<Message, "word" | "body">): number {
    const facts = senseLines(message);
    if (!facts || !facts.lines.length) return 0;
    const byMonth = new Map<string, Line[]>();
    for (const line of facts.lines) {
      const month = this.month(line.ts);
      byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
    }
    let written = 0;
    for (const [month, lines] of byMonth) {
      const path = this.file(facts.kind, month);
      const ids = this.ids(path);
      if (ids.has(facts.batch)) continue;
      const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        // A line torn by a crash stays on its own line rather than swallowing the first new one.
        const size = fstatSync(fd).size, last = Buffer.alloc(1);
        const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
        writeAll(fd, `${torn ? "\n" : ""}${lines.map((line) => `${JSON.stringify(line)}\n`).join("")}`);
        fsyncSync(fd);
        const stat = fstatSync(fd, { bigint: true });
        ids.add(facts.batch);
        this.seen.set(path, { ino: stat.ino, size: stat.size, ids });
      } finally { closeSync(fd); }
      written += lines.length;
    }
    return written;
  }

  /** Archived lines of a kind with from <= ts < to, read from every month file the range touches. */
  lines<K extends SenseKind>(kind: K, from: number, to: number): LineOf<K>[] {
    if (!(to > from)) return [];
    const months: string[] = [];
    for (let at = from; ; at += 86_400_000 * 27) {
      const month = this.month(Math.min(at, to - 1));
      if (!months.includes(month)) months.push(month);
      if (at >= to - 1) break;
    }
    const out: LineOf<K>[] = [];
    for (const month of months) {
      const path = this.file(kind, month);
      let content: string;
      try {
        if (!lstatSync(path).isFile()) continue;
        content = readFileSync(path, "utf8");
      } catch { continue; }
      for (const raw of content.split("\n")) {
        if (!raw) continue;
        const line = parseLine(kind, raw);
        if (line && line.ts >= from && line.ts < to) out.push(line as LineOf<K>);
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  readDaily(date: string): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("invalid date");
    try {
      const path = join(this.dir(), `daily-${date}.json`);
      return lstatSync(path).isFile() ? readFileSync(path, "utf8") : null;
    } catch { return null; }
  }

  /** Replace a daily summary atomically; false when the file already holds exactly this content. */
  writeDaily(date: string, summary: unknown): boolean {
    const content = `${JSON.stringify(summary, null, 2)}\n`;
    if (this.readDaily(date) === content) return false;
    const dir = this.dir(), path = join(dir, `daily-${date}.json`), temp = join(dir, `.daily-${date}.${process.pid}.tmp`);
    try { unlinkSync(temp); } catch { /* none left over */ }
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeAll(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    return true;
  }
}
