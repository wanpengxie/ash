import { CollaborationCreateError, type CreateAdapter, type CreateInvocation, type CreateOutcome, type CreateProjectScope, type CreateReadContext, type CreateStage, type CreateTarget } from "./create-types";
import { parseCreateWorkRequest } from "./create-protocol";
import type { HistoryTurn, ReadPage, WorkRef } from "./types";
import { CodexCreateTransport } from "./codex-create-transport";
import { codexProjects, createCwd, createError, createGate, createIdentity, resolveCodexProject, assertCreateScope, snapshotCreateContext } from "./codex-projects";
export interface CodexCreateOptions { node_id: string; endpoint_id: string; transport: CodexCreateTransport }
/** Stage intent/client ID durability is owned by the caller's journal. No automatic stage chaining or replay. */
export class CodexCreateAdapter implements CreateAdapter {
  private attempted = new Set<string>();
  private busy = new Set<string>();
  get connector_epoch(): string { return this.options.transport.epoch; }
  get native_interface_version(): string { return this.options.transport.version; }
  constructor(private readonly options: CodexCreateOptions) {}
  async connect(): Promise<void> { await this.options.transport.connect(); }
  close(): void { this.options.transport.close(); }
  private scope(scope: CreateProjectScope): void {
    if (scope.node_id !== this.options.node_id || scope.endpoint_id !== this.options.endpoint_id || !createCwd(scope.cwd)) throw new CollaborationCreateError("permission_denied");
  }
  private work(work: WorkRef): void {
    if (work.node_id !== this.options.node_id || work.endpoint_id !== this.options.endpoint_id || work.kind !== "conversation" || !createIdentity(work.native_id)) throw new CollaborationCreateError("permission_denied");
  }
  async projects(scope: CreateProjectScope, context: CreateReadContext): Promise<{ project_id: string; cwd: string }[]> {
    scope = Object.freeze({ ...scope }); context = snapshotCreateContext(context);
    this.scope(scope); assertCreateScope(scope, context); return codexProjects(this.options.transport, scope, context);
  }
  async resolveProject(target: CreateTarget, context: CreateReadContext): Promise<CreateTarget> {
    target = Object.freeze({ ...target }); context = snapshotCreateContext(context);
    this.scope(target); assertCreateScope(target, context); return resolveCodexProject(this.options.transport, target, context);
  }
  createThread(invocation: CreateInvocation): Promise<CreateOutcome> { return this.invoke("create", invocation); }
  nameThread(invocation: CreateInvocation & { work: WorkRef }): Promise<CreateOutcome> { return this.invoke("name", invocation, invocation.work); }
  startFirstInput(invocation: CreateInvocation & { work: WorkRef; native_client_message_id: string }): Promise<CreateOutcome> {
    return this.invoke("first_input", invocation, invocation.work, invocation.native_client_message_id);
  }
  private async invoke(stage: CreateStage, invocation: CreateInvocation, work?: WorkRef, client?: string): Promise<CreateOutcome> {
    const capturedContext = snapshotCreateContext(invocation);
    let request;
    try { request = parseCreateWorkRequest(invocation.request); }
    catch (error) {
      await createGate(this.options.transport, capturedContext, invocation.connector_epoch, invocation.native_interface_version);
      throw createError(error);
    }
    invocation = Object.freeze({ ...capturedContext, principal: Object.freeze({ ...invocation.principal }), request: Object.freeze({ ...request, target: Object.freeze({ ...request.target }), input: Object.freeze({ ...request.input }) }) });
    if (work) work = Object.freeze({ ...work });
    const transport = this.options.transport, epoch = invocation.connector_epoch, version = invocation.native_interface_version;
    const key = JSON.stringify([invocation.principal.principal_id, invocation.request.operation_id, stage]);
    const context: CreateReadContext = { ...invocation, deadline: Math.min(invocation.deadline, invocation.request.expires_at) };
    let sent = false, ownsBusy = false, outcome: CreateOutcome | undefined, failure: unknown;
    try {
      this.scope(invocation.request.target); assertCreateScope(invocation.request.target, context);
      if (!createIdentity(invocation.attempt_id) || !createIdentity(invocation.request.operation_id) || !createIdentity(invocation.principal.principal_id)) throw new CollaborationCreateError("invalid");
      if (this.attempted.has(key)) throw new CollaborationCreateError("result_unknown");
      if (this.busy.has(key)) throw new CollaborationCreateError("busy");
      this.busy.add(key); ownsBusy = true;
      await createGate(transport, context, epoch, version);
      if (stage === "create") await this.resolveProject(invocation.request.target, context);
      else {
        if (!work) throw new CollaborationCreateError("invalid");
        this.work(work);
        const metadata = await this.metadata(work, context);
        if (metadata.cwd !== invocation.request.target.cwd) throw new CollaborationCreateError("permission_denied");
      }
      if (stage === "first_input" && !createIdentity(client)) throw new CollaborationCreateError("invalid");
      if (typeof invocation.request.title !== "string" || !invocation.request.title.trim() || Buffer.byteLength(invocation.request.title) > 256 || typeof invocation.request.input.text !== "string" || !invocation.request.input.text.trim() || Buffer.byteLength(invocation.request.input.text) > 64 * 1024) throw new CollaborationCreateError("invalid");
      if (this.attempted.size >= 10_000) throw new CollaborationCreateError("too_large");
      await createGate(transport, context, epoch, version);
      this.attempted.add(key); sent = true;
      if (stage === "create") {
        const result = await transport.request("thread/start", { cwd: invocation.request.target.cwd, projectId: invocation.request.target.project_id, ephemeral: false }, context.deadline);
        const thread = result?.thread;
        if (!createIdentity(thread?.id) || thread.cwd !== invocation.request.target.cwd || (thread.projectId !== undefined && thread.projectId !== invocation.request.target.project_id)) throw new CollaborationCreateError("result_unknown");
        const created: WorkRef = { node_id: this.options.node_id, endpoint_id: this.options.endpoint_id, kind: "conversation", native_id: thread.id };
        const metadata = await this.metadata(created, context);
        if (metadata.cwd !== invocation.request.target.cwd) throw new CollaborationCreateError("result_unknown");
        outcome = { status: "accepted", receipt: { stage, accepted_by: "native", work: created } };
      } else if (stage === "name") {
        const result = await transport.request("thread/name/set", { threadId: work!.native_id, name: invocation.request.title }, context.deadline);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new CollaborationCreateError("result_unknown");
        if ((result?.threadId !== undefined && result.threadId !== work!.native_id) || (result?.thread !== undefined && (result.thread.id !== work!.native_id || (result.thread.cwd !== undefined && result.thread.cwd !== invocation.request.target.cwd)))) throw new CollaborationCreateError("result_unknown");
        outcome = { status: "accepted", receipt: { stage, accepted_by: "native", work: { ...work! } } };
      } else {
        const result = await transport.request("turn/start", { threadId: work!.native_id, input: [{ type: "text", text: invocation.request.input.text, text_elements: [] }], clientUserMessageId: client }, context.deadline);
        if (!createIdentity(result?.turn?.id) || (result.threadId !== undefined && result.threadId !== work!.native_id) || (result.clientUserMessageId !== undefined && result.clientUserMessageId !== client) || (result.turn.clientUserMessageId !== undefined && result.turn.clientUserMessageId !== client)) throw new CollaborationCreateError("result_unknown");
        // A turn acknowledgement alone does not prove stable client→message association.
        outcome = { status: "accepted", receipt: { stage, accepted_by: "native", work: { ...work! }, native_turn_id: result.turn.id, native_message_id: null, correlation: "uncertain" } };
      }
    } catch (error) { failure = error; }
    finally { if (ownsBusy) this.busy.delete(key); }
    try { await createGate(transport, context, epoch, version); }
    catch (error) { failure = error; }
    if (failure) {
      if (sent) throw new CollaborationCreateError("result_unknown");
      throw createError(failure);
    }
    return outcome!;
  }
  async metadata(work: WorkRef, context: CreateReadContext): Promise<{ work: WorkRef; cwd: string }> {
    work = Object.freeze({ ...work }); context = snapshotCreateContext(context);
    const transport = this.options.transport, epoch = transport.epoch, version = transport.version;
    let result: { work: WorkRef; cwd: string } | undefined, failure: unknown;
    try {
      this.work(work); assertCreateScope({ ...work, cwd: context.authorized_scope?.cwd }, context); await createGate(transport, context, epoch, version);
      const response = await transport.request("thread/read", { threadId: work.native_id, includeTurns: false }, context.deadline);
      if (response?.thread?.id !== work.native_id || !createCwd(response.thread.cwd) || response.thread.cwd !== context.authorized_scope.cwd) throw new CollaborationCreateError("permission_denied");
      result = { work: { ...work }, cwd: response.thread.cwd };
    } catch (error) { failure = error; }
    await createGate(transport, context, epoch, version);
    if (failure) throw createError(failure);
    return result!;
  }
  async history(work: WorkRef, context: CreateReadContext & { cursor?: string; limit?: number }): Promise<ReadPage<HistoryTurn>> {
    work = Object.freeze({ ...work }); context = snapshotCreateContext(context);
    const transport = this.options.transport, epoch = transport.epoch, version = transport.version;
    let result: ReadPage<HistoryTurn> | undefined, failure: unknown;
    try {
      this.work(work);
      const limit = context.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25 || (context.cursor !== undefined && !createIdentity(context.cursor))) throw new CollaborationCreateError("invalid");
      const before = await this.metadata(work, context);
      await createGate(transport, context, epoch, version);
      const page = await transport.request("thread/turns/list", { threadId: work.native_id, limit, ...(context.cursor ? { cursor: context.cursor } : {}), sortDirection: "desc", itemsView: "full" }, context.deadline);
      if (!Array.isArray(page?.data) || page.data.length > limit || (page.nextCursor != null && (!createIdentity(page.nextCursor) || page.nextCursor === context.cursor))) throw new CollaborationCreateError("result_unknown");
      const seen = new Set<string>(), messageIds = new Set<string>(), clientIds = new Set<string>(); let count = 0;
      const items: HistoryTurn[] = page.data.map((turn: any) => {
        if (!createIdentity(turn?.id) || seen.has(turn.id) || turn.itemsView !== "full" || !Array.isArray(turn.items) || turn.items.length > 100) throw new CollaborationCreateError("result_unknown");
        seen.add(turn.id);
        const messages: HistoryTurn["messages"] = [];
        for (const item of turn.items) {
          if (item?.type !== "userMessage") continue;
          if (!createIdentity(item.id) || messageIds.has(item.id) || (item.clientId != null && (!createIdentity(item.clientId) || clientIds.has(item.clientId))) || ++count > 100) throw new CollaborationCreateError("result_unknown");
          messageIds.add(item.id); if (item.clientId) clientIds.add(item.clientId);
          messages.push({ work: { ...work }, turn_id: turn.id, source_message_id: item.id, ...(item.clientId ? { source_client_message_id: item.clientId } : {}), role: "user", text: "" });
        }
        return { turn_id: turn.id, history_status: null, status_source: "codex.saved_history", messages };
      });
      const after = await this.metadata(work, context);
      if (after.cwd !== before.cwd) throw new CollaborationCreateError("permission_denied");
      result = { items, next_cursor: page.nextCursor ?? null, observed_at: new Date().toISOString(), completeness: "source_page", source: "codex.saved_history", runtime_state: "unknown" };
    } catch (error) { failure = error; }
    await createGate(transport, context, epoch, version);
    if (failure) throw createError(failure);
    return result!;
  }
}
