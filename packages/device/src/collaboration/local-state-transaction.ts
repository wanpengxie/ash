import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { acquireDescriptorStateLock, DescriptorLockError, type DescriptorStateLock } from "./descriptor-lock";
export { AUTHORIZATION_LOCK_FILE } from "./descriptor-lock";
import { isAbsolute, join, parse, resolve } from "node:path";
import { readLocalStateFile, type LocalStateFile } from "./local-state";

export type LocalStateName = "paired.json" | "collaboration-read.json" | "collaboration-control.json" | "collaboration-material.json" | "collaboration-read-runtime.json" | "collaboration-control-runtime.json";
export const LOCAL_STATE_LIMITS: Readonly<Record<LocalStateName, number>> = Object.freeze({ "paired.json": 16 * 1024, "collaboration-read.json": 1024 * 1024, "collaboration-control.json": 64 * 1024, "collaboration-material.json": 64 * 1024, "collaboration-read-runtime.json": 16 * 1024, "collaboration-control-runtime.json": 16 * 1024 });
export type LocalStateErrorCode = "stale" | "busy" | "storage" | "unavailable" | "invalid";
export class LocalStateError extends Error {
  constructor(readonly code: LocalStateErrorCode) { super(`Local authorization state: ${code}`); }
}
export interface LocalStateToken { readonly revision: string; readonly epoch: string }
export interface LocalStateObservation extends LocalStateToken { readonly files: Readonly<Record<LocalStateName, LocalStateFile | null>> }
const instances = new Map<string, Set<LocalStateTransaction>>();
const names = Object.keys(LOCAL_STATE_LIMITS) as LocalStateName[];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Canonicalize system ancestor aliases (e.g. macOS /var) once, reject a symlink state directory.
 * All subsequent reads/writes use the canonical path and verify its components. */
