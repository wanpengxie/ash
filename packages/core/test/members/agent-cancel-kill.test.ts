import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}

test("SIGKILL between durable cancel intent and router settlement cannot replay a device request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-cancel-kill-"));
  const childFile = join(import.meta.dirname, "agent-cancel-kill-child.ts");
  const launch = (mode: string) => {
    const child = spawn(process.execPath, ["--expose-internals", "--import", "tsx", childFile, mode, dir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const line = (prefix: string) => new Promise<string>((resolve, reject) => {
      const inspect = () => { const found = stdout.split("\n").find((row) => row.startsWith(prefix)); if (found) resolve(found); };
      child.stdout?.on("data", inspect);
      child.once("exit", (code) => { inspect(); reject(new Error(`child exited before ${prefix}: ${code}; ${stderr}`)); });
      inspect();
    });
    return { child, line, get stderr() { return stderr; } };
  };
  let victim: ReturnType<typeof launch> | undefined;
  let recovery: ReturnType<typeof launch> | undefined;
  try {
    victim = launch("victim");
    assert.equal(await bounded(victim.line("INTENT_READY"), 5_000, "intent wait"), "INTENT_READY");
    victim.child.kill("SIGKILL");
    const [, signal] = await once(victim.child, "exit");
    assert.equal(signal, "SIGKILL");

    recovery = launch("recover");
    const resultLine = await bounded(recovery.line("RESULT "), 7_000, "recovery wait");
    const result = JSON.parse(resultLine.slice("RESULT ".length)) as { deviceCalls: number; unsettledBeforeRouter: number;
      batches: { texts: string[]; facts: string[] }[]; holdResponses: { ok: boolean; error?: { code: string } }[]; endReasons: string[] };
    const [code] = await once(recovery.child, "exit");
    assert.equal(code, 0, recovery.stderr);
    assert.equal(result.unsettledBeforeRouter, 0, "cancel intent was not reconciled before router recovery");
    assert.equal(result.deviceCalls, 0, "device request replayed after restart");
    assert.deepEqual(result.holdResponses.map((body) => body.error?.code), ["cancelled"]);
    assert.deepEqual(result.endReasons, ["cancelled", "completed", "completed"]);
    assert.equal(result.batches.length, 2);
    assert.deepEqual(result.batches[0].texts, ["after crash"]);
    assert.equal(result.batches[0].facts.length, 1);
    assert.match(result.batches[0].facts[0], /stop before router settlement/);
    assert.deepEqual(result.batches[1], { texts: ["later"], facts: [] });
  } finally {
    if (victim?.child.exitCode === null) victim.child.kill("SIGKILL");
    if (recovery?.child.exitCode === null) recovery.child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
