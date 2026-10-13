import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOCK_START, SKILL_MARK, codexStatus, installCodex, uninstallCodex } from "../src/codex-install";
import { CODEX_SKILL } from "../src/skill.generated";

const options = (codexHome: string) => ({ codexHome, command: "/home/u/.ash-device/current/bin/ash-device", args: ["mcp", "--config", "/home/u/.ash-device/device.json"], now: () => 1000 });
const home = async () => mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "codex-home-"));
const exists = (path: string) => stat(path).then(() => true, () => false);
const ORIGINAL = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["x"]\n`;

test("install adds the MCP server and the skill, keeps the rest of the config byte for byte, and backs the config up first", async () => {
  const dir = await home();
  await writeFile(join(dir, "config.toml"), ORIGINAL);
  const said = await installCodex(options(dir));
  const config = await readFile(join(dir, "config.toml"), "utf8");
  assert.ok(config.startsWith(ORIGINAL), "what was there is untouched");
  assert.match(config, /\[mcp_servers\.ash\]\ncommand = "\/home\/u\/\.ash-device\/current\/bin\/ash-device"\nargs = \["mcp", "--config", "\/home\/u\/\.ash-device\/device\.json"\]\ntool_timeout_sec = 120\n/);
  assert.equal(await readFile(join(dir, "config.toml.ash-backup-1000"), "utf8"), ORIGINAL, "the backup is the config as it was");
  const skill = await readFile(join(dir, "skills", "ash", "SKILL.md"), "utf8");
  assert.ok(skill.startsWith("---\nname: ash\n"), "the frontmatter is first");
  assert.ok(skill.includes(SKILL_MARK));
  assert.ok(said.some((line) => /backup/.test(line)) && said.some((line) => /Restart the Codex App/.test(line)));
  assert.deepEqual(await codexStatus(options(dir)).then(({ config, skill }) => ({ config, skill })), { config: "installed", skill: "installed" });
});

test("install again changes nothing and makes no backup; a changed command is rewritten, with a backup", async () => {
  const dir = await home();
  await writeFile(join(dir, "config.toml"), ORIGINAL);
  await installCodex(options(dir));
  const after = await readFile(join(dir, "config.toml"), "utf8");
  const said = await installCodex({ ...options(dir), now: () => 2000 });
  assert.equal(await readFile(join(dir, "config.toml"), "utf8"), after);
  assert.equal(await exists(join(dir, "config.toml.ash-backup-2000")), false);
  assert.ok(said.some((line) => /already/.test(line)));
  await installCodex({ ...options(dir), command: "/new/path/ash-device", now: () => 3000 });
  const moved = await readFile(join(dir, "config.toml"), "utf8");
  assert.match(moved, /command = "\/new\/path\/ash-device"/);
  assert.equal(moved.match(/\[mcp_servers\.ash\]/g)!.length, 1, "one block, not two");
  assert.equal(await readFile(join(dir, "config.toml.ash-backup-3000"), "utf8"), after);
});

test("uninstall takes the block and the skill out and leaves the config as it was before install", async () => {
  const dir = await home();
  await writeFile(join(dir, "config.toml"), ORIGINAL);
  await installCodex(options(dir));
  const said = await uninstallCodex({ codexHome: dir, now: () => 4000 });
  assert.equal(await readFile(join(dir, "config.toml"), "utf8"), ORIGINAL);
  assert.equal(await exists(join(dir, "skills", "ash")), false);
  assert.ok(said.some((line) => /backup/.test(line)));
  assert.deepEqual((await codexStatus(options(dir))).config, "missing");
  const again = await uninstallCodex({ codexHome: dir, now: () => 5000 });
  assert.ok(again.every((line) => /no |not ours/.test(line)));
});

test("no config at all: install makes one and uninstall leaves it empty; Codex not installed is an error that says so", async () => {
  const dir = await home();
  await installCodex(options(dir));
  assert.ok((await readFile(join(dir, "config.toml"), "utf8")).startsWith(BLOCK_START));
  assert.equal((await readdir(dir)).filter((n) => n.includes("backup")).length, 0, "there was nothing to back up");
  await uninstallCodex({ codexHome: dir });
  assert.equal(await readFile(join(dir, "config.toml"), "utf8"), "");
  await assert.rejects(installCodex(options(join(dir, "nowhere"))), /does not exist.*Codex App installed/);
});

test("a server called ash that the user wrote is not touched: install refuses and says what to do", async () => {
  const dir = await home();
  const own = `[mcp_servers.ash]\ncommand = "mine"\n`;
  await writeFile(join(dir, "config.toml"), own);
  await assert.rejects(installCodex(options(dir)), /already defines \[mcp_servers\.ash\] by hand/);
  assert.equal(await readFile(join(dir, "config.toml"), "utf8"), own);
  assert.equal(await exists(join(dir, "skills")), false, "nothing else was done either");
  assert.equal((await codexStatus(options(dir))).config, "other");
});

test("a skill file that is not ours is kept as a backup, and uninstall leaves one it did not write", async () => {
  const dir = await home();
  await mkdir(join(dir, "skills", "ash"), { recursive: true });
  await writeFile(join(dir, "skills", "ash", "SKILL.md"), "my own\n");
  await installCodex(options(dir));
  assert.equal(await readFile(join(dir, "skills", "ash", "SKILL.md.ash-backup-1000"), "utf8"), "my own\n");
  await uninstallCodex({ codexHome: dir });
  await writeFile(join(dir, "skills", "ash", "SKILL.md"), "someone else's\n");
  const said = await uninstallCodex({ codexHome: dir });
  assert.ok(said.some((line) => /not ours/.test(line)));
  assert.equal(await readFile(join(dir, "skills", "ash", "SKILL.md"), "utf8"), "someone else's\n");
});

test("the skill is in Ash's own skill format: frontmatter with name, description and whenToUse, in Chinese, and it is the file the generator read", async () => {
  const file = await readFile(new URL("../skill/SKILL.md", import.meta.url), "utf8");
  assert.equal(CODEX_SKILL, file, "run `node tools/gen-rules.mjs` after changing skill/SKILL.md");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(file)![1]!;
  const keys = Object.fromEntries(front.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  assert.equal(keys.name, "ash");
  assert.ok(keys.description!.length > 20 && keys.whenToUse!.length > 20);
  for (const tool of ["capability_list", "capability_describe", "capability_call", "await_result", "list_pending", "cancel", "agent_list", "agent_ask", "agent_tell", "waiting_owner", "pending.get", "pending.redeem"]) assert.ok(file.includes(tool), `the skill says ${tool}`);
});
