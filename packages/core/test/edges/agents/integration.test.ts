import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createDshDriver } from "../../../src/edges/agents/dsh";
import { fixture, OWNER, waitFor } from "./helpers";

// The hub's agents module with the real DSH driver, over a stand-in agent that speaks only ACP and the _ash/* methods.
const SCRIPT = new URL("./fake-acp-agent.mjs", import.meta.url).pathname;
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test("SPEC-08 §5.1: kill the DSH process -> the driver reports ended -> the module starts it again -> both sessions are resumed and the next message is answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-int-"));
  dirs.push(dir);
  const logFile = join(dir, "agent.log");
  const written: Record<string, string> = {};
  const procs: ReturnType<typeof spawn>[] = [];
  const f = fixture({ secrets: { DEEPSEEK_API_KEY: "sk-fake-int-key" }, drivers: { dsh: (report) => createDshDriver({
    report, writeFile: async (path, content) => { written[path] = content; },
    spawn: () => { const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FAKE_EXT: "1", FAKE_LOG: logFile }, stdio: ["pipe", "pipe", "pipe"] }); procs.push(p); return p; },
  }) } });
  await f.start();
  await waitFor(() => f.agents.manager.stateOf("agent:main") === "idle");
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  try {
    assert.match(written["/root/work/AGENTS.md"]!, /soul v1/);
    assert.equal(log().filter((l) => l.new).length, 2); // front and back
    assert.equal(log().filter((l) => l.credentialSet).length, 1); // the key DSH lacked
    const handles = { ...f.agents.manager.runs.get("agent:main")!.spec.sessions };
    assert.equal(Object.keys(handles).length, 2);

    await f.call("agent:main", "say", { text: "hello there" });
    await waitFor(() => f.router.says().length === 1);
    assert.deepEqual(f.router.says(), [{ from: "agent:main", text: "echo: hello there" }]);
    assert.equal(f.router.events("turn.ended").length, 1);

    // the process dies in the middle of a turn
    await f.call("agent:main", "say", { text: "DIE now" });
    await waitFor(() => log().filter((l) => l.resume).length === 2, "both sessions resumed by the new process");
    assert.deepEqual(log().filter((l) => l.resume).map((l) => l.resume).sort(), Object.values(handles).sort());
    await waitFor(() => f.registry.members.has("agent:main"), "the agent registered again");
    // the key is asked about again, and the new process (which remembers nothing) is given it again
    await waitFor(() => log().filter((l) => l.credentialSet).length === 2);
    // what was cut off is not sent again as it was: the new process is given the recovery prompt, which names it, and answers it
    assert.equal(log().filter((l) => l.prompt && /DIE now/.test(l.text) && !/被中断/.test(l.text)).length, 1);
    await waitFor(() => f.router.says().length === 3, "the owner's line and the answer to the recovery prompt");
    const ends = f.router.events("turn.ended").map((e) => e.msg.body as { outcome: string });
    assert.deepEqual(ends.map((e) => e.outcome), ["completed", "error", "completed"]);
    assert.match(f.router.says()[1]!.text, /刚才中断了.*正在接着做：DIE now/);
    assert.equal(f.router.to("person:owner", "show").length, 0, "no failure card");
    // and the front lane takes a message again
    await f.call("agent:main", "say", { text: "still there?" });
    await waitFor(() => f.router.says().length === 4);
    assert.equal(f.router.says()[3]!.text, "echo: still there?");
    assert.ok(!JSON.stringify([f.router.sent, f.logs]).includes("sk-fake-int-key"));
  } finally {
    await f.agents.stopAll();
    for (const p of procs) p.kill("SIGKILL");
  }
});

test("T17h: kill -9 in the middle of a turn (no reply, stdout closes): the turn ends as an error once, and the new process is given the recovery prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-int-"));
  dirs.push(dir);
  const logFile = join(dir, "agent.log");
  const procs: ReturnType<typeof spawn>[] = [];
  const f = fixture({ drivers: { dsh: (report) => createDshDriver({
    report, writeFile: async () => {},
    spawn: () => { const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FAKE_EXT: "1", FAKE_LOG: logFile, FAKE_KILLED: join(dir, "killed") }, stdio: ["pipe", "pipe", "pipe"] }); procs.push(p); return p; },
  }) } });
  await f.start();
  await waitFor(() => f.agents.manager.stateOf("agent:main") === "idle");
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  try {
    await f.call("agent:main", "say", { text: "KILL9 a long task" });
    await waitFor(() => f.router.events("turn.ended").length === 2, "the cut turn and the picked-up one");
    assert.deepEqual(f.router.events("turn.ended").map((e) => (e.msg.body as { outcome: string }).outcome), ["error", "completed"]);
    assert.match(f.router.says()[0]!.text, /刚才中断了.*正在接着做：KILL9 a long task/);
    assert.equal(f.router.to("person:owner", "show").length, 0, "no failure card");
    assert.equal(log().filter((l) => l.prompt && /KILL9/.test(l.text)).length, 2, "the words once on each process, the second time inside the recovery prompt");
    assert.equal(log().filter((l) => l.prompt && /被中断/.test(l.text)).length, 1);
    assert.equal(procs.length, 2);
  } finally {
    await f.agents.stopAll();
    for (const p of procs) p.kill("SIGKILL");
  }
});

test("two lanes of the real driver run at once, and a reflect lane's words stay private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-int-"));
  dirs.push(dir);
  const procs: ReturnType<typeof spawn>[] = [];
  const f = fixture({ drivers: { dsh: (report) => createDshDriver({
    report, writeFile: async () => {},
    spawn: () => { const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FAKE_EXT: "1" }, stdio: ["pipe", "pipe", "pipe"] }); procs.push(p); return p; },
  }) } });
  await f.start();
  try {
    await f.service("declare", { id: "agent:r", name: "r", summary: "reflective", brief: "reflect",
      lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], speak: false } } });
    await f.call("agent:r", "say", { text: "SLOW question" });
    await waitFor(() => f.router.events("turn.started").length === 1);
    await f.call("agent:main", "say", { text: "other agent question" }); // another agent, same driver, runs meanwhile
    await waitFor(() => f.router.says().length === 1);
    assert.equal(f.router.says()[0]!.from, "agent:main");
    await f.service("session.steer", { agent: "agent:r", key: "front", text: "GO" });
    await waitFor(() => f.router.says().length === 2);
    await waitFor(() => f.router.events("turn.ended").length === 3, "front, main and reflect turns");
    assert.deepEqual(f.router.says().map((s) => s.from).sort(), ["agent:main", "agent:r"]);
    assert.deepEqual(f.router.events("turn.ended").map((e) => (e.msg.body as any).lane).sort(), ["front", "front", "reflect"]);
  } finally {
    await f.agents.stopAll();
    for (const p of procs) p.kill("SIGKILL");
  }
});
