import type { WorkRef } from "./types";
import type { NativeFrame } from "./control-native-types";
export type { TurnIdentityProvenance, LiveSnapshot } from "../../../sdk/src/collaboration/live-types";
import type { TurnIdentityProvenance, LiveSnapshot } from "../../../sdk/src/collaboration/live-types";
/** Shared across rearming a target; finished/errored IDs cannot become candidates again. */
export interface TurnFences { blocked: Set<string>; exhausted: boolean }
type BootstrapEvent = { kind: string; turn?: string; status?: string; approval?: boolean };
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
/** Runtime activity comes from current native metadata/events. History supplies ONLY an ID candidate. */
export class CodexLiveState {
  private state: LiveSnapshot;
  private poisoned = false;
  private pendingStart = false;
  private bootstrap?: BootstrapEvent[];
  readonly threadId: string;
  constructor(work: WorkRef, readonly epoch: string, readonly fences: TurnFences = { blocked: new Set(), exhausted: false }) {
    this.threadId = work.native_id;
    this.state = { state: "unknown", revision: 0, work: Object.freeze({ ...work }), connector_epoch: epoch, source: "codex.live", observed_at: null, identity_provenance: "none" };
  }
  snapshot(): LiveSnapshot { return { ...this.state, work: { ...this.state.work } }; }
  /** A pending start has not supplied a reliable execution boundary; do not reset it to old idle. */
  isStartPending(): boolean { return this.pendingStart; }
  needsObservation(): boolean { return this.poisoned && !this.pendingStart && !this.bootstrap && !this.fences.exhausted; }
  invalidate(): void { this.poisoned = true; this.update("unknown"); }
  private block(id: unknown): void {
    if (!validId(id)) return;
    if (this.fences.blocked.size >= 256 && !this.fences.blocked.has(id)) { this.fences.exhausted = true; return; }
    this.fences.blocked.add(id);
  }
  private update(state: LiveSnapshot["state"], turn_id?: string, provenance: TurnIdentityProvenance = "none"): void {
    this.state = { ...this.state, state, turn_id, identity_provenance: provenance, revision: this.state.revision + 1, observed_at: new Date().toISOString() };
  }
  reserveStart(): void { this.pendingStart = true; this.update("unknown"); }
  beginBootstrap(): void { this.bootstrap = []; }
  /** Fresh current status proves active/idle; candidates are never used to infer busy. */
  finishBootstrap(status: any, candidates: readonly string[]): void {
    const events = this.bootstrap ?? []; this.bootstrap = undefined;
    if (this.poisoned || this.fences.exhausted) { this.invalidate(); return; }
    if (status?.type === "active" && Array.isArray(status.activeFlags) && status.activeFlags.length) { this.update("approval_required"); return; }
    if (events.some(event => ["error", "turn/completed", "approval"].includes(event.kind) || event.approval)) { this.invalidate(); return; }
    const started = new Set(events.filter(event => event.kind === "turn/started").map(event => event.turn));
    const itemTurns = new Set(events.filter(event => event.kind.startsWith("item/")).map(event => event.turn));
    if (started.size > 1 || itemTurns.size > 1 || events.some(event => event.kind === "thread/status/changed" && event.status !== status?.type)) { this.invalidate(); return; }
    if (status?.type === "idle") {
      if (started.size || itemTurns.size) { this.invalidate(); return; }
      this.update("idle"); return;
    }
    if (status?.type !== "active" || !Array.isArray(status.activeFlags) || status.activeFlags.length || candidates.length !== 1) { this.invalidate(); return; }
    const candidate = candidates[0];
    if (!validId(candidate) || this.fences.blocked.has(candidate) || [...started, ...itemTurns].some(id => id !== candidate)) { this.invalidate(); return; }
    this.update("active", candidate, started.has(candidate) ? "observed_turn_started" : "history_candidate");
  }
  metadata(status: any): void {
    this.state.observed_at = new Date().toISOString();
    if (this.poisoned || this.bootstrap || this.fences.exhausted) return;
    if (this.pendingStart && status?.type === "idle") return;
    if (status?.type === "idle") { if (this.state.turn_id) this.invalidate(); else this.update("idle"); }
    else if (status?.type === "active" && Array.isArray(status.activeFlags)) {
      if (status.activeFlags.length) this.update("approval_required", this.state.turn_id, this.state.identity_provenance);
      else if (this.state.turn_id && !this.fences.blocked.has(this.state.turn_id)) this.update("active", this.state.turn_id, this.state.identity_provenance);
      else this.update("unknown");
    } else this.invalidate();
  }
  event(frame: NativeFrame, epoch: string): void {
    if (epoch !== this.epoch || frame.params?.threadId !== this.threadId) return;
    const p = frame.params, method = frame.method;
    const turn = method === "turn/started" || method === "turn/completed" ? p.turn?.id : p.turnId;
    // Keep terminal fences even while an observation is poisoned, so rearming cannot resurrect it.
    if (method === "turn/completed" || method === "error") this.block(turn);
    const approval = frame.id !== undefined && !!method;
    if (this.bootstrap) {
      if (!approval && !["error", "turn/started", "turn/completed", "item/started", "item/completed", "thread/status/changed"].includes(method ?? "")) return;
      if (this.bootstrap.length >= 64 || ((method?.startsWith("turn/") || method?.startsWith("item/") || method === "error") && !validId(turn))) { this.invalidate(); return; }
      this.bootstrap.push({ kind: approval ? "approval" : method!, ...(validId(turn) ? { turn } : {}), ...(method === "thread/status/changed" ? { status: p.status?.type, approval: p.status?.type === "active" && (!Array.isArray(p.status.activeFlags) || p.status.activeFlags.length > 0) } : {}) });
      this.state.revision++; this.state.observed_at = new Date().toISOString(); return;
    }
    if (this.poisoned || this.fences.exhausted) return;
    this.state.observed_at = new Date().toISOString();
    if (method === "error") { this.invalidate(); return; }
    if (approval) { this.update("approval_required", this.state.turn_id, this.state.identity_provenance); return; }
    if (method === "thread/status/changed") { this.metadata(p.status); return; }
    if (method === "turn/started") {
      if (!validId(turn) || this.fences.blocked.has(turn) || (this.state.turn_id && this.state.turn_id !== turn)) { this.invalidate(); return; }
      this.pendingStart = false;
      if (this.state.turn_id !== turn || this.state.identity_provenance !== "observed_turn_started") this.update("active", turn, "observed_turn_started");
    } else if (method === "turn/completed") {
      if (!validId(turn) || (this.state.turn_id && this.state.turn_id !== turn)) { this.invalidate(); return; }
      if (!this.state.turn_id) return; // A duplicate completion cannot poison a reliable idle state.
      this.update("idle");
    } else if (method === "item/started" || method === "item/completed") {
      if (this.fences.blocked.has(turn)) return; // Late item notifications for finished turns are harmless.
      if (!this.state.turn_id || turn !== this.state.turn_id) this.invalidate();
    }
  }
}
