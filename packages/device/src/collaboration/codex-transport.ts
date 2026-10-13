import {inspectNativeUnixListener,NativeListenerEvidenceError} from './native-listener-evidence';
import {NativeArtifactVersion,NativeArtifactVersionError,readNativeArtifactVersion,closeNativeArtifactVersion} from './native-artifact-version';
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ListenerEvidence, NativeFrame, NativeMethod, NativeSocket } from "./control-native-types";
export class NativeTransportError extends Error {
  constructor(readonly code: "offline" | "timeout" | "unsupported" | "invalid" | "too_large" | "source_error") { super(`Native control: ${code}`); }
}
export interface CodexTransportOptions {
  socket: string; executable: string; pid: number; supportedVersions: readonly string[];
  timeoutMs?: number; maxBytes?: number;
  /** Injection points for isolated fixtures. Production defaults verify the actual listener. */
  verifyListener?: (force?: boolean) => ListenerEvidence;
  /** Cheap immediate lifecycle/config fence, required to memoize an injected verifier. */
  current?: () => undefined;
  /** Internal verifier lifetime cleanup; never a wire authority. */
  releaseListenerVerification?: () => void;
  connectSocket?: (url: string) => Promise<NativeSocket>;
}
const methods = new Set<NativeMethod>(["initialize", "thread/loaded/list", "thread/read", "thread/resume", "thread/turns/list", "turn/start", "turn/steer"]);
export function verifyUnixListener(options: Pick<CodexTransportOptions, "socket" | "executable" | "pid">): ListenerEvidence {
  try {
    if (!isAbsolute(options.socket) || /[:?#\r\n]/.test(options.socket) || !isAbsolute(options.executable) || !Number.isSafeInteger(options.pid) || options.pid < 1) throw 0;
    const socket = realpathSync(options.socket), executable = realpathSync(options.executable), stat = statSync(socket);
    if (!stat.isSocket()) throw 0;
    const run = (args: string[]) => execFileSync("lsof", args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }).split("\n");
    const unix = run(["-nP", "-a", "-p", String(options.pid), "-U", "-Fn"]);
    const text = run(["-a", "-p", String(options.pid), "-d", "txt", "-Fn"]);
    const all = run(["-nP", "-U", "-Fpn"]);
    const canonical = (line: string) => { try { return realpathSync(line.slice(1)); } catch { return ""; } };
    if (!unix.some(line => line.startsWith("n") && canonical(line) === socket) || !text.some(line => line.startsWith("n") && canonical(line) === executable)) throw 0;
    const owners = new Set<number>(); let pid = 0;
    for (const line of all) {
      if (line.startsWith("p")) { const value = Number(line.slice(1)); pid = Number.isSafeInteger(value) && value > 0 ? value : 0; }
      else if (line.startsWith("n") && pid && canonical(line) === socket) owners.add(pid);
    }
    if (owners.size !== 1 || !owners.has(options.pid)) throw 0;
    const version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 }).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (!version) throw 0;
    return { socket, executable, pid: options.pid, version, identity: `${options.pid}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${executable}:${version}` };
  } catch { throw new NativeTransportError("offline"); }
}
/** Supplement the uncached classic result with current main-image/all-owner
 * evidence. Never reuses an arbitrary VM mapping as a main executable proof. */
export function verifyListenerMainEvidence(evidence:ListenerEvidence,requireKernel=false):ListenerEvidence {
  try{
    const observation=inspectNativeUnixListener({socket:evidence.socket,executable:evidence.executable,expectedPid:evidence.pid});
    const stat=statSync(evidence.socket);
    if(!observation.has_listener||observation.pid!==evidence.pid||observation.socket!==evidence.socket||observation.main_executable!==evidence.executable||
      `${evidence.pid}:${stat.dev}:${stat.ino}:${stat.ctimeMs}:${evidence.executable}:${evidence.version}`!==evidence.identity)throw 0;
    return evidence;
  }catch(error){if(error instanceof NativeListenerEvidenceError&&error.code==='unsupported'&&!requireKernel)return evidence;throw new NativeTransportError('offline');}
}
/** Regular fresh inspection preserves the classic identity format. Kernel snapshots
 * are observations only, never continuity or generation credentials. Unsupported
 * release/platform falls back to the complete classic verifier; ownership failure does not. */
