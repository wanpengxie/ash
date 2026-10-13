import test from "node:test";
import assert from "node:assert/strict";
import { MATERIAL_LIMITS as L, MaterialProtocolError, type CollaborationRequest, type AssetRef, type MaterialReply, type ResultEnvelope, type MaterialTrustedContext, type MaterialAuthorization, type MaterialAuthorizationScope, type MaterialResultFact } from "../src/collaboration/material-types";
import { parseCollaborationRequest, parseAssetRef, parseLinkRef, parseMaterialEnvelope, parseAssetEnvelope, materialPayloadHash, materialBytesHash, assertMaterialReplyBinding, assertMaterialResultBinding, toMaterialResultDto, toMaterialTransferDto, materialAwaitPolicy, canTransitionMaterialRequest, canTransitionMaterialTransfer, assertMaterialEnvelopeSize, parseMaterialEndpoint, sameMaterialEndpoint, parseMaterialQuestion, parseMaterialReply, parseAssetReceipt, assertMaterialFactBinding, assertAssetReceiptBinding } from "../src/collaboration/material-protocol";
const work = { node_id: "desktop", endpoint_id: "codex", kind: "conversation" as const, native_id: "existing" };
const source = { kind: "work" as const, work };
const phone = { kind: "node" as const, node_id: "phone", endpoint_id: "ash" };
const question = { pending_id: "pending", question_version: 1, expires_at: 1000 };
const asset: AssetRef = { kind: "asset", asset_id: "asset", version: 1, sha256: "a".repeat(64), byte_length: 3, media_type: "image/png", display_name: "picture.png", provenance: [], expires_at: 1000 };
const request: CollaborationRequest = { version: 1, request_id: "request", client_id: "client", source, return_to: source, target: { node_id: "phone", endpoint_id: "ash" }, target_work: null, kind: "human_material", purpose: "select photo", context: { goal: "goal", confirmed_decisions: [], increment: "new", expected_output: "photo", uncertain: [], missing: [], refs: [asset], provenance: [] }, expected_output: "photo", expires_at: 1000 };
const result: ResultEnvelope = { version: 1, request_id: "request", reply_to: "request", result_version: 1, source, target_work: null, summary: "selected", assets: [asset], missing: [], error_code: null, observed_at: 100 };
const reply: MaterialReply = { kind: "human_answer", version: 1, client_id: "answer", request_id: "request", pending_id: "pending", question_version: 1, source, expires_at: 1000, result };
function invalid(fn: () => unknown, code = "invalid") {
    assert.throws(fn, (e: unknown) => e instanceof MaterialProtocolError && e.code === code);
}
test("fixed operations and recursive keys reject identities, tokens and native method tunnels", () => {
    assert.deepEqual(parseMaterialEnvelope("submit", request), request);
    for (const patch of [{ principal: "owner" }, { owner: "owner" }, { token: "secret" }, { method: "thread/start" }, { capability: "all" }])
        invalid(() => parseCollaborationRequest({ ...request, ...patch }));
    invalid(() => parseCollaborationRequest({ ...request, context: { ...request.context, principal_id: "owner" } }));
    invalid(() => parseCollaborationRequest({ ...request, source: { kind: "work", work: { ...work, owner: "owner" } } }));
    invalid(() => parseAssetRef({ ...asset, provenance: [{ source: { kind: "user_selection", native_method: "read" }, observed_at: 0, producer: "user", model_summary: false, missing: [] }] }));
    invalid(() => parseMaterialEnvelope("native" as never, {}));
    invalid(() => parseAssetEnvelope("workspace.read" as never, {}));
});
test("work structural association is complete and exact, without granting native authority", () => {
    invalid(() => parseCollaborationRequest({ ...request, return_to: { kind: "work", work: { ...work, native_id: "other" } } }));
    invalid(() => parseCollaborationRequest({ ...request, kind: "material_to_work" }));
    const r = { ...request, kind: "material_to_work" as const, target: { node_id: "desktop", endpoint_id: "codex" }, target_work: work };
    assert.deepEqual(parseCollaborationRequest(r), r);
    invalid(() => parseCollaborationRequest({ ...r, target_work: { ...work, node_id: "other" } }));
    invalid(() => parseCollaborationRequest({ ...request, target: { ...request.target, capability_id: "phone.photo" } }));
    assert.equal(parseCollaborationRequest({ ...request, kind: "agent_task", target: { ...request.target, capability_id: "phone.photo_select" } }).kind, "agent_task");
    invalid(() => parseCollaborationRequest({ ...request, kind: "agent_task", target: { ...request.target, capability_id: "thread/start" } }));
});
test("reply binds question version expiry and work; result binds original request", () => {
    assertMaterialReplyBinding(reply, request, question, 999);
    invalid(() => assertMaterialReplyBinding(reply, request, { ...question, question_version: 2 }, 100), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, { ...request, source: { kind: "work", work: { ...work, native_id: "other" } }, return_to: { kind: "work", work: { ...work, native_id: "other" } } }, question, 100), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, request, question, 1000), "expired");
    assertMaterialResultBinding(result, request);
    invalid(() => assertMaterialResultBinding({ ...result, source: { kind: "work", work: { ...work, endpoint_id: "other" } } }, request), "conflict");
    invalid(() => assertMaterialResultBinding({ ...result, request_id: "other" }, request), "conflict");
});
test("versions hash MIME and immutable asset fields are strict", () => {
    for (const patch of [{ version: 0 }, { sha256: "A".repeat(64) }, { byte_length: L.file_bytes + 1 }, { received: true }, { filename: "/tmp/file" }])
        invalid(() => parseAssetRef({ ...asset, ...patch }), "byte_length" in patch ? "too_large" : "invalid");
    invalid(() => parseCollaborationRequest({ ...request, version: 2 }));
    const reversed = Object.fromEntries(Object.entries(request).reverse()) as unknown as CollaborationRequest;
    assert.equal(materialPayloadHash(request), materialPayloadHash(reversed));
    assert.notEqual(materialPayloadHash(request), materialPayloadHash({ ...request, context: { ...request.context, goal: "é" } }));
    assert.notEqual(materialPayloadHash({ ...request, context: { ...request.context, goal: "é" } }), materialPayloadHash({ ...request, context: { ...request.context, goal: "é" } }));
    assert.notEqual(materialPayloadHash(request), materialPayloadHash({ ...request, context: { ...request.context, refs: [{ ...asset, version: 2 }] } }));
    assert.equal(materialBytesHash(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("UTF8 context totals and file/ref/request budgets include nested provenance", () => {
    invalid(() => parseCollaborationRequest({ ...request, context: { ...request.context, confirmed_decisions: Array(5).fill("x".repeat(4096)) } }), "too_large");
    invalid(() => parseCollaborationRequest({ ...request, context: { ...request.context, refs: Array.from({ length: 5 }, (_, i) => ({ ...asset, asset_id: String(i) })) } }), "too_large");
    invalid(() => parseCollaborationRequest({ ...request, context: { ...request.context, refs: Array.from({ length: 3 }, (_, i) => ({ ...asset, asset_id: String(i), byte_length: L.file_bytes })) } }), "too_large");
    invalid(() => parseAssetRef({ ...asset, display_name: "é".repeat(129) }), "too_large");
    invalid(() => assertMaterialEnvelopeSize({ x: "x".repeat(L.envelope_bytes) }), "too_large");
});
test("40KiB raw chunks fit encoded gateway JSON; oversized and noncanonical base64 fail", () => {
    const chunk = { version: 1 as const, transfer_id: "transfer", request_id: "request", asset_id: "asset", asset_version: 1, chunk_index: 0, data_base64: Buffer.alloc(L.chunk_bytes).toString("base64") };
    assert.deepEqual(parseAssetEnvelope("put_chunk", chunk), chunk);
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < L.envelope_bytes);
    invalid(() => parseAssetEnvelope("put_chunk", { ...chunk, data_base64: Buffer.alloc(48 * 1024).toString("base64") }), "too_large");
    invalid(() => parseAssetEnvelope("put_chunk", { ...chunk, data_base64: "Zh==" }));
    invalid(() => parseAssetEnvelope("put_chunk", { ...chunk, data_base64: "" }));
    invalid(() => parseAssetEnvelope("put_chunk", { ...chunk, principal_id: "owner" }));
});
test("link_only can never carry byte hash receipt or implicit downloaded state", () => {
    const link = { kind: "link_only", url: "https://example.com/photo", description: "reference", observed_at: 1, provenance: [] };
    assert.deepEqual(parseLinkRef(link), link);
    for (const patch of [{ byte_length: 3 }, { sha256: asset.sha256 }, { received: true }, { path: "/tmp/a" }])
        invalid(() => parseLinkRef({ ...link, ...patch }));
    invalid(() => parseLinkRef({ ...link, url: "file:///tmp/a" }));
    invalid(() => parseLinkRef({ ...link, url: "https://user:password@example.com/" }));
});
test("result facts separate registration, commit, claim and unverified business", () => {
    const fact = { version: 1, request_id: "request", state: "result_available", result, question, claimed_result_version: null, receipts: [], business_state: "unverified", observed_at: 100 };
    assert.deepEqual(toMaterialResultDto(fact), fact);
    invalid(() => toMaterialResultDto({ ...fact, claimed_result_version: 2 }));
    invalid(() => toMaterialResultDto({ ...fact, business_state: "done" }));
    invalid(() => toMaterialResultDto({ ...fact, state: "waiting_owner" }));
    invalid(() => toMaterialResultDto({ ...fact, principal_id: "secret" }));
    invalid(() => toMaterialResultDto({ ...fact, result: { ...result, local_path: "/secret" } }));
    const t = { version: 1, transfer_id: "t", request_id: "request", asset_id: "asset", asset_version: 1, state: "offered", received_chunks: [], receipt: null, expires_at: 1000 };
    assert.deepEqual(toMaterialTransferDto(t), t);
    invalid(() => toMaterialTransferDto({ ...t, state: "committed" }));
    invalid(() => toMaterialTransferDto({ ...t, received_chunks: [0] }));
    invalid(() => toMaterialTransferDto({ ...t, owner_epoch: "private" }));
});
test("unknown never starts another business operation and waiting_owner returns immediately", () => {
    assert.equal(canTransitionMaterialRequest("unknown", "running"), false);
    assert.equal(canTransitionMaterialRequest("unknown", "waiting_owner"), false);
    assert.equal(canTransitionMaterialTransfer("unknown", "receiving"), false);
    assert.deepEqual(materialAwaitPolicy("waiting_owner", 20000), { wait_ms: 0, next: "query_next_turn", cancels_execution: false });
    assert.equal(materialAwaitPolicy("running", 20000).wait_ms, 20000);
    invalid(() => materialAwaitPolicy("running", 20001), "too_large");
});
test("human result null target permits structurally valid receipt; destination proof belongs to service", () => {
    const receipt = { version: 1, receipt_id: "received", transfer_id: "transfer", request_id: "request", asset_id: asset.asset_id, asset_version: asset.version, sha256: asset.sha256, byte_length: asset.byte_length, destination: source, received_at: 100 };
    const fact = { version: 1, request_id: "request", state: "result_available", result, question, claimed_result_version: null, receipts: [receipt], business_state: "unverified", observed_at: 100 };
    assert.deepEqual(toMaterialResultDto(fact).receipts[0]?.destination, source);
    for (const patch of [{ request_id: "other" }, { asset_version: 2 }, { sha256: "b".repeat(64) }, { byte_length: 4 }])
        invalid(() => toMaterialResultDto({ ...fact, receipts: [{ ...receipt, ...patch }] }));
});
test("result producing work cannot override request node endpoint or exact original work", () => {
    const agent: CollaborationRequest = { ...request, kind: "agent_task", target: { ...request.target, capability_id: "phone.photo_select" } };
    const producingWork = { ...work, node_id: agent.target.node_id, endpoint_id: agent.target.endpoint_id, native_id: "agent-output" };
    assertMaterialResultBinding({ ...result, target_work: producingWork }, agent, producingWork);
    invalid(() => assertMaterialResultBinding({ ...result, target_work: producingWork }, request, producingWork), "conflict");
    for (const patch of [{ node_id: "foreign" }, { endpoint_id: "foreign" }]) {
        const foreignWork = { ...producingWork, ...patch };
        invalid(() => assertMaterialResultBinding({ ...result, target_work: foreignWork }, agent, foreignWork), "conflict");
        invalid(() => assertMaterialResultBinding({ ...result, target_work: foreignWork }, request, foreignWork), "conflict");
    }
    const material: CollaborationRequest = { ...request, kind: "material_to_work", target: { node_id: work.node_id, endpoint_id: work.endpoint_id }, target_work: work };
    assertMaterialResultBinding({ ...result, target_work: work }, material);
    const other = { ...work, native_id: "different-existing-work" };
    invalid(() => assertMaterialResultBinding({ ...result, target_work: other }, material, other), "conflict");
    invalid(() => assertMaterialResultBinding({ ...result, target_work: null }, material, null), "conflict");
});
test("node and work endpoints are exact identities and legacy drafts have no fallback", () => {
    assert.deepEqual(parseMaterialEndpoint(phone), phone);
    assert.deepEqual(parseMaterialEndpoint(source), source);
    assert.equal(sameMaterialEndpoint(phone, { ...phone, endpoint_id: "other" }), false);
    assert.equal(sameMaterialEndpoint(phone, { kind: "work", work: { ...work, node_id: phone.node_id, endpoint_id: phone.endpoint_id } }), false);
    for (const value of [{ ...phone, work }, { ...source, node_id: "desktop" }, { ...phone, principal_id: "owner" }, { kind: "node", node_id: "phone" }, { kind: "conversation", native_id: "fake" }])
        invalid(() => parseMaterialEndpoint(value));
    const { source: removed, ...oldRequest } = request;
    invalid(() => parseCollaborationRequest({ ...oldRequest, source_work: work, return_to: work }));
    invalid(() => parseCollaborationRequest({ ...request, source_work: work }));
    for (const kind of ["human_material", "agent_task"] as const)
        invalid(() => parseCollaborationRequest({ ...request, kind, source: phone, return_to: phone, target: { ...request.target, ...(kind === "agent_task" ? { capability_id: "phone.photo" } : {}) } }));
});
test("phone node material request goes to exact existing work and result returns to node", () => {
    const req: CollaborationRequest = { ...request, kind: "material_to_work", source: phone, return_to: phone, target: { node_id: work.node_id, endpoint_id: work.endpoint_id }, target_work: work };
    assert.deepEqual(parseCollaborationRequest(req), req);
    invalid(() => parseCollaborationRequest({ ...req, return_to: { ...phone, endpoint_id: "other" } }));
    const output: ResultEnvelope = { ...result, source: phone, target_work: work };
    const answer: MaterialReply = { kind: "work_result", version: 1, client_id: "work-reply", request_id: req.request_id, source: phone, expires_at: req.expires_at, result: output };
    assert.deepEqual(parseMaterialReply(answer), answer);
    assertMaterialReplyBinding(answer, req, null, 999);
    const inputOffer = { version: 1 as const, request_id: req.request_id, asset, source: phone, destination: source, expires_at: 1000 };
    const outputOffer = { ...inputOffer, source, destination: phone };
    assert.deepEqual(parseAssetEnvelope("offer", inputOffer), inputOffer);
    assert.deepEqual(parseAssetEnvelope("offer", outputOffer), outputOffer);
    const receipt = { version: 1 as const, receipt_id: "receipt", transfer_id: "transfer", request_id: req.request_id, asset_id: asset.asset_id, asset_version: asset.version, sha256: asset.sha256, byte_length: asset.byte_length, destination: phone, received_at: 100 };
    assertAssetReceiptBinding(receipt, outputOffer);
    const fact: MaterialResultFact = { version: 1, request_id: req.request_id, state: "result_available", result: output, question: null, claimed_result_version: 1, receipts: [receipt], business_state: "unverified", observed_at: 100 };
    assertMaterialFactBinding(fact, req, null);
    invalid(() => assertMaterialFactBinding({ ...fact, receipts: [{ ...receipt, destination: source }] }, req, null), "conflict");
    invalid(() => assertAssetReceiptBinding({ ...receipt, destination: source }, outputOffer), "conflict");
    invalid(() => parseMaterialReply({ ...answer, pending_id: "pending", question_version: 1 }));
    invalid(() => assertMaterialReplyBinding(answer, request, question, 100), "conflict");
});
test("original work human question survives answer and later claim with node actor binding", () => {
    const waiting: MaterialResultFact = { version: 1, request_id: request.request_id, state: "waiting_owner", result: null, question, claimed_result_version: null, receipts: [], business_state: "unverified", observed_at: 10 };
    assertMaterialFactBinding(waiting, request, question);
    assertMaterialReplyBinding(reply, request, question, 999);
    const available: MaterialResultFact = { ...waiting, state: "result_available", result, claimed_result_version: result.result_version };
    assertMaterialFactBinding(available, request, question);
    assertMaterialFactBinding({ ...available, state: "expired" }, request, question);
    invalid(() => assertMaterialFactBinding({ ...available, question: null }, request, question), "conflict");
    invalid(() => assertMaterialFactBinding({ ...available, question: { ...question, question_version: 2 } }, request, question), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, request, null, 100), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, request, { ...question, pending_id: "other" }, 100), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, request, { ...question, expires_at: 1001 }, 100), "conflict");
    invalid(() => assertMaterialReplyBinding(reply, { ...request, kind: "agent_task", target: { ...request.target, capability_id: "phone.photo" } }, question, 100), "conflict");
    const actor: MaterialTrustedContext = { principal_id: "trusted-phone-user", pairing_id: "pair", grant_revision: "revision", authorization_epoch: "epoch", source_binding: phone, expires_at: 1000 };
    const discovery: MaterialAuthorizationScope = { kind: "discovery", action: "discover", target: request.target };
    const scope: MaterialAuthorizationScope = { kind: "request", action: "reply", request_id: request.request_id, source, return_to: source, target: phone, transfer: null };
    const auth: MaterialAuthorization = { before: async (context) => ({ ...context }), after: async () => {
        }, current: (_lease, _scope) => {
        } };
    auth.current(actor, scope);
    auth.current(actor, discovery);
    invalid(() => assertMaterialReplyBinding({ ...reply, source: phone, result: { ...result, source: phone } }, request, question, 100), "conflict");
});
test("strict question reply receipt and fact nested keys reject obsolete or forged shapes", () => {
    for (const patch of [{ owner: "secret" }, { question_version: 0 }, { expires_at: 0 }])
        invalid(() => parseMaterialQuestion({ ...question, ...patch }));
    const { pending_id, question_version, ...base } = reply;
    invalid(() => parseMaterialReply(base));
    invalid(() => parseMaterialReply({ ...reply, kind: "agent_result" }));
    invalid(() => parseMaterialReply({ ...reply, source_work: work }));
    invalid(() => toMaterialResultDto({ version: 1, request_id: "request", state: "waiting_owner", result: null, question: null, claimed_result_version: null, receipts: [], business_state: "unverified", observed_at: 0 }));
    invalid(() => toMaterialResultDto({ version: 1, request_id: "request", state: "unknown", result: null, question: { ...question, grant_revision: "secret" }, claimed_result_version: null, receipts: [], business_state: "unverified", observed_at: 0 }));
    const receipt = { version: 1, receipt_id: "receipt", transfer_id: "transfer", request_id: "request", asset_id: asset.asset_id, asset_version: 1, sha256: asset.sha256, byte_length: 3, destination: source, received_at: 100 };
    invalid(() => parseAssetReceipt({ ...receipt, target_work: work }));
    invalid(() => parseAssetReceipt({ ...receipt, destination: { ...phone, token: "secret" } }));
    const { destination, ...old } = receipt;
    invalid(() => parseAssetReceipt({ ...old, target_work: work }));
    invalid(() => parseAssetEnvelope("offer", { version: 1, request_id: "request", asset, source_work: work, target_work: work, expires_at: 1000 }));
});
test("authorization types require exact transfer direction and synchronous final fence", async () => {
    const lease: MaterialTrustedContext = { principal_id: "principal", pairing_id: "pair", grant_revision: "revision", authorization_epoch: "epoch", source_binding: phone, expires_at: 1000 };
    const scope: MaterialAuthorizationScope = { kind: "request", action: "commit", request_id: "request", source, return_to: source, target: phone, transfer: { asset_id: asset.asset_id, asset_version: asset.version, source: phone, destination: source } };
    const fences: string[] = [];
    const auth: MaterialAuthorization = { before: async (context) => {
            fences.push("before");
            return { ...context };
        }, after: async () => {
            fences.push("after");
        }, current: () => {
            fences.push("current");
        } };
    const captured = await auth.before(lease, scope);
    await auth.after(captured, scope);
    auth.current(captured, scope);
    assert.deepEqual(fences, ["before", "after", "current"]);
    // @ts-expect-error Asset scopes cannot use null to mean every asset.
    const wideAsset: MaterialAuthorizationScope = { kind: "request", action: "commit", request_id: "request", source, return_to: source, target: phone, transfer: null };
    // @ts-expect-error Request operations cannot smuggle an asset direction.
    const misplaced: MaterialAuthorizationScope = { kind: "request", action: "get_result", request_id: "request", source, return_to: source, target: phone, transfer: { asset_id: "asset", asset_version: 1, source: phone, destination: source } };
    void wideAsset;
    void misplaced;
});

test("authorization current type rejects Promise returning final fences", () => {
    const current: MaterialAuthorization["current"] = () => undefined;
    // @ts-expect-error A Promise-returning current fence can leave an authorization gap.
    const asyncCurrent: MaterialAuthorization["current"] = async () => undefined;
    void current;
    void asyncCurrent;
});
