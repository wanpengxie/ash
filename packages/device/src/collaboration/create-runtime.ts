import { join } from "node:path";
import { loadControlRuntimeConfig, controlRuntimePath, discoverControlListener, type DeviceControlRuntimeOptions } from "./control-runtime";
import { loadControlAuthorization } from "./control-authorization";
import { watchControlAuthorization } from "./control-watch";
import { NativeTransportError } from "./codex-transport";
import { CodexCreateTransport } from "./codex-create-transport";
import { CodexCreateAdapter } from "./codex-create";
import { CreateOperationStore } from "./create-operation-store";
import { CreateAuthorization } from "./create-authorization";
import { DeviceCreateService } from "./create-service";
import { CollaborationCreateError } from "./create-types";
import type { CreateOperation } from "./create-protocol";
import type { TrustedCallContext } from "./authorization";

export interface DeviceCreateRuntimeOptions extends DeviceControlRuntimeOptions {}
/** Uses only the selected shared listener. Owns connections and its journal, never a daemon. */
export function createDeviceCreateRuntime(options: DeviceCreateRuntimeOptions) {
  let closed = false, watcherFailed = false, generation = 0;
  let store: CreateOperationStore | undefined, service: DeviceCreateService | undefined;
  let stopWatch: (() => void) | undefined, closing: Promise<void> | undefined, storeClosed = false;
  const transports = new Set<CodexCreateTransport>();
  const deadlineMs = Math.min(30_000, Math.max(1, options.deadlineMs ?? 30_000));
  const configuration = () => loadControlRuntimeConfig(options.stateDir, options.endpointId);
  const grant = () => loadControlAuthorization(options.stateDir, options.endpointId);
  const authorization = new CreateAuthorization({ nodeId: options.nodeId, endpointId: options.endpointId, authorization: grant,
    pinnedOwnerId: () => closed || watcherFailed ? null : options.pinnedOwnerId() });
  const invalidate = () => { generation++; authorization.invalidate(); service?.invalidate(); for (const native of transports) native.close(); transports.clear(); };
  try {
    store = new CreateOperationStore(join(options.stateDir, "collaboration-create.sqlite"));
    service = new DeviceCreateService({ node_id: options.nodeId, endpoint_id: options.endpointId, store, authorization, deadlineMs,
      native: () => {
        const config = configuration().config, born = generation;
        if (closed || watcherFailed || !config) throw new NativeTransportError("offline");
        const fingerprint = JSON.stringify(config);
        const verifyListener = () => {
          if (closed || watcherFailed || born !== generation || fingerprint !== JSON.stringify(configuration().config)) throw new NativeTransportError("offline");
          const evidence = options.testing?.listener?.(config) ?? discoverControlListener(config);
          if (!config.supportedVersions.includes(evidence.version)) throw new NativeTransportError("unsupported");
          return evidence;
        };
        const evidence = verifyListener();
        const transport = new CodexCreateTransport({ socket: config.socket, executable: config.executable, pid: evidence.pid,
          supportedVersions: config.supportedVersions, timeoutMs: Math.min(5000, deadlineMs), maxBytes: 1024 * 1024,
          verifyListener, connectSocket: options.testing?.connectSocket });
        transports.add(transport);
        const adapter = new CodexCreateAdapter({ node_id: options.nodeId, endpoint_id: options.endpointId, transport });
        return Object.assign(adapter, { close: () => { transport.close(); transports.delete(transport); } });
      },
    });
    stopWatch = (options.testing?.watch ?? watchControlAuthorization)([controlRuntimePath(options.stateDir), join(options.stateDir, "collaboration-control.json"), join(options.stateDir, "paired.json")], invalidate, () => { watcherFailed = true; invalidate(); });
  } catch {
    watcherFailed = true; invalidate();
    void service?.close().catch(() => {});
    if (store) { store.close(); storeClosed = true; }
  }
  return {
    status: () => ({ state: closed ? "closed" as const : watcherFailed ? "watcher_failed" as const : configuration().state, grant_state: grant().state }),
    manifest: (context?: TrustedCallContext) => service?.manifest(context) ?? { version: 1 as const, endpoint_id: options.endpointId, grant_state: "grant_required" as const,
      authorization_revision: null, actions: [], scope: null, limitations: { native_readiness: "unknown" as const, cancel: false as const, automatic_replay: false as const, execution_completion: "unknown" as const } },
    execute: (operation: CreateOperation, body: unknown, context?: TrustedCallContext) => {
      if (closed || watcherFailed || !service) return Promise.reject(new CollaborationCreateError("offline"));
      // Saved query (and terminal apply) is authorized independently of native availability.
      return service.execute(operation, body, context);
    },
    invalidate,
    /** Local create-runtime facts only. No completion subscription exists yet; accepted input remains unknown. */
    changeSafety: (): {scope:'create-runtime';state:'safe'|'busy'|'unavailable';reason:'idle_observed'|'config_required'|'raw_pending'|'journal_invoking'|'journal_unknown'|'native_unknown'|'unavailable';generation:number} => {
      const result=(state:'safe'|'busy'|'unavailable',reason:'idle_observed'|'config_required'|'raw_pending'|'journal_invoking'|'journal_unknown'|'native_unknown'|'unavailable')=>({scope:'create-runtime' as const,state,reason,generation});
      if(closed||watcherFailed||!store||!service||storeClosed)return result('unavailable','unavailable');
      if(service.busy)return result('busy','raw_pending');
      try {
        const facts=store.changeFacts();
        if(facts.invoking)return result('busy','journal_invoking');
        if(facts.unknown)return result('unavailable','journal_unknown');
        if(facts.acceptedInput)return result('unavailable','native_unknown');
        const selected=configuration();
        if(selected.state==='config_required'&&!transports.size)return result('safe','config_required');
        if(!selected.config)return result('unavailable','unavailable');
        for(const transport of transports)transport.verifyCurrent();
        return result('safe','idle_observed');
      }catch{return result('unavailable','unavailable');}
    },
    get busy() { return !!service?.busy; },
    close: (): Promise<void> => {
      if (closing) return closing;
      if (!closed) { closed = true; stopWatch?.(); invalidate(); }
      const attempt = Promise.resolve(service?.close()).then(() => { if (store && !storeClosed) { store.close(); storeClosed = true; } })
        .finally(() => { if (closing === attempt) closing = undefined; });
      closing = attempt; return attempt;
    },
  };
}
export type DeviceCreateRuntime = ReturnType<typeof createDeviceCreateRuntime>;
