import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { TrustedCallContext } from "./authorization";
import { CollaborationControlError, type AuthenticatedPrincipal, type ControlAction, type AuthorizeControl } from "./control-types";
import type { WorkRef } from "./types";

export type GrantedControlAction = ControlAction | "create_work";
export type ControlScope = { kind: "exact_cwd"; cwd: string } | { kind: "single_work"; work: WorkRef };
export interface ControlAuthorizationConfig {
  version: 1;
  owner_id: string;
  endpoint_id: string;
  authorization_generation: number;
  allowed_actions: GrantedControlAction[];
  scope: ControlScope;
  expires_at?: number;
}
export interface ControlAuthorizationSnapshot {
  state: "ready" | "grant_required" | "invalid_configuration";
  config: ControlAuthorizationConfig | null;
  authorization_revision: string | null;
}
export interface ControlAuthorizationBinding {
  endpoint_id: string;
  authorization_revision: string;
  work: WorkRef;
  action: ControlAction;
}
export interface ControlNativeMetadata { work: WorkRef; cwd: string }
export interface ControlAuthorizationOptions {
  nodeId: string;
  endpointId: string;
  /** Current pinned pairing identity, never a request field. null means unpaired. */
  pinnedOwnerId(): string | null;
  /** Local control configuration only; read authorization is not accepted. */
  authorization(): ControlAuthorizationSnapshot;
  metadata(work: WorkRef): Promise<ControlNativeMetadata>;
  now?: () => number;
}
export interface ControlAuthorizationLease {
  readonly principal: Readonly<AuthenticatedPrincipal>;
  /** Synchronous owner/grant/epoch fence; never performs native IO. */
  current(): undefined;
  /** Direct J hook: also checks the supplied principal, complete work and action. */
  authorize: AuthorizeControl;
  /** Recheck at each J authorize hook, including query of previously persisted receipts. */
  check(purpose: "invoke" | "query"): Promise<boolean>;
  /** Recheck immediately before the operation and after its asynchronous result. */
  run<T>(purpose: "invoke" | "query", operation: () => Promise<T>): Promise<T>;
}
const fail = (): never => { throw new CollaborationControlError("permission_denied"); };
const invalid = (): never => { throw new CollaborationControlError("invalid"); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
function cwd(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 4096 || !isAbsolute(value) || /[\u0000-\u001f]/.test(value)) invalid();
  return resolve(value as string);
}
function work(value: unknown): WorkRef {
  if (!object(value) || !keys(value, ["node_id", "endpoint_id", "kind", "native_id"]) || !id(value.node_id) || !id(value.endpoint_id) || !id(value.native_id) || value.kind !== "conversation") invalid();
  const v = value as unknown as WorkRef;
  return { node_id: v.node_id, endpoint_id: v.endpoint_id, kind: "conversation", native_id: v.native_id };
}
function sameWork(a: WorkRef, b: WorkRef): boolean { return a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id; }
/** Strict input with stable field/action ordering; aliases normalize lexically, never by basename. */
export function parseControlAuthorization(value: unknown, endpointId: string): ControlAuthorizationConfig {
  if (!object(value) || !keys(value, ["version", "owner_id", "endpoint_id", "authorization_generation", "allowed_actions", "scope", "expires_at"]) || value.version !== 1 || !id(value.owner_id) || value.endpoint_id !== endpointId || !id(value.endpoint_id) || !Number.isSafeInteger(value.authorization_generation) || (value.authorization_generation as number) < 1 || !Array.isArray(value.allowed_actions) || !value.allowed_actions.length || value.allowed_actions.length > 3 || value.allowed_actions.some(action => !["send_input", "steer", "create_work"].includes(action)) || new Set(value.allowed_actions).size !== value.allowed_actions.length || !object(value.scope) || (value.expires_at !== undefined && (!Number.isSafeInteger(value.expires_at) || (value.expires_at as number) < 1))) invalid();
  const v = value as unknown as ControlAuthorizationConfig;
  let scope: ControlScope;
  if (v.scope.kind === "exact_cwd" && keys(v.scope as unknown as Record<string, unknown>, ["kind", "cwd"])) scope = { kind: "exact_cwd", cwd: cwd(v.scope.cwd) };
  else if (v.scope.kind === "single_work" && keys(v.scope as unknown as Record<string, unknown>, ["kind", "work"])) {
    scope = { kind: "single_work", work: work(v.scope.work) };
    if (scope.work.endpoint_id !== endpointId || v.allowed_actions.includes("create_work")) invalid();
  } else invalid();
  return { version: 1, owner_id: v.owner_id, endpoint_id: endpointId, authorization_generation: v.authorization_generation, allowed_actions: [...v.allowed_actions].sort(), scope: scope!, ...(v.expires_at === undefined ? {} : { expires_at: v.expires_at }) };
}
export function controlAuthorizationSnapshot(value: unknown, endpointId: string): ControlAuthorizationSnapshot {
  if (value === null || value === undefined) return { state: "grant_required", config: null, authorization_revision: null };
  try {
    const config = parseControlAuthorization(value, endpointId);
    return { state: "ready", config, authorization_revision: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
  } catch { return { state: "invalid_configuration", config: null, authorization_revision: null }; }
}
export const controlAuthorizationPath = (stateDir: string) => join(stateDir, "collaboration-control.json");
export const CONTROL_AUTHORIZATION_MAX_BYTES = 64 * 1024;
/** CLI integration must use UUID temporary files, wx/0600, atomic rename and finally cleanup.
 * This module does not install grants or change real pairing/read state. */
export function loadControlAuthorization(stateDir: string, endpointId: string): ControlAuthorizationSnapshot {
  try {
    const path = controlAuthorizationPath(stateDir);
    if (statSync(path).size > CONTROL_AUTHORIZATION_MAX_BYTES) return { state: "invalid_configuration", config: null, authorization_revision: null };
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > CONTROL_AUTHORIZATION_MAX_BYTES) throw new Error();
    return controlAuthorizationSnapshot(JSON.parse(raw), endpointId);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "grant_required" : "invalid_configuration", config: null, authorization_revision: null };
  }
}

