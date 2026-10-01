import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("production owner restart does not reclassify a keyed offer or revive a retired work source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-key-kill-"));
  const childFile = join(import.meta.dirname, "post-key-kill-child.ts");
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ["--expose-internals", "--import", "tsx", childFile, mode, dir], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    let stdout = "", stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const line = (prefix: string) => new Promise<string>((resolve, reject) => {
      const inspect = () => { const found = stdout.split("\n").find((row) => row.startsWith(prefix)); if (found) resolve(found); };
      child.stdout?.on("data", inspect);
      child.once("exit", (code) => { inspect(); reject(new Error(`child exited before ${prefix}: ${code}; ${stderr}`)); });
      inspect();
    });
    return { child, exit, line, get stderr() { return stderr; } };
  };
  const bounded = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer!: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8000); })]); }
    finally { clearTimeout(timer); }
  };
  let victim: ReturnType<typeof launch> | undefined;
  let recovery: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    assert.equal(await bounded(victim.line("READY"), "victim"), "READY");
    victim.child.kill("SIGKILL");
    assert.equal((await victim.exit)[1], "SIGKILL");
    recovery = launch("recover");
    const result = JSON.parse((await bounded(recovery.line("RESULT "), "recovery")).slice(7)) as {
      before: number; after: number; strandedResponse: { ok: boolean; error?: { code: string } }; secondState: string; secondDeliveries: number };
    assert.equal((await bounded(recovery.exit, "recovery exit"))[0], 0, recovery.stderr);
    assert.equal(result.before, 1);
    assert.equal(result.after, 1, "already classified offer must not be submitted again after restart");
    assert.equal(result.strandedResponse.error?.code, "forbidden", "current production authority rejects retired work source");
    assert.equal(result.secondState, "dropped");
    assert.equal(result.secondDeliveries, 1);
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
