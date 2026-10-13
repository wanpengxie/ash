import {
  CONTROL_CAPABILITIES, CONTROL_DEADLINE_MS, CONTROL_INPUT_MAX_BYTES, CONTROL_OUTPUT_MAX_BYTES,
  controlObject, parseControlEnvelope, parseControlManifest, validateControlResponse,
  type ControlEnvelope, type CoreControlEnvelope, type ControlManifestDto, type ControlOperation, type ControlResponse,
} from "../../../../sdk/src/collaboration/control-protocol";
import { CollaborationControlError } from "../../../../sdk/src/collaboration/control-types";

export { CONTROL_CAPABILITIES };
export type { ControlOperation, CoreControlEnvelope, ControlResponse };
export const CONTROL_INPUT_BYTES = CONTROL_INPUT_MAX_BYTES;
export const CONTROL_OUTPUT_BYTES = CONTROL_OUTPUT_MAX_BYTES;
export const CONTROL_ROUTES = {
  "/api/collaboration/control/state": "state",
  "/api/collaboration/control/apply": "apply",
  "/api/collaboration/control/query": "query",
  "/api/collaboration/control/reconcile": "reconcile",
} as const;
export const CONTROL_ERROR_STATUS = {
  invalid: 400, too_large: 413, permission_denied: 403, expired: 410, conflict: 409, busy: 409,
  storage_failure: 503, unsupported: 422, offline: 503, stale_precondition: 409, result_unknown: 409,
  timeout: 504, cancelled: 499,
} as const;
export type CoreControlErrorCode = keyof typeof CONTROL_ERROR_STATUS;
export class CoreControlError extends Error {
  constructor(readonly code: CoreControlErrorCode) { super(`Collaboration control ${code}`); }
}
const controlDeadlines = new WeakMap<AbortSignal, number>();
function assertControlBudget(signal: AbortSignal): void {
  if (signal.aborted) throw new CoreControlError("cancelled");
  const deadline = controlDeadlines.get(signal);
  if (deadline !== undefined && Date.now() >= deadline) throw new CoreControlError("timeout");
}
export function controlFailure(error: unknown): CoreControlError {
  if (error instanceof CoreControlError) return error;
  if (error instanceof CollaborationControlError) return new CoreControlError(error.code);
  // Fixed transport categories only. Never expose source errors, paths or input.
  const message = error instanceof Error ? error.message : "";
  return new CoreControlError(message === "too_large" ? "too_large" : message === "cancelled" ? "cancelled" : message === "device timeout" ? "timeout" : "offline");
}
export function controlOperation(method: string, url: URL): ControlOperation {
  if (method !== "POST" || !Object.hasOwn(CONTROL_ROUTES, url.pathname)) throw new CoreControlError("unsupported");
  if (url.search) throw new CoreControlError("invalid");
  return CONTROL_ROUTES[url.pathname as keyof typeof CONTROL_ROUTES];
}
export function parseControlInput(operation: ControlOperation, body: Buffer | null): CoreControlEnvelope {
  if (!Object.hasOwn(CONTROL_CAPABILITIES, operation)) throw new CoreControlError("unsupported");
  if ((body?.length ?? 0) > CONTROL_INPUT_BYTES) throw new CoreControlError("too_large");
  try {
    const input = parseControlEnvelope(operation, JSON.parse(body?.toString("utf8") ?? ""), true) as CoreControlEnvelope;
    if (!/^device:[A-Za-z0-9_-]+$/.test(input.device_id)) throw new CoreControlError("invalid");
    const id = input.device_id.slice(7);
    if (input.endpoint_id !== id || input.work.node_id !== id || input.work.endpoint_id !== id) throw new CoreControlError("permission_denied");
    if (!/^[0-9a-f]{64}$/.test(input.authorization_revision)) throw new CoreControlError("invalid");
    return input;
  } catch (error) {
    if (error instanceof SyntaxError) throw new CoreControlError("invalid");
    throw controlFailure(error);
  }
}
export interface ControlTarget extends ControlManifestDto {
  device_id: string;
  name: string;
  capabilities: ControlOperation[];
}
/** Only the separate control block is parsed; read metadata remains independent. */
export function normalizeControlTarget(deviceId: string, name: string, raw: unknown): ControlTarget | null {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(deviceId) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const manifest = raw as Record<string, unknown>;
    if ((manifest.protocol !== undefined && manifest.protocol !== "ash-dev/1") || !Array.isArray(manifest.capabilities)) return null;
    const control = parseControlManifest(manifest.collaboration_control);
    if (control.endpoint_id !== deviceId || (control.authorization_revision !== null && !/^[0-9a-f]{64}$/.test(control.authorization_revision))) return null;
    const declaredCapabilities = manifest.capabilities;
    const capabilities = (Object.keys(CONTROL_CAPABILITIES) as ControlOperation[]).filter(operation => declaredCapabilities.some((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const cap = value as Record<string, unknown>;
      return cap.name === CONTROL_CAPABILITIES[operation] && cap.risk === (operation === "apply" ? "outward" : "none");
    }));
    if (control.grant_state === "ready" && capabilities.length !== 4) return null;
    return { ...control, device_id: `device:${deviceId}`, name: name.replace(/[\p{C}]/gu, " ").slice(0, 80), capabilities };
  } catch { return null; }
}

