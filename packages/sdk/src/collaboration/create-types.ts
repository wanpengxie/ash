import type { AuthenticatedPrincipal } from "./control-types";
import type { WorkRef, HistoryTurn, ReadPage } from "./types";

export type CreateErrorCode = "invalid" | "too_large" | "permission_denied" | "expired" | "conflict" | "busy" | "storage_failure" | "unsupported" | "offline" | "stale_precondition" | "result_unknown";
export class CollaborationCreateError extends Error {
  constructor(readonly code: CreateErrorCode) { super(`Collaboration create: ${code}`); this.name = "CollaborationCreateError"; }
}
export interface CreateProjectScope { node_id: string; endpoint_id: string; cwd: string }
export interface CreateTarget extends CreateProjectScope { project_id: string }
export interface CreateWorkRequest {
  version: 1; request_id: string; operation_id: string; authorization_revision: string;
  target: CreateTarget; title: string; input: { text: string }; expires_at: number;
}
export type CreateStage = "create" | "name" | "first_input";
export type CreateStageStatus = "not_started" | "invoking" | "accepted" | "rejected" | "unknown";
export type CreateReceipt =
  | { stage: "create"; accepted_by: "native"; work: WorkRef }
  | { stage: "name"; accepted_by: "native"; work: WorkRef }
  /** stable_message_id requires reliable native association with THIS durable client ID, never matching text/turn alone. */
  | { stage: "first_input"; accepted_by: "native"; work: WorkRef; native_turn_id: string; native_message_id: string | null; correlation: "stable_message_id" | "uncertain" };
export interface CreateStageFact {
  status: CreateStageStatus; attempt_id: string | null;
  /** Process identity is internal journal evidence, never a public connector epoch. */
  owner_epoch: string | null; connector_epoch: string | null; native_interface_version: string | null;
  started_at: number | null; observed_at: number; receipt: CreateReceipt | null; error_code: CreateErrorCode | null;
}
export interface CreateReconciliationProvenance {
  source: "codex.saved_history"; lookup_scope: "bounded_history_pages";
  work: WorkRef; pages_observed: number; history_exhausted: boolean;
  connector_epoch: string; native_interface_version: string; observed_at: string;
  native_client_message_id: string; native_turn_id: string; native_message_id: string;
}
export interface CreateWorkFact {
  version: 1; principal_id: string; request_id: string; operation_id: string;
  authorization_revision: string; target: CreateTarget; payload_hash: string; expires_at: number;
  status: "recorded"; create: CreateStageFact; name: CreateStageFact; first_input: CreateStageFact;
  work: WorkRef | null; native_client_message_id: string | null;
  reconciliation: CreateReconciliationProvenance | null; error_code: CreateErrorCode | null; observed_at: number;
}
export type CreateOutcome = { status: "accepted"; receipt: CreateReceipt } | { status: "rejected"; code: Exclude<CreateErrorCode, "result_unknown"> };
export type CreatePurpose = "invoke" | "query";
export interface CreateLease {
  readonly principal: Readonly<AuthenticatedPrincipal>; readonly target: Readonly<CreateTarget>; readonly authorization_revision: string;
  /** Snapshot of the CURRENT verified grant, not copied from the request target. */
  readonly authorized_scope: Readonly<CreateProjectScope>;
  readonly connector_epoch: string; readonly native_interface_version: string;
  authorize(purpose: CreatePurpose): Promise<boolean>;
  run<T>(purpose: CreatePurpose, operation: () => Promise<T>): Promise<T>;
}
/** Discovery is authorized before consulting native projects, without a fake project ID. */
export interface CreateProjectsLease {
  readonly principal: Readonly<AuthenticatedPrincipal>; readonly scope: Readonly<CreateProjectScope>; readonly authorization_revision: string;
  /** Current exact_cwd grant snapshot, checked against discovery scope before any native read. */
  readonly authorized_scope: Readonly<CreateProjectScope>;
  readonly connector_epoch: string; readonly native_interface_version: string;
  authorize(): Promise<boolean>; run<T>(operation: () => Promise<T>): Promise<T>;
}
export interface CreateReadContext {
  /** Trusted transport lease grant snapshot. Never construct from arbitrary request.target. */
  readonly authorized_scope: Readonly<CreateProjectScope>;
  deadline: number; authorize(): Promise<boolean>; signal?: AbortSignal;
}
export interface CreateInvocation extends CreateReadContext {
  principal: AuthenticatedPrincipal; request: CreateWorkRequest; attempt_id: string;
  connector_epoch: string; native_interface_version: string;
}
export interface CreateAdapter {
  readonly connector_epoch: string; readonly native_interface_version: string;
  projects(scope: CreateProjectScope, context: CreateReadContext): Promise<{ project_id: string; cwd: string }[]>;
  resolveProject(target: CreateTarget, context: CreateReadContext): Promise<CreateTarget>;
  createThread(invocation: CreateInvocation): Promise<CreateOutcome>;
  nameThread(invocation: CreateInvocation & { work: WorkRef }): Promise<CreateOutcome>;
  startFirstInput(invocation: CreateInvocation & { work: WorkRef; native_client_message_id: string }): Promise<CreateOutcome>;
  /** Check node/endpoint and native cwd against authorized_scope before returning metadata. */
  metadata(work: WorkRef, context: CreateReadContext): Promise<{ work: WorkRef; cwd: string }>;
  /** Recheck native metadata against authorized_scope before AND after every history read. */
  history(work: WorkRef, context: CreateReadContext & { cursor?: string; limit?: number }): Promise<ReadPage<HistoryTurn>>;
}
/** FULL durable claim must precede native invocation; no time lease licenses replay. */
export interface CreateStore {
  get(principal: string, operation: string): CreateWorkFact | null;
  record(principal: string, request: CreateWorkRequest, payloadHash: string, now: number): CreateWorkFact;
  /** CAS not_started only. claimed=true proves FULL commit; first_input includes a durable stable client ID. */
  claim(principal: string, operation: string, stage: CreateStage, connectorEpoch: string, now: number, nativeVersion: string): { fact: CreateWorkFact; claimed: boolean };
  /** CAS original attempt/owner only. null means unknown; retry only this save after an ended native call. */
  finish(fact: CreateWorkFact, stage: CreateStage, outcome: CreateOutcome | null, now: number): CreateWorkFact;
  /** CAS original first_input attempt, preserving any already stronger stable association. */
  reconcile(fact: CreateWorkFact, provenance: CreateReconciliationProvenance, now: number): CreateWorkFact;
  recoverAbandoned(): void; close(): void;
}

export interface CreateManifestDto {
  version: 1; endpoint_id: string; grant_state: "ready" | "grant_required" | "invalid_configuration";
  authorization_revision: string | null; actions: ("projects" | "apply" | "query" | "reconcile")[];
  scope: { kind: "exact_cwd"; cwd: string } | null;
  limitations: { native_readiness: "unknown"; cancel: false; automatic_replay: false; execution_completion: "unknown" };
}
