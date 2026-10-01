import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DshHost } from "../src/host";

const root = process.env.ASH_TEST_DSH_ROOT;
const skip = !root || !existsSync(join(root, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed DSH package" : false;

test("ash skills plugin appears in a fresh DSH catalog without patching DSH", { skip }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ash-skills-"));
  const host = new DshHost({
    root: root!, home: join(scratch, "dsh-home"),
    skillsRoot: resolve("packages/ash-skills"),
    env: { DSH_TELEMETRY_DISABLED: "1" },
  });
  try {
    await host.boot();
    const names = (await host.ctx.skills.list()).map((skill: { name: string }) => skill.name);
    for (const name of ["first-meeting", "ash-self-evidence", "forget", "ash-broad-inquiry"])
      assert.ok(names.includes(name), `${name} missing from DSH catalog`);
    const first = await host.ctx.skills.get("first-meeting");
    assert.match(first.content, /第一次聊天/);
    assert.doesNotMatch(first.content, /^---/);
    await host.close();
    const restarted = new DshHost({
      root: root!, home: join(scratch, "dsh-home"),
      skillsRoot: resolve("packages/ash-skills"),
      env: { DSH_TELEMETRY_DISABLED: "1" },
    });
    try {
      await restarted.boot();
      const afterRestart = (await restarted.ctx.skills.list()).map((skill: { name: string }) => skill.name);
      for (const name of ["first-meeting", "ash-self-evidence", "forget", "ash-broad-inquiry"])
        assert.ok(afterRestart.includes(name), `${name} missing after DSH restart`);
    } finally {
      await restarted.close();
    }
  } finally {
    await host.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
