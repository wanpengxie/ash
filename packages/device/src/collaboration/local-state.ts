import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export interface LocalStateFile { readonly raw: string; readonly identity: string }
const identity = (stat: import("node:fs").BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":");
/** One descriptor supplies both bytes and identity. Links and special files fail before any read. */
export function readLocalStateFile(path: string, maxBytes: number): LocalStateFile | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("Invalid local state bound");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) throw new Error("Invalid local state file");
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fstatSync(fd, { bigint: true }), pathStat = lstatSync(path, { bigint: true });
    if (length > maxBytes || BigInt(length) !== before.size || identity(before) !== identity(after) || identity(after) !== identity(pathStat) || !pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.nlink !== 1n) throw new Error("Local state changed during read");
    const raw = bytes.subarray(0, length).toString("utf8");
    return Object.freeze({ raw, identity: `${identity(after)}:${createHash("sha256").update(bytes.subarray(0, length)).digest("hex")}` });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fd === undefined) return null;
    throw new Error("Local state unavailable");
  } finally { if (fd !== undefined) closeSync(fd); }
}
