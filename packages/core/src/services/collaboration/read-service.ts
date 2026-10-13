import type { HistoryTurn, ReadPage, WorkRef, WorkSummary } from "../../../../sdk/src/collaboration/types";

export const READ_INPUT_BYTES = 64 * 1024;
export const READ_OUTPUT_BYTES = 1024 * 1024;
export const READ_CAPABILITIES = { list_work: "collaboration.work.list", read_work: "collaboration.work.read" } as const;
export type ReadAction = keyof typeof READ_CAPABILITIES;
export class CoreReadError extends Error {
  constructor(readonly code: string) { super(`Collaboration read ${code}`); }
}
const invalid = (): never => { throw new CoreReadError("invalid"); };
function object(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, any>;
}
function string(value: unknown, max = 1024, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.length > 0) && !/[\u0000-\u001f]/.test(value);
}
export interface ReadTarget {
  device_id: string; name: string; version: 1; node_id: string; endpoint_id: string;
  adapter: "desktop/codex"; authorization_state: "ready" | "scope_required" | "invalid_configuration";
  authorization_generation: number; authorization_revision: string; runtime_availability: "unknown"; scope_kind: "exact_cwd";
  source: "codex.saved_history"; runtime_state: "unknown"; control: "unsupported"; actions: ReadAction[];
}
/** Ignore unrelated manifest metadata; only implemented, fixed reads become a target. */
export function normalizeReadTarget(deviceId: string, name: string, raw: unknown): ReadTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const manifest = raw as Record<string, any>, c = manifest.collaboration;
  if (manifest.protocol !== undefined && manifest.protocol !== "ash-dev/1") return null;
  if (!c || c.version !== 1 || c.node_id !== deviceId || c.endpoint_id !== deviceId || c.adapter !== "desktop/codex" ||
    !["ready", "scope_required", "invalid_configuration"].includes(c.authorization_state) ||
    !Number.isSafeInteger(c.authorization_generation) || c.authorization_generation < 0 || typeof c.authorization_revision !== "string" || !/^[0-9a-f]{64}$/.test(c.authorization_revision) ||
    (c.authorization_state === "ready" && c.authorization_generation < 1) || c.runtime_availability !== "unknown" ||
    c.scope_kind !== "exact_cwd" || c.source !== "codex.saved_history" || c.runtime_state !== "unknown" || c.control !== "unsupported" || !Array.isArray(manifest.capabilities)) return null;
  const actions = (Object.keys(READ_CAPABILITIES) as ReadAction[]).filter(action => manifest.capabilities.some((cap: any) => cap?.name === READ_CAPABILITIES[action] && cap.risk === "none"));
  if (c.authorization_state === "ready" && actions.length !== 2) return null;
  return { device_id: `device:${deviceId}`, name: name.replace(/[\p{C}]/gu, " ").slice(0, 80), version: 1,
    node_id: deviceId, endpoint_id: deviceId, adapter: "desktop/codex", authorization_state: c.authorization_state,
    authorization_generation: c.authorization_generation, authorization_revision: c.authorization_revision, runtime_availability: "unknown", scope_kind: "exact_cwd",
    source: "codex.saved_history", runtime_state: "unknown", control: "unsupported", actions: c.authorization_state === "ready" ? actions : [] };
}
export interface ReadInput { version: 1; device_id: string; endpoint_id: string; authorization_generation: number; authorization_revision: string; action: ReadAction; page?: { cursor?: string; limit?: number }; work?: WorkRef }
export function validateWork(value: unknown, node: string, endpoint: string): WorkRef {
  const w = object(value, ["node_id", "endpoint_id", "kind", "native_id"]);
  if (w.node_id !== node || w.endpoint_id !== endpoint || w.kind !== "conversation" || !string(w.native_id)) throw new CoreReadError("permission_denied");
  return { node_id: node, endpoint_id: endpoint, kind: "conversation", native_id: w.native_id };
}
export function parseReadInput(body: Buffer | null): ReadInput {
  if ((body?.length ?? 0) > READ_INPUT_BYTES) throw new CoreReadError("too_large");
  let value: unknown; try { value = JSON.parse(body?.toString("utf8") ?? ""); } catch { return invalid(); }
  const b = object(value, ["version", "device_id", "endpoint_id", "authorization_generation", "authorization_revision", "action", "page", "work"]);
  if (b.version !== 1 || !string(b.device_id) || !/^device:[A-Za-z0-9_-]+$/.test(b.device_id) || !string(b.endpoint_id) || !Number.isSafeInteger(b.authorization_generation) || b.authorization_generation < 1 || typeof b.authorization_revision !== "string" || !/^[0-9a-f]{64}$/.test(b.authorization_revision) || !Object.hasOwn(READ_CAPABILITIES, b.action)) invalid();
  if (b.endpoint_id !== b.device_id.slice(7)) throw new CoreReadError("permission_denied");
  if (b.page !== undefined) {
    const p = object(b.page, ["cursor", "limit"]);
    if ((p.cursor !== undefined && !string(p.cursor)) || (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100))) invalid();
  }
  if (b.action === "read_work") b.work = validateWork(b.work, b.device_id.slice(7), b.endpoint_id);
  else if (b.work !== undefined) invalid();
  return b as ReadInput;
}
/** The DTO boundary rejects hidden source fields, paths and material payloads. */
export function validateReadPage(value: unknown, input: ReadInput): ReadPage<WorkSummary> | ReadPage<HistoryTurn> {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > READ_OUTPUT_BYTES) throw new CoreReadError("too_large");
  const p = object(value, ["items", "next_cursor", "observed_at", "completeness", "source", "runtime_state"]);
  if (!Array.isArray(p.items) || p.items.length > (input.page?.limit ?? 100) || !(p.next_cursor === null || string(p.next_cursor)) || !string(p.observed_at, 80) || !Number.isFinite(Date.parse(p.observed_at)) || p.completeness !== "source_page" || p.source !== "codex.saved_history" || p.runtime_state !== "unknown") invalid();
  for (const value of p.items) {
    if (input.action === "list_work") {
      const row = object(value, ["work", "title", "cwd", "updated_at", "runtime_state"]);
      validateWork(row.work, input.device_id.slice(7), input.endpoint_id);
      // Native preview fallbacks are human text and may contain multiple lines.
      if (typeof row.title !== "string" || row.title.length > 8192 || !string(row.cwd, 4096, true) || !(row.updated_at === null || (typeof row.updated_at === "number" && Number.isFinite(row.updated_at))) || row.runtime_state !== "unknown") invalid();
    } else {
      const turn = object(value, ["turn_id", "history_status", "status_source", "messages"]);
      if (!string(turn.turn_id) || !(turn.history_status === null || string(turn.history_status, 128)) || turn.status_source !== "codex.saved_history" || !Array.isArray(turn.messages) || turn.messages.length > 1000) invalid();
      for (const value of turn.messages) {
        const m = object(value, ["work", "turn_id", "source_message_id", "source_client_message_id", "role", "text", "phase", "material_refs"]);
        const w = validateWork(m.work, input.device_id.slice(7), input.endpoint_id);
        if (w.native_id !== input.work!.native_id) throw new CoreReadError("permission_denied");
        if (m.turn_id !== turn.turn_id || !string(m.source_message_id) || (m.source_client_message_id !== undefined && !string(m.source_client_message_id)) || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > READ_OUTPUT_BYTES || (m.phase !== undefined && !["commentary", "final_answer"].includes(m.phase))) invalid();
        if (m.material_refs !== undefined) {
          if (!Array.isArray(m.material_refs) || m.material_refs.length > 1000) invalid();
          for (const value of m.material_refs) {
            const r = object(value, ["source_part_index", "kind", "source_type", "availability"]);
            const kinds: Record<string, string> = { image: "image", localImage: "image", audio: "audio", localAudio: "audio", skill: "skill", mention: "mention" };
            if (!Number.isSafeInteger(r.source_part_index) || r.source_part_index < 0 || !Object.hasOwn(kinds, r.source_type) || kinds[r.source_type] !== r.kind || r.availability !== "reference_only") invalid();
          }
        }
      }
    }
  }
  return p as ReadPage<WorkSummary> | ReadPage<HistoryTurn>;
}
export interface CollaborationReadTransport {
  collaborationEndpoints(signal: AbortSignal): Promise<ReadTarget[]>;
  collaborationRead(input: ReadInput, signal: AbortSignal): Promise<{ target: ReadTarget; page: ReadPage<WorkSummary> | ReadPage<HistoryTurn> }>;
}
/** One deadline bounds discovery, authorization checks and the device exchange together. */
export async function boundedRead<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, no) => { reject = no; });
  controller.signal.addEventListener("abort", () => reject(new CoreReadError(timedOut ? "timeout" : "cancelled")), { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    if (signal?.aborted) abort();
    if (controller.signal.aborted) return await cancelled;
    return await Promise.race([work(controller.signal), cancelled]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
export const READ_ERROR_STATUS: Record<string, number> = { invalid: 400, permission_denied: 403, unsupported: 422, not_found: 404, offline: 503, timeout: 504, cancelled: 499, too_large: 413 };
