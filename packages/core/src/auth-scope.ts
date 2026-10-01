import { createHmac, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = "screen-auth-scope.key";
const KEY_BYTES = 32;

function readKey(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== KEY_BYTES || (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("invalid screen auth scope key");
    const key = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, key, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new Error("incomplete screen auth scope key");
    return key;
  } finally { closeSync(fd); }
}

function durableDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

/** Create once, atomically; corrupt or inaccessible existing keys never rotate silently. */
export function loadAuthScopeKey(stateDir: string): Buffer {
  const target = join(stateDir, KEY_FILE);
  try { const existing = readKey(target); durableDirectory(stateDir); return existing; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(stateDir, `${KEY_FILE}.${randomBytes(12).toString("hex")}.tmp`);
  const key = randomBytes(KEY_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, key, 0, key.length, 0) !== key.length) throw new Error("incomplete screen auth scope key write");
    fsyncSync(fd);
    closeSync(fd); fd = null;
    try { linkSync(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const installed = readKey(target);
    durableDirectory(stateDir);
    return installed;
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function authScope(key: Buffer, transportPrincipal: string): string {
  if (key.length !== KEY_BYTES || !transportPrincipal) throw new Error("invalid screen auth scope input");
  return `v1_${createHmac("sha256", key).update("v1\0").update(transportPrincipal).digest("base64url")}`;
}
