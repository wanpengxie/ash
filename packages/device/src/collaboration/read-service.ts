import type { CallResult } from "./compat";
import { CodexReadAdapter, type CodexReadOptions, type CodexReadInput } from "./codex-read";
import { deniedReadAuthorization, readAuthorizationSnapshot, type ReadAuthorizationSnapshot, type TrustedCallContext } from "./authorization";
import { currentPinnedOwnerId, parseCurrentPairing } from "./pairing";
import { readLocalStateFile } from "./local-state";
import { LocalStateTransaction } from "./local-state-transaction";
import { COLLABORATION_LIST, COLLABORATION_READ, readCapabilities } from "./capabilities";
import { captureProtectedReadSource, currentReadSource, releaseReadSource, readSourceDrained, readSourcePath, ReadSourceError, type ProtectedReadSource } from "./read-source";
import { CollaborationReadError, type WorkRef, type PageInput, type ReadPage, type WorkSummary, type HistoryTurn } from "./types";

export interface HistoryReader {
  listWork(input?: CodexReadInput): Promise<ReadPage<WorkSummary>>;
  readWork(work: WorkRef, input?: CodexReadInput): Promise<ReadPage<HistoryTurn>>;
  close(): Promise<void>;
  drained?(): Promise<void>;
}
export interface ReadServiceOptions {
  stateDir: string; nodeId: string;
  /** Legacy injection shape retained for a later main dependency migration.
   * Production never accepts this unprotected factory. */
  factory?: (options: CodexReadOptions) => HistoryReader;
  testing?: {
    factory?: (options: CodexReadOptions) => HistoryReader;
    source?: { capture(current: () => undefined): ProtectedReadSource; current(source: ProtectedReadSource): undefined; drained(source: ProtectedReadSource): Promise<void>; release(source: ProtectedReadSource): undefined };
  };
  authorization?: () => ReadAuthorizationSnapshot;
  timeoutMs?: number;
}
/** Fixed read-only dispatch with a fresh authorization check before and after every observation. */
export class CollaborationReadService {
  private snapshot: ReadAuthorizationSnapshot;
  private readonly transaction: LocalStateTransaction;
  private reader?: HistoryReader;
  private source?: ProtectedReadSource;
  private unavailableSource?: string;
  private epoch = 0;
  private stopped = false;
  private readonly pending = new Map<AbortController, TrustedCallContext>();
  private readonly closing = new Set<Promise<void>>();
  private readonly monitor: ReturnType<typeof setInterval>;
  constructor(private readonly options: ReadServiceOptions) {
    if (options.factory) throw new CollaborationReadError("invalid", "Reader factory requires explicit testing injection");
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)) throw new CollaborationReadError("invalid", "Invalid read timeout");
    this.transaction = new LocalStateTransaction(options.stateDir, () => this.invalidate());
    this.snapshot = this.load();
    this.monitor = setInterval(() => {
      this.refresh();
      if (this.source) try { this.sourceCurrent(this.source); } catch { this.invalidate(); }
      if ([...this.pending.values()].some(context => !this.ownerCurrent(context))) this.invalidate();
    }, 100);
    this.monitor.unref();
  }
  get busy(): boolean { return this.pending.size > 0 || this.closing.size > 0; }
  private load(): ReadAuthorizationSnapshot {
    try {
      const observed = this.transaction.capture();
      const pairingFile = observed.files["paired.json"];
      const pairing = pairingFile ? parseCurrentPairing(pairingFile.raw) : null;
      const owner = pairing && !pairing.revoked ? pairing.ownerId : null;
      const fingerprint = `${observed.revision}:${observed.epoch}`;
      const file = observed.files["collaboration-read.json"];
      const actual = file ? readAuthorizationSnapshot(JSON.parse(file.raw), this.options.nodeId, owner, fingerprint) : deniedReadAuthorization(this.options.nodeId, "scope_required", fingerprint);
      const supplied = this.options.authorization?.();
      if (supplied) {
        if (supplied.state !== "ready") return deniedReadAuthorization(this.options.nodeId, supplied.state === "scope_required" ? "scope_required" : "invalid_configuration", fingerprint);
        const checked = readAuthorizationSnapshot({ version: supplied.version, owner_id: supplied.owner_id, endpoint_id: supplied.endpoint_id,
          authorization_generation: supplied.authorization_generation, allowedCwds: supplied.allowedCwds, ...(supplied.version === 3 ? {source_id:supplied.source_id,binding_revision:supplied.binding_revision} : {}) }, this.options.nodeId, owner, fingerprint);
        return supplied.authorization_revision === checked.authorization_revision && actual.state === "ready" && actual.authorization_revision === checked.authorization_revision ? checked : deniedReadAuthorization(this.options.nodeId, "invalid_configuration", fingerprint);
      }
      return actual;
    } catch { return deniedReadAuthorization(this.options.nodeId, "invalid_configuration", "unavailable"); }
  }
  private ownerCurrent(context: TrustedCallContext): boolean {
    try {
      const pinned = currentPinnedOwnerId(this.options.stateDir);
      return !!pinned && context.isCurrent() && context.transportOwnerId === pinned && this.snapshot.owner_id === pinned;
    } catch { return false; }
  }
  private sourceCurrent(source: ProtectedReadSource): undefined {
    return this.options.testing?.source ? this.options.testing.source.current(source) : currentReadSource(source);
  }
  private releaseSource(source: ProtectedReadSource): undefined {
    return this.options.testing?.source ? this.options.testing.source.release(source) : releaseReadSource(source);
  }
  private sourceDrained(source: ProtectedReadSource): Promise<void> {
    return this.options.testing?.source ? this.options.testing.source.drained(source) : readSourceDrained(source);
  }
  private refresh() {
    if (this.stopped) return;
    const next = this.load();
    if (next.fingerprint !== this.snapshot.fingerprint || next.state !== this.snapshot.state || next.authorization_revision !== this.snapshot.authorization_revision) { this.invalidate(); this.snapshot = next; }
  }
  private ensureSource(): ProtectedReadSource {
    if (this.snapshot.state !== "ready" || this.snapshot.version !== 3) throw new CollaborationReadError("permission_denied", "Choose a saved history source and grant its scope");
    if (this.closing.size) throw new CollaborationReadError("draining", "Previous saved history reader is still draining");
    if (!this.source) {
      const epoch = this.epoch, revision = this.snapshot.authorization_revision;
      const sourceFence = (): undefined => {
        this.refresh();
        if (this.stopped || epoch !== this.epoch || this.snapshot.authorization_revision !== revision || this.snapshot.state !== "ready") throw new CollaborationReadError("permission_denied", "Read authorization changed");
        return undefined;
      };
      const source = this.options.testing?.source ? this.options.testing.source.capture(sourceFence) : captureProtectedReadSource({stateDir:this.options.stateDir,endpointId:this.options.nodeId,current:sourceFence});
      if (source.source_id !== this.snapshot.source_id || source.source_revision !== this.snapshot.binding_revision) {
        this.releaseSource(source);
        throw new CollaborationReadError("permission_denied", "Saved history source requires a new local scope grant");
      }
      this.source = source;
    }
    this.sourceCurrent(this.source);
    return this.source;
  }
  invalidate(): void {
    this.unavailableSource = undefined;
    this.epoch++;
    for (const controller of this.pending.keys()) controller.abort();
    const reader = this.reader, source = this.source; this.reader = undefined; this.source = undefined;
    if (!reader && source) {
      try { this.releaseSource(source); } catch { const failure = new Promise<void>(() => {}); this.closing.add(failure); }
      return;
    }
    if (reader || source) {
      const closing = (async () => {
        let closeFailure: unknown;
        try { await reader?.close(); } catch (error) { closeFailure = error; }
        // Bounded close can fail while owned raw pipes remain open. Actual drain
        // retains the slot; no error catch permits a replacement reader early.
        if (reader?.drained) await reader.drained();
        else if (closeFailure) await new Promise<void>(() => {});
        if (source) {
          await this.sourceDrained(source);
          try { this.sourceCurrent(source); } catch { /* Invalidated evidence is never returned. */ }
          this.releaseSource(source);
        }
      })();
      this.closing.add(closing);
      // Cleanup failures remain retained fail closed, without unhandled rejection.
      void closing.then(() => {
        this.closing.delete(closing);
        // A draining failure receipt is obsolete only after actual reader/raw
        // settlement and successful source release. Fresh manifest validation
        // still checks the current grant and source; this does not grant access.
        this.unavailableSource = undefined;
      }, () => {});
    }
  }
  private sourceReceipt(): string {
    try { return `${this.snapshot.authorization_revision}:${readLocalStateFile(readSourcePath(this.options.stateDir),16384)?.identity ?? "missing"}`; }
    catch { return `${this.snapshot.authorization_revision}:unavailable`; }
  }
  manifest() {
    this.refresh();
    let advertised = this.snapshot;
    if (advertised.state === "ready") {
      const receipt = this.sourceReceipt();
      // A user refresh always revalidates the source. A failed account/config
      // snapshot cannot hide a restored source behind a negative receipt.
      try { this.ensureSource(); this.unavailableSource = undefined; }
      catch (error) {
        this.invalidate();
        // Availability failures do not revoke the persisted scope. A later
        // user refresh validates a fresh source; dispatch still proves it before
        // returning any history. Only a failed binding/configuration is latched.
        const transient = !receipt.endsWith(":missing") && !receipt.endsWith(":unavailable") && (
          error instanceof ReadSourceError && ["offline", "stale", "timeout", "draining"].includes(error.code)
          || error instanceof CollaborationReadError && error.code === "draining");
        if (!transient) { this.unavailableSource = receipt; advertised = {...this.snapshot,state:"scope_required"}; }
      }
    }
    return { capabilities: readCapabilities(advertised), collaboration: { version: 1, node_id: this.options.nodeId, endpoint_id: this.options.nodeId, adapter: "desktop/codex", authorization_state: advertised.state, runtime_availability: "unknown", authorization_generation: this.snapshot.authorization_generation, authorization_revision: this.snapshot.authorization_revision, scope_kind: "exact_cwd", source: "codex.saved_history", runtime_state: "unknown", control: "unsupported" } };
  }
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, context?: TrustedCallContext): Promise<CallResult> {
    if (context) {
      const supplied = context;
      context = Object.freeze({ transportOwnerId: supplied.transportOwnerId, isCurrent: () => supplied.isCurrent() });
    }
    let controller: AbortController | undefined;
    let removeAbort: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let requestEpoch: number | undefined;
    let requestReader: HistoryReader | undefined;
    try {
      this.refresh();
      if (!context || !this.ownerCurrent(context)) throw new CollaborationReadError("permission_denied", "Trusted paired transport is required");
      if (this.stopped) throw new CollaborationReadError("offline", "History reader is closed");
      if (this.snapshot.state !== "ready") throw new CollaborationReadError("permission_denied", "Select a local desktop history scope first");
      if (name !== COLLABORATION_LIST && name !== COLLABORATION_READ) throw new CollaborationReadError("unsupported", "Unsupported collaboration capability");
      if (!args || typeof args !== "object" || Array.isArray(args) || args.version !== 1 || args.endpoint_id !== this.options.nodeId || Object.keys(args).some(key => !["version", "endpoint_id", "authorization_revision", "page", ...(name === COLLABORATION_READ ? ["work"] : [])].includes(key))) throw new CollaborationReadError("invalid", "Invalid read envelope");
      if (typeof args.authorization_revision !== "string" || !/^[a-f0-9]{64}$/.test(args.authorization_revision) || args.authorization_revision !== this.snapshot.authorization_revision) throw new CollaborationReadError("permission_denied", "Read authorization changed; refresh the endpoint manifest");
      const page = args.page ?? {};
      if (!page || typeof page !== "object" || Array.isArray(page) || Object.keys(page).some(key => !["cursor", "limit"].includes(key))) throw new CollaborationReadError("invalid", "Invalid read page");
      const input = page as PageInput;
      if ((input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) || (input.cursor !== undefined && (typeof input.cursor !== "string" || !input.cursor.length || input.cursor.length > 1024))) throw new CollaborationReadError("invalid", "Invalid read page");
      if (name === COLLABORATION_READ) {
        const work = args.work as WorkRef;
        if (!work || Array.isArray(work) || Object.keys(work).some(key => !["node_id", "endpoint_id", "kind", "native_id"].includes(key)) || work.node_id !== this.options.nodeId || work.endpoint_id !== this.options.nodeId || work.kind !== "conversation" || typeof work.native_id !== "string" || !work.native_id.length || work.native_id.length > 1024 || /[\u0000-\u001f]/.test(work.native_id)) throw new CollaborationReadError("permission_denied", "Work reference does not belong to this endpoint");
      }
      if (signal?.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
      controller = new AbortController(); const active = controller;
      const abort = () => active.abort(); signal?.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal?.removeEventListener("abort", abort);
      this.pending.set(active, context);
      const epoch = this.epoch;
      requestEpoch = epoch;
      this.unavailableSource = undefined;
      const source = this.ensureSource();
      if (!this.reader) {
        try { this.reader = (this.options.testing?.factory ?? (options => new CodexReadAdapter(options)))({ node_id: this.options.nodeId, endpoint_id: this.options.nodeId, allowedCwds: [...this.snapshot.allowedCwds], source }); }
        catch (error) { this.releaseSource(source); this.source = undefined; throw error; }
      }
      requestReader = this.reader;
      this.refresh();
      if (!this.ownerCurrent(context) || epoch !== this.epoch) throw new CollaborationReadError("permission_denied", "Read authorization changed");
      const cancelled = new Promise<never>((_, reject) => active.signal.addEventListener("abort", () => reject(new CollaborationReadError(timedOut ? "timeout" : "cancelled", timedOut ? "History read timed out" : "History read cancelled")), { once: true }));
      timeout = setTimeout(() => { timedOut = true; active.abort(); }, this.options.timeoutMs ?? 30_000);
      const current = (): undefined => {
        this.refresh();
        if (!this.ownerCurrent(context!) || epoch !== this.epoch || args.authorization_revision !== this.snapshot.authorization_revision || this.source !== source) throw new CollaborationReadError("permission_denied", "Read authorization changed");
        this.sourceCurrent(source);
        return undefined;
      };
      current();
      const operation = name === COLLABORATION_LIST ? this.reader.listWork({ ...input, signal: active.signal, current }) : this.reader.readWork(args.work as WorkRef, { ...input, signal: active.signal, current });
      const data = await Promise.race([operation, cancelled]);
      current();
      this.refresh();
      if (!this.ownerCurrent(context) || epoch !== this.epoch || args.authorization_revision !== this.snapshot.authorization_revision) throw new CollaborationReadError("permission_denied", "Read authorization changed");
      if (active.signal.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
      if (Buffer.byteLength(JSON.stringify(data)) > 1024 * 1024) throw new CollaborationReadError("too_large", "History page exceeds 1 MiB");
      this.refresh();
      if (!this.ownerCurrent(context) || epoch !== this.epoch || args.authorization_revision !== this.snapshot.authorization_revision) throw new CollaborationReadError("permission_denied", "Read authorization changed");
      current();
      return { ok: true, content: [], data };
    } catch (error) {
      // A cancelled observation from an older authorization must not close its replacement reader.
      if (controller && requestEpoch === this.epoch && (requestReader === this.reader || error instanceof ReadSourceError)) this.invalidate();
      if (context && !this.ownerCurrent(context)) return { ok: false, content: [], error: "Read authorization changed", data: { code: "permission_denied" } };
      const code = error instanceof CollaborationReadError ? error.code : error instanceof ReadSourceError ? error.code === "stale" ? "offline" : error.code : "offline";
      return { ok: false, content: [], error: `Desktop history read: ${code}`, data: { code } };
    } finally {
      clearTimeout(timeout); removeAbort?.();
      if (controller) this.pending.delete(controller);
    }
  }
  async close(): Promise<void> { this.stopped = true; clearInterval(this.monitor); this.transaction.close(); this.invalidate(); await Promise.all([...this.closing]); }
}
