import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { CollaborationCreateError, type CreateErrorCode, type CreateProjectScope, type CreateTarget, type CreateWorkRequest, type CreateWorkFact, type CreateStageFact, type CreateStage, type CreateReceipt, type CreateReconciliationProvenance, type CreateLease, type CreateProjectsLease, type CreateReadContext, type CreatePurpose } from "./create-types";
import type { WorkRef } from "./types";

export type CreateOperation = "projects" | "apply" | "query" | "reconcile";
export const CREATE_CAPABILITIES = { projects: "collaboration.create.projects", apply: "collaboration.create.apply", query: "collaboration.create.query", reconcile: "collaboration.create.reconcile" } as const;
export const CREATE_INPUT_MAX_BYTES = 64 * 1024;
export const CREATE_OUTPUT_MAX_BYTES = 1024 * 1024;
export const CREATE_TITLE_MAX_BYTES = 256;
export const CREATE_DEADLINE_MS = 30_000;
export type CreateEnvelope =
  | (CreateProjectScope & { version: 1; authorization_revision: string })
  | { version: 1; request: CreateWorkRequest; expected_connector_epoch: string }
  | { version: 1; target: CreateTarget; authorization_revision: string; operation_id: string };
export type CoreCreateEnvelope = CreateEnvelope & { device_id: string };
export type CreateStageDto = Omit<CreateStageFact, "owner_epoch">;
export type CreateFactDto = Omit<CreateWorkFact, "principal_id" | "payload_hash" | "create" | "name" | "first_input"> & { create: CreateStageDto; name: CreateStageDto; first_input: CreateStageDto };
export interface CreateProjectsDto {
  target: CreateProjectScope; authorization_revision: string; connector_epoch: string; native_interface_version: string;
  projects: { project_id: string; cwd: string }[]; complete: true;
}
export type CreateResponse = CreateProjectsDto | { fact: CreateFactDto | null };
const invalid = (): never => { throw new CollaborationCreateError("invalid"); };
export function createObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid();
  return value as Record<string, unknown>;
}
export function createId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) invalid(); return value as string; }
/** Node/endpoint identities include the complete gateway base64url alphabet. */
export function createIdentity(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) invalid(); return value as string; }
function revision(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value as string; }
function integer(value: unknown, min = 0): number { if (!Number.isSafeInteger(value) || Number(value) < min) invalid(); return Number(value); }
function size(value: unknown, max: number): void { let encoded: string | undefined; try { encoded = JSON.stringify(value); } catch { invalid(); } if (!encoded!) invalid(); if (Buffer.byteLength(encoded!) > max) throw new CollaborationCreateError("too_large"); }
/** Same lexical normalization as exact_cwd grants; Unicode and case remain exact. */
export function normalizeCreateCwd(value: unknown): string { if (typeof value !== "string" || !value.length || value.length > 4096 || !isAbsolute(value) || /[\u0000-\u001f]/.test(value)) invalid(); return resolve(value as string); }
/** Native source evidence must match every grant coordinate, not merely remain stable across reads. */
export function assertCreateSourceScope(authorizedScope: Readonly<CreateProjectScope>, source: Readonly<CreateProjectScope>): void {
  if (createIdentity(source.node_id) !== createIdentity(authorizedScope.node_id) || createIdentity(source.endpoint_id) !== createIdentity(authorizedScope.endpoint_id) || normalizeCreateCwd(source.cwd) !== normalizeCreateCwd(authorizedScope.cwd)) throw new CollaborationCreateError("permission_denied");
}
/** Trusted internal factory. The lease must come from authorization, never from body fields. */
export function createLeaseReadContext(lease: CreateLease | CreateProjectsLease, deadline: number, purpose: CreatePurpose, signal?: AbortSignal): CreateReadContext {
  integer(deadline, 1);
  const source = "target" in lease ? lease.target : lease.scope;
  assertCreateSourceScope(lease.authorized_scope, source);
  const authorized_scope = Object.freeze({ node_id: createIdentity(lease.authorized_scope.node_id), endpoint_id: createIdentity(lease.authorized_scope.endpoint_id), cwd: normalizeCreateCwd(lease.authorized_scope.cwd) });
  return Object.freeze({ authorized_scope, deadline, ...(signal ? { signal } : {}), authorize: async () => {
    assertCreateSourceScope(authorized_scope, lease.authorized_scope);
    assertCreateSourceScope(authorized_scope, "target" in lease ? lease.target : lease.scope);
    const allowed = "target" in lease ? await lease.authorize(purpose) : await lease.authorize();
    // Async revoke/target switching cannot carry source proof into an old response.
    assertCreateSourceScope(authorized_scope, lease.authorized_scope);
    assertCreateSourceScope(authorized_scope, "target" in lease ? lease.target : lease.scope);
    return allowed === true;
  } });
}
export function parseCreateTarget(value: unknown): CreateTarget { const v = createObject(value, ["node_id", "endpoint_id", "project_id", "cwd"]); return { node_id: createIdentity(v.node_id), endpoint_id: createIdentity(v.endpoint_id), project_id: createId(v.project_id), cwd: normalizeCreateCwd(v.cwd) }; }
export function sameCreateTarget(a: CreateTarget, b: CreateTarget): boolean { return a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.project_id === b.project_id && a.cwd === b.cwd; }
function work(value: unknown, target: CreateTarget): WorkRef { const v = createObject(value, ["node_id", "endpoint_id", "kind", "native_id"]); if (v.kind !== "conversation" || v.node_id !== target.node_id || v.endpoint_id !== target.endpoint_id) invalid(); return { node_id: createIdentity(v.node_id), endpoint_id: createIdentity(v.endpoint_id), kind: "conversation", native_id: createId(v.native_id) }; }
const sameWork = (a: WorkRef, b: WorkRef) => a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id;
export function parseCreateWorkRequest(value: unknown): CreateWorkRequest {
  size(value, CREATE_INPUT_MAX_BYTES);
  const v = createObject(value, ["version", "request_id", "operation_id", "authorization_revision", "target", "title", "input", "expires_at"]), i = createObject(v.input, ["text"]);
  if (v.version !== 1 || typeof v.title !== "string" || !v.title.trim().length || /[\u0000-\u001f]/.test(v.title) || typeof i.text !== "string" || !i.text.length) invalid();
  if (Buffer.byteLength(v.title as string) > CREATE_TITLE_MAX_BYTES) throw new CollaborationCreateError("too_large");
  return { version: 1, request_id: createId(v.request_id), operation_id: createId(v.operation_id), authorization_revision: revision(v.authorization_revision), target: parseCreateTarget(v.target), title: v.title as string, input: { text: i.text as string }, expires_at: integer(v.expires_at, 1) };
}
/** Fixed order and domain separation; exact text/title, normalized target, revision and expiry are bound. */
export function createPayloadHash(value: CreateWorkRequest): string { const r = parseCreateWorkRequest(value); return createHash("sha256").update(JSON.stringify(["collaboration.create.v1", r.version, r.request_id, r.operation_id, r.authorization_revision, r.target.node_id, r.target.endpoint_id, r.target.project_id, r.target.cwd, r.title, r.input.text, r.expires_at])).digest("hex"); }
export function parseCreateEnvelope(operation: CreateOperation, value: unknown, core = false): CreateEnvelope | CoreCreateEnvelope {
  size(value, CREATE_INPUT_MAX_BYTES);
  if (!Object.hasOwn(CREATE_CAPABILITIES, operation)) invalid();
  const keys = ["version", ...(core ? ["device_id"] : []), ...(operation === "apply" ? ["request", "expected_connector_epoch"] : operation === "projects" ? ["node_id", "endpoint_id", "authorization_revision", "cwd"] : ["target", "authorization_revision", "operation_id"])];
  const v = createObject(value, keys); if (v.version !== 1) invalid();
  let result: CreateEnvelope;
  if (operation === "apply") result = { version: 1, request: parseCreateWorkRequest(v.request), expected_connector_epoch: createId(v.expected_connector_epoch) };
  else if (operation === "projects") result = { version: 1, node_id: createIdentity(v.node_id), endpoint_id: createIdentity(v.endpoint_id), authorization_revision: revision(v.authorization_revision), cwd: normalizeCreateCwd(v.cwd) };
  else result = { version: 1, target: parseCreateTarget(v.target), authorization_revision: revision(v.authorization_revision), operation_id: createId(v.operation_id) };
  if (!core) return result;
  const device = createId(v.device_id); if (!/^device:[A-Za-z0-9_-]{1,249}$/.test(device)) invalid(); return { ...result, device_id: device };
}
const codes: readonly CreateErrorCode[] = ["invalid", "too_large", "permission_denied", "expired", "conflict", "busy", "storage_failure", "unsupported", "offline", "stale_precondition", "result_unknown"];
function errorCode(value: unknown): CreateErrorCode | null { if (value === null) return null; if (!codes.includes(value as CreateErrorCode)) invalid(); return value as CreateErrorCode; }
function receipt(value: unknown, stage: CreateStage, target: CreateTarget, expectedWork: WorkRef | null): CreateReceipt {
  const v = createObject(value, ["stage", "accepted_by", "work", ...(stage === "first_input" ? ["native_turn_id", "native_message_id", "correlation"] : [])]);
  const w = work(v.work, target); if (v.stage !== stage || v.accepted_by !== "native" || !expectedWork || !sameWork(w, expectedWork)) invalid();
  if (stage !== "first_input") return { stage, accepted_by: "native", work: w };
  if (v.correlation !== "stable_message_id" && v.correlation !== "uncertain") invalid();
  const message = v.native_message_id === null ? null : createId(v.native_message_id); if (v.correlation === "stable_message_id" && message === null) invalid();
  return { stage, accepted_by: "native", work: w, native_turn_id: createId(v.native_turn_id), native_message_id: message, correlation: v.correlation as "stable_message_id" | "uncertain" };
}
function phase(value: unknown, stage: CreateStage, target: CreateTarget, w: WorkRef | null): CreateStageDto {
  const v = createObject(value, ["status", "attempt_id", "connector_epoch", "native_interface_version", "started_at", "observed_at", "receipt", "error_code"]);
  if (!["not_started", "invoking", "accepted", "rejected", "unknown"].includes(String(v.status))) invalid();
  const idle = v.status === "not_started";
  for (const key of ["attempt_id", "connector_epoch", "native_interface_version"]) { if (idle ? v[key] !== null : v[key] === null) invalid(); if (v[key] !== null) createId(v[key]); }
  if (idle ? v.started_at !== null : v.started_at === null) invalid(); if (v.started_at !== null && integer(v.started_at) > integer(v.observed_at)) invalid();
  const code = errorCode(v.error_code);
  if ((v.status === "accepted") !== (v.receipt !== null) || ((idle || v.status === "invoking" || v.status === "accepted") && code !== null) || (v.status === "rejected" && (code === null || code === "result_unknown")) || (v.status === "unknown" && code !== "result_unknown")) invalid();
  return { status: v.status as CreateStageDto["status"], attempt_id: v.attempt_id as string | null, connector_epoch: v.connector_epoch as string | null, native_interface_version: v.native_interface_version as string | null, started_at: v.started_at as number | null, observed_at: integer(v.observed_at), receipt: v.receipt === null ? null : receipt(v.receipt, stage, target, w), error_code: code };
}
function provenance(value: unknown, fact: CreateFactDto): CreateReconciliationProvenance {
  const v = createObject(value, ["source", "lookup_scope", "work", "pages_observed", "history_exhausted", "connector_epoch", "native_interface_version", "observed_at", "native_client_message_id", "native_turn_id", "native_message_id"]);
  const r = fact.first_input.receipt;
  if (v.source !== "codex.saved_history" || v.lookup_scope !== "bounded_history_pages" || integer(v.pages_observed, 1) > 4 || typeof v.history_exhausted !== "boolean" || typeof v.observed_at !== "string" || !Number.isFinite(Date.parse(v.observed_at)) || !fact.work || !sameWork(work(v.work, fact.target), fact.work) || !r || r.stage !== "first_input" || r.correlation !== "stable_message_id" || v.native_client_message_id !== fact.native_client_message_id || v.native_turn_id !== r.native_turn_id || v.native_message_id !== r.native_message_id || v.native_interface_version !== fact.first_input.native_interface_version) invalid();
  for (const key of ["connector_epoch", "native_interface_version", "native_client_message_id", "native_turn_id", "native_message_id"]) createId(v[key]);
  return structuredClone(v) as unknown as CreateReconciliationProvenance;
}
export function validateCreateResponse(operation: CreateOperation, value: unknown, envelope: CreateEnvelope): CreateResponse {
  size(value, CREATE_OUTPUT_MAX_BYTES);
  if (operation === "projects") {
    if (!("cwd" in envelope)) invalid();
    const e = envelope as CreateProjectScope & { authorization_revision: string }, v = createObject(value, ["target", "authorization_revision", "connector_epoch", "native_interface_version", "projects", "complete"]), t = createObject(v.target, ["node_id", "endpoint_id", "cwd"]);
    if (t.node_id !== e.node_id || t.endpoint_id !== e.endpoint_id || t.cwd !== e.cwd || v.authorization_revision !== e.authorization_revision || v.complete !== true || !Array.isArray(v.projects) || v.projects.length > 1000) invalid();
    const ids = new Set<string>(); const projects = (v.projects as unknown[]).map(p => { const row = createObject(p, ["project_id", "cwd"]), id = createId(row.project_id); if (row.cwd !== e.cwd || ids.has(id)) invalid(); ids.add(id); return { project_id: id, cwd: e.cwd }; });
    return { target: { node_id: e.node_id, endpoint_id: e.endpoint_id, cwd: e.cwd }, authorization_revision: e.authorization_revision, connector_epoch: createId(v.connector_epoch), native_interface_version: createId(v.native_interface_version), projects, complete: true };
  }
  if (operation !== "apply" && operation !== "query" && operation !== "reconcile") invalid();
  const v = createObject(value, ["fact"]); if (v.fact === null) { if (operation === "apply") invalid(); return { fact: null }; }
  const e = "request" in envelope ? envelope.request : "target" in envelope ? envelope : invalid();
  const f = createObject(v.fact, ["version", "request_id", "operation_id", "authorization_revision", "target", "expires_at", "status", "create", "name", "first_input", "work", "native_client_message_id", "reconciliation", "error_code", "observed_at"]), target = parseCreateTarget(f.target);
  if (f.version !== 1 || f.status !== "recorded" || !sameCreateTarget(target, e.target) || f.authorization_revision !== e.authorization_revision || f.operation_id !== e.operation_id || ("request" in envelope && (f.request_id !== envelope.request.request_id || f.expires_at !== envelope.request.expires_at))) invalid();
  // Responses must already be canonical; lexical aliases cannot hide target switching.
  if ((f.target as Record<string, unknown>).cwd !== target.cwd) invalid();
  const w = f.work === null ? null : work(f.work, target);
  const c = phase(f.create, "create", target, w), n = phase(f.name, "name", target, w), i = phase(f.first_input, "first_input", target, w);
  if ((c.status === "accepted") !== (w !== null) || (c.status !== "accepted" && n.status !== "not_started") || (n.status !== "accepted" && i.status !== "not_started")) invalid();
  const client = f.native_client_message_id === null ? null : createId(f.native_client_message_id);
  if ((i.status !== "not_started") !== (client !== null)) invalid();
  const observed = integer(f.observed_at); if ([c, n, i].some(p => p.observed_at > observed)) invalid();
  const fact: CreateFactDto = { version: 1, request_id: createId(f.request_id), operation_id: createId(f.operation_id), authorization_revision: revision(f.authorization_revision), target, expires_at: integer(f.expires_at, 1), status: "recorded", create: c, name: n, first_input: i, work: w, native_client_message_id: client, reconciliation: null, error_code: errorCode(f.error_code), observed_at: observed };
  if (f.reconciliation !== null) fact.reconciliation = provenance(f.reconciliation, fact);
  return { fact };
}
/** Select every public field, including nested receipts; database extras never survive. */
export function toCreateFactDto(f: CreateWorkFact): CreateFactDto {
  const stage = (p: CreateStageFact): CreateStageDto => ({ status: p.status, attempt_id: p.attempt_id, connector_epoch: p.connector_epoch, native_interface_version: p.native_interface_version, started_at: p.started_at, observed_at: p.observed_at, receipt: p.receipt && receipt(p.receipt, p.receipt.stage, f.target, f.work), error_code: p.error_code });
  const dto: CreateFactDto = { version: 1, request_id: f.request_id, operation_id: f.operation_id, authorization_revision: f.authorization_revision, target: { node_id: f.target.node_id, endpoint_id: f.target.endpoint_id, project_id: f.target.project_id, cwd: f.target.cwd }, expires_at: f.expires_at, status: "recorded", create: stage(f.create), name: stage(f.name), first_input: stage(f.first_input), work: f.work && { node_id: f.work.node_id, endpoint_id: f.work.endpoint_id, kind: f.work.kind, native_id: f.work.native_id }, native_client_message_id: f.native_client_message_id, reconciliation: null, error_code: f.error_code, observed_at: f.observed_at };
  if (f.reconciliation) dto.reconciliation = provenance(f.reconciliation, dto);
  return (validateCreateResponse("query", { fact: dto }, { version: 1, target: dto.target, authorization_revision: dto.authorization_revision, operation_id: dto.operation_id }) as { fact: CreateFactDto }).fact;
}