/** One owner gateway connection, fenced across EVERY asynchronous transport step. */
export interface CoreControlSession {
  current(): void;
  /** Fresh pairing, expose permission and manifest; never a cached discovery entry. */
  inspect(deviceId: string, signal: AbortSignal): Promise<ControlDeviceInspection>;
  /** Implemented exclusively as POST /ash/call, response from this exact device. */
  exchange(deviceId: string, call: { capability: string; caller: "person:owner"; args: ControlEnvelope }, signal: AbortSignal): Promise<{ status: number; body: Buffer }>;
}
export interface ControlDeviceInspection {
  id: string; name?: string; online: boolean; revoked: boolean; permissions: string[]; manifest: unknown;
}
export interface ControlReturnGate {
  authorize(): Promise<void>; current(): void;
  /** Keep the same session fenced through the route await and final return. */
  bindDeviceFence(fence: () => void): void;
}
export interface CollaborationControlTransport {
  /** Run the owner gate before the final fresh device inspection, then synchronously fence both. */
  collaborationControl(operation: ControlOperation, input: CoreControlEnvelope, signal: AbortSignal, gate: ControlReturnGate): Promise<ControlResponse>;
}
export class FixedControlTransport implements CollaborationControlTransport {
  constructor(private readonly open: (signal: AbortSignal) => CoreControlSession) {}
  async collaborationControl(operation: ControlOperation, input: CoreControlEnvelope, signal: AbortSignal, gate: ControlReturnGate): Promise<ControlResponse> {
    // Even direct trusted callers use the same parser; there is no loose method path.
    input = parseControlInput(operation, Buffer.from(JSON.stringify(input)));
    const session = this.open(signal), id = input.device_id.slice(7);
    gate.bindDeviceFence(() => {
      try { assertControlBudget(signal); session.current(); } catch (error) { throw controlFailure(error); }
    });
    const current = () => { assertControlBudget(signal); gate.current(); session.current(); };
    const inspect = async () => {
      current(); const device = await session.inspect(id, signal); current();
      if (device.id !== id || device.revoked || !device.permissions.includes("expose_capability")) throw new CoreControlError("permission_denied");
      if (!device.online) throw new CoreControlError("offline");
      const target = normalizeControlTarget(id, device.name ?? id, device.manifest);
      if (!target) throw new CoreControlError("unsupported");
      const action = input.request?.action ?? input.action;
      if (target.grant_state !== "ready" || target.authorization_revision !== input.authorization_revision || target.endpoint_id !== input.endpoint_id || !action || !target.actions.includes(action) || !target.capabilities.includes(operation)) throw new CoreControlError("permission_denied");
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
        response = await session.exchange(id, { capability: CONTROL_CAPABILITIES[operation], caller: "person:owner", args }, signal);
      } catch (error) { exchangeFailed = true; exchangeError = error; }
      current();
      // Finish the asynchronous owner check before the final asynchronous device read.
      await gate.authorize();
      current();
      // Recheck BEFORE parsing even errors: a revoked owner receives no device fact.
      const after = await inspect();
      if (JSON.stringify(after) !== fingerprint) throw new CoreControlError("permission_denied");
      current();
      if (exchangeFailed) throw controlFailure(exchangeError);
      if (!response) throw new CoreControlError("offline");
      if (response.body.length > CONTROL_OUTPUT_BYTES) throw new CoreControlError("too_large");
      if (response.status !== 200) throw new CoreControlError("offline");
      let raw: unknown;
      try { raw = JSON.parse(response.body.toString("utf8")); } catch { throw new CoreControlError("invalid"); }
      const envelope = controlObject(raw, ["ok", "content", "data", "error"]);
      if (typeof envelope.ok !== "boolean" || !Array.isArray(envelope.content) || envelope.content.length !== 0) throw new CoreControlError("invalid");
      if (!envelope.ok) {
        const data = controlObject(envelope.data, ["code"]), code = data.code;
        if (typeof envelope.error !== "string" || typeof code !== "string" || !Object.hasOwn(CONTROL_ERROR_STATUS, code) || code === "timeout" || code === "cancelled") throw new CoreControlError("invalid");
        throw new CoreControlError(code as CoreControlErrorCode);
      }
      if (envelope.error !== undefined) throw new CoreControlError("invalid");
      const result = validateControlResponse(operation, envelope.data, args);
      if (operation === "state" && "allowed_actions" in result && result.allowed_actions.some(action => !after.actions.includes(action))) throw new CoreControlError("invalid");
      current();
      return result;
    } catch (error) { throw controlFailure(error); }
  }
}

