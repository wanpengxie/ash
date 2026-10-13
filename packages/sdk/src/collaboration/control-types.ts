import type { MaterialInputSelection } from "./material-input-manifest";
import type { WorkRef } from "./types";

export type ControlAction = "send_input" | "steer";
export type DeliveryStatus = "recorded" | "invoking" | "accepted" | "rejected" | "unknown";
export type ControlErrorCode = "invalid" | "too_large" | "permission_denied" | "expired" | "conflict" | "busy" | "storage_failure" | "unsupported" | "offline" | "stale_precondition" | "result_unknown";
/** Messages are fixed categories: source errors, credentials and input are never interpolated. */
export class CollaborationControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(`Collaboration control: ${code}`); this.name = "CollaborationControlError"; }
}
/** Supplied separately by the authenticated transport, never extracted from request body. */
export interface AuthenticatedPrincipal { principal_id: string }
export interface ControlRequest {
  request_id: string;
  operation_id: string;
  work: WorkRef;
  action: ControlAction;
  input: { text: string; material?: MaterialInputSelection };
  expected_turn_id?: string;
  expires_at: number;
}
export interface NativeReceipt {
  accepted_by: "connector" | "native";
  native_turn_id?: string;
  native_message_id?: string;
  /**
   * A turn ID alone cannot identify a message or reclaim an optimistic message.
   * stable_message_id requires a proven native association with THIS invocation
   * in its WorkRef (for example an echoed client ID); matching text is not proof.
   */
  correlation: "stable_message_id" | "uncertain";
}
export type NativeOutcome = { status: "accepted"; receipt: NativeReceipt } | { status: "rejected"; code: "unsupported" | "offline" | "stale_precondition" | "permission_denied" };
export interface DeliveryFact {
  principal_id: string;
  request_id: string;
  operation_id: string;
  work: WorkRef;
  action: ControlAction;
  payload_hash: string;
  expires_at: number;
  delivery_status: DeliveryStatus;
  attempt_id: string | null;
  connector_epoch: string | null;
  native_client_message_id: string | null;
  native_interface_version: string | null;
  expected_turn_id: string | null;
  reconciliation: ReconciliationProvenance | null;
  receipt: NativeReceipt | null;
  error_code: ControlErrorCode | null;
  observed_at: number;
}
export type AuthorizeControl = (principal: AuthenticatedPrincipal, work: WorkRef, action: ControlAction, purpose: "invoke" | "query") => boolean | Promise<boolean>;
export type DeliveryStage = "before_record" | "after_record" | "before_invoking" | "after_invoking" | "after_native" | "after_saved";

/** Saved-history proof, never an instantaneous ack or execution-completion claim. */
export interface ReconciliationProvenance {
  source: "codex.saved_history";
  lookup_scope: "bounded_history_pages";
  pages_observed: number;
  history_exhausted: boolean;
  native_interface_version: string;
  connector_epoch: string;
  observed_at: string;
  native_client_message_id: string;
  native_turn_id: string;
  native_message_id: string;
}
