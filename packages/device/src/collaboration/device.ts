import { MaterialResultExport, RESULT_EXPORT_PREPARE, RESULT_EXPORT_READ_CHUNK } from "./material-result-export";
import { resultFileCapabilities } from "./result-file-capabilities";
import { CollaborationReadService, type ReadServiceOptions } from "./read-service";
import { controlOperation, controlCapabilities, createOperation, createCapabilities } from "./capabilities";
import { createDeviceControlRuntime, type DeviceControlRuntimeOptions } from "./control-runtime";
import { createDeviceCreateRuntime, type DeviceCreateRuntimeOptions } from "./create-runtime";
import { CollaborationCreateError } from "./create-types";
import { CREATE_INPUT_MAX_BYTES, CREATE_OUTPUT_MAX_BYTES } from "./create-protocol";
import { currentPinnedOwnerId } from "./pairing";
import { CollaborationControlError } from "./control-types";
import { CONTROL_INPUT_MAX_BYTES, CONTROL_OUTPUT_MAX_BYTES } from "./control-protocol";
import type { TrustedCallContext } from "./authorization";
import type { CallResult } from "./compat";
import type { MaterialInputReader } from "./material-input-reader";
async function closeAll(resources: (() => unknown | Promise<unknown>)[]): Promise<void> {
  const results = await Promise.allSettled(resources.map(close => Promise.resolve().then(close)));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}

/** The same fixed collaboration dispatch used by the production device entry. */
export function createDeviceCollaboration(stateDir: string, nodeId: string, dependencies: { readFactory?: ReadServiceOptions["factory"]; controlTesting?: DeviceControlRuntimeOptions["testing"]; controlDeadlineMs?: number; createTesting?: DeviceCreateRuntimeOptions["testing"]; createDeadlineMs?: number;materialInputReader?:MaterialInputReader;testing?:{read?:ReadServiceOptions['testing']} } = {}) {
  const reads = new CollaborationReadService({ stateDir, nodeId, factory: dependencies.readFactory,testing:dependencies.testing?.read });
  const control = createDeviceControlRuntime({ stateDir, nodeId, endpointId: nodeId, pinnedOwnerId: () => currentPinnedOwnerId(stateDir), testing: dependencies.controlTesting, deadlineMs: dependencies.controlDeadlineMs,materialInputReader:dependencies.materialInputReader });
  const create = createDeviceCreateRuntime({ stateDir, nodeId, endpointId: nodeId, pinnedOwnerId: () => currentPinnedOwnerId(stateDir), testing: dependencies.createTesting, deadlineMs: dependencies.createDeadlineMs });
  const results = new MaterialResultExport({stateDir, nodeId, reads});
  return {
    control,create,results,
    get readBusy(){return reads.busy;},
    manifest: (context?: TrustedCallContext) => { const read = reads.manifest(), manifest = control.manifest(), creation = create.manifest(context); return { collaboration: read.collaboration, collaboration_control: manifest, collaboration_create: creation, capabilities: [...read.capabilities, ...controlCapabilities(manifest, nodeId), ...createCapabilities(creation, nodeId), ...resultFileCapabilities(nodeId, read.collaboration.authorization_state === "ready")] }; },
    call: async (name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: TrustedCallContext): Promise<CallResult> => {
      if (name === RESULT_EXPORT_PREPARE || name === RESULT_EXPORT_READ_CHUNK) {
        if (signal?.aborted || !context?.isCurrent()) return {ok:false,content:[],data:{code:"permission_denied"}};
        if (Buffer.byteLength(JSON.stringify(args)) > 64*1024) return {ok:false,content:[],data:{code:"too_large"}};
        const answer=await results.dispatch(name,args,context);
        if (Buffer.byteLength(JSON.stringify(answer)) > 64*1024) return {ok:false,content:[],data:{code:"too_large"}};
        return !signal?.aborted && context.isCurrent() ? answer : {ok:false,content:[],data:{code:"permission_denied"}};
      }
      const creation = createOperation(name), operation = creation ?? controlOperation(name);
      if (!operation) return reads.call(name, args, signal, context);
      try {
        if (!context?.isCurrent()) throw new CollaborationControlError("permission_denied");
        if (signal?.aborted) throw new CollaborationControlError("offline");
        if (Buffer.byteLength(JSON.stringify(args)) > (creation ? CREATE_INPUT_MAX_BYTES : CONTROL_INPUT_MAX_BYTES)) throw new CollaborationControlError("too_large");
        // Abort suppresses this response; it never forwards a cancellation to the daemon.
        const current: TrustedCallContext = { transportOwnerId: context.transportOwnerId, isCurrent: () => !signal?.aborted && context.isCurrent() };
        const data = creation ? await create.execute(creation, args, current) : await control.execute(operation as NonNullable<ReturnType<typeof controlOperation>>, args, current);
        if (!current.isCurrent()) throw new CollaborationControlError("permission_denied");
        if (Buffer.byteLength(JSON.stringify(data)) > (creation ? CREATE_OUTPUT_MAX_BYTES : CONTROL_OUTPUT_MAX_BYTES)) throw new CollaborationControlError("too_large");
        return { ok: true, content: [], data };
      } catch (error) {
        const code = !context?.isCurrent() ? "permission_denied" : error instanceof CollaborationControlError || error instanceof CollaborationCreateError ? error.code : "offline";
        return { ok: false, content: [], error: `Collaboration ${creation ? "create" : "control"}: ${code}`, data: { code } };
      }
    },
    invalidate: () => { results.revoke(); reads.invalidate(); control.invalidate(); create.invalidate(); },
    get busy() { return results.busy || reads.busy || control.busy || create.busy; },
    close: () => closeAll([() => {results.close();}, () => control.close(), () => reads.close(), () => create.close()]),
  };
}
