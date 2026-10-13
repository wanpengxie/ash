import { controlMaterialError, parseControlMaterial } from "./control-protocol";
import { createHash } from "node:crypto";
import type { ControlRequest, Invocation } from "./control-types";
import { CollaborationControlError } from "./control-types";
import { currentInputControlProof, type MaterialInputControlProof } from "./control-service";
import { MATERIAL_LIMITS, type AssetReceipt } from "./material-types";
import { materialInputManifestHash, materialInputText, verifyMaterialInputBytes, type MaterialInputAsset, type MaterialInputSelection } from "./material-input-manifest";
import { MaterialInputStaging, type MaterialInputPin } from "./material-input-staging";
export { currentInputControlProof, type MaterialInputControlProof } from "./control-service";
export interface InputAssetLease {
    readonly ref: MaterialInputAsset;
    readonly receipt: AssetReceipt;
    readChunk(index: number): Promise<Uint8Array>;
    /** Private local complete-asset read, under the same live lease. */
    readAll?(): Promise<Uint8Array>;
    current(): undefined;
    release(): undefined;
}
export interface MaterialInputCapture {
    selection: MaterialInputSelection;
    asset: MaterialInputAsset;
    work: ControlRequest['work'];
    material_request_id: string;
    asset_id: string;
    asset_version: number;
    sha256: string;
    byte_length: number;
    media_type: MaterialInputAsset['media_type'];
}
export interface MaterialInputReaderOptions {
    captureInput(input: MaterialInputCapture, proof: MaterialInputControlProof): Promise<InputAssetLease>;
    staging: MaterialInputStaging;
    deadlineMs?: number;
}
export interface MaterialInputDraft {
    readonly kind: 'material-input-draft';
}
export interface PreparedMaterialInput {
    readonly kind: 'prepared-material-input';
}
export type MaterialNativeInput = Readonly<{
    type: 'text';
    text: string;
    text_elements: readonly never[];
} | {
    type: 'localImage';
    path: string;
}>;
interface Draft {
    owner: MaterialInputReader;
    request: ControlRequest;
    selection: MaterialInputSelection;
    proof: MaterialInputControlProof;
    files: Uint8Array[];
    leases: InputAssetLease[];
    used: boolean;
    released: boolean;
    abandoned: boolean;
}
interface Prepared {
    draft: Draft;
    invocation: Invocation;
    inputs: readonly MaterialNativeInput[];
    pins: MaterialInputPin[];
    native_hash: string;
    manifest_hash: string;
    logical_content_hash:string;
    submitted: boolean;
    dispatched: boolean;
    ended: boolean;
    fence: {
        check(): undefined;
    };
}
const drafts = new WeakMap<object, Draft>(), prepared = new WeakMap<object, Prepared>();
const settled = new WeakSet<object>();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fail(): never { throw new CollaborationControlError('permission_denied'); }
function currentDraft(d: Draft) { if (d.released || d.abandoned || !d.owner.current())
    fail(); const c = currentInputControlProof(d.proof); if (c.operation_id !== d.request.operation_id || c.request_id !== d.request.request_id || c.manifest_hash !== materialInputManifestHash(d.selection) || JSON.stringify(c.work) !== JSON.stringify(d.request.work) || c.action !== d.request.action)
    fail(); for (const l of d.leases)
    if (l.current() !== undefined)
        fail(); }
function exact(i: Invocation, j: Invocation) { return i.principal.principal_id === j.principal.principal_id && i.attempt_id === j.attempt_id && i.connector_epoch === j.connector_epoch && i.native_client_message_id === j.native_client_message_id && i.native_interface_version===j.native_interface_version && i.request.operation_id === j.request.operation_id && JSON.stringify(i.request) === JSON.stringify(j.request); }
/** Only the private reader can provide bytes/paths. Copies or JSON recreations have no authority. */
export function currentPreparedMaterialInput(value: PreparedMaterialInput, invocation?: Invocation) { const p = prepared.get(value); if (!p || p.ended || invocation && !exact(p.invocation, invocation))
    fail(); currentDraft(p.draft); if (currentInputControlProof(p.draft.proof).native_generation !== p.invocation.connector_epoch)
    fail(); for (const pin of p.pins)
    p.draft.owner.staging.current(pin, !p.submitted); if (hash(p.inputs) !== p.native_hash || hash(['ash.material.input.content/v1',p.draft.request.input.text,p.manifest_hash])!==p.logical_content_hash)
    fail(); return Object.freeze({ invocation: p.invocation, inputs: p.inputs, manifest_hash: p.manifest_hash, logical_content_hash:p.logical_content_hash, native_input_hash: p.native_hash }); }
