import type { WorkRef } from "./types";
export type TurnIdentityProvenance = "none" | "observed_turn_started" | "history_candidate";
export type LiveSnapshot = { state: "unknown" | "idle" | "active" | "approval_required"; turn_id?: string; revision: number; work: WorkRef; connector_epoch: string; source: "codex.live"; observed_at: string | null; identity_provenance: TurnIdentityProvenance };
