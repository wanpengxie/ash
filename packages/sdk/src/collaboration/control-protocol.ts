import type { MaterialInputSelection } from "./material-input-manifest";
import { MaterialProtocolError } from "./material-types";
import { parseMaterialInputSelection } from "./material-input-manifest";
import { CollaborationControlError, type ControlAction, type ControlRequest, type DeliveryFact } from "./control-types";
import type { WorkRef } from "./types";
import type { LiveSnapshot } from "./live-types";
export type ControlOperation = "state" | "apply" | "query" | "reconcile";
export const CONTROL_CAPABILITIES = { state: "collaboration.control.state", apply: "collaboration.control.apply", query: "collaboration.control.query", reconcile: "collaboration.control.reconcile" } as const;
export const CONTROL_INPUT_MAX_BYTES = 64 * 1024;
export const CONTROL_OUTPUT_MAX_BYTES = 1024 * 1024;
export const CONTROL_DEADLINE_MS = 30_000;
export interface ControlTarget { endpoint_id: string; work: WorkRef }
interface Base { version: 1; endpoint_id: string; authorization_revision: string; work: WorkRef }
export type ControlEnvelope = (Base & { action: ControlAction; operation_id?: never; request?: never; expected_connector_epoch?: never }) | (Base & { request: ControlRequest; expected_connector_epoch: string; action?: never; operation_id?: never }) | (Base & { action: ControlAction; operation_id: string; request?: never; expected_connector_epoch?: never });
export type CoreControlEnvelope = ControlEnvelope & { device_id: string };
export type ControlFactDto = Omit<DeliveryFact, "principal_id" | "payload_hash">;
export interface ControlLimitations { atomic_idle_start: false; cancel: false; queue: false; runtime_state: "unknown" | "observed"; subscription_state: "unknown" | "observed" }
export interface ControlStateDto { target: ControlTarget; authorization_revision: string; connector_epoch: string; native_interface_version: string; snapshot: LiveSnapshot; allowed_actions: ControlAction[]; limitations: ControlLimitations }
export interface ControlManifestDto { version: 1; endpoint_id: string; grant_state: "ready" | "grant_required" | "invalid_configuration"; authorization_revision: string | null; actions: ControlAction[]; limitations: ControlLimitations }
export type ControlResponse = ControlStateDto | { fact: ControlFactDto | null };
const invalid = (): never => { throw new CollaborationControlError("invalid"); };
export function controlMaterialError(error:unknown):CollaborationControlError { if(error instanceof CollaborationControlError)return error;const code=error instanceof MaterialProtocolError?error.code:'invalid';return new CollaborationControlError(code==='too_large'?'too_large':code==='unsupported'?'unsupported':code==='permission_denied'?'permission_denied':code==='expired'?'expired':'invalid'); }
export function parseControlMaterial(value:unknown):MaterialInputSelection {try{return parseMaterialInputSelection(value);}catch(error){throw controlMaterialError(error);}}
export function controlObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid();
  return value as Record<string, unknown>;
}
export function controlId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) invalid(); return value as string; }
/** Gateway SHA-256/base64url identities can begin with '_' or '-'. Other IDs
 * retain their existing request/native syntax. All bindings remain exact. */