/** Denial suppresses results, including saved receipts. It cannot undo an already invoked native action. */
export class ControlAuthorization {
  private epoch = 0;
  constructor(private readonly options: ControlAuthorizationOptions) {}
  /** Watchers should invalidate on every observed grant/pairing change, including revoke then restore. */
  invalidate(): void { this.epoch++; }
  async begin(context: TrustedCallContext | undefined, binding: ControlAuthorizationBinding): Promise<ControlAuthorizationLease> {
    if (!context) fail();
    // Copy the complete target so caller mutation cannot retarget a lease after admission.
    let target: WorkRef;
    try { target = work(binding.work); } catch { fail(); }
    const bound = { ...binding, work: target! };
    const epoch = this.epoch;
    const principal = Object.freeze({ principal_id: context!.transportOwnerId });
    const current = (): ControlAuthorizationConfig => {
      try {
        if (epoch !== this.epoch || !context!.isCurrent() || principal.principal_id !== this.options.pinnedOwnerId()) fail();
        const supplied = this.options.authorization();
        const snapshot = supplied.state === "ready" ? controlAuthorizationSnapshot(supplied.config, this.options.endpointId) : supplied;
        if (snapshot.state !== "ready" || !snapshot.config || snapshot.authorization_revision !== bound.authorization_revision || supplied.authorization_revision !== snapshot.authorization_revision) fail();
        const config = snapshot.config!;
        if (config.owner_id !== principal.principal_id || bound.endpoint_id !== this.options.endpointId || target!.endpoint_id !== this.options.endpointId || target!.node_id !== this.options.nodeId || !config.allowed_actions.includes(bound.action) || (config.expires_at !== undefined && (this.options.now ?? Date.now)() >= config.expires_at)) fail();
        if (config.scope.kind === "single_work" && !sameWork(config.scope.work, target!)) fail();
        return config;
      } catch { return fail(); }
    };
    const assertCurrent = async (): Promise<void> => {
      current();
      let metadata: ControlNativeMetadata;
      try { metadata = await this.options.metadata({ ...target! }); } catch { fail(); }
      const config = current(); // Grant or transport may have changed during native metadata lookup.
      try {
        if (!sameWork(work(metadata!.work), target!) || (config.scope.kind === "exact_cwd" && cwd(metadata!.cwd) !== config.scope.cwd)) fail();
      } catch { return fail(); }
    };
    await assertCurrent();
    current();
    return {
      principal,
      current: () => { current(); return undefined; },
      authorize: async (caller, candidate, action, _purpose) => {
        try {
          if (caller.principal_id !== principal.principal_id || !sameWork(work(candidate), target!) || action !== bound.action) return false;
          await assertCurrent(); current(); return true;
        } catch { return false; }
      },
      check: async (_purpose) => { try { await assertCurrent(); current(); return true; } catch { return false; } },
      run: async (_purpose, operation) => {
        await assertCurrent();
        current();
        try {
          const result = await operation();
          await assertCurrent();
          current();
          return result;
        } catch (error) {
          // Even an error body must not escape the old authorization after revoke.
          await assertCurrent();
          current();
          throw error;
        }
      },
    };
  }
}
