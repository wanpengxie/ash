import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * On the phone, everything in the agent container runs as the app's Linux user. A process of that user may read another
 * one's memory through /proc unless it is marked non-dumpable. Core holds the vault, so it marks itself at start with a
 * tiny native library shipped next to it (prctl(PR_SET_DUMPABLE, 0) in its constructor). Off the phone it is absent.
 */
export function protectProcessMemory(log: (...args: unknown[]) => void): boolean {
  const lib = join(dirname(fileURLToPath(import.meta.url)), "libashnodump.so");
  if (!existsSync(lib)) return false;
  try { process.dlopen({ exports: {} } as unknown as NodeJS.Module, lib); }
  catch { /* not a Node addon: the constructor has already run */ }
  // A non-dumpable process's /proc files belong to root.
  const protectedNow = statSync("/proc/self/mem").uid === 0;
  log(protectedNow ? "process memory is protected from other processes" : "process memory protection did not take effect");
  return protectedNow;
}
