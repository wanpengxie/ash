import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface RuntimeInfo { kind: "codex" | "claude" | "workbuddy"; installed: boolean; logged_in: boolean | null; models: { id: string; efforts?: string[] }[] }
async function executable(names: string[]): Promise<string | undefined> {
  for (const name of names) for (const path of name.includes("/") ? [name] : (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, name))) {
    try { await access(path, constants.X_OK); return path; } catch { /* next path */ }
  }
}
/** Probe login status only, never starts a model turn or reads provider credential files. */
export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  return Promise.all((["codex", "claude", "workbuddy"] as const).map(async kind => {
    const command = await executable(kind === "workbuddy" ? ["/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", "codebuddy"] : [kind]);
    const info: RuntimeInfo = { kind, installed: !!command, logged_in: null, models: [] };
    if (!command || kind === "workbuddy") return info;
    try {
      const result = await exec(command, kind === "codex" ? ["login", "status"] : ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 128 * 1024 });
      info.logged_in = kind === "codex" ? true : JSON.parse(result.stdout).loggedIn === true;
    } catch { /* unavailable status is unknown, not proof of no login */ }
    return info;
  }));
}