/** Final write dispatch marker. It does not assert native has consumed a file. */
export function markMaterialInputSubmitted(value: PreparedMaterialInput, invocation: Invocation) { currentPreparedMaterialInput(value, invocation); prepared.get(value)!.submitted = true; }
/** Only final proxy dispatch consumes this permission. Queue admission/rechecks and response fences remain read-only. */
export function consumePreparedMaterialDispatch(value: PreparedMaterialInput, method: string, params: any): undefined { const p = prepared.get(value), v = currentPreparedMaterialInput(value); if (!p || !p.submitted || p.dispatched || method !== (v.invocation.request.action === 'steer' ? 'turn/steer' : 'turn/start') || params.threadId !== v.invocation.request.work.native_id || params.clientUserMessageId !== v.invocation.native_client_message_id || params.expectedTurnId !== v.invocation.request.expected_turn_id || JSON.stringify(params.input) !== JSON.stringify(v.inputs))
    fail(); p.dispatched = true; return undefined; }
/** A genuine issued proof may be replaced only after its raw invocation has settled, never on timeout observation alone. */
export function isPreparedMaterialSettled(value:PreparedMaterialInput):boolean {return settled.has(value);}
/** Settling a native RPC releases source read leases, but never accepted/unknown image pins. */
export function finishPreparedMaterialInput(value: PreparedMaterialInput, status: 'accepted' | 'unknown' | 'rejected') { const p = prepared.get(value); if (!p || p.ended)
    return; try {
    for (const pin of p.pins) {
        try {
            p.draft.owner.staging.markSubmitted(pin, status === 'accepted' ? 'accepted' : 'unknown');
        }
        catch { /* Revocation cannot authorize deletion; retain the protected pin. */ }
    }
}
finally {
    p.ended = true;
    p.fence.check = fail;
    settled.add(value);
    prepared.delete(value);
    p.draft.owner.releaseDraftData(p.draft);
} }
export class MaterialInputReader {
    readonly staging: MaterialInputStaging;
    private pending = new Set<Promise<unknown>>();
    private closed = false;
    constructor(private readonly options: MaterialInputReaderOptions) { if (options.deadlineMs !== undefined && (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > MATERIAL_LIMITS.await_ms))
        throw new CollaborationControlError('invalid'); this.staging = options.staging; }
    get busy() { return this.pending.size > 0; }
    current() { return !this.closed; }
    async read(request: ControlRequest, proof: MaterialInputControlProof): Promise<MaterialInputDraft> {
        if (this.closed)
            throw new CollaborationControlError('offline');
        if (this.pending.size >= 32)
            throw new CollaborationControlError('busy');
        const selection = parseControlMaterial(request.input.material);
        const c = currentInputControlProof(proof);
        if (JSON.stringify(c.work) !== JSON.stringify(request.work) || c.action !== request.action)
            fail();
        const d: Draft = { owner: this, request: Object.freeze({ ...request, input: Object.freeze({ ...request.input, material: selection }) }), selection, proof, files: [], leases: [], used: false, released: false, abandoned: false };
        let abandoned = false;
        const raw = (async () => { try {
            for (const asset of selection.assets) {
                if (this.closed)
                    throw new CollaborationControlError('offline');
                currentDraft(d);
                const l = await this.options.captureInput({ selection, asset, work: request.work, material_request_id: selection.request_id, ...asset }, proof);
                d.leases.push(l);
                currentDraft(d);
                if (['asset_id', 'asset_version', 'sha256', 'byte_length', 'media_type'].some(k => l.ref[k as keyof MaterialInputAsset] !== asset[k as keyof MaterialInputAsset]) || l.receipt.version !== 1 || l.receipt.request_id !== selection.request_id || l.receipt.asset_id !== asset.asset_id || l.receipt.asset_version !== asset.asset_version || l.receipt.sha256 !== asset.sha256 || l.receipt.byte_length !== asset.byte_length || (l.receipt.destination.kind === 'node' ? (l.receipt.destination.node_id !== request.work.node_id || l.receipt.destination.endpoint_id !== request.work.endpoint_id) : JSON.stringify(l.receipt.destination.work) !== JSON.stringify(request.work)))
                    fail();
                let bytes: Uint8Array;
                if (l.readAll) {
                    bytes = await l.readAll();
                    currentDraft(d);
                    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== asset.byte_length)
                        throw new CollaborationControlError('invalid');
                    d.files.push(bytes);
                } else {
                    bytes = new Uint8Array(asset.byte_length);
                    d.files.push(bytes);
                    for (let index = 0, offset = 0; offset < bytes.length; index++) {
                        currentDraft(d);
                        const chunk = await l.readChunk(index);
                        currentDraft(d);
                        const want = Math.min(MATERIAL_LIMITS.chunk_bytes, bytes.length - offset);
                        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== want)
                            throw new CollaborationControlError('invalid');
                        bytes.set(chunk, offset);
                        offset += want;
                    }
                }
                verifyMaterialInputBytes(asset, bytes);
            }
            materialInputText(request.input.text, selection.assets.flatMap((asset, index) => asset.media_type === 'text/plain' ? [{ asset, bytes: d.files[index] }] : []));
            currentDraft(d);
            if (abandoned || this.closed)
                throw new CollaborationControlError('offline');
            const result = Object.freeze({ kind: 'material-input-draft' as const });
            drafts.set(result, d);
            return result;
        }
        catch (error) {
            this.releaseDraftData(d);
            throw controlMaterialError(error);
        } })();
        this.pending.add(raw);
        raw.then(() => this.pending.delete(raw), () => this.pending.delete(raw));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([raw, new Promise<never>((_, reject) => { timer = setTimeout(() => { abandoned = true; d.abandoned = true; reject(new CollaborationControlError('offline')); }, this.options.deadlineMs ?? MATERIAL_LIMITS.await_ms); })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    bind(value: MaterialInputDraft, invocation: Invocation): PreparedMaterialInput { const d = drafts.get(value); if (!d || d.owner !== this || d.used || this.closed)
        fail(); currentDraft(d); const c = currentInputControlProof(d.proof); if (c.principal_id !== invocation.principal.principal_id || c.native_generation !== invocation.connector_epoch || JSON.stringify(invocation.request) !== JSON.stringify(d.request) || !invocation.attempt_id || !invocation.native_client_message_id)
        fail(); d.used = true; const fence: {
        check(): undefined;
    } = { check: () => { currentDraft(d); return undefined; } }; try {
        const manifest_hash = materialInputManifestHash(d.selection), pins: MaterialInputPin[] = [], inputs: MaterialNativeInput[] = [Object.freeze({ type: 'text', text: materialInputText(d.request.input.text, d.selection.assets.flatMap((asset, index) => asset.media_type === 'text/plain' ? [{ asset, bytes: d.files[index] }] : [])), text_elements: Object.freeze([]) })];
        for (const [asset, index] of d.selection.assets.map((a, i) => [a, i] as const)) {
            if (asset.media_type === 'text/plain')
                continue;
            const pin = this.staging.stage(d.selection, index, d.files[index], { operation_id: invocation.request.operation_id, attempt_id: invocation.attempt_id, client_message_id: invocation.native_client_message_id!, native_generation: invocation.connector_epoch, manifest_hash, expires_at: invocation.request.expires_at, current: () => fence.check() });
            pins.push(pin);
            inputs.push(Object.freeze({ type: 'localImage', path: this.staging.inspect(pin).path }));
        }
        if (Buffer.byteLength(JSON.stringify(inputs)) > 1024 * 1024)
            throw new CollaborationControlError('too_large');
        const result = Object.freeze({ kind: 'prepared-material-input' as const });
        prepared.set(result, { draft: d, invocation: Object.freeze({ ...invocation }), inputs: Object.freeze(inputs), pins, native_hash: hash(inputs), manifest_hash, logical_content_hash:hash(['ash.material.input.content/v1',d.request.input.text,manifest_hash]), submitted: false, dispatched: false, ended: false, fence });
        currentPreparedMaterialInput(result, invocation);
        return result;
    }
    catch (error) {
        fence.check = fail;
        this.releaseDraftData(d);
        throw controlMaterialError(error);
    } }
    release(value: MaterialInputDraft) { const d = drafts.get(value); if (d && !d.used)
        this.releaseDraftData(d); }
    releaseDraftData(d: Draft) { if (d.released)
        return; d.released = true; for (const l of d.leases) {
        try {
            l.release();
        }
        catch { }
    } for (const file of d.files)
        file.fill(0); d.files = []; d.leases = []; }
    drain():Promise<void> {return Promise.allSettled([...this.pending]).then(()=>undefined);}
    close() { this.closed = true; }
}
