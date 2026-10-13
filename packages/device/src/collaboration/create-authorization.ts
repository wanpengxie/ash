import type { TrustedCallContext } from "./authorization";
import { controlAuthorizationSnapshot, type ControlAuthorizationSnapshot } from "./control-authorization";
import { assertCreateSourceScope, createId, normalizeCreateCwd, parseCreateTarget } from "./create-protocol";
import { CollaborationCreateError, type CreateLease, type CreateProjectScope, type CreateProjectsLease, type CreateTarget } from "./create-types";

export interface CreateAuthorizationOptions {
  nodeId: string; endpointId: string;
  pinnedOwnerId(): string | null;
  /** Production supplies loadControlAuthorization; no read grant or request-derived scope. */
  authorization(): ControlAuthorizationSnapshot;
  now?: () => number;
}
export interface CreateSourceIdentity { readonly connector_epoch: string; readonly native_interface_version: string }
export interface CreateAdmission {
  readonly principal: Readonly<{ principal_id: string }>;
  check(): Promise<boolean>;
  run<T>(operation: () => Promise<T>): Promise<T>;
  projects(source: CreateSourceIdentity): CreateProjectsLease;
  target(target: CreateTarget, source: CreateSourceIdentity): CreateLease;
}
const deny = (): never => { throw new CollaborationCreateError("permission_denied"); };
/** A grant admission precedes source construction/initialization. Watch every change to defeat ABA. */
export class CreateAuthorization {
  private epoch = 0;
  constructor(private readonly options: CreateAuthorizationOptions) {}
  invalidate(): void { this.epoch++; }
  manifestScope(context?: TrustedCallContext): { kind: "exact_cwd"; cwd: string } | null {
    const supplied = this.options.authorization();
    if (supplied.state !== "ready" || !supplied.config || supplied.config.scope.kind !== "exact_cwd" || !supplied.authorization_revision) return null;
    try {
      this.begin(context, { node_id: this.options.nodeId, endpoint_id: this.options.endpointId, cwd: supplied.config.scope.cwd }, supplied.authorization_revision);
      return { kind: "exact_cwd", cwd: normalizeCreateCwd(supplied.config.scope.cwd) };
    } catch { return null; }
  }
  status(): { state: ControlAuthorizationSnapshot["state"]; authorization_revision: string | null; allowed: boolean } {
    const supplied = this.options.authorization();
    const snapshot = supplied.state === "ready" ? controlAuthorizationSnapshot(supplied.config, this.options.endpointId) : supplied;
    const g = snapshot.config;
    const allowed = snapshot.state === "ready" && supplied.authorization_revision === snapshot.authorization_revision && !!g && g.owner_id === this.options.pinnedOwnerId() && g.allowed_actions.includes("create_work") && g.scope.kind === "exact_cwd" && (g.expires_at === undefined || (this.options.now ?? Date.now)() < g.expires_at);
    return { state: snapshot.state, authorization_revision: snapshot.authorization_revision, allowed };
  }
  begin(context: TrustedCallContext | undefined, scope: CreateProjectScope, revision: string): CreateAdmission {
    if (!context) deny();
    const owner = context!.transportOwnerId, isCurrent = context!.isCurrent.bind(context);
    const epoch = this.epoch;
    const bound = Object.freeze({ node_id: scope.node_id, endpoint_id: scope.endpoint_id, cwd: normalizeCreateCwd(scope.cwd) });
    const principal = Object.freeze({ principal_id: owner });
    const current = () => {
      try {
        if (epoch !== this.epoch || !isCurrent() || owner !== this.options.pinnedOwnerId()) deny();
        const supplied = this.options.authorization();
        const snapshot = supplied.state === "ready" ? controlAuthorizationSnapshot(supplied.config, this.options.endpointId) : supplied;
        const grant = snapshot.config;
        if (snapshot.state !== "ready" || !grant || supplied.authorization_revision !== snapshot.authorization_revision || snapshot.authorization_revision !== revision || grant.owner_id !== owner || grant.endpoint_id !== this.options.endpointId || bound.node_id !== this.options.nodeId || bound.endpoint_id !== this.options.endpointId || !grant.allowed_actions.includes("create_work") || grant.scope.kind !== "exact_cwd" || (grant.expires_at !== undefined && (this.options.now ?? Date.now)() >= grant.expires_at)) deny();
        const authorized = Object.freeze({ node_id: this.options.nodeId, endpoint_id: grant!.endpoint_id, cwd: grant!.scope.kind === "exact_cwd" ? grant!.scope.cwd : deny() });
        assertCreateSourceScope(authorized, bound); return authorized;
      } catch { return deny(); }
    };
    const authorized_scope = current(); // Source is not touched before this check.
    const guard = (source?: CreateSourceIdentity) => {
      const connector_epoch = source?.connector_epoch, native_interface_version = source?.native_interface_version;
      if (source) { createId(connector_epoch); createId(native_interface_version); if (connector_epoch === "disconnected") throw new CollaborationCreateError("offline"); }
      const assert = () => {
        assertCreateSourceScope(authorized_scope, current());
        if (source && (source.connector_epoch !== connector_epoch || source.native_interface_version !== native_interface_version)) throw new CollaborationCreateError("stale_precondition");
      };
      const check = async () => { try { assert(); return true; } catch { return false; } };
      const run = async <T>(operation: () => Promise<T>): Promise<T> => {
        assert();
        try { const value = await operation(); assert(); return value; }
        catch (error) { assert(); throw error; }
      };
      return { check, run, connector_epoch: connector_epoch!, native_interface_version: native_interface_version! };
    };
    const admission = guard();
    return Object.freeze({
      principal, check: admission.check, run: admission.run,
      projects: (source: CreateSourceIdentity): CreateProjectsLease => {
        current(); const g = guard(source);
        return Object.freeze({ principal, scope: bound, authorized_scope, authorization_revision: revision, connector_epoch: g.connector_epoch, native_interface_version: g.native_interface_version, authorize: g.check, run: g.run });
      },
      target: (value: CreateTarget, source: CreateSourceIdentity): CreateLease => {
        current(); const target = Object.freeze(parseCreateTarget(value)); assertCreateSourceScope(authorized_scope, target); const g = guard(source);
        return Object.freeze({ principal, target, authorized_scope, authorization_revision: revision, connector_epoch: g.connector_epoch, native_interface_version: g.native_interface_version, authorize: async () => g.check(), run: async <T>(_purpose: "invoke" | "query", operation: () => Promise<T>) => g.run(operation) });
      },
    });
  }
}