function canonicalDirectory(stateDir: string): string {
  if (!isAbsolute(stateDir)) throw new LocalStateError("storage");
  try {
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalStateError("storage");
    return realpathSync(stateDir);
  } catch { throw new LocalStateError("storage"); }
}
function directoryIdentity(stateDir: string): string {
  let cursor = parse(stateDir).root;
  for (const part of resolve(stateDir).slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalStateError("storage");
  }
  const stat = lstatSync(stateDir, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
/** Shared by GUI setup, administrator scope writes and pairing/revocation. No await in commit.
 * A descriptor-only native flock helper holds an OS mutex; no owner/grant sidecar exists.
 * Real filesystem events always invalidate, even when restored bytes compare equal. */
export class LocalStateTransaction {
  readonly stateDir: string;
  private readonly instance = randomUUID();
  private generation = 0;
  private failed = false;
  private closed = false;
  private readonly watcher: FSWatcher;
  private observedRevision: string | undefined;
  private ownCommitNames=new Set<LocalStateName>();
  private ownCommitIdentities?:string[];
  private readonly initialDirectoryIdentity: string;
  constructor(stateDir: string, private readonly changed?: () => void, private readonly extraEpoch?: () => string) {
    this.stateDir = canonicalDirectory(stateDir);
    this.initialDirectoryIdentity = directoryIdentity(this.stateDir);
    try {
      this.watcher = watch(this.stateDir, { persistent: false }, (_event, filename) => {
        if(filename!==null&&names.includes(String(filename) as LocalStateName)&&this.ownCommitNames.has(String(filename) as LocalStateName)&&this.ownCommitIdentities){
          try{const current=this.files(),identities=names.map(name=>current[name]?.identity??"missing");
            // Only a registered synchronous commit's exact physical receipt.
            // External same-byte replacement changes inode/ctime and cannot match.
            if(directoryIdentity(this.stateDir)===this.initialDirectoryIdentity&&JSON.stringify(identities)===JSON.stringify(this.ownCommitIdentities))return;
          }catch{/* Unknown/unreadable evidence remains invalidating. */}
        }
        if (filename === null || names.includes(String(filename) as LocalStateName)) this.invalidate();
      });
      this.watcher.on("error", () => { this.failed = true; this.invalidate(); });
    } catch { throw new LocalStateError("unavailable"); }
    const observers = instances.get(this.stateDir) ?? new Set<LocalStateTransaction>();
    observers.add(this); instances.set(this.stateDir, observers);
  }
  private invalidate(): void { this.generation++; try { this.changed?.(); } catch { this.failed = true; } }
  private epoch(): string {
    if (this.closed || this.failed) throw new LocalStateError("unavailable");
    const additional = this.extraEpoch?.() ?? "";
    if (typeof additional !== "string") throw new LocalStateError("unavailable");
    return `${this.instance}:${this.generation}:${additional}`;
  }
  private files(): Record<LocalStateName, LocalStateFile | null> {
    const result = {} as Record<LocalStateName, LocalStateFile | null>;
    for (const name of names) result[name] = readLocalStateFile(join(this.stateDir, name), LOCAL_STATE_LIMITS[name]);
    return result;
  }
  capture(): LocalStateObservation {
    try {
      const beforeEpoch = this.epoch();
      if (directoryIdentity(this.stateDir) !== this.initialDirectoryIdentity) throw new LocalStateError("stale");
      const first = this.files(), second = this.files();
      const firstIdentity = names.map(name => first[name]?.identity ?? "missing"), secondIdentity = names.map(name => second[name]?.identity ?? "missing");
      if (JSON.stringify(firstIdentity) !== JSON.stringify(secondIdentity) || beforeEpoch !== this.epoch() || directoryIdentity(this.stateDir) !== this.initialDirectoryIdentity) throw new LocalStateError("stale");
      const revision = hash(JSON.stringify([this.initialDirectoryIdentity, ...secondIdentity]));
      // Synchronous observation also catches a delivered-between-checks external ABA by inode/ctime.
      if (this.observedRevision !== undefined && this.observedRevision !== revision) this.invalidate();
      this.observedRevision = revision;
      return Object.freeze({ revision, epoch: this.epoch(), files: Object.freeze(second) });
    } catch (error) { if (error instanceof LocalStateError) throw error; throw new LocalStateError("storage"); }
  }
  assertCurrent(expected: LocalStateToken): LocalStateObservation {
    const actual = this.capture();
    if (expected.revision !== actual.revision || expected.epoch !== actual.epoch) throw new LocalStateError("stale");
    return actual;
  }
  write(name: LocalStateName, raw: string | null, supplied: LocalStateToken, fence: () => undefined = () => undefined): LocalStateObservation {
    const expected = Object.freeze({ revision: supplied.revision, epoch: supplied.epoch });
    let lock: DescriptorStateLock | undefined, temporary: string | undefined;
    try {
      if (!Object.hasOwn(LOCAL_STATE_LIMITS, name) || raw !== null && (typeof raw !== "string" || Buffer.byteLength(raw) > LOCAL_STATE_LIMITS[name])) throw new LocalStateError("invalid");
      this.assertCurrent(expected);
      lock = acquireDescriptorStateLock(this.stateDir);
      this.assertCurrent(expected);
      if (raw !== null) {
        temporary = join(this.stateDir, `.authorization-${randomUUID()}.tmp`);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      }
      this.assertCurrent(expected);
      if (fence() !== undefined) throw new LocalStateError("unavailable");
      lock.assertCurrent();
      this.assertCurrent(expected);
      // No await between the final checks and rename. OS advisory lock survives no crashed process.
      if (temporary) { renameSync(temporary, join(this.stateDir, name)); temporary = undefined; }
      else { try { unlinkSync(join(this.stateDir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      const committed=this.files(),identities=names.map(name=>committed[name]?.identity??"missing");
      for (const observer of instances.get(this.stateDir) ?? []) {if(committed[name])observer.ownCommitNames.add(name);else observer.ownCommitNames.delete(name);observer.ownCommitIdentities=[...identities];observer.invalidate();}
      const dir = openSync(this.stateDir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return this.capture();
    } catch (error) { if (error instanceof LocalStateError) throw error; if (error instanceof DescriptorLockError) throw new LocalStateError(error.code); throw new LocalStateError("storage"); }
    finally {
      if (temporary) { try { unlinkSync(temporary); } catch {} }
      lock?.release();
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.watcher.close();
    const observers = instances.get(this.stateDir); observers?.delete(this);
    if (!observers?.size) instances.delete(this.stateDir);
  }
}
