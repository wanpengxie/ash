import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalStateFile } from "./local-state";

export const AUTHORIZATION_LOCK_FILE = ".authorization.lock";
export class DescriptorLockError extends Error {
  constructor(readonly code: "unavailable" | "storage" | "busy") { super(`Authorization lock: ${code}`); }
}
const helperDirectory = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../../dist/" : "./", import.meta.url));
const statIdentity = (stat: import("node:fs").BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.nlink}`;
/** The approved release bundles this fixed binary and hash; no environment/PATH runner fallback. */
function openHelper(): { fd: number; identity: string } {
  let fd: number | undefined;
  try {
    const metadata = readLocalStateFile(join(helperDirectory, "native-helper.json"), 4096);
    if (!metadata) throw new Error();
    const manifest = JSON.parse(metadata.raw);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).some(key => !["version", "name", "platform", "arch", "sha256"].includes(key)) || manifest.version !== 1 || manifest.name !== "ash-state-lock" || manifest.platform !== process.platform || manifest.arch !== process.arch || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error();
    const path = join(helperDirectory, "ash-state-lock");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 256n * 1024n || (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n) throw new Error();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, length)) > 0) length += count;
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (BigInt(length) !== before.size || statIdentity(before) !== statIdentity(after) || statIdentity(after) !== statIdentity(current) || !current.isFile() || current.isSymbolicLink() || createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !== manifest.sha256) throw new Error();
    return { fd, identity: statIdentity(after) };
  } catch { if (fd !== undefined) closeSync(fd); throw new DescriptorLockError("unavailable"); }
}
export interface DescriptorStateLock { assertCurrent(): undefined; release(): undefined }
/** Keep the verified lock fd open through commit. The helper receives its DUP, not its path.
 * The fixed helper belongs to the approved release code directory (the same trust boundary
 * as ash-device.mjs); it is not a user-selectable executable or an environment/PATH runner.
 * Only fd3 is a lock input: the helper never opens any local-state pathname. */
export function acquireDescriptorStateLock(stateDir: string): DescriptorStateLock {
  let fd: number | undefined, helperFd: number | undefined;
  try {
    if (!["darwin", "linux", "android"].includes(process.platform)) throw new DescriptorLockError("unavailable");
    const path = join(stateDir, AUTHORIZATION_LOCK_FILE);
    try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== 0n || (before.mode & 0o077n) !== 0n) throw new DescriptorLockError("storage");
    const identity = `${before.dev}:${before.ino}`;
    fsyncSync(fd);
    const helper = openHelper(); helperFd = helper.fd;
    const executable = join(helperDirectory, "ash-state-lock");
    const result = spawnSync(executable, [], { stdio: ["ignore", "pipe", "ignore", fd], timeout: 5000, maxBuffer: 1024 });
    if (statIdentity(fstatSync(helperFd, { bigint: true })) !== helper.identity || statIdentity(lstatSync(executable, { bigint: true })) !== helper.identity) throw new DescriptorLockError("unavailable");
    closeSync(helperFd); helperFd = undefined;
    if (result.status === 2) throw new DescriptorLockError("busy");
    if (result.error || result.status !== 0 || String(result.stdout) !== "ash-state-lock/1 acquired\n") throw new DescriptorLockError("unavailable");
    const retained = fd;
    const assertCurrent = (): undefined => {
      const held = fstatSync(retained, { bigint: true }), current = lstatSync(path, { bigint: true });
      if (!held.isFile() || held.nlink !== 1n || held.size !== 0n || (held.mode & 0o077n) !== 0n || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || `${held.dev}:${held.ino}` !== identity || `${current.dev}:${current.ino}` !== identity) throw new DescriptorLockError("storage");
      return undefined;
    };
    assertCurrent(); fd = undefined;
    let released = false;
    return { assertCurrent, release: () => { if (!released) { released = true; closeSync(retained); } return undefined; } };
  } catch (error) { if (error instanceof DescriptorLockError) throw error; throw new DescriptorLockError("storage"); }
  finally { if (helperFd !== undefined) closeSync(helperFd); if (fd !== undefined) closeSync(fd); }
}
