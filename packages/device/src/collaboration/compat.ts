/** Internal DTOs retained by the Codex adapters; wire frames use ash-link/1. */
export interface CapabilitySpec { name: string; description: string; input_schema: Record<string, unknown>; timeout_ms?: number; risk?: "none" | "outward" | "structure" }
export interface CallResult { ok: boolean; content: import("../../../sdk/src/link").ContentPart[]; data?: unknown; error?: string }
