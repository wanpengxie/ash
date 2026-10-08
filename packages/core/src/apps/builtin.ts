// ash's own apps travel inside the core and are put into the apps folder when missing or older; the app's own data
// (data.json and anything else it wrote) is left alone, and a same or newer version is never overwritten.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BUILTIN_APPS } from "./builtin.generated";
import { APP_CONTRACT_DOC, HELLO_EXAMPLE, HELLO_EXAMPLE_BINARY } from "./contract.generated";
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

/**
 * The contract and the hello example next to the apps, for an agent to read with its own tools: <root>/APP-CONTRACT.md
 * and <root>/_examples/hello/ (not an app folder: "_examples" is no app id, so discovery passes it by). Rewritten only
 * when ash's copy differs.
 */
export function installAppDocs(root: string): void {
  const files: Record<string, string | Buffer> = { "APP-CONTRACT.md": APP_CONTRACT_DOC };
  for (const [name, text] of Object.entries(HELLO_EXAMPLE)) files[`_examples/hello/${name}`] = text;
  for (const [name, data] of Object.entries(HELLO_EXAMPLE_BINARY)) files[`_examples/hello/${name}`] = Buffer.from(data, "base64");
  for (const [name, content] of Object.entries(files)) {
    const file = join(root, name);
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    try { if (existsSync(file) && readFileSync(file).equals(bytes)) continue; } catch { /* rewrite */ }
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, bytes, { mode: 0o644 });
    renameSync(temp, file);
  }
}