export function inspectUnixListener(options: Pick<CodexTransportOptions, "socket" | "executable" | "pid">, unsupportedFallback?:()=>ListenerEvidence, artifact?:NativeArtifactVersion,initialArtifactAdmission=false): ListenerEvidence {
  try {
    if (!isAbsolute(options.socket) || /[:?#\r\n]/.test(options.socket) || !isAbsolute(options.executable) || !Number.isSafeInteger(options.pid) || options.pid < 1) throw 0;
    const socket=realpathSync(options.socket),executable=realpathSync(options.executable),before=statSync(socket);
    if(!before.isSocket()||!Number.isSafeInteger(options.pid)||options.pid<1)throw 0;
    artifact&&readNativeArtifactVersion(artifact,executable);
    const observation=inspectNativeUnixListener({socket,executable,expectedPid:options.pid});
    if(!observation.has_listener||observation.pid!==options.pid||observation.socket!==socket||observation.executable!==executable||observation.main_executable!==executable)throw 0;
    const version=artifact?readNativeArtifactVersion(artifact,executable):execFileSync(executable,["--version"],{encoding:"utf8",timeout:5000,maxBuffer:4096}).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    const after=statSync(socket);
    if(!version||!after.isSocket()||before.dev!==after.dev||before.ino!==after.ino||before.ctimeMs!==after.ctimeMs)throw 0;
    return {socket,executable,pid:options.pid,version,identity:`${options.pid}:${after.dev}:${after.ino}:${after.ctimeMs}:${executable}:${version}`};
  }catch(error){if(error instanceof NativeListenerEvidenceError&&error.code==='unsupported'){if(artifact)throw new NativeTransportError(initialArtifactAdmission?'unsupported':'offline');try{const evidence=unsupportedFallback?unsupportedFallback():verifyUnixListener(options);artifact&&readNativeArtifactVersion(artifact,evidence.executable);return evidence;}catch{throw new NativeTransportError('offline');}}throw new NativeTransportError('offline');}
}
export class CodexTransport {
  epoch = "disconnected";
  version = "";
  onEvent?: (frame: NativeFrame, epoch: string) => void;
  onDisconnect?: () => void;
  private socket?: NativeSocket;
  private identity?: string;
  private listenerMemo?: ListenerEvidence;
  private artifact?:NativeArtifactVersion|null;
  private sequence = 0;
  private generation = 0;
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly timeout: number;
  private readonly maxBytes: number;
  constructor(private readonly options: CodexTransportOptions) {
    this.timeout = options.timeoutMs ?? 5000; this.maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isInteger(this.timeout) || this.timeout < 1 || this.timeout > 60_000 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 1024 * 1024) throw new NativeTransportError("invalid");
  }
  private verify(force = false): ListenerEvidence {
    try {
      if(this.options.verifyListener)return this.options.verifyListener(force);
      this.artifact&&readNativeArtifactVersion(this.artifact,realpathSync(this.options.executable));
      if(force){const evidence=verifyListenerMainEvidence(verifyUnixListener(this.options),!!this.artifact);this.artifact&&readNativeArtifactVersion(this.artifact,evidence.executable);if(this.options.current&&this.options.current()!==undefined)throw 0;return evidence;}
      if(this.artifact===undefined){let candidate:NativeArtifactVersion|undefined;try{
        candidate=NativeArtifactVersion.open(realpathSync(this.options.executable),this.version);
        inspectUnixListener(this.options,undefined,candidate,true);
        if(this.options.current&&this.options.current()!==undefined)throw 0;
        this.artifact=candidate;
      }catch(error){candidate&&closeNativeArtifactVersion(candidate);if((error instanceof NativeArtifactVersionError||error instanceof NativeTransportError)&&error.code==='unsupported')this.artifact=null;else throw error;}}
      const evidence=inspectUnixListener(this.options,()=>{if(this.artifact)throw new NativeTransportError('offline');return verifyUnixListener(this.options);},this.artifact??undefined);
      if(this.options.current&&this.options.current()!==undefined)throw 0;
      this.artifact&&readNativeArtifactVersion(this.artifact,evidence.executable);return evidence;
    }
    catch { throw new NativeTransportError("offline"); }
  }
  verifyCurrent(force = false): void {
    try {
      if(this.options.current && this.options.current()!==undefined)throw 0;
      this.artifact&&readNativeArtifactVersion(this.artifact,realpathSync(this.options.executable));
      if(!this.socket)throw 0;
      const memoAllowed=!this.options.verifyListener||!!this.options.current;
      let evidence=force||!memoAllowed?this.verify(force):this.listenerMemo;
      if(!evidence)evidence=this.verify();
      if(evidence.identity!==this.identity)throw 0;
      // A forced check is always fresh, but its successful result may serve a
      // following regular check in this same synchronous segment only.
      if(memoAllowed&&this.listenerMemo!==evidence){this.listenerMemo=evidence;const captured=evidence;queueMicrotask(()=>{if(this.listenerMemo===captured)this.listenerMemo=undefined;});}
    }catch{this.close();throw new NativeTransportError('offline');}
  }
  finalCurrent():void {this.verifyCurrent(true);}
  async connect(): Promise<void> {
    this.close();
    const generation = this.generation;
    const evidence = this.verify(true);
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
      } else this.onEvent?.(frame, epoch);
    });
    const fail = () => { if (this.socket === socket) this.close(); };
    socket.on("close", fail); socket.on("error", fail);
    try {
      const init = await this.request("initialize", { clientInfo: { name: "ash-native-control", version: "1" }, capabilities: { experimentalApi: true } });
      if (init?.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] !== evidence.version) throw new NativeTransportError("unsupported");
      this.finalCurrent(); socket.send(JSON.stringify({ method: "initialized" }));
    } catch (error) { this.close(); throw error; }
  }
  request(method: NativeMethod, params: object): Promise<any> {
    if (!methods.has(method)) return Promise.reject(new NativeTransportError("unsupported"));
    if (!this.socket) return Promise.reject(new NativeTransportError("offline"));
    if (this.pending.size >= 32) return Promise.reject(new NativeTransportError("too_large"));
    const id = ++this.sequence, data = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(data) > this.maxBytes) return Promise.reject(new NativeTransportError("too_large"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new NativeTransportError("timeout")); this.close(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.finalCurrent(); this.socket!.send(data); } catch { this.close(); }
    });
  }
  close(code: NativeTransportError["code"] = "offline"): void {
    this.generation++; this.listenerMemo=undefined;
    try{try{this.artifact&&closeNativeArtifactVersion(this.artifact);}finally{this.artifact=undefined;this.options.releaseListenerVerification?.();}}
    finally{
      const socket = this.socket; this.socket = undefined; this.identity = undefined; this.epoch = "disconnected";
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new NativeTransportError(code)); }
      this.pending.clear(); socket?.close(); if (socket) this.onDisconnect?.();
    }
  }
}
