import {
  CREATE_CAPABILITIES, CREATE_DEADLINE_MS, CREATE_INPUT_MAX_BYTES, CREATE_OUTPUT_MAX_BYTES,
  createObject, parseCreateEnvelope, parseCreateManifest, validateCreateResponse,
  type CreateEnvelope, type CoreCreateEnvelope, type CreateManifestDto, type CreateOperation, type CreateResponse,
} from "../../../../sdk/src/collaboration/create-protocol";
import { CollaborationCreateError } from "../../../../sdk/src/collaboration/create-types";

export { CREATE_CAPABILITIES };
export type { CreateOperation, CoreCreateEnvelope, CreateResponse };
export const CREATE_INPUT_BYTES = CREATE_INPUT_MAX_BYTES;
export const CREATE_OUTPUT_BYTES = CREATE_OUTPUT_MAX_BYTES;
export const CREATE_ROUTES = {
  "/api/collaboration/create/projects": "projects",
  "/api/collaboration/create/apply": "apply",
  "/api/collaboration/create/query": "query",
  "/api/collaboration/create/reconcile": "reconcile",
} as const;
export const CREATE_ERROR_STATUS = {
  invalid: 400, too_large: 413, permission_denied: 403, expired: 410, conflict: 409, busy: 409,
  storage_failure: 503, unsupported: 422, offline: 503, stale_precondition: 409, result_unknown: 409,
  timeout: 504, cancelled: 499,
} as const;
export type CoreCreateErrorCode = keyof typeof CREATE_ERROR_STATUS;
export class CoreCreateError extends Error {
  constructor(readonly code: CoreCreateErrorCode) { super(`Collaboration create ${code}`); }
}
const createDeadlines = new WeakMap<AbortSignal, number>();
function assertCreateBudget(signal: AbortSignal): void {
  if (signal.aborted) throw new CoreCreateError("cancelled");
  const deadline = createDeadlines.get(signal);
  if (deadline !== undefined && Date.now() >= deadline) throw new CoreCreateError("timeout");
}
export function createFailure(error: unknown): CoreCreateError {
  if (error instanceof CoreCreateError) return error;
  if (error instanceof CollaborationCreateError) return new CoreCreateError(error.code);
  // Fixed transport categories only. Never expose source errors, paths or input.
  const message = error instanceof Error ? error.message : "";
  return new CoreCreateError(message === "too_large" ? "too_large" : message === "cancelled" ? "cancelled" : message === "device timeout" ? "timeout" : "offline");
}
export function createOperation(method: string, url: URL): CreateOperation {
  if (method !== "POST" || !Object.hasOwn(CREATE_ROUTES, url.pathname)) throw new CoreCreateError("unsupported");
  if (url.search) throw new CoreCreateError("invalid");
  return CREATE_ROUTES[url.pathname as keyof typeof CREATE_ROUTES];
}
export function parseCreateInput(operation: CreateOperation, body: Buffer | null): CoreCreateEnvelope {
  if (!Object.hasOwn(CREATE_CAPABILITIES, operation)) throw new CoreCreateError("unsupported");
  if ((body?.length ?? 0) > CREATE_INPUT_BYTES) throw new CoreCreateError("too_large");
  try {
    const input = parseCreateEnvelope(operation, JSON.parse(body?.toString("utf8") ?? ""), true) as CoreCreateEnvelope;
    if (!/^device:[A-Za-z0-9_-]+$/.test(input.device_id)) throw new CoreCreateError("invalid");
    const id = input.device_id.slice(7);
    const binding = "request" in input ? input.request : input;
    const scope = "target" in binding ? binding.target : binding;
    if (scope.node_id !== id || scope.endpoint_id !== id) throw new CoreCreateError("permission_denied");
    return input;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CoreCreateError("invalid");
    throw createFailure(error);
  }
}
export interface CreateTarget extends CreateManifestDto {
  device_id: string;
  name: string;
  capabilities: CreateOperation[];
}
/** Create is independent of read and existing-work control grants. */
export function normalizeCreateTarget(deviceId: string, name: string, raw: unknown): CreateTarget | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(deviceId) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const manifest = raw as Record<string, unknown>;
    if ((manifest.protocol !== undefined && manifest.protocol !== "ash-dev/1") || !Array.isArray(manifest.capabilities)) return null;
    const create = parseCreateManifest(manifest.collaboration_create, deviceId);
    if (create.endpoint_id !== deviceId || (create.authorization_revision !== null && !/^[0-9a-f]{64}$/.test(create.authorization_revision))) return null;
    const declaredCapabilities = manifest.capabilities;
    const capabilities = (Object.keys(CREATE_CAPABILITIES) as CreateOperation[]).filter(operation => declaredCapabilities.some((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const cap = value as Record<string, unknown>;
      return cap.name === CREATE_CAPABILITIES[operation] && cap.risk === (operation === "apply" ? "outward" : "none");
    }));
    if (create.grant_state === "ready" && capabilities.length !== 4) return null;
    return { ...create, device_id: `device:${deviceId}`, name: name.replace(/[\p{C}]/gu, " ").slice(0, 80), capabilities };
  } catch { return null; }
}

