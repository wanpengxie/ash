import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("accepted stale pause cancellation remains harmless after SIGKILL and recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-stale-kill-"));
  const file = join(import.meta.dirname, "admin-stale-kill-child.ts");
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ["--expose-internals", "--import", "tsx", file, mode, dir], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const line = (prefix: string) => new Promise<string>((resolve, reject) => {
      const inspect = () => { const row = stdout.split("\n").find((entry) => entry.startsWith(prefix)); if (row) resolve(row); };
      child.stdout?.on("data", inspect);
      child.once("exit", (code) => { inspect(); reject(new Error(`isolated child exited before ${prefix}: ${code}; ${stderr}`)); });
      inspect();
    });
    return { child, exit, line, get stderr() { return stderr; } };
  };
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 12000); })]); }
    finally { clearTimeout(timer); }
  };
  let victim: ReturnType<typeof launch> | undefined, recovery: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    assert.equal(await bounded(victim.line("READY"), "accepted barrier"), "READY");
    victim.child.kill("SIGKILL");
    assert.equal((await victim.exit)[1], "SIGKILL");
    recovery = launch("recover");
    const result = JSON.parse((await bounded(recovery.line("RESULT "), "recovery")).slice(7));
    assert.equal((await bounded(recovery.exit, "recovery exit"))[0], 0, recovery.stderr);
    assert.deepEqual(result.reply, { ok: true, result: { cancelled: false } });
    assert.equal(result.intents, 0);
    assert.equal(result.runs, 0, "restart must not resume the old model session");
    assert.deepEqual(result.ends, ["completed", "error"], "process restart, not stale admin cancel, ends the newer turn");
    assert.equal(result.cancelled, 1);
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
