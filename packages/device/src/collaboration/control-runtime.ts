import type { MaterialInputReader } from "./material-input-reader";
import {NativeArtifactVersion,NativeArtifactVersionError,readNativeArtifactVersion,closeNativeArtifactVersion} from './native-artifact-version';
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CodexTransport, NativeTransportError, verifyUnixListener, inspectUnixListener,verifyListenerMainEvidence } from "./codex-transport";
import { CodexControlAdapter } from "./codex-control";
import { ControlAuthorization, loadControlAuthorization, type ControlNativeMetadata, type ControlAuthorizationBinding } from "./control-authorization";
import { DeviceControlService, type ControlNativeScope } from "./control-service";
import { watchControlAuthorization } from "./control-watch";
import { OperationStore } from "./operation-store";
import { CollaborationControlError } from "./control-types";
import { sameControlWork, type ControlOperation } from "./control-protocol";
import type { TrustedCallContext } from "./authorization";
import type { ListenerEvidence, NativeMetadata, NativeSocket } from "./control-native-types";
import type { WorkRef } from "./types";

export interface ControlRuntimeConfig { version: 1; endpoint_id: string; socket: string; executable: string; supportedVersions: string[] }
export type ControlRuntimeConfiguration = { state: "configured"; config: ControlRuntimeConfig } | { state: "config_required" | "invalid_configuration"; config: null };
export const controlRuntimePath = (stateDir: string) => join(stateDir, "collaboration-control-runtime.json");
const MAX_CONFIG_BYTES = 16 * 1024;
const targetPorts = new WeakMap<object, {testing:boolean;capture:(context: TrustedCallContext, binding: ControlAuthorizationBinding) => Promise<ControlTargetMetadata>}>();
export interface ControlTargetMetadata extends ControlNativeMetadata { readonly generation: string; readonly authorized_until:number|null; current(): undefined; finalCurrent(): undefined; check(): Promise<boolean>; release(): void; }
/** Only the actual runtime factory can register this private port. */
export function captureControlTarget(runtime: DeviceControlRuntime, context: TrustedCallContext, binding: ControlAuthorizationBinding, environment:'production'|'testing'='production'): Promise<ControlTargetMetadata> {
  const port = targetPorts.get(runtime); if (!port || port.testing && environment!=='testing') return Promise.reject(new CollaborationControlError("permission_denied"));
  return port.capture(context, binding);
}
const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024 && !/[\u0000-\u001f]/.test(v);
const path = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && isAbsolute(v) && !/[\u0000-\u001f]/.test(v);
export function parseControlRuntimeConfig(value: unknown, endpointId: string): ControlRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NativeTransportError("invalid");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["version", "endpoint_id", "socket", "executable", "supportedVersions"].includes(k)) || v.version !== 1 || !identifier(v.endpoint_id) || v.endpoint_id !== endpointId || !path(v.socket) || /[:?#]/.test(v.socket) || !path(v.executable) || !Array.isArray(v.supportedVersions) || !v.supportedVersions.length || v.supportedVersions.length > 32 || v.supportedVersions.some(x => typeof x !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(x)) || new Set(v.supportedVersions).size !== v.supportedVersions.length) throw new NativeTransportError("invalid");
  return { version: 1, endpoint_id: endpointId, socket: resolve(v.socket), executable: resolve(v.executable), supportedVersions: [...v.supportedVersions] as string[] };
}
/** Local regular file only; bounded reads and no symlink-following configuration. */
export function loadControlRuntimeConfig(stateDir: string, endpointId: string): ControlRuntimeConfiguration {
  let fd: number | undefined;
  try {
    fd = openSync(controlRuntimePath(stateDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error();
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_CONFIG_BYTES) throw new Error();
    return { state: "configured", config: parseControlRuntimeConfig(JSON.parse(bytes.subarray(0, length).toString("utf8")), endpointId) };
  } catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "config_required" : "invalid_configuration", config: null }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Parse only the selected socket's lsof records. Ambiguous ownership always fails closed. */
export function parseUnixListenerPid(output: string, socket: string, canonicalize: (p: string) => string = realpathSync): number {
  let pid = 0;
  const owners = new Set<number>();
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { const number = Number(line.slice(1)); pid = Number.isSafeInteger(number) && number > 0 ? number : 0; }
    if (line.startsWith("n") && pid) {
      try { if (canonicalize(line.slice(1)) === socket) owners.add(pid); } catch { /* Unprovable paths are not evidence. */ }
    }
  }
  if (owners.size !== 1) throw new NativeTransportError("offline");
  return [...owners][0];
}
export function discoverControlListener(config: ControlRuntimeConfig): ListenerEvidence {
  try {
    const socket = realpathSync(config.socket);
    const output = execFileSync("lsof", ["-nP", "-a", "-U", "-Fpn", "--", socket], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
    const pid = parseUnixListenerPid(output, socket);
    return verifyUnixListener({ socket: config.socket, executable: config.executable, pid });
  } catch { throw new NativeTransportError("offline"); }
}
export interface DeviceControlRuntimeOptions {
  stateDir: string; nodeId: string; endpointId: string;
  /** Trusted local pairing accessor. Must derive from CURRENT, unrevoked paired.json
   * using the existing gateway identity algorithm on every change; never a body field
   * or permanent owner cache. Pairing events also invalidate outstanding leases. */
  pinnedOwnerId(): string | null;
  materialInputReader?: MaterialInputReader;
  deadlineMs?: number;
  /** Explicit fake-only dependencies; production defaults never bypass listener verification. */
  testing?: {
    listener?(config: ControlRuntimeConfig): ListenerEvidence;
    connectSocket?(url: string): Promise<NativeSocket>;
    watch?(paths: readonly string[], invalidate: () => void, onError: () => void): () => void;
  };
}
/** A configured runtime owns no daemon lifecycle: close affects its sockets and journal only. */
export function createDeviceControlRuntime(options: DeviceControlRuntimeOptions) {
  let closed = false, watcherFailed = false, generation = 0, active = 0, nativeBound = false;
  const transports = new Set<CodexTransport>();
  // Per-channel verifier, never a socket/config-wide authorization cache.
  const listenerVerifiers = new WeakMap<CodexTransport, (force?: boolean) => ListenerEvidence>();
  const artifactVersions = new WeakMap<CodexTransport, () => NativeArtifactVersion | null | undefined>();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined, storeClosed = false;
  const deadlineMs = Math.min(30_000, Math.max(1, options.deadlineMs ?? 30_000));
  const configuration = () => loadControlRuntimeConfig(options.stateDir, options.endpointId);
  const grant = () => loadControlAuthorization(options.stateDir, options.endpointId);
  const requireConfig = () => {
    if (closed || watcherFailed) throw new NativeTransportError("offline");
    const current = configuration();
    if (!current.config) throw new NativeTransportError("offline");
    return current.config;
  };
  const transport = () => {
    const config = requireConfig(), fingerprint = JSON.stringify(config), born = generation;
    let artifact:NativeArtifactVersion|null|undefined;
    const current=():undefined=>{if(born!==generation||fingerprint!==JSON.stringify(requireConfig()))throw new NativeTransportError('offline');artifact&&readNativeArtifactVersion(artifact,realpathSync(config.executable));return undefined;};
    const initial = options.testing?.listener?.(config) ?? discoverControlListener(config);
    let listenerMemo: ListenerEvidence | undefined;
    const versionArtifact=()=>{
      current();
      if(options.testing?.listener)return undefined;
      if(artifact===undefined){let candidate:NativeArtifactVersion|undefined;try{
        candidate=NativeArtifactVersion.open(initial.executable,initial.version);
        // Hash/version issuance may take time: re-observe current kernel/main
        // image and config after it, before admitting the newly issued fact.
        const observed=inspectUnixListener({socket:config.socket,executable:config.executable,pid:initial.pid},undefined,candidate,true);
        current();if(observed.identity!==initial.identity)throw new NativeTransportError('offline');
        artifact=candidate;
      }catch(error){candidate&&closeNativeArtifactVersion(candidate);if((error instanceof NativeArtifactVersionError||error instanceof NativeTransportError)&&error.code==='unsupported')artifact=null;else throw error;}}
      artifact&&readNativeArtifactVersion(artifact,initial.executable);return artifact;
    };
    const verifyListener = (force = false) => {
      current();
      // Final never issues a cache, but an existing artifact must remain current.
      if(artifact)readNativeArtifactVersion(artifact,initial.executable);
      if (!force && listenerMemo) return listenerMemo;
      const proof=force?undefined:versionArtifact();
      // Every observation is fresh. Final checks deliberately omit the artifact
      // version shortcut so --version is still executed at that boundary.
      const evidence = options.testing?.listener?.(config) ?? inspectUnixListener({socket:config.socket,executable:config.executable,pid:initial.pid},()=>verifyListenerMainEvidence(discoverControlListener(config),!!artifact),force?undefined:proof??undefined);
      current();
      if (!config.supportedVersions.includes(evidence.version)) throw new NativeTransportError("unsupported");
      const captured = Object.freeze({...evidence});
      listenerMemo = captured;
      queueMicrotask(() => { if (listenerMemo === captured) listenerMemo = undefined; });
      return captured;
    };
    const native = new CodexTransport({ socket: config.socket, executable: config.executable, pid: initial.pid, supportedVersions: config.supportedVersions, timeoutMs: Math.min(5000, deadlineMs), maxBytes: 1024 * 1024,
      // Same-segment listener memo never caches this immediate config/lifecycle fence.
      current,verifyListener,releaseListenerVerification:()=>{artifact&&closeNativeArtifactVersion(artifact);artifact=undefined;listenerMemo=undefined;}, connectSocket: options.testing?.connectSocket });
    listenerVerifiers.set(native, verifyListener);
    artifactVersions.set(native,versionArtifact);
    nativeBound = true;
    transports.add(native); return native;
  };
  const track = <T>(task: () => Promise<T>): Promise<T> => {
    active++;
    const execution = (async () => { try { return await task(); } finally { active--; } })();
    pending.add(execution);
    execution.then(() => pending.delete(execution), () => pending.delete(execution));
    return execution;
  };
  const metadataResults = new AsyncLocalStorage<{ actual?: ControlNativeMetadata; listener?: ListenerEvidence; artifact?:NativeArtifactVersion|null; needListener?:true; failure?:unknown }>();
  // Runtime-private read-only channel. Responses are never cached and never authorize a business resend.
  interface MetadataChannel {native:CodexTransport;born:number;connected:boolean;retired:boolean;connecting:Promise<void>;users:number;}
  let metadataChannel:MetadataChannel|undefined;
  const retireMetadata=(channel=metadataChannel,reason:ConstructorParameters<typeof NativeTransportError>[0]='offline')=>{if(!channel||channel.retired)return;channel.retired=true;if(metadataChannel===channel)metadataChannel=undefined;channel.native.close(reason);transports.delete(channel.native);};
  const acquireMetadata=():MetadataChannel=>{
    if(metadataChannel&&(metadataChannel.born!==generation||metadataChannel.retired||metadataChannel.connected&&metadataChannel.native.epoch==='disconnected'))retireMetadata();
    if(!metadataChannel){const native=transport(),channel:MetadataChannel={native,born:generation,connected:false,retired:false,connecting:undefined as unknown as Promise<void>,users:0};metadataChannel=channel;
      channel.connecting=native.connect().then(()=>{if(channel.retired||channel.born!==generation||closed||watcherFailed)throw new NativeTransportError('offline');channel.connected=true;}).catch(error=>{retireMetadata(channel);throw error;});channel.connecting.catch(()=>{});
    }
    if(metadataChannel.users>=16)throw new CollaborationControlError('busy');metadataChannel.users++;return metadataChannel;
  };
  const metadata = (value: WorkRef) => track(async () => {
    const work = Object.freeze({ ...value });
    if (work.node_id !== options.nodeId || work.endpoint_id !== options.endpointId || work.kind !== 'conversation' || !identifier(work.native_id)) throw new CollaborationControlError('permission_denied');
    const channel=acquireMetadata(),native=channel.native,born=channel.born;
    const timer=setTimeout(()=>retireMetadata(channel,'timeout'),deadlineMs);
    try {
      await channel.connecting;
      if(channel.retired||born!==generation)throw new NativeTransportError('offline');
      const epoch=native.epoch,version=native.version;
      native.verifyCurrent();
      const result=await native.request('thread/read',{threadId:work.native_id,includeTurns:false});
      native.finalCurrent();
      if(channel.retired||born!==generation||epoch!==native.epoch||version!==native.version||result?.thread?.id!==work.native_id||!path(result.thread.cwd))throw new CollaborationControlError('permission_denied');
      const actual={work:{...work},cwd:resolve(result.thread.cwd)},capture=metadataResults.getStore();
      // This exact channel just performed an uncached final check above. Copy
      // that same-segment result rather than issuing another full discovery.
      if(capture){capture.actual=actual;if(capture.needListener){capture.listener=listenerVerifiers.get(native)!(false);capture.artifact=artifactVersions.get(native)!();}}
      return actual;
    }catch(error){retireMetadata(channel);throw error;}finally{clearTimeout(timer);channel.users--;}
  }).catch(error=>{const capture=metadataResults.getStore();if(capture?.needListener)capture.failure=error;throw error;});
  const authorization = new ControlAuthorization({ nodeId: options.nodeId, endpointId: options.endpointId, pinnedOwnerId: () => closed || watcherFailed ? null : options.pinnedOwnerId(), authorization: grant, metadata });
  let store: OperationStore | undefined;
  let service: DeviceControlService | undefined;
  let stopWatch: (() => void) | undefined;
  const invalidate = () => { generation++; retireMetadata(); authorization.invalidate(); service?.invalidate(); for (const native of transports) native.close(); transports.clear(); };
  try {
    store = new OperationStore(join(options.stateDir, "collaboration-control.sqlite"));
    service = new DeviceControlService({ node_id: options.nodeId, endpoint_id: options.endpointId, store, authorization, grant, deadlineMs, materialInputReader:options.materialInputReader,
      native: (scope: ControlNativeScope) => {
        const native = transport();
        const current = (work: WorkRef, meta: NativeMetadata) => !closed && !watcherFailed && sameControlWork(scope.work, work) && sameControlWork(work, meta.work) && path(meta.cwd) && meta.epoch !== "disconnected" && meta.epoch === native.epoch && meta.version === native.version;
        const validate = async (work: WorkRef, meta: NativeMetadata, allowed: () => boolean | Promise<boolean>) => {
          if (!current(work, meta)) return false;
          try {
            native.verifyCurrent();
            if (!await allowed()) return false;
            const actual = await metadata(work);
            if (!sameControlWork(work, actual.work) || actual.cwd !== resolve(meta.cwd)) return false;
            // Fresh S2 authorization AFTER the asynchronous metadata comparison.
            // Capture its own independent read, so final cwd/work comparison adds
            // no further await after S2's final owner/grant check. This ALS contains
            // metadata only, never a lease or authorization policy.
            const capture: { actual?: ControlNativeMetadata } = {};
            if (!await metadataResults.run(capture, allowed)) return false;
            native.verifyCurrent();
            return current(work, meta) && !!capture.actual && sameControlWork(work, capture.actual.work) && capture.actual.cwd === resolve(meta.cwd);
          } catch { return false; }
        };
        const adapter = new CodexControlAdapter({ node_id: options.nodeId, endpoint_id: options.endpointId, transport: native,
          validateMetadata: (inv, meta) => validate(inv.request.work, meta, () => scope.authorize(inv.principal, inv.request.work, inv.request.action, "invoke")),
          validateHistoryMetadata: (work, meta) => validate(work, meta, () => scope.allowHistory(work)),
          allowSubscription: (work, meta) => meta ? validate(work, meta, () => scope.allowSubscription(work)) : scope.allowSubscription(work),
        });
        return { get connector_epoch() { return adapter.connector_epoch; }, get native_interface_version() { return adapter.native_interface_version; },
          current:()=>adapter.current(),finalCurrent:()=>adapter.finalCurrent(), connect: () => track(() => adapter.connect()), observe: work => track(() => adapter.observe(work)),
          needsObservation: work => adapter.needsObservation(work), snapshot: work => adapter.snapshot(work),
          invoke: invocation => track(() => adapter.invoke(invocation)), readHistoryPage: input => track(() => adapter.readHistoryPage(input)),
          close: () => { adapter.close(); transports.delete(native); },
        };
      },
    });
    stopWatch = (options.testing?.watch ?? watchControlAuthorization)([controlRuntimePath(options.stateDir), join(options.stateDir, "collaboration-control.json"), join(options.stateDir, "paired.json")], invalidate, () => { watcherFailed = true; invalidate(); });
  } catch {
    watcherFailed = true; invalidate();
    // Construction has not exposed execute, so no journal claim can exist yet.
    // Explicitly consume the asynchronous scope drain on this exception path.
    void service?.close().catch(() => {});
    if (store) { store.close(); storeClosed = true; }
  }
  const runtime = {
    /** Exact read-only target capture. This port cannot invoke/resume a native turn. */
    captureTargetMetadata: (context: TrustedCallContext, binding: ControlAuthorizationBinding) => track(async () => {
      const born = generation, config = JSON.stringify(requireConfig());
      const capture: { actual?: ControlNativeMetadata; listener?: ListenerEvidence; artifact?:NativeArtifactVersion|null; needListener:true; failure?:unknown } = {needListener:true};
      let lease;
      try {lease = await metadataResults.run(capture, () => authorization.begin(context, binding));}
      catch(error){if(capture.failure instanceof NativeTransportError&&['offline','unsupported','timeout'].includes(capture.failure.code))throw capture.failure;throw error;}
      if (!capture.actual || !capture.listener) throw new CollaborationControlError("permission_denied");
      const actual = Object.freeze({ work: Object.freeze({ ...capture.actual.work }), cwd: capture.actual.cwd });
      const identity = JSON.stringify(capture.listener);
      let released = false, listenerMemo:string|undefined;
      // A memo belongs to one synchronous JS segment only. Every authority/config
      // check remains immediate, and every final physical boundary bypasses it.
      const fence = (force:boolean): undefined => {
        try {
          const now=requireConfig();
          if (released || born !== generation || config !== JSON.stringify(now) || lease.current() !== undefined) throw new Error();
          capture.artifact&&readNativeArtifactVersion(capture.artifact,capture.listener!.executable);
          if(force||listenerMemo===undefined){
            const listener = options.testing?.listener?.(now) ?? (force ? verifyListenerMainEvidence(discoverControlListener(now),!!capture.artifact) : inspectUnixListener({socket:now.socket,executable:now.executable,pid:capture.listener!.pid},()=>verifyListenerMainEvidence(discoverControlListener(now),!!capture.artifact),capture.artifact??undefined));
            if (identity !== JSON.stringify(listener)) throw new Error();
            if(listenerMemo===undefined)queueMicrotask(()=>{listenerMemo=undefined;});
            listenerMemo=JSON.stringify(listener);
          }
          if(listenerMemo!==identity)throw new Error();
          return undefined;
        } catch { released = true; listenerMemo=undefined; throw new CollaborationControlError("permission_denied"); }
      };
      const current=():undefined=>fence(false),finalCurrent=():undefined=>fence(true);
      finalCurrent();
      return Object.freeze({ ...actual, generation: `${born}:${createHash('sha256').update(identity).digest('hex')}`, authorized_until:grant().config?.expires_at??null, current,finalCurrent,
        check: async (): Promise<boolean> => { try { finalCurrent(); const next = await metadata(binding.work); finalCurrent(); if (!sameControlWork(next.work, actual.work) || next.cwd !== actual.cwd) throw new Error(); return true; } catch { released = true;listenerMemo=undefined; return false; } },
        release: () => { released = true; },
      });
    }),
    /** Caller must hold its admission gate while checking and applying a change. No journal mutation/recovery. */
    changeSafety: (): {scope:'control-runtime';state:'safe'|'busy'|'unavailable';reason:'config_required'|'idle_observed'|'raw_pending'|'journal_invoking'|'journal_unknown'|'native_active'|'native_unknown'|'unavailable';generation:number} => {
      if(closed||watcherFailed||!store||storeClosed||!service)return {scope:'control-runtime',state:'unavailable',reason:'unavailable',generation};
      if(active||service.busy||options.materialInputReader?.busy)return {scope:'control-runtime',state:'busy',reason:'raw_pending',generation};
      try {
        const facts = store.unsettled();
        if(facts.invoking)return {scope:'control-runtime',state:'busy',reason:'journal_invoking',generation};
        if(facts.unknown)return {scope:'control-runtime',state:'unavailable',reason:'journal_unknown',generation};
        const selected = configuration();
        // Bootstrap only a runtime that has never bound a native channel. Clearing
        // transports on invalidation does not erase prior native uncertainty.
        if(selected.state==='config_required'&&!nativeBound&&!transports.size&&!pending.size&&!store.hasNativeInvocation()&&service.changeSafety()==='safe')
          return {scope:'control-runtime',state:'safe',reason:'config_required',generation};
        if(!selected.config)return {scope:'control-runtime',state:'unavailable',reason:'unavailable',generation};
        for(const native of transports)native.finalCurrent();
        const state=service.changeSafety();
        return {scope:'control-runtime',state:state==='safe'?'safe':state==='busy'?'busy':'unavailable',reason:state==='safe'?'idle_observed':state==='busy'?'native_active':'native_unknown',generation};
      } catch {return {scope:'control-runtime',state:'unavailable',reason:'unavailable',generation};}
    },
    status: () => ({ state: closed ? "closed" as const : watcherFailed ? "watcher_failed" as const : configuration().state, grant_state: grant().state }),
    manifest: () => service?.manifest() ?? { version: 1 as const, endpoint_id: options.endpointId, grant_state: grant().state, authorization_revision: grant().authorization_revision, actions: [], limitations: { atomic_idle_start: false as const, cancel: false as const, queue: false as const, runtime_state: "unknown" as const, subscription_state: "unknown" as const } },
    execute: (operation: ControlOperation, body: unknown, context?: TrustedCallContext) => track(async () => {
      if (closed || watcherFailed || !service || !configuration().config) throw new CollaborationControlError("offline");
      return service.execute(operation, body, context);
    }),
    invalidate,
    get busy() { return active > 0 || !!service?.busy || !!options.materialInputReader?.busy; },
    close: (): Promise<void> => {
      if (closing) return closing;
      if (!closed) { closed = true; stopWatch?.(); invalidate(); options.materialInputReader?.close(); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CollaborationControlError("busy")), deadlineMs); });
      // A pending socket factory cannot be forcibly settled. Keep its execution
      // tracked and the database open; return a bounded failure that can be retried.
      const drain = Promise.all([service?.close(), options.materialInputReader?.drain(), Promise.allSettled([...pending])]);
      const attempt = Promise.race([drain, timeout]).then(() => {
        if (store && !storeClosed) { store.close(); storeClosed = true; }
      }).finally(() => { if (timer) clearTimeout(timer); if (closing === attempt) closing = undefined; });
      closing = attempt;
      return attempt;
    },
  };
  targetPorts.set(runtime, {testing:options.testing!==undefined,capture:runtime.captureTargetMetadata});
  return runtime;
}
export type DeviceControlRuntime = ReturnType<typeof createDeviceControlRuntime>;
