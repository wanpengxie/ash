/** References remain scoped to their source; native IDs alone are never cross-node identities. */
export interface WorkRef {
  node_id: string;
  endpoint_id: string;
  kind: "conversation";
  native_id: string;
}
export type ReadErrorCode = "permission_denied" | "unsupported" | "not_found" | "invalid" | "offline" | "timeout" | "cancelled" | "too_large" | "source_required" | "draining";
export class CollaborationReadError extends Error {
  constructor(readonly code: ReadErrorCode, message: string) { super(message); this.name = "CollaborationReadError"; }
}
export interface WorkSummary {
  work: WorkRef;
  title: string;
  cwd: string;
  updated_at: number | null;
  runtime_state: "unknown";
}
/** Locates a visible source part; it grants no download or filesystem access. */
export interface MaterialReference {
  source_part_index: number;
  kind: "image" | "audio" | "skill" | "mention";
  source_type: "image" | "localImage" | "audio" | "localAudio" | "skill" | "mention";
  availability: "reference_only";
}
export interface VisibleMessage {
  work: WorkRef;
  turn_id: string;
  source_message_id: string;
  source_client_message_id?: string;
  role: "user" | "assistant";
  text: string;
  phase?: string;
  material_refs?: MaterialReference[];
}
export interface HistoryTurn {
  turn_id: string;
  history_status: string | null;
  status_source: "codex.saved_history";
  messages: VisibleMessage[];
}
export interface ReadPage<T> {
  items: T[];
  next_cursor: string | null;
  observed_at: string;
  completeness: "source_page";
  source: "codex.saved_history";
  runtime_state: "unknown";
}
export interface PageInput { cursor?: string; limit?: number; signal?: AbortSignal }
