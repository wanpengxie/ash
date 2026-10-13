import type { WorkRef } from "./types";
export const MATERIAL_LIMITS = Object.freeze({ envelope_bytes: 64 * 1024, context_text_bytes: 16 * 1024, refs: 8, assets: 4, file_bytes: 4 * 1024 * 1024, request_bytes: 8 * 1024 * 1024, chunk_bytes: 40 * 1024, await_ms: 20000, provenance: 8, missing: 16, text_item_bytes: 4096, display_name_bytes: 256, id_bytes: 256, temporary_ttl_ms: 3600000, asset_ttl_ms: 7 * 86400000, principal_bytes: 64 * 1024 * 1024, principal_files: 128 });
export type MaterialErrorCode = "invalid" | "too_large" | "permission_denied" | "expired" | "conflict" | "not_found" | "unsupported" | "offline" | "timeout" | "result_unknown" | "hash_mismatch";
export class MaterialProtocolError extends Error {
    constructor(readonly code: MaterialErrorCode, message = code) {
        super(message);
        this.name = "MaterialProtocolError";
    }
}
export interface MaterialProvenance {
    source: {
        kind: "work_message";
        work: WorkRef;
        message_id: string;
    } | {
        kind: "user_selection";
    };
    observed_at: number;
    producer: "user" | "model" | "connector";
    model_summary: boolean;
    missing: readonly string[];
}
export interface AssetRef {
    readonly kind: "asset";
    readonly asset_id: string;
    readonly version: number;
    readonly sha256: string;
    readonly byte_length: number;
    readonly media_type: string;
    readonly display_name: string;
    readonly provenance: readonly MaterialProvenance[];
    readonly expires_at: number;
}
export interface LinkRef {
    kind: "link_only";
    url: string;
    description: string;
    observed_at: number;
    provenance: readonly MaterialProvenance[];
}
export type MaterialRef = AssetRef | LinkRef;
export interface ContextBundle {
    goal: string;
    confirmed_decisions: readonly string[];
    increment: string;
    expected_output: string;
    uncertain: readonly string[];
    missing: readonly string[];
    refs: readonly MaterialRef[];
    provenance: readonly MaterialProvenance[];
}
export interface MaterialTarget {
    node_id: string;
    endpoint_id: string;
    capability_id?: string;
}
/** Exact material entry point, never a node-wide wildcard grant. */
export type MaterialEndpointRef = {
    kind: "node";
    node_id: string;
    endpoint_id: string;
} | {
    kind: "work";
    work: WorkRef;
};
export interface MaterialQuestionFact {
    pending_id: string;
    question_version: number;
    expires_at: number;
}
export interface CollaborationRequest {
    version: 1;
    request_id: string;
    client_id: string;
    source: MaterialEndpointRef;
    return_to: MaterialEndpointRef;
    target: MaterialTarget;
    target_work: WorkRef | null;
    kind: "human_material" | "agent_task" | "material_to_work";
    purpose: string;
    context: ContextBundle;
    expected_output: string;
    expires_at: number;
}
export interface ResultEnvelope {
    version: 1;
    request_id: string;
    reply_to: string;
    result_version: number;
    source: MaterialEndpointRef;
    target_work: WorkRef | null;
    summary: string;
    assets: readonly MaterialRef[];
    missing: readonly string[];
    error_code: MaterialErrorCode | null;
    observed_at: number;
}
export interface MaterialReplyBase {
    version: 1;
    client_id: string;
    request_id: string;
    source: MaterialEndpointRef;
    expires_at: number;
    result: ResultEnvelope;
}
export type MaterialReply = MaterialReplyBase & ({
    kind: "human_answer";
    pending_id: string;
    question_version: number;
} | {
    kind: "work_result";
});
export interface ResultQuery {
    version: 1;
    request_id: string;
}
export type MaterialOperation = "discover" | "submit" | "reply" | "get_result" | "await_result" | "ack_result";
export interface MaterialInputs {
    discover: {
        version: 1;
        target: MaterialTarget;
    };
    submit: CollaborationRequest;
    reply: MaterialReply;
    get_result: ResultQuery;
    await_result: ResultQuery & {
        wait_ms: number;
    };
    ack_result: ResultQuery & {
        result_version: number;
    };
}
export type AssetOperation = "offer" | "put_chunk" | "commit" | "read_chunk" | "ack";
export interface TransferIdentity {
    version: 1;
    transfer_id: string;
    request_id: string;
    asset_id: string;
    asset_version: number;
}
export interface AssetInputs {
    offer: {
        version: 1;
        request_id: string;
        asset: AssetRef;
        source: MaterialEndpointRef;
        destination: MaterialEndpointRef;
        expires_at: number;
    };
    put_chunk: TransferIdentity & {
        chunk_index: number;
        data_base64: string;
    };
    commit: TransferIdentity;
    read_chunk: TransferIdentity & {
        chunk_index: number;
    };
    ack: TransferIdentity & {
        receipt_id: string;
    };
}
export type MaterialRequestState = "registered" | "waiting_owner" | "running" | "result_available" | "expired" | "failed" | "unknown";
export type MaterialTransferState = "offered" | "receiving" | "committed" | "acknowledged" | "expired" | "failed" | "unknown";
/** A receipt exists only after verified, atomic byte commit. It is not a business receipt. */
export interface AssetReceipt {
    version: 1;
    receipt_id: string;
    transfer_id: string;
    request_id: string;
    asset_id: string;
    asset_version: number;
    sha256: string;
    byte_length: number;
    destination: MaterialEndpointRef;
    received_at: number;
}
export interface MaterialResultFact {
    version: 1;
    request_id: string;
    state: MaterialRequestState;
    result: ResultEnvelope | null;
    question: MaterialQuestionFact | null;
    claimed_result_version: number | null;
    receipts: readonly AssetReceipt[];
    business_state: "unverified";
    observed_at: number;
}
export interface TransferFact extends TransferIdentity {
    state: MaterialTransferState;
    received_chunks: readonly number[];
    receipt: AssetReceipt | null;
    expires_at: number;
}
/** Metadata only: ledger/pending/job remain the sole body and execution fact owners. */
export interface MaterialRequestMapping {
    request_id: string;
    principal_id: string;
    client_id: string;
    payload_sha256: string;
    source: MaterialEndpointRef;
    return_to: MaterialEndpointRef;
    grant_revision: string;
    authorization_epoch: string;
    expires_at: number;
    ledger_request_id: string;
    pending_id: string | null;
    question_version: number | null;
    job_id: string | null;
}
/** Trusted injection only; never accepted as a body or proof of current authorization. */
export interface MaterialTrustedContext {
    principal_id: string;
    pairing_id: string;
    grant_revision: string;
    authorization_epoch: string;
    source_binding: MaterialEndpointRef;
    expires_at: number;
}
export type MaterialAuthorizationScope = {
    kind: "discovery";
    action: "discover";
    target: MaterialTarget;
} | ({
    kind: "request";
    request_id: string;
    source: MaterialEndpointRef;
    return_to: MaterialEndpointRef;
    target: MaterialEndpointRef;
} & ({
    action: Exclude<MaterialOperation, "discover">;
    transfer: null;
} | {
    action: AssetOperation;
    transfer: {
        asset_id: string;
        asset_version: number;
        source: MaterialEndpointRef;
        destination: MaterialEndpointRef;
    };
}));
export interface MaterialAuthorization {
    /** Optional synchronous after-I/O authorization; only undefined completes this synchronous fence. */
    synchronousAfter?(lease: MaterialTrustedContext, scope: MaterialAuthorizationScope): undefined;
    /** Optional uncached physical/write return fence; legacy authorities retain current(). */
    finalCurrent?(lease: MaterialTrustedContext, scope: MaterialAuthorizationScope): undefined;
    before(context: MaterialTrustedContext, scope: MaterialAuthorizationScope): Promise<MaterialTrustedContext>;
    after(lease: MaterialTrustedContext, scope: MaterialAuthorizationScope): Promise<void>;
    /** Synchronous final return fence; observed revoke/restore invalidates old epochs. */
    current(lease: MaterialTrustedContext, scope: MaterialAuthorizationScope): undefined;
}
export interface MaterialAssetService {
    invoke<K extends AssetOperation>(operation: K, input: AssetInputs[K], context: MaterialTrustedContext): Promise<K extends "read_chunk" ? AssetInputs["put_chunk"] : TransferFact>;
}
export interface MaterialRequestService {
    invoke<K extends MaterialOperation>(operation: K, input: MaterialInputs[K], context: MaterialTrustedContext): Promise<K extends "discover" ? {
        version: 1;
        target: MaterialTarget;
        capabilities: readonly string[];
    } : MaterialResultFact>;
}
