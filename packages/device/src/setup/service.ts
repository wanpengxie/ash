import type {ControlRuntimeSettings} from './control-runtime-settings';
import type {ReadSourceSettings,ReadSourceSelection} from './read-source-settings';
import type {SetupShellStatus,ShellStatusObservation} from './shell-status';
import {setupVerificationReadBinding,currentSetupVerificationProof,currentSetupVerificationSourceProof,releaseSetupVerificationProof,type SetupVerificationProof} from './native-verification';
import {parseMaterialReceiveScope,type MaterialReceiveScopeConfig,type MaterialReceiveGrant} from "../collaboration/material-receive-scope";
import { parseReadAuthorization } from "../collaboration/authorization";
import { parseControlAuthorization, type ControlScope, type GrantedControlAction } from "../collaboration/control-authorization";
import { setupDiagnostics, type DiagnosticEvidence, type SetupDiagnostics } from "./diagnostics";
import { SetupError, SetupScopeStore, type ScopeStoreOptions, type SetupPrecondition } from "./scope-settings";

export type ScopeSelection = { kind: "read"; allowedCwds: string[] } | { kind: "control"; allowedActions: GrantedControlAction[]; scope: ControlScope; expiresAt?: number };
export type MaterialScopeSelection = {grants:readonly MaterialReceiveGrant[];expiresAt:number}|{kind:'project';cwd:string;expiresAt:number};
export interface ScopePreview { selection: ScopeSelection; precondition: SetupPrecondition }
export interface SetupStatus { diagnostics: SetupDiagnostics; precondition: SetupPrecondition | null }
export interface SetupVerification {
  /** Read-only native lookup. Must check exact cwd existence and full work identity at this endpoint. */
  verifyScope(selection: Readonly<ScopeSelection>, current?: () => undefined): Promise<boolean>;
  captureScope?(selection:Readonly<ScopeSelection>,current:()=>undefined):Promise<SetupVerificationProof>;
  diagnostics(): Promise<DiagnosticEvidence>;
}
export interface SetupRuntime {
  /** Actual runtime reservation/drain; deny while active/unknown operations or update are unsafe. */
  reserveChange(): Promise<{ assertCurrent(): undefined; release(): undefined }>;
}
export interface SetupCredentialOperations {
  /** Production shell may supply existing pairing UI; service never starts a substitute runner. */
  openPairing(): Promise<undefined>;
  openOriginalClientLogin(): Promise<undefined>;
}
export interface ConnectionSetupOptions extends ScopeStoreOptions {
  verification?: SetupVerification;
  shellStatus?:SetupShellStatus;
  readSource?:ReadSourceSettings;
  controlRuntime?:ControlRuntimeSettings;
  /** Explicit isolated legacy fixtures only; production requires private retained native proof. */
  testing?: {allowBooleanVerification:true;readBinding?:{source_id:string;binding_revision:string}};
  /** Exact local target metadata proof; receiving does not issue send or work-source grants. */
  materialVerification?(grant:Readonly<MaterialReceiveGrant>):Promise<boolean>;
  materialProjectVerification?(cwd:string,ownerId:string,current:()=>undefined):Promise<boolean>;
  runtime?: SetupRuntime;
  readRuntime?:SetupRuntime;
  /** Receive-only changes retain I/O fences without requiring native execution completion. */
  materialRuntime?:SetupRuntime;
  connectionReady?():boolean;
  verifyRead?(project:string,current:()=>undefined):Promise<{state:'readable'|'empty';conversations:number;messages:number}>;
  credentials?: SetupCredentialOperations;
  now?: () => number;
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function precondition(value: SetupPrecondition): SetupPrecondition {
  if (!value || typeof value.ownerId !== "string" || typeof value.revision !== "string" || typeof value.epoch !== "string") throw new SetupError("invalid");
  return Object.freeze({ ownerId: value.ownerId, revision: value.revision, epoch: value.epoch });
}
function currentFence(current:()=>undefined):undefined{if(current()!==undefined)throw new SetupError('unavailable');return undefined;}
const unavailable = (): never => { throw new SetupError("unavailable"); };
/** Local typed backend. Shell/IPC must authenticate a local user and keep these ports private. */
export class ConnectionSetupService {
  private readonly store: SetupScopeStore;
  constructor(private readonly options: ConnectionSetupOptions) { this.store = new SetupScopeStore(options); }
  async status(current:()=>undefined=()=>undefined,probe=true): Promise<SetupStatus> {
    if(probe&&this.options.shellStatus){const original=this.store.snapshot(),boundary=this.options.shellStatus.boundary(original);try{return await this.captureStatus(current,probe);}catch(error){currentFence(current);if(!(error instanceof SetupError)||error.code!=='stale')throw error;const fresh=this.store.snapshot();if(!original.precondition||!fresh.precondition||original.precondition.ownerId!==fresh.precondition.ownerId||original.precondition.revision!==fresh.precondition.revision)throw error;boundary();return this.captureStatus(current,probe);}}
    return this.captureStatus(current,probe);
  }
  private async captureStatus(current:()=>undefined,probe:boolean):Promise<SetupStatus>{
    currentFence(current);
    const before = this.store.snapshot();
    let evidence: DiagnosticEvidence = {},observation:ShellStatusObservation|undefined;
    try {
      if(probe&&this.options.shellStatus){observation=await this.options.shellStatus.capture(before,current);evidence=observation.evidence;}
      else if(probe)try {evidence=setupDiagnostics(await this.options.verification?.diagnostics()??{},{pairing:'unpaired',readGrant:'missing',controlGrant:'missing'});}catch{}
      currentFence(current);
      // Never show capability evidence obtained under a changed owner/scope/source.
      if(before.precondition)this.store.assertCurrent(before.precondition);
      const after=this.store.snapshot();if(!before.precondition&&after.precondition)throw new SetupError('stale');
      observation?.current();currentFence(current);
      return {diagnostics:setupDiagnostics(evidence,{pairing:after.precondition?'paired':'unpaired',readGrant:observation?.readGrantState??after.readState,controlGrant:after.controlState}),precondition:after.precondition};
    }finally{observation?.release();}
  }