/** Sole manifest parser. Scope is the current owner grant, never derived from project request input. */
export function parseCreateManifest(value: unknown, endpointId?: string): import("./create-types").CreateManifestDto {
  size(value, CREATE_OUTPUT_MAX_BYTES);
  const v = createObject(value, ["version", "endpoint_id", "grant_state", "authorization_revision", "actions", "scope", "limitations"]);
  const endpoint = createIdentity(v.endpoint_id);
  if (v.version !== 1 || endpointId !== undefined && endpoint !== endpointId || !["ready", "grant_required", "invalid_configuration"].includes(String(v.grant_state)) || !Array.isArray(v.actions)) invalid();
  const actions = v.actions as unknown[];
  const rev = v.authorization_revision === null ? null : revision(v.authorization_revision);
  const expected = ["projects", "apply", "query", "reconcile"];
  let scope: { kind: "exact_cwd"; cwd: string } | null = null;
  if (v.scope !== null) {
    const s = createObject(v.scope, ["kind", "cwd"]);
    if (s.kind !== "exact_cwd" || normalizeCreateCwd(s.cwd) !== s.cwd) invalid();
    scope = { kind: "exact_cwd", cwd: s.cwd as string };
  }
  if (v.grant_state !== "ready" && (rev !== null || scope !== null || actions.length !== 0) || v.grant_state === "ready" && (rev === null || scope === null) || scope === null && actions.length !== 0 || scope !== null && (v.grant_state !== "ready" || JSON.stringify(actions) !== JSON.stringify(expected))) invalid();
  const l = createObject(v.limitations, ["native_readiness", "cancel", "automatic_replay", "execution_completion"]);
  if (l.native_readiness !== "unknown" || l.cancel !== false || l.automatic_replay !== false || l.execution_completion !== "unknown") invalid();
  return { version: 1, endpoint_id: endpoint, grant_state: v.grant_state as "ready" | "grant_required" | "invalid_configuration", authorization_revision: rev, actions: scope ? expected as CreateOperation[] : [], scope,
    limitations: { native_readiness: "unknown", cancel: false, automatic_replay: false, execution_completion: "unknown" } };
}
export type { CreateManifestDto } from "./create-types";
