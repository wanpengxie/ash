import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STUCK_MS } from "../fixtures/wait";

test("SIGKILL after pause commit reconciles active tool cancellation before restart dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-active-kill-"));
  const file = join(import.meta.dirname, "admin-active-kill-child.ts");
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
    try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), STUCK_MS); })]); }
    finally { clearTimeout(timer); }
  };
  let victim: ReturnType<typeof launch> | undefined, recovery: ReturnType<typeof launch> | undefined, reopened: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    assert.equal(await bounded(victim.line("COMMITTED"), "commit barrier"), "COMMITTED");
    victim.child.kill("SIGKILL");
    assert.equal((await victim.exit)[1], "SIGKILL");
    recovery = launch("recover");
    const first = JSON.parse((await bounded(recovery.line("RESULT "), "first recovery")).slice(7));
    assert.equal((await bounded(recovery.exit, "first exit"))[0], 0, recovery.stderr);
    assert.deepEqual(first.ends, ["cancelled"]);
    assert.equal(first.state.pending, 1);
    assert.equal(first.state.intents, 1);
    assert.equal(first.state.facts, 1);
    assert.equal(first.runs, 0, "paused recovery must not invoke the model");
    assert.deepEqual(first.history, { started: 1, completed: 0 }, "the cancelled turn must not be resumed as completed work");
    assert.equal(first.toolReplies.length, 1);
    assert.equal(first.toolReplies[0].error.code, "cancelled");
    assert.deepEqual(first.pauseReply, { ok: true, result: { paused: true } });
    assert.equal(first.cancelled, 0, "recovery must not replay a live cancel request");
    reopened = launch("reopen");
    const second = JSON.parse((await bounded(reopened.line("RESULT "), "second recovery")).slice(7));
    assert.equal((await bounded(reopened.exit, "second exit"))[0], 0, reopened.stderr);
    assert.deepEqual(second.before.ends, ["cancelled"]);
    assert.equal(second.before.state.intents, 1);
    assert.equal(second.before.toolReplies.length, 1);
    assert.equal(second.before.runs, 0);
    assert.deepEqual(second.before.history, { started: 1, completed: 0 });
    assert.deepEqual(second.resume, { ok: true, result: { paused: false } });
    assert.deepEqual(second.after.ends, ["cancelled", "completed"]);
    assert.equal(second.after.state.pending, 0);
    assert.equal(second.after.runs, 1);
    assert.deepEqual(second.after.stopFactsSeen, [1]);
    assert.equal(second.after.state.facts, 0, "only a completed next turn consumes the stop fact");
    assert.deepEqual(second.after.history, { started: 2, completed: 1 });
    assert.equal(second.after.toolReplies.length, 1);
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    if (reopened?.child.exitCode === null) reopened.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
