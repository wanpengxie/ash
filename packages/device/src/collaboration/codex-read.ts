import { realpathSync, lstatSync } from "node:fs";
import { currentReadSource, startReadSourceProcess, attestReadSourceProcess, closeReadSourceProcess, readSourceDrained, ReadSourceError, type ProtectedReadSource } from "./read-source";
import { isAbsolute, resolve } from "node:path";
import { JsonProcess, type Command, type Frame } from "../agents/process";
import { redactText } from "../redact";
import { CollaborationReadError, type HistoryTurn, type MaterialReference, type PageInput, type ReadPage, type VisibleMessage, type WorkRef, type WorkSummary } from "./types";

export interface CodexReadOptions {
  node_id: string;
  endpoint_id: string;
  /** Exact source working directories explicitly approved locally. Empty means no access. */
  allowedCwds?: readonly string[];
  source?: ProtectedReadSource;
  /** Explicit isolated protocol fixtures only. Never supplied by production or wire input. */
  testing?: { command: Command; processCwd?: string };
  timeoutMs?: number;
}
export interface CodexReadInput extends PageInput { /** Trusted device call fence, never wire data. */ current?: () => undefined }
const READ_METHODS = new Set(["initialize", "thread/list", "thread/read", "thread/turns/list"]);
// Parsed source results and complete returned pages are capped at 1 MiB.
// JsonProcess separately caps incoming frames at 8 MiB before parsing. This
// post-parse check does not promise a 1 MiB transport or source-memory bound.
const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 100;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);

