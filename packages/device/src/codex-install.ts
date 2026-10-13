/**
 * `ash-device codex install | uninstall | status`: make the Codex App able to use Ash.
 *
 * Two things go in, as one: the MCP server `ash` (`ash-device mcp`) in Codex's `config.toml`, and the skill `ash` in Codex's
 * skills directory. Codex's plugin format could carry both, but a plugin has to be taken in through a marketplace and the
 * app's own plugin cache, which a program of ours cannot do without owning that; direct registration is the documented way.
 *
 * Safe to run again: what is already right is left alone. Before any file Codex owns changes, it is copied to `<name>.ash-backup-<time>`.
 * The config is edited as text, in one marked block, so everything else in it stays byte for byte; `uninstall` takes the block out.
 */
import { copyFile, mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_SKILL } from "./skill.generated";

export const BLOCK_START = "# >>> ash (managed by `ash-device codex install`; remove it with `ash-device codex uninstall`) >>>";
export const BLOCK_END = "# <<< ash <<<";
export const SKILL_MARK = "<!-- managed by `ash-device codex install`: changes here are replaced by the next install -->";

export interface CodexInstallOptions {
  /** Codex's home (default `$CODEX_HOME`, else `~/.codex`). */
  codexHome?: string;
  /** What Codex starts for the MCP server: the ash-device program and its arguments (`mcp --config <file>`). */
  command: string;
  args: string[];
  now?: () => number;
}

export const codexHome = (env: NodeJS.ProcessEnv = process.env): string => env.CODEX_HOME || join(homedir(), ".codex");

const q = (text: string) => JSON.stringify(text); // a TOML basic string is a JSON string for these characters
const exists = (path: string) => stat(path).then(() => true, () => false);
const blockPattern = new RegExp(`\\n?${BLOCK_START.replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")}[\\s\\S]*?${BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`);

export function block(o: Pick<CodexInstallOptions, "command" | "args">): string {
  return [BLOCK_START, "[mcp_servers.ash]", `command = ${q(o.command)}`, `args = [${o.args.map(q).join(", ")}]`, "tool_timeout_sec = 120", BLOCK_END, ""].join("\n");
}
/** Something of the user's already defines the server `ash`, outside our block. */
const definedByHand = (config: string) => /^\s*\[mcp_servers\.("?)ash\1(\.[^\]]*)?\]/m.test(config) || /^\s*mcp_servers\.("?)ash\1[.\s=]/m.test(config);
const without = (config: string) => config.replace(blockPattern, "");

export interface CodexStatus { config: "installed" | "missing" | "other"; skill: "installed" | "missing" | "other"; configPath: string; skillPath: string }

async function backup(path: string, now: number): Promise<string | null> {
  if (!(await exists(path))) return null;
  const copy = `${path}.ash-backup-${now}`;
  await copyFile(path, copy);
  return copy;
}

export async function codexStatus(o: CodexInstallOptions): Promise<CodexStatus> {
  const home = o.codexHome ?? codexHome();
  const configPath = join(home, "config.toml"), skillPath = join(home, "skills", "ash", "SKILL.md");
  const config = await readFile(configPath, "utf8").catch(() => "");
  const skill = await readFile(skillPath, "utf8").catch(() => null);
  return {
    configPath, skillPath,
    config: config.includes(BLOCK_START) ? "installed" : definedByHand(config) ? "other" : "missing",
    skill: skill === null ? "missing" : skill.includes(SKILL_MARK) ? "installed" : "other",
  };
}

const skillText = () => CODEX_SKILL.replace(/^(---\n[\s\S]*?\n---\n)/, `$1\n${SKILL_MARK}\n`);

export async function installCodex(o: CodexInstallOptions): Promise<string[]> {
  const home = o.codexHome ?? codexHome(), now = (o.now ?? Date.now)();
  if (!(await exists(home))) throw new Error(`Codex's home ${home} does not exist: is the Codex App installed and opened once on this computer?`);
  const said: string[] = [];
  const configPath = join(home, "config.toml");
  const current = await readFile(configPath, "utf8").catch(() => null);
  const base = current ?? "";
  if (definedByHand(without(base))) throw new Error(`${configPath} already defines [mcp_servers.ash] by hand; remove it (or rename it) and run this again`);
  const rest = without(base);
  const next = rest === "" ? block(o) : `${rest}${rest.endsWith("\n") ? "\n" : "\n\n"}${block(o)}`;
  if (next === base) said.push(`config.toml already has the ash MCP server`);
  else {
    const copy = await backup(configPath, now);
    await writeFile(configPath, next);
    said.push(`config.toml: added [mcp_servers.ash] -> ${o.command} ${o.args.join(" ")}${copy ? ` (backup ${copy})` : " (new file)"}`);
  }
  const dir = join(home, "skills", "ash"), skillPath = join(dir, "SKILL.md");
  const want = skillText();
  const have = await readFile(skillPath, "utf8").catch(() => null);
  if (have === want) said.push("skill ash is already in place");
  else {
    await mkdir(dir, { recursive: true });
    const copy = have !== null && !have.includes(SKILL_MARK) ? await backup(skillPath, now) : null;
    await writeFile(skillPath, want);
    said.push(`skill: ${skillPath}${copy ? ` (the file that was there is kept as ${copy})` : ""}`);
  }
  said.push("Restart the Codex App (or open a new session) so it loads the MCP server and the skill.");
  return said;
}

export async function uninstallCodex(o: Pick<CodexInstallOptions, "codexHome" | "now">): Promise<string[]> {
  const home = o.codexHome ?? codexHome(), now = (o.now ?? Date.now)();
  const said: string[] = [];
  const configPath = join(home, "config.toml");
  const current = await readFile(configPath, "utf8").catch(() => null);
  if (current !== null && current.includes(BLOCK_START)) {
    const copy = await backup(configPath, now);
    await writeFile(configPath, without(current));
    said.push(`config.toml: removed the ash MCP server (backup ${copy})`);
  } else said.push("config.toml has no ash MCP server of ours");
  const dir = join(home, "skills", "ash"), skillPath = join(dir, "SKILL.md");
  const have = await readFile(skillPath, "utf8").catch(() => null);
  if (have !== null && have.includes(SKILL_MARK)) {
    await rm(skillPath);
    if (!(await readdir(dir)).length) await rmdir(dir);
    said.push("skill ash removed");
  } else said.push(have === null ? "no skill ash" : "skill ash is not ours (no mark): left alone");
  return said;
}
