import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STUCK_MS } from "../fixtures/wait";

for (const [target, revoked] of [["pause", false], ["resume", false], ["pause", true], ["resume", true]] as const)
  test(`SIGKILL after committed ${target} with old owner credential ${revoked ? "revoked" : "current"} preserves the fact`, async () => {
  const dir = mkdtempSync(join(tmpdir(), `ash-admin-${target}-kill-`));
  const childFile = join(import.meta.dirname, "admin-kill-child.ts");
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ["--expose-internals", "--import", "tsx", childFile, mode, target, dir, revoked ? "revoked" : "current"], { stdio: ["ignore", "pipe", "pipe"] });
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
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), STUCK_MS); })]); }
    finally { clearTimeout(timer); }
  };
  let victim: ReturnType<typeof launch> | undefined, recovery: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    assert.equal(await bounded(victim.line("COMMITTED"), "commit barrier"), "COMMITTED");
    victim.child.kill("SIGKILL");
    assert.equal((await victim.exit)[1], "SIGKILL");
    if (revoked) {
      const tokensFile = join(dir, "state", "tokens.json");
      const tokens = JSON.parse(readFileSync(tokensFile, "utf8")) as { api: Record<string, string> };
      for (const [key, member] of Object.entries(tokens.api)) if (member === "person:owner") delete tokens.api[key];
      writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
    }
    recovery = launch("recover");
    const result = JSON.parse((await bounded(recovery.line("RESULT "), "recovery")).slice(7)) as {
      requestId: string; reply?: { ok: boolean; result?: { paused: boolean } }; retryId?: string;
      retryReply?: { ok: boolean; result?: { paused: boolean } }; commands: number[]; state: string; cancels: number };
    assert.equal((await bounded(recovery.exit, "recovery exit"))[0], 0, recovery.stderr);
    assert.deepEqual(result.reply, { ok: true, result: { paused: target === "pause" } });
    if (!revoked) {
      assert.equal(result.retryId, result.requestId);
      assert.deepEqual(result.retryReply, result.reply);
    }
    assert.deepEqual(result.commands, target === "pause" ? [1] : [1, 0], "no duplicate durable effect");
    assert.equal(result.state, target === "pause" ? "true" : "false");
    assert.equal(result.cancels, 0, "committed fact reconciliation must not run pause again");
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
