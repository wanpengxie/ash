import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
/** Watch parent directories so atomic file replacement remains observable. Every
 * delivered event invalidates; equality of the new bytes never suppresses ABA. */
export function watchControlAuthorization(paths: readonly string[], invalidate: () => void, onError?: () => void): () => void {
  const watchers: FSWatcher[] = []; let closed = false;
  const changed = () => { if (!closed) invalidate(); };
  try {
    const directories = new Map<string, Set<string>>();
    for (const path of paths) { const dir = dirname(path), names = directories.get(dir) ?? new Set<string>(); names.add(basename(path)); directories.set(dir, names); }
    for (const [dir, names] of directories) {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => { if (filename === null || names.has(String(filename))) changed(); });
      watcher.on("error", () => { changed(); closed = true; for (const handle of watchers) handle.close(); onError?.(); }); watchers.push(watcher);
    }
  } catch { changed(); for (const watcher of watchers) watcher.close(); onError?.(); throw new Error("Control authorization watcher unavailable"); }
  return () => { closed = true; for (const watcher of watchers) watcher.close(); };
}
