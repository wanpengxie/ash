import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Edit, Message, MessageErrorCode, ResponseBody, WordSpec } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member } from "../world/member";
import type { Ledger } from "../world/ledger";
import type { RouteHandlerContext, WorldRouter } from "../world/router";
import { SelfJournal, type SelfOperation as Operation } from "../world/self-journal";

const names = ["read", "write", "append", "apply_plan", "rollback", "history"] as const;
const contracts = names.map((name) => wordContract("service:self", name) as WordSpec | undefined);
if (contracts.some((item) => !item)) throw new Error("self contracts unavailable");
const fixed = new Set(["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "HEARTBEAT.md", "PROACTIVE.md"]);
const dated = /^memory\/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/;
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function readText(path: string): string {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new SelfFailure("bad_request", "managed file is not valid UTF-8");
  return text;
}
const validPath = (path: unknown): path is string => typeof path === "string" && (fixed.has(path) || dated.test(path));
const responseError = (code: MessageErrorCode, message: string): ResponseBody => ({ ok: false, error: { code, message } });
export type SelfStage = "after-intent" | "after-snapshot" | "after-temp" | "after-rename" | "after-event";

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableNewFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(content, "utf8");
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function ordinaryFile(path: string): boolean {
  const item = lstatSync(path);
  return item.isFile() && item.nlink === 1;
}

function userVersion(content: string | null): number {
  if (content === null) return 0;
  const match = /^---\nversion: ([1-9][0-9]*)\nupdated: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\n---\n/.exec(content);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new SelfFailure("bad_request", "USER.md has invalid frontmatter");
  return Number(match[1]);
}

function updateUser(content: string, version: number, at: number): string {
  const prefix = /^---\nversion: [1-9][0-9]*\nupdated: [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\n---\n/;
  if (content.startsWith("---\n") && !prefix.test(content)) throw new SelfFailure("bad_request", "USER.md has invalid frontmatter");
  const body = content.replace(prefix, "");
  return `---\nversion: ${version}\nupdated: ${new Date(at).toISOString()}\n---\n${body}`;
}

/** Original 1-based coordinates; all guards are checked before any edit is applied. */
export function applySelfEdits(content: string, edits: readonly Edit[]): string {
  const trailing = content.endsWith("\n");
  const lines = content.split("\n");
  if (trailing) lines.pop();
  if (!edits.length) return content;
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let occupied = 0;
  for (const edit of ordered) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 1 || edit.end < edit.start || edit.end > lines.length ||
      (edit.op === "insert_after" && edit.start !== edit.end) || edit.start <= occupied) throw new SelfFailure("bad_request", "invalid or overlapping edit range");
    if (Array.from(lines[edit.start - 1]).slice(0, 24).join("") !== edit.guard) throw new SelfFailure("bad_request", "stale");
    if (edit.op !== "delete" && typeof edit.text !== "string") throw new SelfFailure("bad_request", "edit text required");
    occupied = edit.end;
  }
  const out: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    out.push(...lines.slice(cursor, edit.op === "insert_after" ? edit.end : edit.start - 1));
    if (edit.op !== "delete") {
      const replacement = (edit.text ?? "").split("\n");
      if (replacement.length > 1 && replacement.at(-1) === "") replacement.pop();
      out.push(...replacement);
    }
    cursor = edit.end;
  }
  out.push(...lines.slice(cursor));
  return out.join("\n") + (trailing ? "\n" : "");
}

class SelfFailure extends Error {
  constructor(readonly code: MessageErrorCode, message: string) { super(message); }
}

export interface SelfMemberOptions { home: string; stateDir: string; ledger: Ledger; router: WorldRouter; failpoint?: (stage: SelfStage) => void }

