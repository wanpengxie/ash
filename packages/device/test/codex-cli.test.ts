/** `ash-device codex install | uninstall | status` as the user runs them, in a temporary HOME: nothing of the real ~/.codex is touched. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

async function cli(home: string, args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, ["--import", "tsx", MAIN, ...args], { env: { ...process.env, HOME: home, CODEX_HOME: "", ...env } });
}
const failure = async (promise: Promise<unknown>): Promise<string> => { try { await promise; } catch (e) { return String((e as { stderr?: string; message: string }).stderr || (e as Error).message); } throw new Error("expected a failure"); };

test("install, again, status, uninstall in a temporary HOME: the same steps a user runs, with the backup and the restore", async () => {
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-cli-home-"));
  const root = join(home, ".ash-device"), codexHome = join(home, ".codex");
  await mkdir(join(root, "current", "bin"), { recursive: true });
  await writeFile(join(root, "current", "bin", "ash-device"), "#!/bin/sh\n"); await chmod(join(root, "current", "bin", "ash-device"), 0o755);
  await mkdir(codexHome, { recursive: true });
  const before = "model = \"gpt-5\"\n";
  await writeFile(join(codexHome, "config.toml"), before);
  const common = ["--root", root];

  const first = (await cli(home, ["codex", "install", ...common])).stdout;
  assert.match(first, /added \[mcp_servers\.ash\]/);
  const config = await readFile(join(codexHome, "config.toml"), "utf8");
  assert.match(config, new RegExp(`command = "${join(root, "current", "bin", "ash-device").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`));
  assert.match(config, new RegExp(`args = \\["mcp", "--config", "${join(root, "device.json").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\]`));
  assert.equal((await readdir(codexHome)).filter((n) => n.startsWith("config.toml.ash-backup-")).length, 1);

  assert.match((await cli(home, ["codex", "install", ...common])).stdout, /already has/);
  assert.equal((await readdir(codexHome)).filter((n) => n.startsWith("config.toml.ash-backup-")).length, 1, "the second install made no backup");
  assert.deepEqual(JSON.parse((await cli(home, ["codex", "status", ...common])).stdout), { configPath: join(codexHome, "config.toml"), skillPath: join(codexHome, "skills", "ash", "SKILL.md"), config: "installed", skill: "installed" });

  await cli(home, ["codex", "uninstall", ...common]);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), before);
  assert.deepEqual(JSON.parse((await cli(home, ["codex", "status", ...common])).stdout).config, "missing");
  assert.equal(await stat(join(codexHome, "skills", "ash")).then(() => true, () => false), false);
});

test("CODEX_HOME and --codex-home say where Codex lives; without ~/.codex or an ash-device to point at, install stops and says what is missing", async () => {
  const home = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-cli-home-"));
  const root = join(home, ".ash-device");
  assert.match(await failure(cli(home, ["codex", "install", ...["--root", root]])), /current\/bin\/ash-device does not exist; give the ash-device program with --command/);
  const other = join(home, "elsewhere");
  assert.match(await failure(cli(home, ["codex", "install", "--root", root, "--command", "/bin/ash-device"])), /\.codex does not exist|does not exist.*Codex App installed/);
  await mkdir(other);
  await cli(home, ["codex", "install", "--root", root, "--command", "/bin/ash-device"], { CODEX_HOME: other });
  assert.match(await readFile(join(other, "config.toml"), "utf8"), /command = "\/bin\/ash-device"/);
  await cli(home, ["codex", "uninstall", "--codex-home", other]);
  assert.equal(await readFile(join(other, "config.toml"), "utf8"), "");
});