  async scopeStatus(current:()=>undefined=()=>undefined,probe=true) {
    currentFence(current);let snapshot=this.store.snapshot();const status=await this.status(current,probe);currentFence(current);
    if(probe&&this.options.shellStatus&&snapshot.precondition&&status.precondition){if(snapshot.precondition.revision!==status.precondition.revision||snapshot.precondition.ownerId!==status.precondition.ownerId)throw new SetupError('stale');snapshot=this.store.assertCurrent(status.precondition);}
    if(snapshot.precondition)this.store.assertCurrent(snapshot.precondition);
    else if(status.precondition)throw new SetupError('stale');
    const c=snapshot.control,active=!!c&&(c.expires_at===undefined||c.expires_at>(this.options.now??Date.now)());
    return immutable({...status,diagnostics:!active&&status.diagnostics.controlCapability==='verified'?setupDiagnostics({...status.diagnostics,controlCapability:'missing'},status.diagnostics):status.diagnostics,read:snapshot.read,control:snapshot.control,
      defaultProject:active&&c!.scope.kind==='exact_cwd'&&c!.allowed_actions.includes('create_work')?{state:'configured' as const,cwd:c!.scope.cwd}:{state:'unavailable' as const,cwd:null}});
  }
  private normalize(selection: ScopeSelection, expected: SetupPrecondition): ScopeSelection {
    try {
      if(!selection||typeof selection!=='object'||Array.isArray(selection))throw 0;
      const required=selection.kind==='read'?['kind','allowedCwds']:['kind','allowedActions','scope'];
      if(required.some(key=>!Object.hasOwn(selection,key))||Object.keys(selection).some(key=>!required.includes(key)&&!(selection.kind==='control'&&key==='expiresAt')))throw 0;
      if (selection.kind === "read") {
        const next = parseReadAuthorization({ version: 2, owner_id: expected.ownerId, endpoint_id: this.options.endpointId, authorization_generation: 1, allowedCwds: selection.allowedCwds }, this.options.endpointId);
        return { kind: "read", allowedCwds: next.allowedCwds };
      }
      if (selection.kind !== "control") throw new SetupError("invalid");
      const next = parseControlAuthorization({ version: 1, endpoint_id: this.options.endpointId, owner_id: expected.ownerId, authorization_generation: 1,
        allowed_actions: selection.allowedActions, scope: selection.scope, ...(selection.expiresAt === undefined ? {} : { expires_at: selection.expiresAt }) }, this.options.endpointId);
      if (next.expires_at !== undefined && next.expires_at <= (this.options.now ?? Date.now)()) throw new SetupError("invalid");
      return { kind: "control", allowedActions: next.allowed_actions, scope: next.scope, ...(next.expires_at === undefined ? {} : { expiresAt: next.expires_at }) };
    } catch { throw new SetupError("invalid"); }
  }
  async previewScope(selection: ScopeSelection, expected: SetupPrecondition,current:()=>undefined=()=>undefined): Promise<ScopePreview> {
    currentFence(current);expected = precondition(expected);
    this.store.assertCurrent(expected);
    const normalized = immutable(this.normalize(selection, expected));
    if (!this.options.verification || !this.options.verification.captureScope && this.options.testing?.allowBooleanVerification!==true) unavailable();
    let proof:SetupVerificationProof|undefined;
    try {
      if(this.options.verification!.captureScope){proof=await this.options.verification!.captureScope(normalized,()=>{currentFence(current);this.store.assertCurrent(expected);return undefined;});currentSetupVerificationProof(proof,normalized,true);}
      else if(await this.options.verification!.verifyScope(structuredClone(normalized),()=>{currentFence(current);this.store.assertCurrent(expected);return undefined;})!==true)throw new SetupError('invalid');
      currentFence(current);this.store.assertCurrent(expected);
    }catch(error){currentFence(current);this.store.assertCurrent(expected);throw error instanceof SetupError?error:new SetupError('unavailable');}
    finally{if(proof)releaseSetupVerificationProof(proof);}
    return { selection: normalized, precondition: { ...expected } };
  }
  async applyScope(selection: ScopeSelection, expected: SetupPrecondition,current:()=>undefined=()=>undefined): Promise<SetupStatus> {
    expected = precondition(expected);
    this.store.assertCurrent(expected);
    currentFence(current);selection = immutable(this.normalize(selection, expected));
    if (!this.options.runtime) unavailable();
    const reservation = await this.reserve(selection.kind==='read');let proof:SetupVerificationProof|undefined;
    try {
      currentFence(current);reservation.assertCurrent();
      let preview:ScopePreview;
      if(this.options.verification?.captureScope){
        proof=await this.options.verification.captureScope(selection,()=>{currentFence(current);this.store.assertCurrent(expected);return undefined;});
        currentFence(current);currentSetupVerificationProof(proof,selection);preview={selection,precondition:expected};
      }else preview=await this.previewScope(selection,expected,current);
      currentFence(current);reservation.assertCurrent();
      const previous = this.store.assertCurrent(expected);
      const generation = (preview.selection.kind === "read" ? previous.read?.authorization_generation : previous.control?.authorization_generation) ?? 0;
      const readBinding=preview.selection.kind==='read'?(proof?setupVerificationReadBinding(proof,selection):this.options.testing?.readBinding??unavailable()):undefined;
      const value = preview.selection.kind === "read" ? parseReadAuthorization({ version: 3, ...readBinding, owner_id: expected.ownerId, endpoint_id: this.options.endpointId,
        authorization_generation: generation + 1, allowedCwds: preview.selection.allowedCwds }, this.options.endpointId) : parseControlAuthorization({ version: 1, endpoint_id: this.options.endpointId,
        owner_id: expected.ownerId, authorization_generation: generation + 1, allowed_actions: preview.selection.allowedActions, scope: preview.selection.scope,
        ...(preview.selection.expiresAt === undefined ? {} : { expires_at: preview.selection.expiresAt }) }, this.options.endpointId);
      this.store.write(preview.selection.kind, value, expected, () => {currentFence(current);reservation.assertCurrent();if(proof)currentSetupVerificationProof(proof,selection,true);reservation.assertCurrent();if(proof)currentSetupVerificationSourceProof(proof,selection);return currentFence(current);});
    } catch(error){currentFence(current);throw error;}finally {try{if(proof)releaseSetupVerificationProof(proof);}finally{reservation.release();} }
    currentFence(current);return this.status(current,false);
  }
  async revoke(kind: "read" | "control", expected: SetupPrecondition,current:()=>undefined=()=>undefined): Promise<SetupStatus> {
    if (kind !== "read" && kind !== "control") throw new SetupError("invalid");
    expected = precondition(expected);
    this.store.assertCurrent(expected);
    const reservation = await this.reserve(kind==='read');
    try { currentFence(current);this.store.write(kind, null, expected, () => {currentFence(current);return reservation.assertCurrent();}); }
    finally { reservation.release(); }
    currentFence(current);return this.status(current,false);
  }

