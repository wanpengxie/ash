import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export interface DetectedRuntime { kind: "codex" | "claude" | "workbuddy"; installed: boolean; logged_in: boolean | null; models: { id: string; efforts?: string[] }[] }
async function executable(names: string[]): Promise<string | undefined> {
  for (const name of names) for (const path of name.includes("/") ? [name] : (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, name))) {
    try { await access(path, constants.X_OK); return path; } catch { /* next path */ }
  }
}
/**
 * Where each runtime's program is: on PATH, else where its desktop app keeps it. The Codex App (standalone, or inside the
 * ChatGPT app) carries its own `codex`, which is not on PATH, least of all a background service's.
 */
const WHERE: Record<DetectedRuntime["kind"], string[]> = {
  codex: ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    join(homedir(), "Applications/Codex.app/Contents/Resources/codex"), join(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex")],
  claude: ["claude", join(homedir(), ".claude/local/claude"), join(homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  workbuddy: ["/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", "codebuddy"],
};
/** The program of a runtime, or undefined when this computer has none. */
export const findRuntime = (kind: DetectedRuntime["kind"]): Promise<string | undefined> => executable(WHERE[kind]);
/** Probe login status only, never starts a model turn or reads provider credential files. */
export async function detectRuntimes(): Promise<DetectedRuntime[]> {
  return Promise.all((["codex", "claude", "workbuddy"] as const).map(async kind => {
    const command = await findRuntime(kind);
    const info: DetectedRuntime = { kind, installed: !!command, logged_in: null, models: [] };
    if (!command || kind === "workbuddy") return info;
    try {
      const result = await exec(command, kind === "codex" ? ["login", "status"] : ["auth", "status", "--json"], { timeout: 5000, maxBuffer: 128 * 1024 });
      info.logged_in = kind === "codex" ? true : JSON.parse(result.stdout).loggedIn === true;
    } catch { /* unavailable status is unknown, not proof of no login */ }
    return info;
  }));
}
