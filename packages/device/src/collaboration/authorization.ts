import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CollaborationReadError } from "./types";
import { currentPinnedOwnerId } from "./pairing";
import { readLocalStateFile } from "./local-state";

/** Issued by the active tunnel only after its authenticated peer matches the pinned pairing. */
export interface TrustedCallContext { readonly transportOwnerId: string; isCurrent(): boolean }
interface ReadAuthorizationFields {
  owner_id: string;
  endpoint_id: string;
  /** Local display counter; concurrency may reuse it. Revision binds owner and actual scope. */
  authorization_generation: number;
  allowedCwds: string[];
}
export type ReadAuthorizationConfig = ReadAuthorizationFields & ({ version: 2 } | { version: 3; source_id: string; binding_revision: string });
export type ReadAuthorizationSnapshot = ReadAuthorizationConfig & {
  authorization_revision: string;
  state: "ready" | "scope_required" | "invalid_configuration";
  fingerprint: string;
}
export const readAuthorizationPath = (stateDir: string) => join(stateDir, "collaboration-read.json");
export const READ_AUTHORIZATION_MAX_BYTES = 1024 * 1024;
export function readAuthorizationRevision(config: ReadAuthorizationConfig): string {
  return createHash("sha256").update(JSON.stringify({ version: config.version, owner_id: config.owner_id, endpoint_id: config.endpoint_id, allowedCwds: config.allowedCwds, authorization_generation: config.authorization_generation, ...(config.version === 3 ? { source_id: config.source_id, binding_revision: config.binding_revision } : {}) })).digest("hex");
}
export function deniedReadAuthorization(endpointId: string, state: "scope_required" | "invalid_configuration", fingerprint: string): ReadAuthorizationSnapshot {
  const config: ReadAuthorizationConfig = { version: 2, owner_id: "", endpoint_id: endpointId, authorization_generation: 0, allowedCwds: [] };
  return { ...config, authorization_revision: readAuthorizationRevision(config), state, fingerprint };
}
/** Legacy v2 parses for local review but never authorizes a protected source.
 * Legacy ownerless v1 is rejected without migration: the user must explicitly reselect. */
export function parseReadAuthorization(value: unknown, endpointId: string): ReadAuthorizationConfig {
  const config = value as (Partial<ReadAuthorizationFields> & {version?:number;source_id?:string;binding_revision?:string}) | null;
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => !["version", "owner_id", "endpoint_id", "authorization_generation", "allowedCwds", ...(config.version === 3 ? ["source_id", "binding_revision"] : [])].includes(key)) || ![2, 3].includes(config.version!) || typeof config.owner_id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(config.owner_id) || config.endpoint_id !== endpointId || !Number.isSafeInteger(config.authorization_generation) || config.authorization_generation! < 1 || !Array.isArray(config.allowedCwds) || config.allowedCwds.length > 128 || config.allowedCwds.some(cwd => typeof cwd !== "string" || cwd.length > 4096 || !isAbsolute(cwd) || /[\u0000-\u001f]/.test(cwd))) {
    throw new CollaborationReadError("invalid", "Invalid desktop read authorization configuration");
  }
  if (config.version === 3 && (typeof config.source_id !== "string" || !config.source_id.length || config.source_id.length > 128 || /[\u0000-\u001f]/.test(config.source_id) || typeof config.binding_revision !== "string" || !/^[a-f0-9]{64}$/.test(config.binding_revision))) throw new CollaborationReadError("invalid", "Invalid saved source binding");
  return { version: config.version!, ...(config.version === 3 ? {source_id: config.source_id!, binding_revision: config.binding_revision!} : {}), owner_id: config.owner_id, endpoint_id: endpointId, authorization_generation: config.authorization_generation!, allowedCwds: [...new Set(config.allowedCwds.map(cwd => resolve(cwd)))].sort() } as ReadAuthorizationConfig;
}
export function readAuthorizationSnapshot(value: unknown, endpointId: string, pinnedOwnerId: string | null, fingerprint = "configuration"): ReadAuthorizationSnapshot {
  try {
    const config = parseReadAuthorization(value, endpointId);
    if (!pinnedOwnerId || config.owner_id !== pinnedOwnerId) return deniedReadAuthorization(endpointId, "invalid_configuration", fingerprint);
    return { ...config, authorization_revision: readAuthorizationRevision(config), state: config.version === 3 && config.allowedCwds.length ? "ready" : "scope_required", fingerprint };
  } catch { return deniedReadAuthorization(endpointId, "invalid_configuration", fingerprint); }
}
export function loadReadAuthorization(stateDir: string, endpointId: string): ReadAuthorizationSnapshot {
  try {
    const file = readLocalStateFile(readAuthorizationPath(stateDir), READ_AUTHORIZATION_MAX_BYTES);
    if (!file) return deniedReadAuthorization(endpointId, "scope_required", "missing");
    const owner = currentPinnedOwnerId(stateDir);
    const snapshot = readAuthorizationSnapshot(JSON.parse(file.raw), endpointId, owner, file.identity);
    // Pairing may change during loading; never return its predecessor's scope.
    if (owner !== currentPinnedOwnerId(stateDir)) return deniedReadAuthorization(endpointId, "invalid_configuration", file.identity);
    return snapshot;
  } catch { return deniedReadAuthorization(endpointId, "invalid_configuration", "unavailable"); }
}