/** One owner gateway connection, fenced across EVERY asynchronous transport step. */
export interface CoreCreateSession {
  /** Synchronously fence the real gateway connection, current pairing generation,
   * expose permission and locally known manifest generation. Remote grant state
   * is observed by inspect; this does not promise instantaneous remote revocation. */
  current(): void;
  /** Fresh pairing, expose permission and manifest; never a cached discovery entry. */
  inspect(deviceId: string, signal: AbortSignal): Promise<CreateDeviceInspection>;
  /** Implemented exclusively as POST /ash/call, response from this exact device. */
  exchange(deviceId: string, call: { capability: string; caller: "person:owner"; args: CreateEnvelope }, signal: AbortSignal): Promise<{ status: number; body: Buffer }>;
}
export interface CreateDeviceInspection {
  id: string; name?: string; online: boolean; revoked: boolean; permissions: string[]; manifest: unknown;
}
export interface CreateReturnGate {
  authorize(): Promise<void>; current(): void;
  /** Keep the same session fenced through the route await and final return. */
  bindDeviceFence(fence: () => void): void;
}
export interface CollaborationCreateTransport {
  /** Run the owner gate before the final fresh device inspection, then synchronously fence both. */
  collaborationCreate(operation: CreateOperation, input: CoreCreateEnvelope, signal: AbortSignal, gate: CreateReturnGate): Promise<CreateResponse>;
}
export class FixedCreateTransport implements CollaborationCreateTransport {
  constructor(private readonly open: (signal: AbortSignal) => CoreCreateSession) {}
  async collaborationCreate(operation: CreateOperation, input: CoreCreateEnvelope, signal: AbortSignal, gate: CreateReturnGate): Promise<CreateResponse> {
    // Even direct trusted callers use the same parser; there is no loose method path.
    input = parseCreateInput(operation, Buffer.from(JSON.stringify(input)));
    const session = this.open(signal), id = input.device_id.slice(7);
    gate.bindDeviceFence(() => {
      try { assertCreateBudget(signal); session.current(); } catch (error) { throw createFailure(error); }
    });
    const current = () => { assertCreateBudget(signal); gate.current(); session.current(); };
    const inspect = async () => {
      current(); const device = await session.inspect(id, signal); current();
      if (device.id !== id || device.revoked || !device.permissions.includes("expose_capability")) throw new CoreCreateError("permission_denied");
      if (!device.online) throw new CoreCreateError("offline");
      const target = normalizeCreateTarget(id, device.name ?? id, device.manifest);
      if (!target) throw new CoreCreateError("unsupported");
      const binding = "request" in input ? input.request : input;
      const scope = "target" in binding ? binding.target : binding;
      if (target.grant_state !== "ready" || target.authorization_revision !== binding.authorization_revision || target.endpoint_id !== scope.endpoint_id || target.scope?.kind !== "exact_cwd" || target.scope.cwd !== scope.cwd || !target.actions.includes(operation) || !target.capabilities.includes(operation)) throw new CoreCreateError("permission_denied");
      return target;
    };
    try {
      const before = await inspect(), fingerprint = JSON.stringify(before);
      const { device_id: _device, ...args } = input;
      current();
      // Tunnel limits and disconnects reject rather than returning a response.
      // Keep that outcome private until the same fresh authorization fence has run.
      let response: { status: number; body: Buffer } | undefined;
      let exchangeFailed = false, exchangeError: unknown;
      try {
        response = await session.exchange(id, { capability: CREATE_CAPABILITIES[operation], caller: "person:owner", args }, signal);
      } catch (error) { exchangeFailed = true; exchangeError = error; }
      current();
      // Finish the asynchronous owner check before the final asynchronous device read.
      await gate.authorize();
      current();
      // Recheck BEFORE parsing even errors: a revoked owner receives no device fact.
      const after = await inspect();
      if (JSON.stringify(after) !== fingerprint) throw new CoreCreateError("permission_denied");
      current();
      if (exchangeFailed) throw createFailure(exchangeError);
      if (!response) throw new CoreCreateError("offline");
      if (response.body.length > CREATE_OUTPUT_BYTES) throw new CoreCreateError("too_large");
      if (response.status !== 200) throw new CoreCreateError("offline");
      let raw: unknown;
      try { raw = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreCreateError("invalid"); }
      const envelope = createObject(raw, ["ok", "content", "data", "error"]);
      if (typeof envelope.ok !== "boolean" || !Array.isArray(envelope.content) || envelope.content.length !== 0) throw new CoreCreateError("invalid");
      if (!envelope.ok) {
        const data = createObject(envelope.data, ["code"]), code = data.code;
        if (typeof envelope.error !== "string" || typeof code !== "string" || !Object.hasOwn(CREATE_ERROR_STATUS, code) || code === "timeout" || code === "cancelled") throw new CoreCreateError("invalid");
        throw new CoreCreateError(code as CoreCreateErrorCode);
      }
      if (envelope.error !== undefined) throw new CoreCreateError("invalid");
      const result = validateCreateResponse(operation, envelope.data, args);
      current();
      return result;
    } catch (error) { throw createFailure(error); }
  }
}

