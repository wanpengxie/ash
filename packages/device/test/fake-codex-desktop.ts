/** A stand-in for the Codex desktop app's local channel: its router, and one window that owns the sessions. */
import { createServer, createConnection, type Server, type Socket } from "node:net";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------------------------------------------------
// a stand-in for the desktop app: the router in its main process, and one window that owns the sessions
// ---------------------------------------------------------------------------------------------------------------------

export type F = Record<string, any>;
export const until = async (check: () => boolean, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};
const frameBytes = (frame: F) => { const b = Buffer.from(JSON.stringify(frame)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const send = (socket: Socket, frame: F) => { socket.write(frameBytes(frame)); };
const reader = (socket: Socket, on: (f: F) => void) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (c) => { buf = Buffer.concat([buf, c]); while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) { const n = buf.readUInt32LE(0); on(JSON.parse(buf.subarray(4, 4 + n).toString())); buf = buf.subarray(4 + n); } });
};

export const turn = (id: string, status: string, items: F[]) => ({ id, status, items });
export const snapshot = (over: F = {}) => ({ id: "t1", cwd: "/work/app", name: "Fix the build", threadRuntimeStatus: { type: "idle" }, turns: [] as F[], requests: [] as F[], ...over });

export class Desktop {
  server!: Server;
  clients = new Map<string, { socket: Socket; type: string }>();
  /** Every frame our client sent, and every request the owner window got. */
  got: F[] = [];
  owned: F[] = [];
  discovery: F[] = [];
  /** The sessions the owner window has open, by id. */
  state = new Map<string, { revision: number; raw: F }>();
  ownerId = "";
  /** How the owner answers a request: by method; a string is an error text, undefined answers success. */
  fail = new Map<string, string>();
  silent = new Set<string>();
  n = 0;
  origin = new Map<string, Socket>();

  constructor(readonly path: string) {}

  async listen(): Promise<void> {
    this.server = createServer((socket) => {
      let id = "";
      reader(socket, (f) => this.route(socket, f, (v) => (id = v), () => id));
      socket.on("close", () => { this.clients.delete(id); });
      socket.on("error", () => {});
    });
    await new Promise<void>((r) => this.server.listen(this.path, r));
  }
  async stop(): Promise<void> { for (const c of this.clients.values()) c.socket.destroy(); this.clients.clear(); await new Promise<void>((r) => this.server.close(() => r())); }

  /** The owner window: a real second client of the router, as the app's windows are. */
  async owner(): Promise<void> {
    const socket = createConnection(this.path);
    await new Promise<void>((r) => socket.on("connect", () => r()));
    reader(socket, (f) => this.ownerGot(socket, f));
    send(socket, { type: "request", requestId: "own-init", method: "initialize", params: { clientType: "desktop" } });
    await until(() => !!this.ownerId, "the owner registering");
    (this as any).ownerSocket = socket;
  }
  private ownerGot(socket: Socket, f: F) {
    if (f.type === "response" && f.requestId === "own-init") { this.ownerId = f.result.clientId; return; }
    if (f.type === "client-discovery-request") { send(socket, { type: "client-discovery-response", requestId: f.requestId, response: { canHandle: true } }); return; }
    if (f.type === "broadcast" && f.method === "thread-stream-following-status-requested") { for (const id of this.state.keys()) this.broadcast(socket, "thread-stream-following-changed", { conversationId: id, hostId: "local", following: true }, null); return; }
    if (f.type === "broadcast" && f.method === "thread-stream-following-changed" && f.params.following === true) {
      const s = this.state.get(f.params.conversationId);
      if (s) this.broadcast(socket, "thread-stream-state-changed", { conversationId: f.params.conversationId, hostId: "local", change: { type: "snapshot", revision: s.revision, conversationState: s.raw } }, [f.sourceClientId]);
      return;
    }
    if (f.type === "request") {
      this.owned.push(f);
      if (this.silent.has(f.method)) { socket.destroy(); return; }
      const error = this.fail.get(f.method);
      send(socket, { type: "response", requestId: f.requestId, method: f.method, handledByClientId: this.ownerId, ...(error ? { resultType: "error", error } : { resultType: "success", result: { ok: true, result: f.method === "thread-follower-start-turn" ? { turn: { id: "turn-new" } } : { interruptedTurnId: "turn-2" } } }) });
    }
  }
  broadcast(socket: Socket, method: string, params: F, targets: string[] | null) { send(socket, { type: "broadcast", method, sourceClientId: this.ownerId, targetClientIds: targets, version: method === "thread-stream-state-changed" ? 11 : 1, params }); }
  /** Opens or changes a session in the owner window, and tells the followers. */
  change(id: string, raw: F, patches?: F[]) {
    const prior = this.state.get(id);
    const revision = (prior?.revision ?? 0) + 1;
    this.state.set(id, { revision, raw });
    const socket = (this as any).ownerSocket as Socket;
    if (!prior || !patches) return this.broadcast(socket, "thread-stream-state-changed", { conversationId: id, hostId: "local", change: { type: "snapshot", revision, conversationState: raw } }, null);
    this.broadcast(socket, "thread-stream-state-changed", { conversationId: id, hostId: "local", change: { type: "patches", baseRevision: revision - 1, revision, patches } }, null);
  }

  private route(socket: Socket, f: F, setId: (v: string) => void, getId: () => string) {
    if (f.type === "request" && f.method === "initialize") {
      const id = `c${++this.n}`; setId(id);
      this.clients.set(id, { socket, type: f.params.clientType });
      send(socket, { type: "response", requestId: f.requestId, method: "initialize", resultType: "success", handledByClientId: id, result: { clientId: id } });
      this.got.push({ ...f, from: id });
      // The router asks every client who handles a request; ours must say no.
      send(socket, { type: "client-discovery-request", requestId: `d${id}`, request: { method: "x" } });
      return;
    }
    if (f.type === "client-discovery-response") { this.discovery.push(f); return; }
    if (f.type === "response") { this.origin.get(f.requestId)?.write(frameBytes(f)); this.origin.delete(f.requestId); return; }
    this.got.push({ ...f, from: getId() });
    if (f.type === "broadcast") {
      const from = getId();
      for (const [id, c] of this.clients) if (c.socket !== socket && (!f.targetClientIds || f.targetClientIds.includes(id))) send(c.socket, { ...f, sourceClientId: from });
    } else if (f.type === "request") {
      const target = this.clients.get(f.targetClientIds?.[0]);
      this.origin.set(f.requestId, socket);
      if (target) send(target.socket, { ...f, sourceClientId: getId() });
      else send(socket, { type: "response", requestId: f.requestId, resultType: "error", error: "no-client-found" });
    }
  }
}

