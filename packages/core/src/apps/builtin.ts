// ash's own apps travel inside the core and are put into the apps folder when missing or older; the app's own data
// (data.json and anything else it wrote) is left alone, and a same or newer version is never overwritten.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_APPS } from "./builtin.generated";
import { compareVersions } from "./schema";

export function installBuiltinApps(root: string, log: (...args: unknown[]) => void = () => {}, apps = BUILTIN_APPS): string[] {
  const installed: string[] = [];
  for (const app of apps) {
    const dir = join(root, app.id);
    let current: string | null = null;
    try { if (existsSync(join(dir, "app.json"))) current = String(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")).version ?? "0.0.0"); }
    catch { current = "0.0.0"; }
    if (current !== null && compareVersions(current, app.version) >= 0) continue;
    mkdirSync(dir, { recursive: true });
    // app.json last: a half-written update is never discovered as the new version.
    for (const name of [...Object.keys(app.files).filter((file) => file !== "app.json"), "app.json"]) {
      const temp = join(dir, `.${name}.tmp-${process.pid}`);
      writeFileSync(temp, app.files[name]!, { mode: 0o644 });
      renameSync(temp, join(dir, name));
    }
    installed.push(app.id);
    log("built-in app installed", app.id, app.version, current ? `(was ${current})` : "");
  }
  return installed;
}
