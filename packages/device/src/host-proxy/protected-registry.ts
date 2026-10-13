import { watch, type FSWatcher, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import type { RegistryPort } from "./types";
export function canonicalServer(v: unknown): string { if (typeof v !== "string" || !v || Buffer.byteLength(v) > 256) throw Error("invalid server"); return v.normalize("NFKC").toLowerCase().replace(/^plugin[:/]+/, ""); }
export interface RegistrySnapshot { version: string; connectors: { canonical: string; aliases: string[]; protected: boolean }[] }
/** A supervisor-owned, private configuration manifest, never populated from RPC bodies. */
export class ProtectedRegistry implements RegistryPort {
  private revision = 1; private ready = false; private closed = false; private fingerprint = ""; private servers = new Map<string, boolean>(); private watcher?: FSWatcher; private watchFailed = false;
  constructor(private readonly path: string, private readonly version: string, private readonly attest: (snapshot: Readonly<{ path: string; fingerprint: string; raw: string; version: string }>) => boolean) {
    if (typeof attest !== "function" || !isAbsolute(path)) throw Error("registry path denied"); this.reload();
    this.watcher = watch(path, () => { this.invalidate(); try { this.reload(); } catch { /* remain closed */ } });
    this.watcher.on("error", () => { this.watchFailed = true; this.invalidate(); });
  }
  private snapshot(): { fingerprint: string; value: RegistrySnapshot } {
    const parent = lstatSync(dirname(this.path)); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) || realpathSync(this.path) !== this.path) throw Error("registry parent denied");
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) || before.size > 131072n) throw Error("registry file denied");
      const bytes = Buffer.alloc(131073); let length = 0, count: number;
      while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      const after = fstatSync(fd, { bigint: true }), path = lstatSync(this.path, { bigint: true });
      const stamp = (s: typeof before) => [s.dev,s.ino,s.size,s.ctimeNs,s.mtimeNs,s.uid,s.mode,s.nlink].join(":");
      if (length > 131072 || BigInt(length) !== before.size || stamp(before) !== stamp(after) || stamp(after) !== stamp(path)) throw Error("registry changed");
      const raw = bytes.subarray(0,length).toString("utf8"), fingerprint = `${stamp(after)}:${createHash("sha256").update(bytes.subarray(0,length)).digest("hex")}`;
      if (!this.attest(Object.freeze({path:this.path, fingerprint, raw, version:this.version}))) throw Error("configuration evidence unavailable");
      return { fingerprint, value: JSON.parse(raw) };
    } finally { closeSync(fd); }
  }
  private invalidate(): void { this.revision++; this.ready = false; }
  reload(): void {
    if (this.closed || this.watchFailed) throw Error("registry closed"); this.invalidate();
    const { fingerprint, value } = this.snapshot(); if (value.version !== this.version || !Array.isArray(value.connectors) || value.connectors.length < 1 || value.connectors.length > 256) throw Error("registry snapshot denied");
    const next = new Map<string, boolean>(); let protectedCount = 0;
    for (const entry of value.connectors) {
      if (typeof entry.protected !== "boolean" || !Array.isArray(entry.aliases) || entry.aliases.length > 32) throw Error("registry connector denied");
      if (entry.protected) protectedCount++;
      for (const id of [entry.canonical, ...entry.aliases]) { const name = canonicalServer(id); if (next.has(name)) throw Error("ambiguous alias"); next.set(name, entry.protected); }
    }
    if (!protectedCount) throw Error("protected connector missing"); this.servers = next; this.fingerprint = fingerprint; this.ready = true;
  }
  current(): boolean { if (this.closed || this.watchFailed || !this.ready) return false; try { if (this.snapshot().fingerprint !== this.fingerprint) { this.invalidate(); return false; } return true; } catch { this.invalidate(); return false; } }
  epoch(): number { this.current(); return this.revision; }
  resolve(server: unknown): "protected" | "nonprotected" | "unknown" { if (!this.current()) return "unknown"; try { const v = this.servers.get(canonicalServer(server)); return v === undefined ? "unknown" : v ? "protected" : "nonprotected"; } catch { return "unknown"; } }
  close(): void { if (this.closed) return; this.closed = true; this.invalidate(); this.watcher?.close(); this.watcher = undefined; this.servers.clear(); }
}
