import { createHash } from "node:crypto";
import { join } from "node:path";
import { fromB64u, PERMISSIONS } from "ash-gateway/src/protocol";
import { readLocalStateFile } from "./local-state";

export const MAX_PAIR_BYTES = 16 * 1024;
export interface CurrentPairing { fingerprint: string; ownerId: string; revoked: boolean }
/** Parse only the bounded bytes obtained from a verified local descriptor. */
export function parseCurrentPairing(fingerprint: string): CurrentPairing | null {
  try {
    if (Buffer.byteLength(fingerprint) > MAX_PAIR_BYTES) return null;
    const v = JSON.parse(fingerprint);
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["owner_key", "permissions", "grant_version", "revoked"].includes(k)) || typeof v.owner_key !== "string" || !/^[A-Za-z0-9_-]{1,4096}$/.test(v.owner_key) || (v.revoked !== undefined && typeof v.revoked !== "boolean") || (v.permissions !== undefined && (!Array.isArray(v.permissions) || v.permissions.some((p: unknown) => typeof p !== "string" || !(PERMISSIONS as readonly string[]).includes(p)) || new Set(v.permissions).size !== v.permissions.length)) || (v.grant_version !== undefined && (!Number.isSafeInteger(v.grant_version) || v.grant_version < 1))) return null;
    const key = fromB64u(v.owner_key);
    if (!key.length || Buffer.from(key).toString("base64url") !== v.owner_key) return null;
    return { fingerprint, ownerId: createHash("sha256").update(key).digest("base64url").slice(0, 22), revoked: v.revoked === true };
  } catch { return null; }
}
/** Current single-link regular local pairing only. No cached or request-supplied identity. */
export function loadCurrentPairing(file: string): CurrentPairing | null {
  try { const observed = readLocalStateFile(file, MAX_PAIR_BYTES); return observed ? parseCurrentPairing(observed.raw) : null; } catch { return null; }
}
export const currentPinnedOwnerId = (stateDir: string): string | null => {
  const pairing = loadCurrentPairing(join(stateDir, "paired.json"));
  return pairing && !pairing.revoked ? pairing.ownerId : null;
};
