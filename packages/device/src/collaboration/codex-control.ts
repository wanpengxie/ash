import { currentPreparedMaterialInput, markMaterialInputSubmitted, type PreparedMaterialInput } from "./material-input-reader";
import { isAbsolute } from "node:path";
import { CollaborationControlError, type ControlAdapter, type Invocation, type NativeOutcome } from "./control-types";
import type { NativeControlInvocation, NativeMetadata, ValidateNativeMetadata } from "./control-native-types";
import type { WorkRef } from "./types";
import type { ReconciliationPage, ReconciliationReader } from "./reconciliation";
import { CodexLiveState, type TurnFences } from "./codex-live-state";
import { CodexTransport, NativeTransportError } from "./codex-transport";
export interface CodexControlOptions {
  node_id: string; endpoint_id: string; transport: CodexTransport;
  validateMetadata: ValidateNativeMetadata;
  /** Trusted proxy route binding; required for material on a proxy connection. */
  bindTextInput?: (invocation:Invocation)=>undefined;
  bindPreparedInput?: (proof:PreparedMaterialInput,invocation:Invocation)=>undefined;
  /** Query lease callback, independent of subscription/invoke authorization. Missing means deny. */
  validateHistoryMetadata?: (work: WorkRef, metadata: NativeMetadata) => boolean | Promise<boolean>;
  /** Explicit scope permission for the narrow, override-free observation subscription. */
  allowSubscription: (work: WorkRef, metadata?: NativeMetadata) => boolean | Promise<boolean>;
}
const identity = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 1024 && !/[\u0000-\u001f]/.test(id);
export class CodexControlAdapter implements ControlAdapter, ReconciliationReader {
  private states = new Map<string, CodexLiveState>();
  private fences = new Map<string, TurnFences>();
  private busy = new Set<string>();
  private attempted = new Set<string>();
  get native_interface_version(): string { return this.options.transport.version; }
  get connector_epoch(): string { return this.options.transport.epoch; }
  constructor(private readonly options: CodexControlOptions) {
    options.transport.onEvent = (frame, epoch) => {
      const thread = frame.params?.threadId;
      if (typeof thread === "string") this.states.get(thread)?.event(frame, epoch);
      // Unscoped server requests cannot be answered or safely attributed.
      else if (frame.id !== undefined) for (const state of this.states.values()) state.invalidate();
    };
    options.transport.onDisconnect = () => { for (const state of this.states.values()) state.invalidate(); this.states.clear(); };
  }
  private target(work: WorkRef): void {
    if (!work || work.node_id !== this.options.node_id || work.endpoint_id !== this.options.endpoint_id || work.kind !== "conversation" || !identity(work.native_id)) throw new CollaborationControlError("permission_denied");
  }
  current():undefined {this.options.transport.verifyCurrent();return undefined;}
  finalCurrent():undefined {this.options.transport.finalCurrent();return undefined;}
  async connect(): Promise<void> { await this.options.transport.connect(); }
  /** Caller must grant this target before loading it. No enumerate, create, or overrides. */
  async observe(value: WorkRef): Promise<void> {
    this.target(value);
    const work = Object.freeze({ ...value });
    try { if (!await this.options.allowSubscription(work)) throw new CollaborationControlError("permission_denied"); }
    catch { throw new CollaborationControlError("permission_denied"); }
    if (this.busy.has(work.native_id) || this.states.get(work.native_id)?.isStartPending()) throw new CollaborationControlError("busy");
    if (this.fences.size >= 128 && !this.fences.has(work.native_id)) throw new CollaborationControlError("too_large");
    const transport = this.options.transport, epoch = transport.epoch, version = transport.version;
    transport.verifyCurrent();
    const fences = this.fences.get(work.native_id) ?? { blocked: new Set<string>(), exhausted: false };
    this.fences.set(work.native_id, fences);
    const state = new CodexLiveState(work, epoch, fences); state.beginBootstrap(); this.states.set(work.native_id, state);
    this.busy.add(work.native_id);
    const currentConnection = () => {
      if (epoch !== transport.epoch || version !== transport.version || this.states.get(work.native_id) !== state) throw new CollaborationControlError("offline");
      transport.verifyCurrent();
    };
    const gate = async (thread: any) => {
      currentConnection();
      if (thread?.id !== work.native_id || typeof thread.cwd !== "string" || !isAbsolute(thread.cwd)) throw new CollaborationControlError("permission_denied");
      if (!await this.options.allowSubscription(work, { work, cwd: thread.cwd, version, epoch })) throw new CollaborationControlError("permission_denied");
      currentConnection();
    };
    try {
      const initial = await transport.request("thread/read", { threadId: work.native_id, includeTurns: false });
      await gate(initial?.thread);
      const resumed = await transport.request("thread/resume", { threadId: work.native_id, excludeTurns: true });
      await gate(resumed?.thread);
      if (resumed.thread.cwd !== initial.thread.cwd) throw new CollaborationControlError("permission_denied");
      let candidates: string[] = [];
      if (resumed.thread.status?.type === "active" && Array.isArray(resumed.thread.status.activeFlags) && resumed.thread.status.activeFlags.length === 0) {
        // Summary history supplies identity candidates only, never an activity or running-tool claim.
        const page = await transport.request("thread/turns/list", { threadId: work.native_id, limit: 25, sortDirection: "desc", itemsView: "summary" });
        currentConnection();
        if (!Array.isArray(page?.data) || page.data.length > 25) throw new CollaborationControlError("invalid");
        const seen = new Set<string>();
        for (const turn of page.data) {
          if (!identity(turn?.id) || !["inProgress", "completed", "interrupted", "failed"].includes(turn.status) || seen.has(turn.id)) throw new CollaborationControlError("invalid");
          seen.add(turn.id);
          if (turn.status === "inProgress") candidates.push(turn.id);
        }
      }
      const final = await transport.request("thread/read", { threadId: work.native_id, includeTurns: false });
      await gate(final?.thread);
      if (final.thread.cwd !== initial.thread.cwd) throw new CollaborationControlError("permission_denied");
      if (initial.thread.status?.type !== resumed.thread.status?.type || resumed.thread.status?.type !== final.thread.status?.type || [initial.thread.status, resumed.thread.status].some(status => status?.type === "active" && (!Array.isArray(status.activeFlags) || status.activeFlags.length))) state.invalidate();
      state.finishBootstrap(final.thread.status, candidates);
    } catch (error) {
      state.invalidate();
      if (error instanceof CollaborationControlError || error instanceof NativeTransportError) throw error;
      throw new CollaborationControlError("permission_denied");
    } finally { this.busy.delete(work.native_id); }
  }
  /** Narrow same-epoch recovery signal. Never infer rearming from generic unknown. */
  needsObservation(work: WorkRef): boolean {
    this.target(work);
    const state = this.states.get(work.native_id);
    return !!state && state.epoch === this.connector_epoch && !this.busy.has(work.native_id) && state.needsObservation();
  }
  snapshot(work: WorkRef) { this.target(work); return this.states.get(work.native_id)?.snapshot() ?? { state: "unknown" as const, revision: 0, work: { ...work }, connector_epoch: this.connector_epoch, source: "codex.live" as const, observed_at: null, identity_provenance: "none" as const }; }
  async invoke(invocation: Invocation): Promise<NativeOutcome> {
    const { request } = invocation;
    this.target(request.work);
    const native = invocation as Partial<NativeControlInvocation>, transport = this.options.transport;
    if (!identity(native.native_client_message_id) || native.native_interface_version !== transport.version) throw new CollaborationControlError("invalid");
    if (!identity(invocation.attempt_id) || invocation.connector_epoch !== transport.epoch || transport.epoch === "disconnected") return { status: "rejected", code: "offline" };
    if (request.action !== "send_input" && request.action !== "steer") return { status: "rejected", code: "unsupported" };
    if (typeof request.input?.text !== "string" || Buffer.byteLength(request.input.text) > 64 * 1024) throw new CollaborationControlError("too_large");
    if (request.expires_at <= Date.now()) throw new CollaborationControlError("expired");
    if(request.input.material&&!invocation.prepared_input)return {status:'rejected',code:'unsupported'};
    if(!request.input.material&&invocation.prepared_input)throw new CollaborationControlError('invalid');
    const checkPrepared=()=>invocation.prepared_input?currentPreparedMaterialInput(invocation.prepared_input,invocation):undefined;
    checkPrepared();
    const thread = request.work.native_id, state = this.states.get(thread);
    if (!state || this.busy.has(thread)) return { status: "rejected", code: "stale_precondition" };
    const key = `${invocation.principal.principal_id}:${invocation.attempt_id}`;
    if (this.attempted.has(key)) throw new CollaborationControlError("result_unknown");
    this.busy.add(thread);
    let sent = false;
    try {
      transport.verifyCurrent();
      const revision = state.snapshot().revision;
      checkPrepared();
      const metadata = await transport.request("thread/read", { threadId: thread, includeTurns: false });
      checkPrepared();
      if (metadata?.thread?.id !== thread || typeof metadata.thread.cwd !== "string" || !isAbsolute(metadata.thread.cwd)) return { status: "rejected", code: "permission_denied" };
      if (!await this.options.validateMetadata(invocation, { work: request.work, cwd: metadata.thread.cwd, epoch: transport.epoch, version: transport.version })) return { status: "rejected", code: "permission_denied" };
      checkPrepared();
      if (transport.epoch !== invocation.connector_epoch || state.snapshot().revision !== revision) return { status: "rejected", code: "stale_precondition" };
      state.metadata(metadata.thread.status);
      const live = state.snapshot();
      if (request.action === "send_input" ? live.state !== "idle" || request.expected_turn_id !== undefined : live.state !== "active" || !identity(request.expected_turn_id) || live.turn_id !== request.expected_turn_id) return { status: "rejected", code: "stale_precondition" };
      transport.verifyCurrent();
      if (request.expires_at <= Date.now()) throw new CollaborationControlError("expired");
      if (this.attempted.size >= 10_000) throw new CollaborationControlError("too_large");
      const prepared=checkPrepared();
      if(invocation.prepared_input){this.options.bindPreparedInput?.(invocation.prepared_input,invocation);checkPrepared();}else this.options.bindTextInput?.(invocation);
      const input=prepared?.inputs??[{type:'text',text:request.input.text,text_elements:[]}];
      if(Buffer.byteLength(JSON.stringify({threadId:thread,input,clientUserMessageId:native.native_client_message_id,...(request.action==='steer'?{expectedTurnId:request.expected_turn_id}:{})}))>1024*1024)throw new CollaborationControlError('too_large');
      if(invocation.prepared_input)markMaterialInputSubmitted(invocation.prepared_input,invocation);
      this.attempted.add(key); sent = true;
      // An ack can precede turn/started. Do not treat the previous idle snapshot as reusable.
      if (request.action === "send_input") state.reserveStart();
      const result = await transport.request(request.action === "steer" ? "turn/steer" : "turn/start", {
        threadId: thread, input, clientUserMessageId: native.native_client_message_id,
        ...(request.action === "steer" ? { expectedTurnId: request.expected_turn_id } : {}),
      });
      checkPrepared();
      const turn = request.action === "steer" ? result?.turnId : result?.turn?.id;
      if (!identity(turn) || (request.action === "steer" && turn !== request.expected_turn_id)) throw new CollaborationControlError("result_unknown");
      if (!await this.options.validateMetadata(invocation, { work: request.work, cwd: metadata.thread.cwd, epoch: transport.epoch, version: transport.version })) throw new CollaborationControlError("permission_denied");
      checkPrepared();
      return { status: "accepted", receipt: { accepted_by: "native", native_turn_id: turn, correlation: "uncertain" } };
    } catch (error) {
      if (sent) throw new CollaborationControlError("result_unknown");
      if (error instanceof NativeTransportError) return { status: "rejected", code: error.code === "unsupported" ? "unsupported" : "offline" };
      if (error instanceof CollaborationControlError) throw error;
      throw new CollaborationControlError("permission_denied");
    } finally { this.busy.delete(thread); }
  }
  async readHistoryPage(input: { work: WorkRef; cursor?: string; limit: number }): Promise<ReconciliationPage> {
    this.target(input.work);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 25 || (input.cursor !== undefined && !identity(input.cursor))) throw new CollaborationControlError("invalid");
    const limit = input.limit, cursor = input.cursor;
    const work = Object.freeze({ ...input.work }), transport = this.options.transport;
    const epoch = transport.epoch, version = transport.version;
    const current = () => {
      if (epoch !== transport.epoch || version !== transport.version || epoch === "disconnected") throw new CollaborationControlError("offline");
      transport.verifyCurrent();
    };
    try {
      current();
      const metadata = await transport.request("thread/read", { threadId: work.native_id, includeTurns: false });
      current();
      if (metadata?.thread?.id !== work.native_id || typeof metadata.thread.cwd !== "string" || !isAbsolute(metadata.thread.cwd)) throw new CollaborationControlError("permission_denied");
      const native = { work, cwd: metadata.thread.cwd, epoch, version };
      if (!await this.options.validateHistoryMetadata?.(work, native)) throw new CollaborationControlError("permission_denied");
      current();
      const page = await transport.request("thread/turns/list", { threadId: work.native_id, limit, ...(cursor ? { cursor } : {}), sortDirection: "desc", itemsView: "full" });
      current();
      if (!Array.isArray(page?.data) || page.data.length > limit || (page.nextCursor != null && !identity(page.nextCursor))) throw new CollaborationControlError("invalid");
      const items: ReconciliationPage["items"] = [];
      for (const turn of page.data) {
        if (!identity(turn?.id) || turn.itemsView !== "full" || !Array.isArray(turn.items) || turn.items.length > 10_000) throw new CollaborationControlError("invalid");
        for (const item of turn.items) {
          if (item?.type !== "userMessage") continue;
          if (!identity(item.id) || (item.clientId != null && !identity(item.clientId))) throw new CollaborationControlError("invalid");
          items.push({ native_turn_id: turn.id, native_message_id: item.id, ...(item.clientId ? { source_client_message_id: item.clientId } : {}) });
          if (items.length > 25) throw new CollaborationControlError("too_large");
        }
      }
      if (!await this.options.validateHistoryMetadata?.(work, native)) throw new CollaborationControlError("permission_denied");
      current();
      return { work: { ...work }, native_interface_version: version, connector_epoch: epoch, source: "codex.saved_history", observed_at: new Date().toISOString(), items, next_cursor: page.nextCursor ?? null };
    } catch (error) {
      if (error instanceof CollaborationControlError || error instanceof NativeTransportError) throw error;
      throw new CollaborationControlError("permission_denied");
    }
  }
  close(): void { this.options.transport.close(); }
}
