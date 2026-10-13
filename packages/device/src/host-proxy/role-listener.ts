import http from "node:http";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, unlink, link } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { ListenerFactory, ListenerPort, Role } from "./types";
function inode(path: string): string { const s = lstatSync(path); if (!s.isSocket() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw Error("listener identity denied"); return `${s.dev}:${s.ino}:${s.ctimeMs}`; }
/** Uses an existing supervisor-owned 0700 directory; never deletes a foreign socket. */
export class PrivateRoleListeners implements ListenerFactory {
  private readonly directoryIdentity: string; private readonly instance = randomUUID(); private active = new Set<Role>();
  constructor(private readonly directory: string, private readonly maxPayload = 1024 * 1024) {
    if (!isAbsolute(directory) || realpathSync(directory) !== directory) throw Error("runtime path denied");
    const s = lstatSync(directory); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw Error("runtime directory denied"); this.directoryIdentity = `${s.dev}:${s.ino}`;
  }
  private directoryCurrent(): boolean { try { const s = lstatSync(this.directory); return realpathSync(this.directory) === this.directory && s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && !(s.mode & 0o077) && `${s.dev}:${s.ino}` === this.directoryIdentity; } catch { return false; } }
  async open(role: Role, accept: Parameters<ListenerFactory["open"]>[1], signal: AbortSignal = new AbortController().signal): Promise<ListenerPort> {
    if (signal.aborted || !["gui", "device"].includes(role) || this.active.has(role) || !this.directoryCurrent()) throw Error("listener unavailable");
    const path = join(this.directory, `${role}.sock`); if (Buffer.byteLength(path) > 100) throw Error("socket path too long");
    try { await lstat(path); throw Error("existing listener denied"); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
    if (signal.aborted) throw Error("listener cancelled");
    // libuv unlinks its bind pathname on close. Publish a hard link so closing cannot unlink a replaced fixed role path.
    const bindPath = join(this.directory, `.hp-${randomUUID().slice(0,8)}`); if (Buffer.byteLength(bindPath) > 100) throw Error("bind path too long");
    this.active.add(role); const server = http.createServer((_, r) => { r.writeHead(404); r.end(); }); const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload, perMessageDeflate: false }); let owned = "", closed = false;
    const listener: ListenerPort = { identity: `${this.instance}:${role}`, role, current: () => { try { return !closed && this.directoryCurrent() && inode(path) === owned; } catch { return false; } }, close: async () => {
      if (closed) return; closed = true; this.active.delete(role); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => server.close(() => r())); wss.close();
      try { if (this.directoryCurrent() && inode(path) === owned) await unlink(path); } catch { /* replacement belongs to somebody else */ }
    } };
    server.on("upgrade", (req, socket, head) => { if (req.url !== "/rpc" || !listener.current()) { socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => accept(ws, listener)); });
    try { await new Promise<void>((r, j) => { server.once("error", j); server.listen(bindPath, r); }); if (signal.aborted) throw Error("listener cancelled"); await chmod(bindPath, 0o600); if (signal.aborted) throw Error("listener cancelled"); await link(bindPath, path); owned = inode(path); await unlink(bindPath); owned = inode(path); if (signal.aborted || !this.directoryCurrent()) throw Error("runtime replaced or cancelled"); return listener; }
    catch (e) { await listener.close(); throw e; }
  }
}