  async listControlRuntimeWorks(project:string,current:()=>undefined){currentFence(current);const result=await(this.options.controlRuntime??unavailable()).listLoadedWorks(project,current);currentFence(current);return result;}
  async prepareControlRuntime(candidate:unknown,current:()=>undefined){currentFence(current);const result=await(this.options.controlRuntime??unavailable()).prepare(candidate,current);currentFence(current);return result;}
  async applyControlRuntime(id:string,hash:string,current:()=>undefined){currentFence(current);const result=await(this.options.controlRuntime??unavailable()).apply(id,hash,current);currentFence(current);return result;}
  async inspectSource(current:()=>undefined){currentFence(current);const result=await(this.options.readSource??unavailable()).inspectDefault(current);currentFence(current);return result;}
  sourceStatus(current:()=>undefined){currentFence(current);const result=(this.options.readSource??unavailable()).status();currentFence(current);return result;}
  async prepareSource(selection:ReadSourceSelection,current:()=>undefined){currentFence(current);const result=await(this.options.readSource??unavailable()).prepare(selection,current);currentFence(current);return result;}
  async applySource(id:string,hash:string,current:()=>undefined){currentFence(current);const result=await(this.options.readSource??unavailable()).apply(id,hash,current);currentFence(current);return result;}
  connectionReady(current:()=>undefined){currentFence(current);const ready=this.options.connectionReady?.()===true;currentFence(current);return {ready};}
  async verifyRead(project:string,current:()=>undefined){currentFence(current);const result=await(this.options.verifyRead??unavailable())(project,current);currentFence(current);return result;}
  materialStatus(){return this.store.materialSnapshot();}
  private materialConfig(selection:MaterialScopeSelection,owner:string,generation:number):MaterialReceiveScopeConfig {
    if('kind' in selection){if(selection.kind!=='project'||Object.keys(selection).sort().join(',')!=='cwd,expiresAt,kind')throw new SetupError('invalid');return parseMaterialReceiveScope({version:2,action:'receive_input',owner_id:owner,endpoint_id:this.options.endpointId,authorization_generation:generation,expires_at:selection.expiresAt,grants:[],scope:{kind:'exact_cwd',cwd:selection.cwd}},this.options.nodeId!,this.options.endpointId);}
    if(Object.keys(selection).sort().join(',')!=='expiresAt,grants')throw new SetupError('invalid');
    return parseMaterialReceiveScope({version:1,owner_id:owner,endpoint_id:this.options.endpointId,authorization_generation:generation,expires_at:selection.expiresAt,grants:selection.grants},this.options.nodeId!,this.options.endpointId);
  }
  async previewMaterial(selection:MaterialScopeSelection,expected:SetupPrecondition):Promise<{selection:MaterialScopeSelection;precondition:SetupPrecondition}>{
    expected=precondition(expected);this.store.assertCurrent(expected);if(!this.options.nodeId)unavailable();let parsed:MaterialReceiveScopeConfig;
    try{parsed=this.materialConfig(selection,expected.ownerId,1);if(parsed.expires_at<=(this.options.now??Date.now)())throw Error();}catch{throw new SetupError('invalid');}
    const current=():undefined=>{this.store.assertCurrent(expected);return undefined;};
    if(parsed.version===2){
      if(!this.options.verification?.captureScope||!this.options.materialProjectVerification)unavailable();
      const control:ScopeSelection={kind:'control',allowedActions:['send_input','steer','create_work'],scope:parsed.scope};let proof:SetupVerificationProof|undefined;
      try{proof=await this.options.verification!.captureScope!(control,current);currentSetupVerificationProof(proof,control,true);if(await this.options.materialProjectVerification!(parsed.scope.cwd,expected.ownerId,current)!==true)throw new SetupError('invalid');currentSetupVerificationProof(proof,control,true);current();}
      finally{if(proof)releaseSetupVerificationProof(proof);}
      return {selection:immutable({kind:'project',cwd:parsed.scope.cwd,expiresAt:parsed.expires_at}),precondition:expected};
    }
    if(!this.options.materialVerification)unavailable();for(const grant of parsed.grants){let valid=false;try{valid=await this.options.materialVerification!(grant);}finally{current();}if(valid!==true)throw new SetupError('invalid');}
    return {selection:immutable({grants:parsed.grants,expiresAt:parsed.expires_at}),precondition:expected};
  }
  async applyMaterial(selection:MaterialScopeSelection,expected:SetupPrecondition,current:()=>undefined=()=>undefined){
    selection=immutable(structuredClone(selection));const fence=():undefined=>currentFence(current);fence();expected=precondition(expected);this.store.assertCurrent(expected);const reservation=await this.reserve(false,true);
    try{fence();reservation.assertCurrent();const preview=await this.previewMaterial(selection,expected);fence();reservation.assertCurrent();const previous=this.store.materialSnapshot();this.store.assertCurrent(expected);const config=this.materialConfig(preview.selection,expected.ownerId,(previous.material?.authorization_generation??0)+1);this.store.writeMaterial(config,expected,()=>{fence();return reservation.assertCurrent();});return this.store.materialSnapshot();}finally{reservation.release();}
  }
  async revokeMaterial(expected:SetupPrecondition,current:()=>undefined=()=>undefined){const fence=():undefined=>{if(current()!==undefined)throw new SetupError("unavailable");return undefined;};fence();expected=precondition(expected);this.store.assertCurrent(expected);const reservation=await this.reserve(false,true);try{fence();this.store.writeMaterial(null,expected,()=>{fence();return reservation.assertCurrent();});return this.store.materialSnapshot();}finally{reservation.release();}}
  private async reserve(read=false,material=false) {
    try {
      const reservation = await ((material?this.options.materialRuntime??this.options.runtime:read?this.options.readRuntime??this.options.runtime:this.options.runtime) ?? unavailable()).reserveChange();
      if (!reservation || typeof reservation.assertCurrent !== "function" || typeof reservation.release !== "function") unavailable();
      const call = (fn: () => undefined): undefined => {
        try { if (fn() !== undefined) throw new SetupError("unavailable"); return undefined; }
        catch (error) { if (error instanceof SetupError) throw error; throw new SetupError("busy"); }
      };
      return { assertCurrent: () => call(() => reservation.assertCurrent()), release: () => call(() => reservation.release()) };
    } catch (error) { if (error instanceof SetupError) throw error; throw new SetupError("busy"); }
  }
  close(): void { this.store.close(); }
  async openPairing(): Promise<undefined> {
    try { return await (this.options.credentials ?? unavailable()).openPairing(); } catch { throw new SetupError("unavailable"); }
  }
  async openOriginalClientLogin(): Promise<undefined> {
    try { return await (this.options.credentials ?? unavailable()).openOriginalClientLogin(); } catch { throw new SetupError("unavailable"); }
  }
}
