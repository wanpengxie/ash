import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { renameSync, writeFileSync, watch } from "node:fs";
/** Register before known fixture writes, wait until each pathname was observed, then
 * drain that poll batch before obtaining a fresh manifest/context. No fixed delay. */
export async function observeAuthorizationWrites(directory: string, filenames: readonly string[], write: () => void): Promise<void> {
  const pending = new Set(filenames);
  let resolve!: () => void, reject!: (error: Error) => void;
  const observed = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const watcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (filename !== null) pending.delete(String(filename));
    if (!pending.size) resolve();
  });
  watcher.on("error", reject);
  const deadline = setTimeout(() => reject(new Error("Fixture authorization events were not observed")), 3000);
  try { await new Promise<void>(done => setImmediate(done)); write(); await observed; await new Promise<void>(done => setImmediate(done)); }
  finally { clearTimeout(deadline); watcher.close(); }
}

export function replaceFixtureAuthorization(directory: string, name: string, raw: string): void {
  const temporary = join(directory, `.fixture-${randomUUID()}`);
  writeFileSync(temporary, raw, { mode: 0o600, flag: "wx" });
  renameSync(temporary, join(directory, name));
}
