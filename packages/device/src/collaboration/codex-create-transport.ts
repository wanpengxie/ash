import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ListenerEvidence, NativeFrame, NativeSocket } from "./control-native-types";
import { NativeTransportError, verifyUnixListener, type CodexTransportOptions } from "./codex-transport";
export interface CodexCreateTransportOptions extends CodexTransportOptions {}
export type CreateNativeMethod = "initialize" | "project/list" | "thread/start" | "thread/name/set" | "thread/read" | "thread/turns/list" | "turn/start";
const methods = new Set<CreateNativeMethod>(["initialize", "project/list", "thread/start", "thread/name/set", "thread/read", "thread/turns/list", "turn/start"]);
/** A separately bounded connection to the selected shared Unix daemon. Never launches it. */
export class CodexCreateTransport {
  epoch = "disconnected";
  version = "";
  onEvent?: (frame: NativeFrame, epoch: string) => void;
  onDisconnect?: () => void;
  private socket?: NativeSocket;
  private identity?: string;
  private sequence = 0;
  private generation = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly timeout: number;
  private readonly maxBytes: number;
  constructor(private readonly options: CodexCreateTransportOptions) {
    this.timeout = options.timeoutMs ?? 5000; this.maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 1024 * 1024) throw new NativeTransportError("invalid");
  }
  private verify(): ListenerEvidence {
    try { return this.options.verifyListener?.() ?? verifyUnixListener(this.options); }
    catch { throw new NativeTransportError("offline"); }
  }
  verifyCurrent(): void {
    if (!this.socket || this.verify().identity !== this.identity) { this.close(); throw new NativeTransportError("offline"); }
  }
  async connect(): Promise<void> {
    this.close();
    const generation = this.generation;
    const evidence = this.verify();
    if (!this.options.supportedVersions.includes(evidence.version)) throw new NativeTransportError("unsupported");
    const socket = await (this.options.connectSocket?.(`ws+unix://localhost${evidence.socket}:/rpc`) ?? new Promise<NativeSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://localhost${evidence.socket}:/rpc`, { handshakeTimeout: this.timeout, maxPayload: this.maxBytes, perMessageDeflate: false });
      ws.once("open", () => resolve(ws)); ws.once("error", () => { ws.close(); reject(new NativeTransportError("offline")); });
    })).catch(() => { throw new NativeTransportError("offline"); });
    if (generation !== this.generation) { socket.close(); throw new NativeTransportError("offline"); }
    this.socket = socket; this.identity = evidence.identity; this.epoch = randomUUID(); this.version = evidence.version;
    const epoch = this.epoch;
    socket.on("message", (bytes: any) => {
      if (this.epoch !== epoch || this.socket !== socket) return;
      if (Buffer.byteLength(bytes) > this.maxBytes) { this.close("too_large"); return; }
      let frame: NativeFrame;
      try { frame = JSON.parse(bytes.toString()); if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw 0; } catch { this.close("invalid"); return; }
      if (!frame.method) {
        const entry = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
        if (!entry) return;
        this.pending.delete(frame.id as number); clearTimeout(entry.timer);
        if (frame.error) entry.reject(new NativeTransportError(frame.error.code === -32601 ? "unsupported" : "source_error")); else entry.resolve(frame.result);
      } // Notifications and server requests are never acted on or answered.
    });
    const fail = () => { if (this.socket === socket) this.close(); };
    socket.on("close", fail); socket.on("error", fail);
    try {
      const init = await this.request("initialize", { clientInfo: { name: "ash-native-control", version: "1" }, capabilities: { experimentalApi: true } });
      if (init?.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] !== evidence.version) throw new NativeTransportError("unsupported");
      this.verifyCurrent(); socket.send(JSON.stringify({ method: "initialized" }));
    } catch (error) { this.close(); throw error; }
  }
  request(method: CreateNativeMethod, params: object, deadline?: number): Promise<any> {
    if (!methods.has(method)) return Promise.reject(new NativeTransportError("unsupported"));
    try { this.verifyCurrent(); } catch { return Promise.reject(new NativeTransportError("offline")); }
    if (!this.socket) return Promise.reject(new NativeTransportError("offline"));
    if (this.pending.size >= 32) return Promise.reject(new NativeTransportError("too_large"));
    const id = ++this.sequence, data = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(data) > this.maxBytes) return Promise.reject(new NativeTransportError("too_large"));
    return new Promise((resolve, reject) => {
      const remaining = deadline === undefined ? this.timeout : Math.min(this.timeout, deadline - Date.now());
      if (remaining <= 0) { reject(new NativeTransportError("timeout")); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new NativeTransportError("timeout")); this.close(); }, remaining);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket!.send(data); } catch { this.close(); }
    });
  }
  close(code: NativeTransportError["code"] = "offline"): void {
    this.generation++;
    const socket = this.socket; this.socket = undefined; this.identity = undefined; this.epoch = "disconnected";
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new NativeTransportError(code)); }
    this.pending.clear(); socket?.close(); if (socket) this.onDisconnect?.();
  }
}
