import { consumeNativeInvocationClaim } from "../collaboration/delivery";
import { consumePreparedMaterialDispatch } from "../collaboration/material-input-reader";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { authorize, METHOD_POLICY } from "./method-policy";
import { decodeFrame } from "./protocol";
import type { Frame, ListenerPort, NativeIdentity, ProxyOptions, RoleLease } from "./types";
type Lease = { native: NativeIdentity; registry: number; role: number; frame: Frame };
type Request = { downstreamId: string | number; upstreamId: string; lease: Lease; timer: ReturnType<typeof setTimeout> };
type Peer = { abort: AbortController; down: WebSocket; up?: WebSocket; listener: ListenerPort; role: RoleLease; native: NativeIdentity; requests: Map<string, Request>; queue: Lease[]; dead: boolean; initialized: boolean; timer?: ReturnType<typeof setTimeout> };
type ServerRequest = { key: string; nativeId: string | number; downstreamId: string; owner: Peer; lease: Lease; timer: ReturnType<typeof setTimeout> };
export class HostProxy {
  private readonly instance = randomUUID(); private sequence = 0; private closed = false; private poisoned = false; private closing?: Promise<void>; private starting?: Promise<void>; private readonly startupAbort = new AbortController(); private disposedListeners = new WeakMap<ListenerPort, Promise<void>>(); private peers = new Set<Peer>(); private listeners: ListenerPort[] = []; private server = new Map<string, ServerRequest>(); private retired = new Set<string>();
  private readonly bytes: number; private readonly timeout: number;
  constructor(private readonly options: ProxyOptions) {
    this.bytes = options.maxPayload ?? 1024 * 1024; this.timeout = options.timeoutMs ?? 5000;
    if (!options.native || !options.roles || !options.registry || !options.listeners || !options.version || !Number.isSafeInteger(this.bytes) || this.bytes < 1 || this.bytes > 1024 * 1024 || !Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 60000 || !Number.isSafeInteger(options.maxConnections ?? 16) || (options.maxConnections ?? 16) < 1 || (options.maxConnections ?? 16) > 128 || !Number.isSafeInteger(options.maxRetired ?? 128) || (options.maxRetired ?? 128) < 1 || (options.maxRetired ?? 128) > 4096) throw Error("invalid proxy ports");
    for (const method of METHOD_POLICY.keys()) if (!options.clientMethods.has(method)) throw Error("supported schema missing policy method");
    if (options.native.identity().version !== options.version) throw Error("unsupported native version");
  }
  status() { return { ready: !this.closed && !this.poisoned && this.listeners.length === 2 && this.listeners.every(l => l.current()) && this.options.registry.current() && this.options.native.current(this.options.native.identity()), replaceable: false, connections: this.peers.size, pendingServerRequests: this.server.size, retired: this.retired.size, queued: [...this.peers].reduce((n, p) => n + p.queue.length, 0) }; }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(Error("proxy unavailable"));
    if (this.starting) return this.starting;
    this.starting = this.startListeners(); return this.starting;
  }
  private async startListeners(): Promise<void> {
    const timer = setTimeout(() => this.startupAbort.abort(), this.timeout);
    try {
      for (const role of ["gui", "device"] as const) {
        const signal = this.startupAbort.signal; if (this.closed || signal.aborted) throw Error("startup cancelled");
        // Factory must honor cancellation; the late-resolution guard also disposes a returned owned port.
        const raw = Promise.resolve().then(() => this.options.listeners.open(role, (ws, listener) => this.accept(ws, listener), signal));
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(Error("startup cancelled")); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
        void raw.then(port => { if (signal.aborted || this.closed) return this.disposeListener(port); }, () => {}).catch(() => {});
        let port: ListenerPort;
        try { port = await Promise.race([raw, cancelled]); } finally { signal.removeEventListener("abort", abort); }
        if (this.closed || signal.aborted) { await this.disposeListener(port); throw Error("startup cancelled"); } this.listeners.push(port);
      }
    } catch (e) {
      this.closed = true; this.startupAbort.abort(); for (const p of [...this.peers]) this.drop(p);
      try { await Promise.allSettled(this.listeners.splice(0).map(l => this.disposeListener(l))); } finally { this.options.registry.close(); }
      throw e;
    } finally { clearTimeout(timer); }
  }
  private disposeListener(port: ListenerPort): Promise<void> { const existing = this.disposedListeners.get(port); if (existing) return existing; const closing = Promise.resolve().then(() => port.close()); this.disposedListeners.set(port, closing); return closing; }
  private current(p: Peer): void { if (this.closed || this.poisoned || p.dead || !p.listener.current() || !this.options.roles.current(p.role) || !this.options.native.current(p.native)) throw Error("connection stale"); }
  private capture(p: Peer, frame: Frame): Lease { return { frame, native: p.native, registry: this.options.registry.epoch(), role: this.options.roles.epoch(p.role) }; }
  private operation(p: Peer, lease: Lease, server = false): void {
    this.current(p); if (lease.native.generation !== p.native.generation || !this.options.native.current(lease.native) || lease.registry !== this.options.registry.epoch() || lease.role !== this.options.roles.epoch(p.role)) throw Error("operation stale");
    if (server) { if (p.role.role !== "gui" || !this.options.registry.current()) throw Error("server answer denied"); }
    else { if (lease.frame.method === "thread/start" && !this.options.roles.registerCreated) throw Error("create registration unavailable"); authorize(lease.frame.method!, lease.frame.params, p.role, this.options.registry, this.options.clientMethods); }
  }
  private send(p: Peer, socket: WebSocket | undefined, frame: Frame, fence = () => this.current(p), beforeSend?:()=>undefined): void { fence(); const data = JSON.stringify(frame); if (!socket || socket.readyState !== WebSocket.OPEN || Buffer.byteLength(data) > this.bytes || socket.bufferedAmount + Buffer.byteLength(data) > 2 * this.bytes) throw Error("transport budget"); fence(); if(beforeSend&&beforeSend()!==undefined)throw Error("dispatch denied"); socket.send(data); }
  private retire(key: string): boolean { if (this.retired.has(key)) return true; if (this.retired.size >= (this.options.maxRetired ?? 128)) { this.poisoned = true; for (const p of [...this.peers]) this.drop(p); return false; } this.retired.add(key); return true; }
  private drop(p: Peer): void { if (p.dead) return; p.dead = true; p.abort.abort(); this.peers.delete(p); clearTimeout(p.timer); for (const q of p.requests.values()) clearTimeout(q.timer); p.requests.clear(); p.queue.length = 0; p.down.terminate(); p.up?.terminate(); for (const [key, q] of this.server) if (q.owner === p) { clearTimeout(q.timer); this.server.delete(key); this.retire(key); } }
  private accept(down: WebSocket, listener: ListenerPort): void {
    if (this.closed || this.poisoned || this.listeners.length !== 2 || this.peers.size >= (this.options.maxConnections ?? 16)) { down.terminate(); return; }
    let role: RoleLease, native: NativeIdentity; try { role = this.options.roles.acquire(listener.role, listener.identity); native = this.options.native.identity(); if (role.role !== listener.role || native.version !== this.options.version || !this.options.roles.current(role) || !this.options.native.current(native)) throw 0; } catch { down.terminate(); return; }
    const p: Peer = { abort: new AbortController(), down, listener, role, native, requests: new Map(), queue: [], dead: false, initialized: false }; this.peers.add(p); p.timer = setTimeout(() => this.drop(p), this.timeout);
    down.on("close", () => this.drop(p)); down.on("error", () => this.drop(p));
    down.on("message", data => { try {
      this.current(p); const v = decodeFrame(data, this.bytes);
      if (!v.method) { const q = [...this.server.values()].find(q => q.owner === p && q.downstreamId === v.id); if (!q) throw Error("unowned server answer"); const check = () => this.operation(p, q.lease, true); check(); if (!this.retire(q.key)) return; this.send(p, p.up, { ...v, id: q.nativeId }, check); clearTimeout(q.timer); this.server.delete(q.key); return; }
      if (v.id === undefined) { if (v.method !== "initialized" || !p.initialized) throw Error("notification denied"); this.send(p, p.up, v); return; }
      if (v.method !== "initialize" && !p.initialized) throw Error("handshake required");
      const lease = this.capture(p, v); this.operation(p, lease); if (p.requests.size + p.queue.length >= 32 || [...p.requests.values()].some(q => q.downstreamId === v.id) || p.queue.some(q => q.frame.id === v.id)) throw Error("request budget");
      if (!p.up || p.up.readyState !== WebSocket.OPEN) { if (p.queue.length >= 2 || p.queue.reduce((n, q) => n + Buffer.byteLength(JSON.stringify(q.frame)), 0) + Buffer.byteLength(JSON.stringify(v)) > 2 * this.bytes) throw Error("queue budget"); p.queue.push(lease); }
      else this.forward(p, lease);
    } catch { this.drop(p); } });
    void Promise.resolve().then(() => this.options.native.connect(native, p.abort.signal)).then(up => { try { this.current(p); if (up.readyState !== WebSocket.OPEN) throw Error("native connection not authenticated/open"); p.up = up; clearTimeout(p.timer); up.on("close", () => this.drop(p)); up.on("error", () => this.drop(p)); up.on("message", data => this.nativeMessage(p, data)); for (const lease of p.queue.splice(0)) this.forward(p, lease); } catch { up.terminate(); this.drop(p); } }, () => this.drop(p));
  }
  private forward(p: Peer, lease: Lease): void {
    this.operation(p, lease); const upstreamId = `cr:${this.instance}:${++this.sequence}`, v = lease.frame;
    const timer = setTimeout(() => this.drop(p), this.timeout); p.requests.set(upstreamId, { upstreamId, downstreamId: v.id!, lease, timer });
    try { this.send(p, p.up, { ...v, id: upstreamId }, () => this.operation(p, lease), () => {if(v.method==='turn/start'||v.method==='turn/steer'){const proof=p.role.works.get(v.params.threadId)?.preparedInput;if(proof)consumePreparedMaterialDispatch(proof,v.method,v.params);else{const claim=p.role.works.get(v.params.threadId)?.claimInput;if(claim)consumeNativeInvocationClaim(claim,v.method,v.params);}}return undefined;}); if (v.method === "initialize") p.initialized = true; } catch (e) { clearTimeout(timer); p.requests.delete(upstreamId); throw e; }
  }
  private nativeMessage(p: Peer, data: unknown): void { try {
    this.current(p); const v = decodeFrame(data, this.bytes);
    if (!v.method) { const q = p.requests.get(String(v.id)); if (!q) throw Error("unmatched native answer"); this.operation(p, q.lease);
      if (q.lease.frame.method === "thread/start" && !v.error) { const grant = p.role.create, thread = v.result?.thread; if (!grant || !thread || typeof thread.id !== "string" || thread.cwd !== grant.cwd || (thread.projectId !== undefined && thread.projectId !== grant.projectId) || !this.options.roles.registerCreated) throw Error("create registration unavailable"); const updated = this.options.roles.registerCreated(p.role, grant, thread);
        const registered = updated.works.get(thread.id);
        if (updated.role !== p.role.role || updated.identity !== p.role.identity || updated.generation !== p.role.generation || updated.create?.operationId !== grant.operationId || updated.create.cwd !== grant.cwd || updated.create.projectId !== grant.projectId || !registered || registered.createOperationId !== grant.operationId || !this.options.roles.current(updated)) throw Error("create lease transition denied");
        p.role = updated; q.lease = { ...q.lease, role: this.options.roles.epoch(updated) }; }
      if (q.lease.frame.method === "project/list" && !v.error) {
        const grant = p.role.create, page = v.result; if (!grant || !Array.isArray(page?.data) || page.data.length > q.lease.frame.params.limit || (page.nextCursor != null && (typeof page.nextCursor !== "string" || page.nextCursor === q.lease.frame.params.cursor))) throw Error("project page denied");
        v.result = { ...page, data: page.data.filter((project: any) => project?.id === grant.projectId && Array.isArray(project.roots) && project.roots.some((root: any) => root?.path === grant.cwd)).map((project: any) => ({ ...project, roots: project.roots.filter((root: any) => root?.path === grant.cwd) })) };
      }
      const tid = v.result?.thread?.id ?? v.result?.threadId; if (tid && !p.role.works.has(tid)) throw Error("response work denied");
      this.send(p, p.down, { ...v, id: q.downstreamId }, () => this.operation(p, q.lease)); clearTimeout(q.timer); p.requests.delete(String(v.id)); return;
    }
    if (v.id !== undefined) {
      if (!this.options.serverMethods.has(v.method)) throw Error("server method denied"); if (p.role.role !== "gui") return;
      const key = JSON.stringify([p.native.generation, v.id, v.method, v.params?.threadId ?? null, v.params?.turnId ?? null]); if (this.server.has(key) || this.retired.has(key)) return;
      if (this.server.size >= 32) throw Error("server budget"); const tid = v.params?.threadId; if (tid && !p.role.works.has(tid)) throw Error("server work denied");
      const lease = this.capture(p, v), downstreamId = `sr:${this.instance}:${++this.sequence}`; this.operation(p, lease, true); const timer = setTimeout(() => this.drop(p), this.timeout); this.server.set(key, { key, nativeId: v.id, downstreamId, owner: p, lease, timer }); this.send(p, p.down, { ...v, id: downstreamId }, () => this.operation(p, lease, true)); return;
    }
    const tid = v.params?.threadId ?? v.params?.thread?.id;
    if (tid && !p.role.works.has(tid)) return; if (p.role.role === "device" && (!tid || (["item/started", "item/completed"].includes(v.method) && v.params?.item?.type === "mcpToolCall"))) return;
    const lease = this.capture(p, v); this.send(p, p.down, v, () => { this.current(p); if (lease.registry !== this.options.registry.epoch() || lease.role !== this.options.roles.epoch(p.role) || (tid && !p.role.works.has(tid))) throw Error("event stale"); });
  } catch { this.drop(p); } }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true; this.startupAbort.abort();
    this.closing = (async () => { if (this.starting) await Promise.allSettled([this.starting]); for (const p of [...this.peers]) this.drop(p); for (const q of this.server.values()) clearTimeout(q.timer); this.server.clear(); try { await Promise.allSettled(this.listeners.splice(0).map(l => this.disposeListener(l))); } finally { this.options.registry.close(); } })(); return this.closing;
  }
}
