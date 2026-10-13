import {parseMaterialReceiveScope,type MaterialReceiveScopeConfig} from "../collaboration/material-receive-scope";
import { parseReadAuthorization, type ReadAuthorizationConfig } from "../collaboration/authorization";
import { parseControlAuthorization, type ControlAuthorizationConfig } from "../collaboration/control-authorization";
import { parseCurrentPairing } from "../collaboration/pairing";
import { LocalStateError, LocalStateTransaction, type LocalStateObservation } from "../collaboration/local-state-transaction";

export type SetupErrorCode = "unpaired" | "stale" | "busy" | "invalid" | "unavailable" | "storage" | "source_not_running" | "ambiguous_source" | "unsupported";
export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode) { super(`Connection setup: ${code}`); }
}
export interface SetupPrecondition { ownerId: string; revision: string; epoch: string }
export interface ScopeSnapshot {
  precondition: SetupPrecondition | null;
  read: ReadAuthorizationConfig | null;
  control: ControlAuthorizationConfig | null;
  readState: "configured" | "missing" | "invalid";
  controlState: "configured" | "missing" | "invalid";
}
/** Optional additional epoch never replaces the mandatory real filesystem observation. */
export interface ScopeStoreOptions { stateDir: string; endpointId: string; nodeId?:string; observationEpoch?(): string }
const error = (caught: unknown): SetupError => caught instanceof SetupError ? caught : new SetupError(caught instanceof LocalStateError ? caught.code : "storage");
export class SetupScopeStore {
  private readonly transaction: LocalStateTransaction;
  constructor(private readonly options: ScopeStoreOptions) {
    try { this.transaction = new LocalStateTransaction(options.stateDir, undefined, options.observationEpoch); }
    catch (caught) { throw error(caught); }
  }
  private snapshotFrom(observed: LocalStateObservation): ScopeSnapshot {
    const pairFile = observed.files["paired.json"], pair = pairFile ? parseCurrentPairing(pairFile.raw) : null;
    const owner = pair && !pair.revoked ? pair.ownerId : null;
    const r = observed.files["collaboration-read.json"], c = observed.files["collaboration-control.json"];
    let read: ReadAuthorizationConfig | null = null, control: ControlAuthorizationConfig | null = null;
    try { if (r) { const candidate = parseReadAuthorization(JSON.parse(r.raw), this.options.endpointId); if (owner && candidate.owner_id === owner) read = candidate; } } catch {}
    try { if (c) { const candidate = parseControlAuthorization(JSON.parse(c.raw), this.options.endpointId); if (owner && candidate.owner_id === owner) control = candidate; } } catch {}
    return { precondition: owner ? { ownerId: owner, epoch: observed.epoch, revision: observed.revision } : null,
      read, control, readState: read?.version===3 ? "configured" : !r ? "missing" : "invalid", controlState: control ? "configured" : !c ? "missing" : "invalid" };
  }
  snapshot(): ScopeSnapshot {
    try { return this.snapshotFrom(this.transaction.capture()); } catch (caught) { throw error(caught); }
  }
  assertCurrent(expected: SetupPrecondition): ScopeSnapshot {
    const snapshot = this.snapshot(), actual = snapshot.precondition;
    if (!actual) throw new SetupError("unpaired");
    if (actual.ownerId !== expected.ownerId || actual.revision !== expected.revision || actual.epoch !== expected.epoch) throw new SetupError("stale");
    return snapshot;
  }
  /** Strict synchronous fence rejects Promise-returning implementations. */
  write(kind: "read" | "control", value: ReadAuthorizationConfig | ControlAuthorizationConfig | null, supplied: SetupPrecondition, fence: () => undefined): ScopeSnapshot {
    const expected = Object.freeze({ ownerId: supplied.ownerId, revision: supplied.revision, epoch: supplied.epoch });
    try {
      if (kind !== "read" && kind !== "control") throw new SetupError("invalid");
      this.assertCurrent(expected);
      const parsed = value === null ? null : kind === "read" ? parseReadAuthorization(value, this.options.endpointId) : parseControlAuthorization(value, this.options.endpointId);
      if (parsed && parsed.owner_id !== expected.ownerId) throw new SetupError("invalid");
      const after = this.transaction.write(kind === "read" ? "collaboration-read.json" : "collaboration-control.json", parsed === null ? null : JSON.stringify(parsed) + "\n", expected, () => {
        if (fence() !== undefined) throw new SetupError("unavailable");
        this.assertCurrent(expected); return undefined;
      });
      return this.snapshotFrom(after);
    } catch (caught) { throw error(caught); }
  }
  materialSnapshot(): {precondition:SetupPrecondition|null;material:MaterialReceiveScopeConfig|null;state:"configured"|"missing"|"invalid"} {try{if(!this.options.nodeId)throw new SetupError("unavailable");const token=this.transaction.capture(),snapshot=this.snapshotFrom(token),file=token.files["collaboration-material.json"];let material:MaterialReceiveScopeConfig|null=null;try{if(file){const parsed=parseMaterialReceiveScope(JSON.parse(file.raw),this.options.nodeId!,this.options.endpointId);if(parsed.owner_id===snapshot.precondition?.ownerId)material=parsed;}}catch{}return {precondition:snapshot.precondition,material,state:material?"configured":file?"invalid":"missing"};}catch(caught){throw error(caught);}}
  writeMaterial(value:MaterialReceiveScopeConfig|null,supplied:SetupPrecondition,fence:()=>undefined):ReturnType<SetupScopeStore["materialSnapshot"]>{const expected=Object.freeze({...supplied});try{if(!this.options.nodeId)throw new SetupError("unavailable");this.assertCurrent(expected);const parsed=value===null?null:parseMaterialReceiveScope(value,this.options.nodeId!,this.options.endpointId);if(parsed&&parsed.owner_id!==expected.ownerId)throw new SetupError("invalid");this.transaction.write("collaboration-material.json",parsed===null?null:JSON.stringify(parsed)+"\n",expected,()=>{if(fence()!==undefined)throw new SetupError("unavailable");this.assertCurrent(expected);return undefined;});return this.materialSnapshot();}catch(caught){throw error(caught);}}
  close(): void { this.transaction.close(); }
}
