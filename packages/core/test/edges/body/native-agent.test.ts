/**
 * The same `agents/main.json` runs in the container and on a development machine: the declaration names a place on the body
 * (`/root/work`), and the native body keeps that place under its workspace. The whole hub, a fake host with the native
 * isolation, the real DSH driver and a stand-in for the DSH program (the ACP agent of the driver tests).
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startHub } from "../../../src/next";
import { FakeHost } from "../../fixtures/host";
import { eventually } from "../../fixtures/wait";

const ACP_AGENT = new URL("../agents/fake-acp-agent.mjs", import.meta.url).pathname;

test("native isolation: agent:main starts from the shipped main.json, and its AGENTS.md is written under the workspace", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "native-agent-"));
  const host = new FakeHost();
  t.after(async () => { await host.stop(); await rm(dir, { recursive: true, force: true }); });
  await host.start();

  const log = join(dir, "acp.log");
  const dsh = join(dir, "dsh");
  await writeFile(dsh, `#!/bin/sh\nexec "${process.execPath}" "${ACP_AGENT}" "$@"\n`);
  await chmod(dsh, 0o755);
  process.env.FAKE_LOG = log;
  t.after(() => { delete process.env.FAKE_LOG; });
  const workspace = join(dir, "home");
  const launch = host.writeLaunch({ isolation: { kind: "native", native: { workspace, dsh_bin: dsh, dsh_home: join(dir, "dsh-home") } } });

  const pipe = host.connect();
  // No drivers given: the real DSH driver, through the real body.
  const hub = await startHub({ dataDir: join(dir, "state"), port: 0, env: { ...launch.env }, stdin: pipe.stdin, stdout: pipe.stdout });
  t.after(() => hub.stop());

  const baseline = join(workspace, "root", "work", "AGENTS.md");
  await eventually(() => existsSync(baseline) && existsSync(log), "agent:main started: its baseline file and its sessions");
  assert.match(await readFile(baseline, "utf8"), /\S/, "the baseline instructions were written");
  await eventually(async () => (await readFile(log, "utf8")).includes('"new"'), "a session opened");
  // DSH is told the machine's path of its place: it reads AGENTS.md and runs its shell there.
  const sessions = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.new);
  const place = await realpath(join(workspace, "root", "work"));
  assert.ok(sessions.length > 0 && sessions.every((e) => e.cwd === join(workspace, "root", "work") || e.cwd === place), JSON.stringify(sessions));
  assert.ok(!existsSync(join(workspace, "AGENTS.md")), "nothing was written outside the body's own place");
});