/** Shared deadline includes owner/screen admission and final checks, not just RPC. */
export async function boundedCreate<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, no) => { reject = no; });
  const abort = () => controller.abort();
  controller.signal.addEventListener("abort", () => reject(new CoreCreateError(timedOut ? "timeout" : "cancelled")), { once: true });
  signal?.addEventListener("abort", abort, { once: true });
  const budget = Number.isFinite(timeoutMs) ? Math.min(CREATE_DEADLINE_MS, timeoutMs) : CREATE_DEADLINE_MS;
  const deadline = Date.now() + Math.max(0, budget);
  createDeadlines.set(controller.signal, deadline);
  const timer = setTimeout(() => { timedOut = true; abort(); }, Math.max(0, budget));
  try {
    if (signal?.aborted) abort();
    if (budget <= 0) { timedOut = true; abort(); }
    if (controller.signal.aborted) return await cancelled;
    const result = await Promise.race([work(controller.signal), cancelled]);
    if (Date.now() >= deadline && !controller.signal.aborted) { timedOut = true; abort(); }
    if (controller.signal.aborted) return await cancelled;
    return result;
  } catch (error) {
    if (Date.now() >= deadline && !controller.signal.aborted) { timedOut = true; abort(); }
    if (controller.signal.aborted) return await cancelled;
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** Trusted injection comes from EdgeRouter.context, never from HTTP identity fields. */
export interface TrustedCreateContext {
  authorize(signal: AbortSignal): Promise<void>;
  /** Synchronous owner/screen generation predicate, covering every transport await. */
  current(): void;
}
export async function executeCreateRoute(
  request: { method: string; url: URL; body: Buffer | null; signal?: AbortSignal; deadline?: number },
  context: TrustedCreateContext,
  transport: CollaborationCreateTransport,
  timeoutMs = CREATE_DEADLINE_MS,
): Promise<CreateResponse> {
  const budget = Math.min(timeoutMs, request.deadline === undefined ? Infinity : request.deadline - Date.now());
  return boundedCreate(request.signal, budget, async signal => {
    await context.authorize(signal);
    assertCreateBudget(signal); context.current();
    let result: CreateResponse | undefined, failed = false, failure: unknown, gateAttempted = false;
    let deviceFence: (() => void) | undefined;
    const gate: CreateReturnGate = {
      authorize: async () => { gateAttempted = true; await context.authorize(signal); assertCreateBudget(signal); context.current(); },
      current: () => { assertCreateBudget(signal); context.current(); deviceFence?.(); },
      bindDeviceFence: fence => { if (deviceFence) throw new CoreCreateError("invalid"); deviceFence = fence; },
    };
    try {
      const operation = createOperation(request.method, request.url), input = parseCreateInput(operation, request.body);
      result = validateCreateResponse(operation, await transport.collaborationCreate(operation, input, signal, gate), input);
    } catch (error) { failed = true; failure = error; }
    if (!gateAttempted) await gate.authorize();
    gate.current();
    if (failed) throw createFailure(failure);
    return result!;
  });
}

/** Every create HTTP outcome is private and must bypass caches. */
export const CREATE_HTTP_HEADERS = Object.freeze({ "content-type": "application/json", "cache-control": "no-store" });
export function createErrorResponse(error: unknown): { status: number; headers: typeof CREATE_HTTP_HEADERS; body: Buffer } {
  const failure = createFailure(error);
  return { status: CREATE_ERROR_STATUS[failure.code], headers: CREATE_HTTP_HEADERS, body: Buffer.from(JSON.stringify({ error: `Collaboration create ${failure.code}`, code: failure.code })) };
}
export async function handleCreateRoute(
  request: Parameters<typeof executeCreateRoute>[0], context: TrustedCreateContext, transport: CollaborationCreateTransport, timeoutMs = CREATE_DEADLINE_MS,
): Promise<{ status: number; headers: typeof CREATE_HTTP_HEADERS; body: Buffer }> {
  try {
    const data = await executeCreateRoute(request, context, transport, timeoutMs);
    return { status: 200, headers: CREATE_HTTP_HEADERS, body: Buffer.from(JSON.stringify(data)) };
  } catch (error) { return createErrorResponse(error); }
}
