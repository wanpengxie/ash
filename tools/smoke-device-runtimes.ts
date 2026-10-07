// Explicit local smoke test. Uses existing desktop logins, never reads or prints credentials.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectRuntimes } from "../packages/device/src/agents/detect";
import { CodexSession } from "../packages/device/src/agents/codex";
import { ClaudeSession } from "../packages/device/src/agents/claude";
import { WorkBuddySession } from "../packages/device/src/agents/workbuddy";
import type { AgentEvent, OpenOptions } from "../packages/device/src/agents/types";

const runtimes = await detectRuntimes();
console.log(JSON.stringify(runtimes));
if (process.argv.includes("--execute")) for (const runtime of runtimes) {
  const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7);
  if (only && only !== runtime.kind) continue;
  if (!runtime.installed || runtime.logged_in === false) continue;
  const cwd = await mkdtemp(join(tmpdir(), "ash-runtime-smoke-"));
  const Driver = { codex: CodexSession, claude: ClaudeSession, workbuddy: WorkBuddySession }[runtime.kind];
  let finish!: (event: AgentEvent) => void;
  let final = new Promise<AgentEvent>(resolve => { finish = resolve; });
  let seed: string | undefined;
  let session: Awaited<ReturnType<typeof Driver.open>> | undefined, timer: NodeJS.Timeout | undefined;
  try {
    const options: OpenOptions = { cwd, tools: [], system: "This is a connectivity test. Do not use any tools, read files or make changes. Reply exactly ASH_DEVICE_OK.",
      onModels: models => { runtime.models = models; },
      onEvent: (event: AgentEvent) => { if (event.type === "seed_updated") seed = event.seed; if (event.type === "turn_ended") finish(event); }, onOutbound: async () => { throw new Error("Smoke test does not allow tools"); } };
    session = await Driver.open(options);
    console.log(JSON.stringify({ kind: runtime.kind, models: runtime.models }));
    // Probe an advertised model instead of relying on a possibly obsolete local default.
    if (runtime.models[0]) await session.select(runtime.models[0].id);
    await session.send("smoke", "Reply exactly ASH_DEVICE_OK. Do not use tools.");
    const event = await Promise.race([final, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("model turn timeout")), 90000); })]);
    const ok = event.type === "turn_ended" && event.outcome === "ok" && event.reply?.trim() === "ASH_DEVICE_OK";
    console.log(JSON.stringify({ kind: runtime.kind, model_roundtrip: ok, outcome: event.type === "turn_ended" ? event.outcome : "unknown", ...(event.type === "turn_ended" && event.error ? { error: event.error } : {}) }));
    if (!ok) process.exitCode = 1;
    if (ok && process.argv.includes("--lifecycle")) {
      clearTimeout(timer);
      final = new Promise<AgentEvent>(resolve => { finish = resolve; });
      await session.send("stop", "Reply exactly ASH_DEVICE_OK. Do not use tools.");
      try { await session.interrupt("stop"); }
      catch (error) { if (!/no active turn|turn is not running/.test((error as Error).message)) throw error; }
      const stopped = await Promise.race([final, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("interrupt confirmation timeout")), 45000); })]);
      const stopOK = stopped.type === "turn_ended" && ["ok", "interrupted"].includes(stopped.outcome);
      console.log(JSON.stringify({ kind: runtime.kind, stop_settled: stopOK, outcome: stopped.type === "turn_ended" ? stopped.outcome : "unknown" }));
      if (!stopOK) throw new Error("Stop did not settle to a known outcome");
      await session.close(); clearTimeout(timer);
      session = await Driver.open({ ...options, seed, model: runtime.models[0]?.id });
      final = new Promise<AgentEvent>(resolve => { finish = resolve; });
      await session.send("resumed", "Reply exactly ASH_DEVICE_OK. Do not use tools.");
      const resumed = await Promise.race([final, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("resume timeout")), 90000); })]);
      const resumeOK = resumed.type === "turn_ended" && resumed.outcome === "ok" && resumed.reply.trim() === "ASH_DEVICE_OK";
      console.log(JSON.stringify({ kind: runtime.kind, resumed: resumeOK }));
      if (!resumeOK) process.exitCode = 1;
    }
  } catch (error) { console.log(JSON.stringify({ kind: runtime.kind, model_roundtrip: false, error: (error as Error).message })); process.exitCode = 1; }
  finally { clearTimeout(timer); await session?.close(); }
}