/** Shared deadline includes owner/screen admission and final checks, not just RPC. */
export async function boundedControl<T>(signal: AbortSignal | undefined, timeoutMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let reject!: (error: Error) => void;
  const cancelled = new Promise<never>((_, no) => { reject = no; });
  const abort = () => controller.abort();
  controller.signal.addEventListener("abort", () => reject(new CoreControlError(timedOut ? "timeout" : "cancelled")), { once: true });
  signal?.addEventListener("abort", abort, { once: true });
  const budget = Number.isFinite(timeoutMs) ? Math.min(CONTROL_DEADLINE_MS, timeoutMs) : CONTROL_DEADLINE_MS;
  const deadline = Date.now() + Math.max(0, budget);
  controlDeadlines.set(controller.signal, deadline);
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
export interface TrustedControlContext {
  authorize(signal: AbortSignal): Promise<void>;
  /** Synchronous owner/screen generation predicate, covering every transport await. */
  current(): void;
}
export async function executeControlRoute(
  request: { method: string; url: URL; body: Buffer | null; signal?: AbortSignal; deadline?: number },
  context: TrustedControlContext,
  transport: CollaborationControlTransport,
  timeoutMs = CONTROL_DEADLINE_MS,
): Promise<ControlResponse> {
  const budget = Math.min(timeoutMs, request.deadline === undefined ? Infinity : request.deadline - Date.now());
  return boundedControl(request.signal, budget, async signal => {
    await context.authorize(signal);
    assertControlBudget(signal); context.current();
    let result: ControlResponse | undefined, failed = false, failure: unknown, gateAttempted = false;
    let deviceFence: (() => void) | undefined;
    const gate: ControlReturnGate = {
      authorize: async () => { gateAttempted = true; await context.authorize(signal); assertControlBudget(signal); context.current(); },
      current: () => { assertControlBudget(signal); context.current(); deviceFence?.(); },
      bindDeviceFence: fence => { if (deviceFence) throw new CoreControlError("invalid"); deviceFence = fence; },
    };
    try {
      const operation = controlOperation(request.method, request.url), input = parseControlInput(operation, request.body);
      result = validateControlResponse(operation, await transport.collaborationControl(operation, input, signal, gate), input);
    } catch (error) { failed = true; failure = error; }
    if (!gateAttempted) await gate.authorize();
    gate.current();
    if (failed) throw controlFailure(failure);
    return result!;
  });
}