export function controlIdentity(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) invalid(); return value as string; }
export function sameControlWork(a: WorkRef, b: WorkRef): boolean { return a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id; }
export function parseControlWork(value: unknown): WorkRef { const v = controlObject(value, ["node_id", "endpoint_id", "kind", "native_id"]); if (v.kind !== "conversation") invalid(); return { node_id: controlIdentity(v.node_id), endpoint_id: controlIdentity(v.endpoint_id), kind: "conversation", native_id: controlId(v.native_id) }; }
function action(value: unknown): ControlAction { if (value !== "send_input" && value !== "steer") invalid(); return value as ControlAction; }
function integer(value: unknown, min = 0): number { if (!Number.isSafeInteger(value) || Number(value) < min) invalid(); return Number(value); }
function size(value: unknown, max: number): void { let encoded: string; try { encoded = JSON.stringify(value); } catch { invalid(); } if (!encoded!) invalid(); if (Buffer.byteLength(encoded!) > max) throw new CollaborationControlError("too_large"); }
export function parseControlEnvelope(operation: ControlOperation, value: unknown, core = false): ControlEnvelope | CoreControlEnvelope {
  size(value, CONTROL_INPUT_MAX_BYTES);
  const keys = ["version", "endpoint_id", "authorization_revision", "work", ...(core ? ["device_id"] : []), ...(operation === "apply" ? ["request", "expected_connector_epoch"] : operation === "state" ? ["action"] : ["action", "operation_id"])];
  const v = controlObject(value, keys); if (v.version !== 1) invalid();
  const base = { version: 1 as const, endpoint_id: controlIdentity(v.endpoint_id), authorization_revision: controlId(v.authorization_revision), work: parseControlWork(v.work) };
  if (base.endpoint_id !== base.work.endpoint_id || !/^[a-f0-9]{64}$/.test(base.authorization_revision)) invalid();
  let result: ControlEnvelope;
  if (operation === "apply") {
    const r = controlObject(v.request, ["request_id", "operation_id", "work", "action", "input", "expected_turn_id", "expires_at"]), i = controlObject(r.input, ["text", "material"]);
    if (typeof i.text !== "string" || !i.text.length) invalid();
    const request: ControlRequest = { request_id: controlId(r.request_id), operation_id: controlId(r.operation_id), work: parseControlWork(r.work), action: action(r.action), input: { text: i.text as string, ...(i.material === undefined ? {} : { material: parseControlMaterial(i.material) }) }, expires_at: integer(r.expires_at, 1), ...(r.expected_turn_id === undefined ? {} : { expected_turn_id: controlId(r.expected_turn_id) }) };
    if (!sameControlWork(request.work, base.work) || (request.action === "steer" && !request.expected_turn_id) || (request.action === "send_input" && request.expected_turn_id !== undefined)) invalid();
    result = { ...base, request, expected_connector_epoch: controlId(v.expected_connector_epoch) };
  } else result = { ...base, action: action(v.action), ...(operation === "state" ? {} : { operation_id: controlId(v.operation_id) }) };
  if (core) { const device = controlId(v.device_id); if (!/^device:[A-Za-z0-9_-]{1,249}$/.test(device)) invalid(); return { ...result, device_id: device }; }
  return result;
}
export function parseControlLimitations(value: unknown): ControlLimitations { const v = controlObject(value, ["atomic_idle_start", "cancel", "queue", "runtime_state", "subscription_state"]); if (v.atomic_idle_start !== false || v.cancel !== false || v.queue !== false || !["unknown", "observed"].includes(String(v.runtime_state)) || !["unknown", "observed"].includes(String(v.subscription_state))) invalid(); return v as unknown as ControlLimitations; }
export function parseControlManifest(value: unknown): ControlManifestDto { const v = controlObject(value, ["version", "endpoint_id", "grant_state", "authorization_revision", "actions", "limitations"]); if (v.version !== 1 || !["ready", "grant_required", "invalid_configuration"].includes(String(v.grant_state)) || !Array.isArray(v.actions) || v.actions.length > 2 || new Set(v.actions).size !== v.actions.length) invalid(); const revision = v.authorization_revision === null ? null : controlId(v.authorization_revision); if ((v.grant_state === "ready") !== (revision !== null) || (revision !== null && !/^[a-f0-9]{64}$/.test(revision)) || (v.grant_state !== "ready" && (v.actions as unknown[]).length)) invalid(); return { version: 1, endpoint_id: controlIdentity(v.endpoint_id), grant_state: v.grant_state as ControlManifestDto["grant_state"], authorization_revision: revision, actions: (v.actions as unknown[]).map(action), limitations: parseControlLimitations(v.limitations) }; }
export function toControlFactDto(f: DeliveryFact): ControlFactDto { return { request_id: f.request_id, operation_id: f.operation_id, work: { ...f.work }, action: f.action, expires_at: f.expires_at, delivery_status: f.delivery_status, attempt_id: f.attempt_id, connector_epoch: f.connector_epoch, native_client_message_id: f.native_client_message_id, native_interface_version: f.native_interface_version, expected_turn_id: f.expected_turn_id, receipt: f.receipt && { ...f.receipt }, reconciliation: f.reconciliation && { ...f.reconciliation }, error_code: f.error_code, observed_at: f.observed_at }; }
export function validateControlResponse(operation: ControlOperation, value: unknown, envelope: ControlEnvelope): ControlResponse {
  size(value, CONTROL_OUTPUT_MAX_BYTES);
  if (operation === "state") {
    const v = controlObject(value, ["target", "authorization_revision", "connector_epoch", "native_interface_version", "snapshot", "allowed_actions", "limitations"]), t = controlObject(v.target, ["endpoint_id", "work"]), s = controlObject(v.snapshot, ["state", "turn_id", "revision", "work", "connector_epoch", "source", "observed_at", "identity_provenance"]);
    if (t.endpoint_id !== envelope.endpoint_id || !sameControlWork(parseControlWork(t.work), envelope.work) || v.authorization_revision !== envelope.authorization_revision || !sameControlWork(parseControlWork(s.work), envelope.work) || s.connector_epoch !== v.connector_epoch || s.source !== "codex.live" || !["unknown", "idle", "active", "approval_required"].includes(String(s.state)) || !Array.isArray(v.allowed_actions) || v.allowed_actions.length > 2 || new Set(v.allowed_actions).size !== v.allowed_actions.length) invalid();
    if (!["none", "observed_turn_started", "history_candidate"].includes(String(s.identity_provenance))) invalid();
    controlId(v.connector_epoch); controlId(v.native_interface_version); integer(s.revision); if (s.turn_id !== undefined) controlId(s.turn_id); if (s.state !== "unknown" && s.observed_at === null) invalid(); if (s.state === "active" && (!s.turn_id || s.identity_provenance === "none")) invalid(); if (s.observed_at !== null && (typeof s.observed_at !== "string" || !Number.isFinite(Date.parse(s.observed_at)))) invalid(); (v.allowed_actions as unknown[]).forEach(action); parseControlLimitations(v.limitations); return structuredClone(value) as ControlStateDto;
  }
  const v = controlObject(value, ["fact"]); if (v.fact === null) { if (operation === "apply") invalid(); return { fact: null }; }
  const f = controlObject(v.fact, ["request_id", "operation_id", "work", "action", "expires_at", "delivery_status", "attempt_id", "connector_epoch", "native_client_message_id", "native_interface_version", "expected_turn_id", "receipt", "reconciliation", "error_code", "observed_at"]);
  const expectedAction = envelope.request?.action ?? envelope.action, operationId = envelope.request?.operation_id ?? envelope.operation_id;
  if (!sameControlWork(parseControlWork(f.work), envelope.work) || f.action !== expectedAction || f.operation_id !== operationId || (envelope.request && (f.request_id !== envelope.request.request_id || f.expires_at !== envelope.request.expires_at || f.expected_turn_id !== (envelope.request.expected_turn_id ?? null))) || !["recorded", "invoking", "accepted", "rejected", "unknown"].includes(String(f.delivery_status))) invalid();
  controlId(f.request_id); controlId(f.operation_id); integer(f.expires_at, 1); integer(f.observed_at);
  for (const k of ["attempt_id", "connector_epoch", "native_client_message_id", "native_interface_version", "expected_turn_id"]) if (f[k] !== null) controlId(f[k]);
  if (f.error_code !== null && !["invalid", "too_large", "permission_denied", "expired", "conflict", "busy", "storage_failure", "unsupported", "offline", "stale_precondition", "result_unknown"].includes(String(f.error_code))) invalid();
  if (f.receipt !== null) { const r = controlObject(f.receipt, ["accepted_by", "native_turn_id", "native_message_id", "correlation"]); if (!["native", "connector"].includes(String(r.accepted_by)) || !["uncertain", "stable_message_id"].includes(String(r.correlation))) invalid(); if (r.native_turn_id !== undefined) controlId(r.native_turn_id); if (r.native_message_id !== undefined) controlId(r.native_message_id); if (f.delivery_status !== "accepted" || (r.correlation === "stable_message_id" && (r.accepted_by !== "native" || !r.native_message_id || !r.native_turn_id))) invalid(); }
  if (f.delivery_status === "accepted" && f.receipt === null) invalid();
  if (f.reconciliation !== null) { const p = controlObject(f.reconciliation, ["source", "lookup_scope", "pages_observed", "history_exhausted", "native_interface_version", "connector_epoch", "observed_at", "native_client_message_id", "native_turn_id", "native_message_id"]); if (p.source !== "codex.saved_history" || p.lookup_scope !== "bounded_history_pages" || integer(p.pages_observed, 1) > 4 || typeof p.history_exhausted !== "boolean" || typeof p.observed_at !== "string" || !Number.isFinite(Date.parse(p.observed_at))) invalid(); for (const k of ["native_interface_version", "connector_epoch", "native_client_message_id", "native_turn_id", "native_message_id"]) controlId(p[k]); const receipt = f.receipt as Record<string, unknown> | null; if (f.delivery_status !== "accepted" || !receipt || receipt.correlation !== "stable_message_id" || p.native_turn_id !== receipt.native_turn_id || p.native_message_id !== receipt.native_message_id || p.native_client_message_id !== f.native_client_message_id || p.native_interface_version !== f.native_interface_version) invalid(); }
  return structuredClone(value) as { fact: ControlFactDto };
}
