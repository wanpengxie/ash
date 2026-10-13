import { createHash } from "node:crypto";
import type { WorkRef } from "./types";
import { MATERIAL_LIMITS as L, MaterialProtocolError, type MaterialErrorCode, type MaterialProvenance, type AssetRef, type LinkRef, type MaterialRef, type ContextBundle, type MaterialTarget, type CollaborationRequest, type ResultEnvelope, type MaterialReply, type MaterialInputs, type MaterialOperation, type AssetInputs, type AssetOperation, type TransferIdentity, type AssetReceipt, type MaterialResultFact, type TransferFact, type MaterialRequestState, type MaterialTransferState, type MaterialEndpointRef, type MaterialQuestionFact } from "./material-types";
const errors: readonly MaterialErrorCode[] = ["invalid", "too_large", "permission_denied", "expired", "conflict", "not_found", "unsupported", "offline", "timeout", "result_unknown", "hash_mismatch"];
function fail(code: MaterialErrorCode = "invalid"): never {
    throw new MaterialProtocolError(code);
}
function obj(v: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        fail();
    const r = v as Record<string, unknown>;
    if (Object.keys(r).some(k => !keys.includes(k)) || keys.some(k => !optional.includes(k) && !Object.hasOwn(r, k)))
        fail();
    return r;
}
function str(v: unknown, max: number = L.text_item_bytes, empty = true): string {
    if (typeof v !== "string" || v.includes("\0") || !empty && !v.trim())
        fail();
    if (Buffer.byteLength(v, "utf8") > max)
        fail("too_large");
    return v;
}
function id(v: unknown): string {
    const s = str(v, L.id_bytes, false);
    if (/[\r\n]/.test(s))
        fail();
    return s;
}
function num(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min)
        fail();
    if (v > max)
        fail("too_large");
    return v;
}
function ver(v: unknown): 1 {
    if (v !== 1)
        fail();
    return 1;
}
function list<T>(v: unknown, max: number, parse: (v: unknown) => T): T[] {
    if (!Array.isArray(v))
        fail();
    if (v.length > max)
        fail("too_large");
    return v.map(parse);
}
function texts(v: unknown): string[] {
    return list(v, L.missing, x => str(x));
}
export function assertMaterialEnvelopeSize(value: unknown): void {
    let s: string | undefined;
    try {
        s = JSON.stringify(value);
    }
    catch {
        fail();
    }
    if (!s)
        fail();
    if (Buffer.byteLength(s, "utf8") > L.envelope_bytes)
        fail("too_large");
}
export function parseMaterialWork(value: unknown): WorkRef {
    const v = obj(value, ["node_id", "endpoint_id", "kind", "native_id"]);
    if (v.kind !== "conversation")
        fail();
    return { node_id: id(v.node_id), endpoint_id: id(v.endpoint_id), kind: "conversation", native_id: id(v.native_id) };
}
export function parseMaterialEndpoint(value: unknown): MaterialEndpointRef {
    const v = obj(value, (value as {
        kind?: unknown;
    })?.kind === "work" ? ["kind", "work"] : ["kind", "node_id", "endpoint_id"]);
    if (v.kind === "work")
        return { kind: "work", work: parseMaterialWork(v.work) };
    if (v.kind === "node")
        return { kind: "node", node_id: id(v.node_id), endpoint_id: id(v.endpoint_id) };
    return fail();
}
export function sameMaterialEndpoint(a: MaterialEndpointRef, b: MaterialEndpointRef): boolean {
    return a.kind === "work" ? b.kind === "work" && sameMaterialWork(a.work, b.work) : b.kind === "node" && a.node_id === b.node_id && a.endpoint_id === b.endpoint_id;
}
export function parseMaterialQuestion(value: unknown): MaterialQuestionFact {
    const v = obj(value, ["pending_id", "question_version", "expires_at"]);
    return { pending_id: id(v.pending_id), question_version: num(v.question_version, 1), expires_at: num(v.expires_at, 1) };
}
export function sameMaterialWork(a: WorkRef, b: WorkRef): boolean {
    return a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id;
}
export function parseMaterialProvenance(value: unknown): MaterialProvenance {
    const v = obj(value, ["source", "observed_at", "producer", "model_summary", "missing"]);
    const raw = obj(v.source, (v.source as {
        kind?: unknown;
    })?.kind === "work_message" ? ["kind", "work", "message_id"] : ["kind"]);
    const source: MaterialProvenance["source"] = raw.kind === "work_message" ? { kind: "work_message", work: parseMaterialWork(raw.work), message_id: id(raw.message_id) } : raw.kind === "user_selection" ? { kind: "user_selection" } : fail();
    if (v.producer !== "user" && v.producer !== "model" && v.producer !== "connector" || typeof v.model_summary !== "boolean")
        fail();
    return { source, observed_at: num(v.observed_at), producer: v.producer, model_summary: v.model_summary, missing: texts(v.missing) };
}
function provenance(v: unknown): MaterialProvenance[] {
    return list(v, L.provenance, parseMaterialProvenance);
}
function hash(v: unknown): string {
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v))
        fail();
    return v;
}
export function parseAssetRef(value: unknown): AssetRef {
    const v = obj(value, ["kind", "asset_id", "version", "sha256", "byte_length", "media_type", "display_name", "provenance", "expires_at"]);
    if (v.kind !== "asset")
        fail();
    const media = str(v.media_type, 128, false);
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(media))
        fail();
    return { kind: "asset", asset_id: id(v.asset_id), version: num(v.version, 1), sha256: hash(v.sha256), byte_length: num(v.byte_length, 0, L.file_bytes), media_type: media, display_name: str(v.display_name, L.display_name_bytes, false), provenance: provenance(v.provenance), expires_at: num(v.expires_at, 1) };
}
export function parseLinkRef(value: unknown): LinkRef {
    const v = obj(value, ["kind", "url", "description", "observed_at", "provenance"]);
    if (v.kind !== "link_only")
        fail();
    const url = str(v.url, 2048, false);
    let u: URL;
    try {
        u = new URL(url);
    }
    catch {
        return fail();
    }
    if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        fail();
    return { kind: "link_only", url, description: str(v.description), observed_at: num(v.observed_at), provenance: provenance(v.provenance) };
}
function ref(v: unknown): MaterialRef {
    return (v as {
        kind?: unknown;
    })?.kind === "asset" ? parseAssetRef(v) : parseLinkRef(v);
}
function refs(v: unknown): MaterialRef[] {
    const r = list(v, L.refs, ref), assets = r.filter((x): x is AssetRef => x.kind === "asset");
    if (assets.length > L.assets || assets.reduce((n, x) => n + x.byte_length, 0) > L.request_bytes)
        fail("too_large");
    const ids = new Set<string>();
    for (const a of assets) {
        if (ids.has(a.asset_id))
            fail();
        ids.add(a.asset_id);
    }
    return r;
}
export function parseContextBundle(value: unknown): ContextBundle {
    const v = obj(value, ["goal", "confirmed_decisions", "increment", "expected_output", "uncertain", "missing", "refs", "provenance"]);
    const out: ContextBundle = { goal: str(v.goal), confirmed_decisions: texts(v.confirmed_decisions), increment: str(v.increment), expected_output: str(v.expected_output), uncertain: texts(v.uncertain), missing: texts(v.missing), refs: refs(v.refs), provenance: provenance(v.provenance) };
    const strings = [out.goal, ...out.confirmed_decisions, out.increment, out.expected_output, ...out.uncertain, ...out.missing, ...out.provenance.flatMap(p => p.missing), ...out.refs.flatMap(r => [...(r.kind === "link_only" ? [r.description] : []), ...r.provenance.flatMap(p => p.missing)])];
    if (strings.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0) > L.context_text_bytes)
        fail("too_large");
    return out;
}
function capability(v: unknown): string {
    const s = id(v);
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/.test(s))
        fail();
    return s;
}
export function parseMaterialTarget(value: unknown): MaterialTarget {
    const v = obj(value, ["node_id", "endpoint_id", "capability_id"], ["capability_id"]);
    return { node_id: id(v.node_id), endpoint_id: id(v.endpoint_id), ...(v.capability_id === undefined ? {} : { capability_id: capability(v.capability_id) }) };
}
export function parseCollaborationRequest(value: unknown): CollaborationRequest {
    assertMaterialEnvelopeSize(value);
    const v = obj(value, ["version", "request_id", "client_id", "source", "return_to", "target", "target_work", "kind", "purpose", "context", "expected_output", "expires_at"]);
    if (v.kind !== "human_material" && v.kind !== "agent_task" && v.kind !== "material_to_work")
        fail();
    const source = parseMaterialEndpoint(v.source), ret = parseMaterialEndpoint(v.return_to), target = parseMaterialTarget(v.target), targetWork = v.target_work === null ? null : parseMaterialWork(v.target_work);
    if ((v.kind === "material_to_work") !== (targetWork !== null) || targetWork && (targetWork.node_id !== target.node_id || targetWork.endpoint_id !== target.endpoint_id))
        fail();
    if (v.kind !== "material_to_work" && source.kind !== "work")
        fail();
    if (!sameMaterialEndpoint(source, ret) || (v.kind === "agent_task") !== (target.capability_id !== undefined))
        fail();
    return { version: ver(v.version), request_id: id(v.request_id), client_id: id(v.client_id), source: source, return_to: ret, target, target_work: targetWork, kind: v.kind, purpose: str(v.purpose, 4096, false), context: parseContextBundle(v.context), expected_output: str(v.expected_output), expires_at: num(v.expires_at, 1) };
}
export function parseResultEnvelope(value: unknown): ResultEnvelope {
    assertMaterialEnvelopeSize(value);
    const v = obj(value, ["version", "request_id", "reply_to", "result_version", "source", "target_work", "summary", "assets", "missing", "error_code", "observed_at"]);
    if (v.error_code !== null && !errors.includes(v.error_code as MaterialErrorCode))
        fail();
    return { version: ver(v.version), request_id: id(v.request_id), reply_to: id(v.reply_to), result_version: num(v.result_version, 1), source: parseMaterialEndpoint(v.source), target_work: v.target_work === null ? null : parseMaterialWork(v.target_work), summary: str(v.summary), assets: refs(v.assets), missing: texts(v.missing), error_code: v.error_code as MaterialErrorCode | null, observed_at: num(v.observed_at) };
}
export function parseMaterialReply(value: unknown): MaterialReply {
    assertMaterialEnvelopeSize(value);
    const human = (value as {
        kind?: unknown;
    })?.kind === "human_answer";
    const v = obj(value, ["version", "kind", "client_id", "request_id", "source", "expires_at", "result", ...(human ? ["pending_id", "question_version"] : [])]);
    if (!human && v.kind !== "work_result")
        fail();
    const r = parseResultEnvelope(v.result), source = parseMaterialEndpoint(v.source), request = id(v.request_id);
    if (r.request_id !== request || r.reply_to !== request || !sameMaterialEndpoint(r.source, source))
        fail();
    const base = { version: ver(v.version), client_id: id(v.client_id), request_id: request, source, expires_at: num(v.expires_at, 1), result: r };
    return human ? { ...base, kind: "human_answer", pending_id: id(v.pending_id), question_version: num(v.question_version, 1) } : { ...base, kind: "work_result" };
}
export function assertMaterialReplyBinding(reply: MaterialReply, request: CollaborationRequest, question: MaterialQuestionFact | null, now: number): void {
    parseMaterialReply(reply);
    parseCollaborationRequest(request);
    num(now);
    if (reply.request_id !== request.request_id || !sameMaterialEndpoint(reply.source, request.source))
        fail("conflict");
    if (reply.kind === "human_answer") {
        if (request.kind !== "human_material" || question === null)
            fail("conflict");
        const q = parseMaterialQuestion(question);
        if (q.expires_at > request.expires_at || reply.pending_id !== q.pending_id || reply.question_version !== q.question_version || reply.expires_at !== q.expires_at)
            fail("conflict");
        if (now >= q.expires_at)
            fail("expired");
    }
    else {
        if (request.kind !== "material_to_work" || question !== null || reply.expires_at !== request.expires_at)
            fail("conflict");
    }
    if (now >= request.expires_at)
        fail("expired");
    assertMaterialResultBinding(reply.result, request);
}
export function parseMaterialEnvelope<K extends MaterialOperation>(operation: K, value: unknown): MaterialInputs[K] {
    assertMaterialEnvelopeSize(value);
    let out: MaterialInputs[MaterialOperation];
    if (operation === "submit")
        out = parseCollaborationRequest(value);
    else if (operation === "reply")
        out = parseMaterialReply(value);
    else if (operation === "discover") {
        const v = obj(value, ["version", "target"]);
        out = { version: ver(v.version), target: parseMaterialTarget(v.target) };
    }
    else if (["get_result", "await_result", "ack_result"].includes(operation)) {
        const extra = operation === "await_result" ? ["wait_ms"] : operation === "ack_result" ? ["result_version"] : [];
        const v = obj(value, ["version", "request_id", ...extra]);
        out = { version: ver(v.version), request_id: id(v.request_id), ...(operation === "await_result" ? { wait_ms: num(v.wait_ms, 0, L.await_ms) } : operation === "ack_result" ? { result_version: num(v.result_version, 1) } : {}) };
    }
    else
        return fail();
    return out as MaterialInputs[K];
}
function transfer(v: Record<string, unknown>): TransferIdentity {
    return { version: ver(v.version), transfer_id: id(v.transfer_id), request_id: id(v.request_id), asset_id: id(v.asset_id), asset_version: num(v.asset_version, 1) };
}
export function decodeMaterialChunk(value: unknown): Uint8Array {
    const s = str(value, Math.ceil(L.chunk_bytes / 3) * 4);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))
        fail();
    const bytes = Buffer.from(s, "base64");
    if (!bytes.length || bytes.toString("base64") !== s)
        fail();
    if (bytes.length > L.chunk_bytes)
        fail("too_large");
    return bytes;
}
export function parseAssetEnvelope<K extends AssetOperation>(operation: K, value: unknown): AssetInputs[K] {
    assertMaterialEnvelopeSize(value);
    let out: AssetInputs[AssetOperation];
    if (operation === "offer") {
        const v = obj(value, ["version", "request_id", "asset", "source", "destination", "expires_at"]), a = parseAssetRef(v.asset), expires = num(v.expires_at, 1);
        if (expires > a.expires_at)
            fail();
        out = { version: ver(v.version), request_id: id(v.request_id), asset: a, source: parseMaterialEndpoint(v.source), destination: parseMaterialEndpoint(v.destination), expires_at: expires };
    }
    else if (["put_chunk", "commit", "read_chunk", "ack"].includes(operation)) {
        const extra = operation === "put_chunk" ? ["chunk_index", "data_base64"] : operation === "read_chunk" ? ["chunk_index"] : operation === "ack" ? ["receipt_id"] : [];
        const v = obj(value, ["version", "transfer_id", "request_id", "asset_id", "asset_version", ...extra]);
        const t = transfer(v);
        if (operation === "put_chunk") {
            decodeMaterialChunk(v.data_base64);
            out = { ...t, chunk_index: num(v.chunk_index, 0, Math.ceil(L.file_bytes / L.chunk_bytes) - 1), data_base64: v.data_base64 as string };
        }
        else if (operation === "read_chunk")
            out = { ...t, chunk_index: num(v.chunk_index, 0, Math.ceil(L.file_bytes / L.chunk_bytes) - 1) };
        else if (operation === "ack")
            out = { ...t, receipt_id: id(v.receipt_id) };
        else
            out = t;
    }
    else
        return fail();
    return out as AssetInputs[K];
}
function canonical(value: unknown): string {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    const v = value as Record<string, unknown>;
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}
export function materialPayloadHash(value: CollaborationRequest | MaterialReply): string {
    const parsed = "result" in value ? parseMaterialReply(value) : parseCollaborationRequest(value);
    return createHash("sha256").update(canonical(parsed), "utf8").digest("hex");
}
export function materialBytesHash(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
export function materialInlineSafe(mediaType: string): boolean {
    return ["text/plain", "image/png", "image/jpeg", "image/webp"].includes(mediaType);
}
export function parseAssetReceipt(value: unknown): AssetReceipt {
    const v = obj(value, ["version", "receipt_id", "transfer_id", "request_id", "asset_id", "asset_version", "sha256", "byte_length", "destination", "received_at"]);
    return { version: ver(v.version), receipt_id: id(v.receipt_id), transfer_id: id(v.transfer_id), request_id: id(v.request_id), asset_id: id(v.asset_id), asset_version: num(v.asset_version, 1), sha256: hash(v.sha256), byte_length: num(v.byte_length, 0, L.file_bytes), destination: parseMaterialEndpoint(v.destination), received_at: num(v.received_at) };
}
/** Receipt destination is structurally parsed here; service must bind it to trusted request.return_to and current authorization scope. */
export function toMaterialResultDto(value: unknown): MaterialResultFact {
    assertMaterialEnvelopeSize(value);
    const v = obj(value, ["version", "request_id", "state", "result", "question", "claimed_result_version", "receipts", "business_state", "observed_at"]);
    const states: MaterialRequestState[] = ["registered", "waiting_owner", "running", "result_available", "expired", "failed", "unknown"];
    if (!states.includes(v.state as MaterialRequestState) || v.business_state !== "unverified")
        fail();
    const question = v.question === null ? null : parseMaterialQuestion(v.question);
    if (v.state === "waiting_owner" && question === null)
        fail();
    const r = v.result === null ? null : parseResultEnvelope(v.result), request = id(v.request_id), claimed = v.claimed_result_version === null ? null : num(v.claimed_result_version, 1), receipts = list(v.receipts, L.assets, parseAssetReceipt);
    if (r && (r.request_id !== request || r.reply_to !== request) || (v.state === "result_available") !== (r !== null) && !["expired", "failed"].includes(v.state as string) || claimed !== null && (!r || claimed !== r.result_version))
        fail();
    for (const receipt of receipts) {
        const a = r?.assets.find(a => a.kind === "asset" && a.asset_id === receipt.asset_id);
        if (receipt.request_id !== request || !a || a.kind !== "asset" || a.version !== receipt.asset_version || a.sha256 !== receipt.sha256 || a.byte_length !== receipt.byte_length)
            fail();
    }
    if (new Set(receipts.map(r => r.asset_id)).size !== receipts.length)
        fail();
    return { version: ver(v.version), request_id: request, state: v.state as MaterialRequestState, result: r, question, claimed_result_version: claimed, receipts, business_state: "unverified", observed_at: num(v.observed_at) };
}
export function toMaterialTransferDto(value: unknown): TransferFact {
    assertMaterialEnvelopeSize(value);
    const v = obj(value, ["version", "transfer_id", "request_id", "asset_id", "asset_version", "state", "received_chunks", "receipt", "expires_at"]);
    const t = transfer(v), states: MaterialTransferState[] = ["offered", "receiving", "committed", "acknowledged", "expired", "failed", "unknown"];
    if (!states.includes(v.state as MaterialTransferState))
        fail();
    const chunks = list(v.received_chunks, Math.ceil(L.file_bytes / L.chunk_bytes), x => num(x, 0, Math.ceil(L.file_bytes / L.chunk_bytes) - 1)), receipt = v.receipt === null ? null : parseAssetReceipt(v.receipt);
    if (new Set(chunks).size !== chunks.length || v.state === "offered" && chunks.length || (["committed", "acknowledged"].includes(v.state as string)) !== (receipt !== null) && !["expired", "failed"].includes(v.state as string))
        fail();
    if (receipt && (receipt.transfer_id !== t.transfer_id || receipt.request_id !== t.request_id || receipt.asset_id !== t.asset_id || receipt.asset_version !== t.asset_version))
        fail();
    return { ...t, state: v.state as MaterialTransferState, received_chunks: chunks, receipt, expires_at: num(v.expires_at, 1) };
}
export function materialAwaitPolicy(state: MaterialRequestState, requestedMs: number): {
    wait_ms: number;
    next: "query_next_turn" | "bounded_agent_wait";
    cancels_execution: false;
} {
    num(requestedMs, 0, L.await_ms);
    return { wait_ms: state === "running" ? requestedMs : 0, next: state === "running" ? "bounded_agent_wait" : "query_next_turn", cancels_execution: false };
}
export function canTransitionMaterialRequest(from: MaterialRequestState, to: MaterialRequestState): boolean {
    const transitions: Record<MaterialRequestState, readonly MaterialRequestState[]> = { registered: ["waiting_owner", "running", "result_available", "failed", "expired", "unknown"], waiting_owner: ["result_available", "failed", "expired", "unknown"], running: ["result_available", "failed", "expired", "unknown"], result_available: ["expired"], failed: ["expired"], expired: [], unknown: ["result_available", "failed", "expired"] };
    return from === to || transitions[from].includes(to);
}
export function canTransitionMaterialTransfer(from: MaterialTransferState, to: MaterialTransferState): boolean {
    const transitions: Record<MaterialTransferState, readonly MaterialTransferState[]> = { offered: ["receiving", "committed", "failed", "expired", "unknown"], receiving: ["committed", "failed", "expired", "unknown"], committed: ["acknowledged", "expired"], acknowledged: ["expired"], failed: ["expired"], expired: [], unknown: ["committed", "failed", "expired"] };
    return from === to || transitions[from].includes(to);
}
/** Association check only; caller separately proves current principal, grant, epoch and work ownership. */
export function assertMaterialResultBinding(result: ResultEnvelope, request: CollaborationRequest, expectedTarget: WorkRef | null = request.target_work): void {
    parseResultEnvelope(result);
    parseCollaborationRequest(request);
    if (request.kind === "human_material" && expectedTarget !== null)
        fail("conflict");
    if (expectedTarget !== null) {
        parseMaterialWork(expectedTarget);
        if (expectedTarget.node_id !== request.target.node_id || expectedTarget.endpoint_id !== request.target.endpoint_id)
            fail("conflict");
    }
    if (request.target_work !== null && (expectedTarget === null || !sameMaterialWork(expectedTarget, request.target_work)))
        fail("conflict");
    if (result.request_id !== request.request_id || result.reply_to !== request.request_id || !sameMaterialEndpoint(result.source, request.source) || (result.target_work === null) !== (expectedTarget === null) || result.target_work && expectedTarget && !sameMaterialWork(result.target_work, expectedTarget))
        fail("conflict");
}
/** Request association only; the service must independently prove current destination authorization. */
export function assertMaterialFactBinding(fact: MaterialResultFact, request: CollaborationRequest, expectedQuestion: MaterialQuestionFact | null): void {
    toMaterialResultDto(fact);
    parseCollaborationRequest(request);
    if (fact.request_id !== request.request_id)
        fail("conflict");
    if (request.kind !== "human_material" && (fact.question !== null || expectedQuestion !== null))
        fail("conflict");
    if (request.kind === "human_material") {
        if (expectedQuestion !== null) {
            const q = parseMaterialQuestion(expectedQuestion);
            if (q.expires_at > request.expires_at || fact.question === null || fact.question.pending_id !== q.pending_id || fact.question.question_version !== q.question_version || fact.question.expires_at !== q.expires_at)
                fail("conflict");
        }
        else if (fact.question !== null || !["registered", "unknown", "failed", "expired"].includes(fact.state))
            fail("conflict");
    }
    if (fact.result)
        assertMaterialResultBinding(fact.result, request, fact.result.target_work);
    for (const receipt of fact.receipts)
        if (!sameMaterialEndpoint(receipt.destination, request.return_to))
            fail("conflict");
}
/** Compare against the protected persisted offer, never an untrusted replacement offer. */
export function assertAssetReceiptBinding(receipt: AssetReceipt, offer: AssetInputs["offer"]): void {
    parseAssetReceipt(receipt);
    parseAssetEnvelope("offer", offer);
    if (receipt.request_id !== offer.request_id || receipt.asset_id !== offer.asset.asset_id || receipt.asset_version !== offer.asset.version || receipt.sha256 !== offer.asset.sha256 || receipt.byte_length !== offer.asset.byte_length || !sameMaterialEndpoint(receipt.destination, offer.destination))
        fail("conflict");
}
