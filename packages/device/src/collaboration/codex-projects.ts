import { isAbsolute, resolve } from "node:path";
import { CollaborationCreateError, type CreateProjectScope, type CreateReadContext, type CreateTarget } from "./create-types";
import { NativeTransportError } from "./codex-transport";
import type { CodexCreateTransport } from "./codex-create-transport";
export const createIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
export const createCwd = (value: unknown): value is string => createIdentity(value) && isAbsolute(value) && resolve(value) === value;
export function createError(error: unknown): CollaborationCreateError {
  if (error instanceof CollaborationCreateError) return error;
  if (error instanceof NativeTransportError) return new CollaborationCreateError(error.code === "unsupported" ? "unsupported" : error.code === "too_large" ? "too_large" : error.code === "invalid" ? "invalid" : "offline");
  return new CollaborationCreateError("result_unknown");
}
/** Capture only fixed fields before the first authorization await; caller mutation cannot retarget I/O. */
export function snapshotCreateContext<T extends CreateReadContext>(context: T): T {
  return Object.freeze({ ...context, authorized_scope: Object.freeze({ ...context.authorized_scope }), authorize: context.authorize.bind(context), deadline: context.deadline, signal: context.signal }) as T;
}
export function assertCreateScope(scope: CreateProjectScope, context: CreateReadContext): void {
  const allowed = context.authorized_scope;
  if (!allowed || !createCwd(allowed.cwd) || scope.node_id !== allowed.node_id || scope.endpoint_id !== allowed.endpoint_id || scope.cwd !== allowed.cwd) throw new CollaborationCreateError("permission_denied");
}
/** authorize is the final asynchronous operation: the synchronous epoch/deadline check follows it. */
export async function createGate(transport: CodexCreateTransport, context: CreateReadContext, epoch: string, version: string): Promise<void> {
  if (!await context.authorize().catch(() => false)) throw new CollaborationCreateError("permission_denied");
  if (context.signal?.aborted || !Number.isFinite(context.deadline) || context.deadline <= Date.now()) throw new CollaborationCreateError("expired");
  if (epoch === "disconnected" || transport.epoch !== epoch || transport.version !== version) throw new CollaborationCreateError("stale_precondition");
  try { transport.verifyCurrent(); } catch { throw new CollaborationCreateError("offline"); }
}
/** Entire inventory must be bounded and exhausted before even an exact selected ID is usable. */
export async function codexProjects(transport: CodexCreateTransport, scope: CreateProjectScope, context: CreateReadContext): Promise<{ project_id: string; cwd: string }[]> {
  scope = Object.freeze({ ...scope }); context = snapshotCreateContext(context);
  const epoch = transport.epoch, version = transport.version;
  let result: { project_id: string; cwd: string }[] = [], failure: unknown;
  try {
    assertCreateScope(scope, context);
    if (!createCwd(scope.cwd)) throw new CollaborationCreateError("invalid");
    const cursors = new Set<string>(), ids = new Set<string>(); let cursor: string | null = null, bytes = 0, total = 0;
    for (let page = 0; page < 4; page++) {
      await createGate(transport, context, epoch, version);
      const response = await transport.request("project/list", { limit: 25, ...(cursor ? { cursor } : {}) }, context.deadline);
      await createGate(transport, context, epoch, version);
      bytes += Buffer.byteLength(JSON.stringify(response) ?? "");
      if (bytes > 1024 * 1024) throw new CollaborationCreateError("too_large");
      if (!Array.isArray(response?.data) || response.data.length > 25) throw new CollaborationCreateError("result_unknown");
      total += response.data.length;
      if (total > 100) throw new CollaborationCreateError("too_large");
      for (const project of response.data) {
        if (!createIdentity(project?.id) || ids.has(project.id) || !Array.isArray(project.roots) || project.roots.length > 100) throw new CollaborationCreateError("result_unknown");
        ids.add(project.id);
        const roots = project.roots.map((root: any) => {
          if (!createIdentity(root?.path) || !isAbsolute(root.path)) throw new CollaborationCreateError("result_unknown");
          return resolve(root.path);
        });
        if (roots.includes(scope.cwd)) result.push({ project_id: project.id, cwd: scope.cwd });
      }
      const next = response.nextCursor ?? null;
      if (next === null) { cursor = null; break; }
      if (!createIdentity(next) || cursors.has(next)) throw new CollaborationCreateError("result_unknown");
      cursors.add(next); cursor = next;
    }
    if (cursor !== null) throw new CollaborationCreateError("result_unknown");
  } catch (error) { failure = error; }
  await createGate(transport, context, epoch, version);
  if (failure) throw createError(failure);
  return result;
}
export async function resolveCodexProject(transport: CodexCreateTransport, target: CreateTarget, context: CreateReadContext): Promise<CreateTarget> {
  target = Object.freeze({ ...target }); context = snapshotCreateContext(context);
  const projects = await codexProjects(transport, target, context);
  if (!createIdentity(target.project_id) || projects.filter(project => project.project_id === target.project_id).length !== 1) throw new CollaborationCreateError("stale_precondition");
  return { ...target };
}