/** Only this member writes managed files. A separate OS boundary remains required for AR4. */
export class SelfMember implements Member {
  readonly id = "service:self";
  readonly kind = "service" as const;
  readonly name = "Managed files";
  readonly online = true;
  readonly idempotentRecovery = ["read", "history", "write", "append", "apply_plan", "rollback"] as const;
  private readonly home: string;
  private readonly journal: SelfJournal;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: SelfMemberOptions) {
    mkdirSync(options.home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(options.home);
    this.journal = new SelfJournal(options.stateDir);
  }

  words(): readonly WordSpec[] { return contracts as WordSpec[]; }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; await this.tail.catch(() => {}); this.journal.close(); } }
  private operation(id: string): Operation | null { return this.journal.get(id); }
  private state(id: string, state: Operation["state"]): void { this.journal.state(id, state); }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(task);
    this.tail = next;
    return next;
  }
  private path(path: unknown): string {
    if (!validPath(path)) throw new SelfFailure("forbidden", "managed path not allowed");
    const full = resolve(this.home, path);
    if (!full.startsWith(`${this.home}${sep}`)) throw new SelfFailure("forbidden", "managed path escapes home");
    let current = this.home;
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        const meta = lstatSync(current);
        if (meta.isSymbolicLink() || (meta.isFile() && meta.nlink > 1)) throw new SelfFailure("forbidden", "managed path has an alias");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return full;
  }
  private content(path: string): string | null {
    const full = this.path(path);
    return existsSync(full) ? readText(full) : null;
  }
  private versions(path: string): string {
    const root = join(this.home, ".ash", "versions");
    let current = this.home;
    for (const part of [".ash", "versions", ...path.split("/")]) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new SelfFailure("forbidden", "snapshot path has an alias"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return join(root, path);
  }
  private snapshot(path: string, op: Operation, oldContent: string): void {
    if (op.snapshotTs === null || op.oldHash === null) return;
    const dir = this.versions(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${op.snapshotTs}.md`);
    if (existsSync(file)) { if (!ordinaryFile(file) || hash(readText(file)) !== op.oldHash) throw new SelfFailure("failed", "snapshot conflict"); }
    else durableNewFile(file, oldContent);
    syncDirectory(dir);
  }
  private validSnapshot(op: Operation): boolean {
    if (op.snapshotTs === null || op.oldHash === null) return false;
    const file = join(this.versions(op.path), `${op.snapshotTs}.md`);
    return existsSync(file) && ordinaryFile(file) && hash(readText(file)) === op.oldHash;
  }
  private samePrepared(op: Operation, path: string): boolean {
    if (op.preparedDev === null || op.preparedIno === null || !ordinaryFile(path)) return false;
    const item = lstatSync(path, { bigint: true });
    return item.dev.toString() === op.preparedDev && item.ino.toString() === op.preparedIno;
  }
  private prune(path: string): void {
    const dir = this.versions(path);
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((name) => /^[0-9]+\.md$/.test(name));
    if (files.some((name) => !ordinaryFile(join(dir, name)))) throw new SelfFailure("failed", "snapshot alias");
    files.sort((a, b) => Number(b.slice(0, -3)) - Number(a.slice(0, -3)));
    for (const file of files.slice(50)) unlinkSync(join(dir, file));
    if (files.length > 50) syncDirectory(dir);
  }
  private chooseSnapshotTs(path: string): number {
    const dir = this.versions(path);
    if (!existsSync(dir)) return Date.now();
    const highest = Math.max(0, ...readdirSync(dir).filter((name) => /^[0-9]+\.md$/.test(name)).map((name) => Number(name.slice(0, -3))));
    return Math.max(Date.now(), highest + 1);
  }
  private calculate(message: Message, old: string | null, at: number): { content: string; result: Record<string, unknown>; summary: string } {
    const body = message.body;
    const path = String(body.path);
    const previous = path === "USER.md" ? userVersion(old) : 0;
    let content: string;
    let result: Record<string, unknown>;
    let summary: string;
    if (message.word === "write") {
      if (!Object.hasOwn(body, "expected_hash")) throw new SelfFailure("bad_request", "expected_hash required");
      if ((old === null && body.expected_hash !== null) || (old !== null && body.expected_hash !== hash(old))) throw new SelfFailure("bad_request", "stale");
      content = String(body.content);
      summary = "Managed file updated";
      result = {};
    } else if (message.word === "append") {
      if (!dated.test(path)) throw new SelfFailure("forbidden", "append requires dated log");
      content = (old ?? "") + String(body.text);
      summary = "Dated log appended";
      result = {};
    } else if (message.word === "apply_plan") {
      if (old === null || body.expected_hash !== hash(old)) throw new SelfFailure("bad_request", "stale");
      if (!Array.isArray(body.edits)) throw new SelfFailure("bad_request", "invalid edits");
      content = applySelfEdits(old, body.edits as Edit[]);
      summary = "Managed edit plan applied";
      result = { applied: body.edits.length };
    } else if (message.word === "rollback") {
      if (!Number.isSafeInteger(body.to_ts) || old === null) throw new SelfFailure("bad_request", "invalid rollback target");
      const file = join(this.versions(path), `${body.to_ts}.md`);
      if (!existsSync(file)) throw new SelfFailure("not_found", "snapshot not found");
      if (!ordinaryFile(file)) throw new SelfFailure("forbidden", "snapshot has an alias");
      content = readText(file);
      summary = "Managed file rolled back";
      result = {};
    } else throw new SelfFailure("not_found", "self word unavailable");
    if (path === "USER.md") { content = updateUser(content, previous + 1, at); if (message.word === "write") result.version = previous + 1; }
    if (message.word !== "rollback") result.hash = hash(content);
    return { content, result, summary };
  }
  private makeIntent(message: Message, old: string | null): Operation {
    const digest = hash(JSON.stringify({ word: message.word, path: message.body.path, body: message.body, by: message.from }));
    const prior = this.operation(message.id);
    if (prior) {
      if (prior.digest !== digest || prior.by !== message.from || prior.word !== message.word) throw new SelfFailure("bad_request", "operation identity collision");
      return prior;
    }
    const calculated = this.calculate(message, old, message.ts);
    const op: Operation = { id: message.id, digest, path: String(message.body.path), word: message.word, by: message.from,
      oldHash: old === null ? null : hash(old), newHash: hash(calculated.content), snapshotTs: old === null ? null : this.chooseSnapshotTs(String(message.body.path)),
      result: calculated.result, summary: calculated.summary, state: "intent", preparedDev: null, preparedIno: null };
    this.journal.insert(op);
    this.options.failpoint?.("after-intent");
    return op;
  }
  private async event(op: Operation): Promise<void> {
    await this.options.router.send({ transport: "service", transportPrincipal: "service:self", member: "service:self", local: true, remote: false, ownerProxy: false },
      { to: null, kind: "event", word: "self.changed", body: { path: op.path, by: op.by, summary: op.summary, ...(op.result.version === undefined ? {} : { version: op.result.version }) }, client_id: `self.changed:${op.id}` });
    this.options.failpoint?.("after-event");
  }
  private temp(op: Operation): string { return join(dirname(this.path(op.path)), `.${basename(op.path)}.self-${op.id}.tmp`); }
  private discardUnapplied(op: Operation): void {
    const temp = this.temp(op);
    if (existsSync(temp)) {
      if (!ordinaryFile(temp) || hash(readText(temp)) !== op.newHash) throw new SelfFailure("failed", "temporary file conflict");
      unlinkSync(temp); syncDirectory(dirname(temp));
    }
    if (op.oldHash !== null && op.snapshotTs !== null) {
      const snapshot = join(this.versions(op.path), `${op.snapshotTs}.md`);
      if (existsSync(snapshot)) {
        if (!this.validSnapshot(op)) throw new SelfFailure("failed", "snapshot conflict");
        unlinkSync(snapshot); syncDirectory(dirname(snapshot));
      }
    }
  }
  private async mutate(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (context.signal.aborted) return responseError("cancelled", "request cancelled before self write");
    const path = String(message.body.path);
    const target = this.path(path);
    let old = this.content(path);
    const op = this.makeIntent(message, old);
    if (op.state === "conflict") return responseError("failed", "conflict");
    if (op.state === "aborted") return responseError("cancelled", "request cancelled before self write");
    if (old !== null && hash(old) === op.newHash) {
      if (op.oldHash !== op.newHash && !this.samePrepared(op, target)) { this.state(op.id, "conflict"); return responseError("failed", "conflict"); }
      if (op.oldHash === op.newHash && op.snapshotTs !== null) this.snapshot(path, op, old);
      if (op.oldHash !== null && !this.validSnapshot(op)) throw new SelfFailure("failed", "snapshot missing or corrupt after write");
      await this.event(op); this.state(op.id, "committed"); this.prune(path);
      return { ok: true, result: op.result };
    }
    if ((old === null ? null : hash(old)) !== op.oldHash) { this.state(op.id, "conflict"); return responseError("failed", "conflict"); }
    const calculated = this.calculate(message, old, message.ts);
    if (hash(calculated.content) !== op.newHash) { this.state(op.id, "conflict"); return responseError("failed", "conflict"); }
    if (context.signal.aborted) { this.discardUnapplied(op); this.state(op.id, "aborted"); return responseError("cancelled", "request cancelled before self write"); }
    const parent = dirname(target);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    this.path(path); // re-check aliases after creating the parent
    if (old !== null) { this.snapshot(path, op, old); this.options.failpoint?.("after-snapshot"); }
    const temp = this.temp(op);
    if (existsSync(temp)) { if (!ordinaryFile(temp) || hash(readText(temp)) !== op.newHash) throw new SelfFailure("failed", "temporary file conflict"); }
    else durableNewFile(temp, calculated.content);
    if (op.preparedDev === null || op.preparedIno === null) {
      const item = lstatSync(temp, { bigint: true });
      this.journal.prepared(op.id, item.dev.toString(), item.ino.toString());
      op.preparedDev = item.dev.toString(); op.preparedIno = item.ino.toString();
    } else if (!this.samePrepared(op, temp)) throw new SelfFailure("failed", "temporary file identity changed");
    this.options.failpoint?.("after-temp");
    if (context.signal.aborted) { this.discardUnapplied(op); this.state(op.id, "aborted"); return responseError("cancelled", "request cancelled before self write"); }
    old = this.content(path);
    if ((old === null ? null : hash(old)) !== op.oldHash) { this.state(op.id, "conflict"); return responseError("failed", "conflict"); }
    renameSync(temp, target); syncDirectory(parent);
    this.options.failpoint?.("after-rename");
    await this.event(op);
    this.state(op.id, "committed"); this.prune(path);
    return { ok: true, result: op.result };
  }
  private inspect(message: Message): ResponseBody {
    const path = String(message.body.path);
    const content = this.content(path);
    if (message.word === "read") {
      if (content === null) return responseError("not_found", "managed file not found");
      const version = path === "USER.md" ? userVersion(content) : undefined;
      return { ok: true, result: { content, hash: hash(content), ...(version === undefined ? {} : { version }) } };
    }
    const dir = this.versions(path);
    const versions = existsSync(dir) ? readdirSync(dir).filter((name) => /^[0-9]+\.md$/.test(name) && ordinaryFile(join(dir, name))).map((name) => ({ ts: Number(name.slice(0, -3)), hash: hash(readText(join(dir, name))) })).sort((a, b) => b.ts - a.ts) : [];
    return { ok: true, result: { versions } };
  }
  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    if (this.closed) return responseError("offline", "self member closed");
    if (message.to !== this.id || message.kind !== "request" || !names.includes(message.word as typeof names[number])) return responseError("not_found", "self word unavailable");
    try {
      this.path(message.body.path);
      if (message.word === "read" || message.word === "history") return await this.enqueue(async () => this.inspect(message));
      return await this.enqueue(() => this.mutate(message, context));
    } catch (error) {
      if (error instanceof SelfFailure) return responseError(error.code, error.message);
      throw error;
    }
  }

  /** Reconcile completed effects before WorldRouter treats dispatching work as unknown. */
  async prepareRecovery(): Promise<void> {
    for (const op of this.journal.active()) {
      const request = this.options.ledger.byId(op.id);
      if (!request || request.to !== this.id || request.from !== op.by || request.word !== op.word || request.body.path !== op.path) throw new Error("self intent has no matching authorized request");
      const content = this.content(op.path);
      const current = content === null ? null : hash(content);
      if (current === op.newHash) {
        if (op.oldHash !== op.newHash && !this.samePrepared(op, this.path(op.path))) {
          this.state(op.id, "conflict");
          if (!this.options.ledger.responseTo(op.id)) this.options.ledger.settle(op.id, this.id, responseError("failed", "conflict"));
          continue;
        }
        if (op.oldHash === op.newHash && content !== null) this.snapshot(op.path, op, content);
        if (op.oldHash !== null && !this.validSnapshot(op)) throw new Error("self write completed without a valid snapshot");
        await this.event(op);
        if (!this.options.ledger.responseTo(op.id)) this.options.ledger.settle(op.id, this.id, { ok: true, result: op.result });
        this.state(op.id, "committed"); this.prune(op.path);
      } else if (current === op.oldHash) {
        if (this.options.ledger.responseTo(op.id)) { this.discardUnapplied(op); this.state(op.id, "aborted"); } // no effect; do not resurrect a cancelled request
      } else {
        this.state(op.id, "conflict");
        if (!this.options.ledger.responseTo(op.id)) this.options.ledger.settle(op.id, this.id, responseError("failed", "conflict"));
      }
    }
  }
}

export function createSelfMember(options: SelfMemberOptions): SelfMember { return new SelfMember(options); }