/** Saved-history reader. It never loads, resumes, creates, steers or interrupts a thread. */
export class CodexReadAdapter {
  private process?: JsonProcess;
  private ready?: Promise<void>;
  private creation?: Promise<JsonProcess>;
  private stopped = false;
  private readonly scopes: Set<string>;
  private readonly directories = new Map<string, string>();
  private closing?: Promise<void>;
  private drainedPromise?: Promise<void>;
  private readonly cursors = new Map<string, Map<string, string>>();
  constructor(private readonly options: CodexReadOptions) {
    if (!identity(options.node_id) || !identity(options.endpoint_id)) throw new CollaborationReadError("invalid", "Invalid source identity");
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)) throw new CollaborationReadError("invalid", "Invalid read timeout");
    if ((options.allowedCwds ?? []).some(cwd => typeof cwd !== "string" || !isAbsolute(cwd))) throw new CollaborationReadError("invalid", "Read scopes must be absolute directories");
    this.scopes = new Set((options.allowedCwds ?? []).map(cwd => resolve(cwd)));
    if (!options.testing) for (const cwd of this.scopes) this.directories.set(cwd, this.directory(cwd));
  }
  private directory(cwd: string): string {
    try { const s = lstatSync(cwd, {bigint:true}); if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(cwd) !== cwd) throw new Error(); return [s.dev,s.ino].join(":"); }
    catch { throw new CollaborationReadError("permission_denied", "History scope directory changed"); }
  }
  private current(input?: CodexReadInput): void {
    if (input?.current && input.current() !== undefined) throw new CollaborationReadError("permission_denied", "Read authorization changed");
    if (input?.signal?.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
    if (this.options.source) currentReadSource(this.options.source);
    else if (!this.options.testing) throw new CollaborationReadError("source_required", "Select a protected saved history source");
    for (const [cwd, before] of this.directories) if (this.directory(cwd) !== before) throw new CollaborationReadError("permission_denied", "History scope directory changed");
  }
  private authorize(): void {
    if (!this.scopes.size) throw new CollaborationReadError("permission_denied", "No desktop history scope is authorized");
    if (this.stopped) throw new CollaborationReadError("offline", "History reader is closed");
  }
  private permitted(cwd: unknown): cwd is string { return typeof cwd === "string" && isAbsolute(cwd) && this.scopes.has(resolve(cwd)); }
  private ref(id: string): WorkRef { return { node_id: this.options.node_id, endpoint_id: this.options.endpoint_id, kind: "conversation", native_id: id }; }
  private materialRefs(content: unknown): MaterialReference[] {
    if (!Array.isArray(content)) return [];
    const refs: MaterialReference[] = [];
    const present = (value: unknown): value is string => typeof value === "string" && value.length > 0;
    // UserInput variants verified in the locally generated Codex protocol schema.
    // Copy only a discriminator and original position, never source locators.
    content.forEach((part, index) => {
      if (!part || typeof part !== "object") return;
      let kind: MaterialReference["kind"];
      switch (part.type) {
        case "image": if (!present(part.url) && !present(part.fileId)) return; kind = "image"; break;
        case "localImage": if (!present(part.path)) return; kind = "image"; break;
        case "audio": if (!present(part.url)) return; kind = "audio"; break;
        case "localAudio": if (!present(part.path)) return; kind = "audio"; break;
        case "skill": case "mention": if (!present(part.name) || !present(part.path)) return; kind = part.type; break;
        default: return;
      }
      refs.push({ source_part_index: index, kind, source_type: part.type, availability: "reference_only" });
    });
    return refs;
  }
  private pageInput(input: PageInput): { limit: number; cursor?: string } {
    const limit = input.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS || (input.cursor !== undefined && !identity(input.cursor))) throw new CollaborationReadError("invalid", "Invalid history pagination");
    return { limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
  }
  private async start(input: CodexReadInput): Promise<void> {
    this.current(input);
    if (!this.ready) this.ready = (async () => {
      this.creation = this.options.source ? startReadSourceProcess(this.options.source) : Promise.resolve(new JsonProcess(this.options.testing!.command, this.options.testing!.processCwd ?? process.cwd()));
      this.process = await this.creation;
      this.authorize(); this.current(input);
      this.process.onFrame = frame => {
        if (frame.id !== undefined && !frame.method) {
          // JsonProcess exposes error messages, not native error codes.
          const error = frame.error?.code === -32602 ? { ...frame.error, message: "Invalid history request" } : frame.error;
          this.process!.settle(frame.id, frame.result, error);
        }
        // Ignore notifications; do not answer native requests with an execution decision.
      };
      // A source exit may leave descendants alive; close the whole process group.
      this.process.onExit = () => {
        this.stopped = true;
        queueMicrotask(() => { void this.close().catch(() => {}); });
      };
      this.current(input);
      const initialized = await this.process.request("initialize", { clientInfo: { name: "ash-history-reader", version: "0.1.0" }, capabilities: { experimentalApi: true } }, this.options.timeoutMs ?? 15_000);
      this.current(input);
      if (this.options.source && initialized?.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] !== this.options.source.version) throw new CollaborationReadError("unsupported", "Saved history client version changed");
      this.process.write({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.current(input);
    })();
    await this.ready;
    this.current(input);
  }
  private async request(method: string, params: Frame, input: CodexReadInput): Promise<any> {
    const signal = input.signal;
    this.authorize(); this.current(input);
    if (!READ_METHODS.has(method)) throw new CollaborationReadError("unsupported", "History reader only supports read methods");
    if (signal?.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
    const abort = () => { void this.close().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.start(input);
      this.current(input);
      if (signal?.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
      this.current(input);
      const result = await this.process!.request(method, params, this.options.timeoutMs ?? 15_000);
      this.current(input);
      if (this.options.source) attestReadSourceProcess(this.options.source, this.process!);
      this.current(input);
      if (Buffer.byteLength(JSON.stringify(result ?? null)) > MAX_BYTES) throw new CollaborationReadError("too_large", "History source page exceeds 1 MiB");
      return result;
    } catch (error) {
      if (signal?.aborted) throw new CollaborationReadError("cancelled", "History read cancelled");
      if (error instanceof CollaborationReadError) throw error;
      if (error instanceof ReadSourceError) throw new CollaborationReadError(error.code === "stale" ? "permission_denied" : error.code === "source_not_running" || error.code === "ambiguous_source" ? "offline" : error.code, "Saved history source changed or unavailable");
      const message = redactText(error instanceof Error ? error.message : "History source failed").slice(0, 4096);
      if (/timed out|timeout/i.test(message)) { void this.close().catch(() => {}); throw new CollaborationReadError("timeout", "History read timed out"); }
      const code = /invalid history request|(?:invalid|expired|stale|malformed).*cursor|cursor.*(?:invalid|expired|stale|malformed)/i.test(message) ? "invalid" : /unsupported|unknown method|method not found/i.test(message) ? "unsupported" : /not found|not_found|does not exist/i.test(message) ? "not_found" : "offline";
      throw new CollaborationReadError(code, message);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  private cursorTrail(key: string, cursor?: string): Map<string, string> {
    // An uncursored refresh starts a new traversal. Opaque source cursors may
    // be reused when saved history changes. Capture the trail before requesting
    // so a late response from an old traversal cannot alter a newer refresh.
    let trail = cursor === undefined ? undefined : this.cursors.get(key);
    if (!trail) {
      trail = new Map<string, string>();
      if (this.cursors.size >= 128 && !this.cursors.has(key)) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(key, trail);
    }
    if (cursor !== undefined && trail.size >= 128) throw new CollaborationReadError("too_large", "History traversal exceeds 128 cursor edges; refresh from the first page");
    return trail;
  }
  private nativePage(result: any, limit: number, trail: Map<string, string>, cursor?: string): { data: any[]; next: string | null } {
    if (!result || !Array.isArray(result.data) || result.data.length > limit || (result.nextCursor != null && !identity(result.nextCursor))) throw new CollaborationReadError("invalid", "Invalid source history page");
    const next = result.nextCursor ?? null;
    if (next) {
      const edges = new Map(trail);
      const origin = cursor ?? "";
      edges.set(origin, next);
      let current: string | undefined = next;
      const seen = new Set([origin]);
      while (current !== undefined) {
        if (seen.has(current)) throw new CollaborationReadError("invalid", "History source repeated a pagination cursor");
        seen.add(current); current = edges.get(current);
      }
      // Keep all cycle evidence. Silently evicting old edges would allow a
      // longer cursor ring to run forever. This also handles in-flight pages
      // that began before another response reached the traversal bound.
      if (edges.size > 128) throw new CollaborationReadError("too_large", "History traversal exceeds 128 cursor edges; refresh from the first page");
      trail.clear();
      for (const [from, to] of edges) trail.set(from, to);
    } else if (cursor !== undefined) {
      trail.delete(cursor);
    }
    return { data: result.data, next };
  }
  private page<T>(items: T[], next: string | null): ReadPage<T> {
    const page: ReadPage<T> = { items, next_cursor: next, observed_at: new Date().toISOString(), completeness: "source_page", source: "codex.saved_history", runtime_state: "unknown" };
    if (Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES) throw new CollaborationReadError("too_large", "Visible history page exceeds 1 MiB");
    return page;
  }
  async listWork(input: CodexReadInput = {}): Promise<ReadPage<WorkSummary>> {
    this.authorize(); const params = this.pageInput(input);
    const trail = this.cursorTrail("list", params.cursor);
    const result = await this.request("thread/list", { ...params, sortKey: "updated_at", sortDirection: "desc", cwd: [...this.scopes], useStateDbOnly: true }, input);
    const { data, next } = this.nativePage(result, params.limit, trail, params.cursor);
    const items = new Map<string, WorkSummary>();
    for (const thread of data) {
      if (!thread || !identity(thread.id) || !this.permitted(thread.cwd)) continue;
      items.set(thread.id, { work: this.ref(thread.id), cwd: thread.cwd, title: redactText(typeof thread.name === "string" ? thread.name : typeof thread.preview === "string" ? thread.preview : "Untitled conversation"), updated_at: typeof thread.updatedAt === "number" && Number.isFinite(thread.updatedAt) ? thread.updatedAt : null, runtime_state: "unknown" });
    }
    this.current(input); return this.page([...items.values()], next);
  }
  async readWork(work: WorkRef, input: CodexReadInput = {}): Promise<ReadPage<HistoryTurn>> {
    this.authorize(); const params = this.pageInput(input);
    if (!work || work.node_id !== this.options.node_id || work.endpoint_id !== this.options.endpoint_id || work.kind !== "conversation" || !identity(work.native_id)) throw new CollaborationReadError("permission_denied", "Work reference does not belong to this source");
    const metadata = await this.request("thread/read", { threadId: work.native_id, includeTurns: false }, input);
    if (!metadata?.thread || metadata.thread.id !== work.native_id || !this.permitted(metadata.thread.cwd)) throw new CollaborationReadError("permission_denied", "Conversation is outside the authorized directories");
    const trail = this.cursorTrail(`turns:${work.native_id}`, params.cursor);
    const result = await this.request("thread/turns/list", { ...params, threadId: work.native_id, sortDirection: "desc", itemsView: "full" }, input);
    const { data, next } = this.nativePage(result, params.limit, trail, params.cursor);
    const turns = new Map<string, HistoryTurn>();
    for (const turn of data) {
      if (!turn || !identity(turn.id) || !Array.isArray(turn.items) || turn.items.length > 10_000 || turn.itemsView !== "full") throw new CollaborationReadError("invalid", "Source did not return full history turns");
      const messages = new Map<string, VisibleMessage>();
      for (const item of turn.items) {
        if (!item || !identity(item.id) || !["userMessage", "agentMessage"].includes(item.type)) continue;
        const text = item.type === "agentMessage" ? item.text : Array.isArray(item.content) ? item.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : undefined;
        if (typeof text !== "string") continue;
        const refs = item.type === "userMessage" ? this.materialRefs(item.content) : [];
        // Preserve exact native IDs for correlation; omit unsafe IDs rather than
        // redacting them into a different identity. Never match messages by text.
        const clientId = item.type === "userMessage" && identity(item.clientId) && redactText(item.clientId) === item.clientId ? item.clientId : undefined;
        messages.set(item.id, { work: this.ref(work.native_id), turn_id: turn.id, source_message_id: item.id, role: item.type === "userMessage" ? "user" : "assistant", text: redactText(text), ...(clientId === undefined ? {} : { source_client_message_id: clientId }), ...(refs.length ? { material_refs: refs } : {}), ...(typeof item.phase === "string" ? { phase: item.phase } : {}) });
      }
      turns.set(turn.id, { turn_id: turn.id, history_status: typeof turn.status === "string" ? turn.status : null, status_source: "codex.saved_history", messages: [...messages.values()] });
    }
    // Each observation replaces content for an existing turn/item ID; clients must upsert, not append.
    this.current(input); return this.page([...turns.values()], next);
  }
  close(): Promise<void> {
    this.stopped = true; this.cursors.clear();
    return this.closing ??= (async () => {
      // start() may still be acquiring its exact source-issued child.
      try { await this.creation; } catch {}
      if (this.options.source) { if (this.process) await closeReadSourceProcess(this.options.source, this.process); }
      else await this.process?.close();
    })();
  }
  /** Actual settlement, including escaped pipe holders; no bounded close promise
   * may release the service slot or retained source. */
  drained(): Promise<void> {
    return this.drainedPromise ??= (async () => {
      try { await this.close(); } catch {}
      if (this.options.source) await readSourceDrained(this.options.source);
      else await this.closing;
    })();
  }
}
