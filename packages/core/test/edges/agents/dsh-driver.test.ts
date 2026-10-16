import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { WordError } from "../../../../sdk/src/message";
import { wordContract } from "../../../../sdk/src/words";
import type { AgentEvent, AgentStartSpec, DriverMessage, PromptModule } from "../../../../sdk/src/driver";
import { createDshDriver, BASELINE_FILE } from "../../../src/edges/agents/dsh";

const SCRIPT = new URL("./fake-acp-agent.mjs", import.meta.url).pathname;
const dirs: string[] = [];
const drivers: ReturnType<typeof createDshDriver>[] = [];
after(async () => { for (const d of drivers) for (const a of ["agent:main", "agent:w"]) await d.stop(a, "test").catch(() => {}); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const waitFor = async (pred: () => boolean, what = "condition") => {
  const until = Date.now() + 8000;
  while (!pred()) { if (Date.now() > until) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-driver-"));
  dirs.push(dir);
  const logFile = join(dir, "agent.log");
  const events: AgentEvent[] = [];
  const written: Record<string, string> = {};
  const spawned: string[][] = [];
  const driver = createDshDriver({
    report: (e) => events.push(e),
    spawn: (argv) => { spawned.push(argv); return nodeSpawn(process.execPath, [SCRIPT], { env: { ...process.env, FAKE_LOG: logFile, ...env }, stdio: ["pipe", "pipe", "pipe"] }); },
    writeFile: async (path, content) => { written[path] = content; },
    timeZone: () => "Asia/Shanghai",
    readBlob: (ref) => (ref === "img" ? { bytes: Buffer.from("png"), mime: "image/png" } : null),
  });
  drivers.push(driver);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  const of = (name: AgentEvent["event"]) => events.filter((e) => e.event === name);
  return { driver, events, log, of, written, spawned, dir };
}

const module_ = (id: PromptModule["id"], body: string): PromptModule => ({ id, version: body.slice(0, 6), content: `[${id}] ${body}` });
const spec = (over: Partial<AgentStartSpec> = {}): AgentStartSpec => ({
  runtime: { kind: "dsh" }, native: { on: "body:main", cwd: "/root/work" }, tools: { mcp_url: "http://127.0.0.1:1/mcp", tokens: { front: "tok-front", back: "tok-back" }, allowed: [] },
  modules: { static: [module_("identity", "I am Ash"), module_("rules", "be kind")] }, lanes: ["front", "back"], sessions: {}, ...over,
});
const msg = (text: string, over: Partial<DriverMessage> = {}): DriverMessage => ({ id: `m_${text.slice(0, 6)}`, from: "person:owner", word: "say", text, lane: "front", at: 1_700_000_000_000, ...over });

test("start: baseline file, a process, one session per lane with the tool surface, handles reported", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  assert.deepEqual(t.driver.status("agent:main"), { state: "running" });
  assert.equal(t.written[`/root/work/${BASELINE_FILE}`], "[identity] I am Ash\n\n---\n\n[rules] be kind\n");
  const news = t.log().filter((l) => l.new);
  assert.equal(news.length, 2);
  assert.equal(news[0]!.cwd, "/root/work");
  assert.deepEqual(news[0]!.mcp, [{ type: "http", name: "ash", url: "http://127.0.0.1:1/mcp", headers: [{ name: "authorization", value: "Bearer tok-front" }] }]);
  assert.deepEqual(news[1]!.mcp, [{ type: "http", name: "ash", url: "http://127.0.0.1:1/mcp", headers: [{ name: "authorization", value: "Bearer tok-back" }] }], "each lane's session carries its own token");
  const handles = t.of("handle.updated") as Extract<AgentEvent, { event: "handle.updated" }>[];
  assert.deepEqual(handles.map((h) => h.key), ["front", "back"]);
  assert.equal(t.driver.session.get("agent:main", "front"), handles[0]!.handle);
  assert.equal(t.driver.session.get("agent:main", "nope"), null);
});

test("send: the turn is reported started, then speech as whole messages, thoughts apart, then ended; the envelope names the local time with its zone (not UTC), source, lane and id", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("hello TWO", { origin: { channel: "app", client: "client:a", label: "手机 · 对话" } })]);
  await waitFor(() => t.of("turn.ended").length === 1, "turn end");
  const order = t.events.filter((e) => e.agent === "agent:main" && e.event !== "handle.updated").map((e) => e.event);
  assert.deepEqual(order, ["turn.started", "thought", "output", "output", "turn.ended"]);
  const said = (t.of("output") as Extract<AgentEvent, { event: "output" }>[]).map((o) => o.text);
  assert.deepEqual(said, ["echo: hello TWO", "second"]); // two messages, not four chunks
  const started = t.of("turn.started")[0] as Extract<AgentEvent, { event: "turn.started" }>;
  assert.deepEqual(started.ids, ["m_hello "]);
  assert.equal((t.of("turn.ended")[0] as any).outcome, "completed");
  const seen = t.log().find((l) => l.prompt)!;
  assert.match(seen.text, /^\[ash\] 2023-11-15 Wed 06:13:20 Asia\/Shanghai \(UTC\+08:00\) · 手机 · 对话 · lane front · say · id m_hello /);
});

test("tool calls become tool events with start and end", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("TOOL please")]);
  await waitFor(() => t.of("turn.ended").length === 1);
  const tools = t.of("tool") as Extract<AgentEvent, { event: "tool" }>[];
  assert.deepEqual(tools.map((x) => [x.phase, x.name, x.ok]), [["start", "read_file", undefined], ["end", "read_file", true]]);
  assert.deepEqual(tools.map((x) => x.summary), ["在读文件", "在读文件"]); // an unknown name falls back on the ACP kind
});

test("ctx.read tool events describe the requested word without copying raw output into agent.tool summaries", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("CTXREAD please")]);
  await waitFor(() => t.of("turn.ended").length === 1);
  const tools = t.of("tool") as Extract<AgentEvent, { event: "tool" }>[];
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((e) => e.summary), ["在读手机上的使用记录", "在读手机上的使用记录"]);
  assert.ok(!JSON.stringify(tools).includes("SYNTHETIC_CTX_PRIVATE_SENTINEL"));
});

test("a tool event carries a human line (what the step is about: the command, the purpose), the same on start and end, and the raw name only as `name`", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("MANYCALLS please")]);
  await waitFor(() => t.of("turn.ended").length === 1);
  const tools = t.of("tool") as Extract<AgentEvent, { event: "tool" }>[];
  const history = wordContract("service:history", "query")!.label.doing;
  assert.deepEqual(tools.map((x) => [x.phase, x.name, x.summary, x.ok]), [
    ["start", "bash", "跑 sleep 90", undefined], ["end", "bash", "跑 sleep 90", true],
    ["start", "mcp__ash__human_say", "在回你", undefined], ["end", "mcp__ash__human_say", "在回你", true],
    ["start", "mcp__ash__capability_call", history, undefined], ["end", "mcp__ash__capability_call", history, true],
    ["start", "mcp__ash__capability_call", "在用手机/设备能力", undefined], ["end", "mcp__ash__capability_call", "在用手机/设备能力", true],
    ["start", "some_future_tool", "在处理", undefined], ["end", "some_future_tool", "在处理", false],
  ]);
});

test("two lanes run at once; one lane takes one turn at a time (send on a running lane is a conflict)", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("SLOW front")]);
  await t.driver.send("agent:main", "back", [msg("SLOW back", { lane: "back" })]); // front is still running
  await assert.rejects(t.driver.send("agent:main", "front", [msg("again")]), (e: any) => e instanceof WordError && e.code === "conflict");
  assert.equal(t.of("turn.started").length, 2);
  assert.equal(t.of("turn.ended").length, 0);
  await t.driver.steer("agent:main", "front", "GO");
  await t.driver.steer("agent:main", "back", "GO");
  await waitFor(() => t.of("turn.ended").length === 2);
});

test("followup: queued behind the running turn, becomes the next turn at once; on an idle lane it is a send", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("SLOW first")]);
  await t.driver.followup("agent:main", "front", [msg("second")]);
  await t.driver.followup("agent:main", "front", [msg("third")]);
  assert.equal(t.of("turn.started").length, 1);
  await t.driver.steer("agent:main", "front", "GO");
  await waitFor(() => t.of("turn.ended").length === 2, "second turn");
  const starts = t.of("turn.started") as Extract<AgentEvent, { event: "turn.started" }>[];
  assert.deepEqual(starts[1]!.ids, ["m_second", "m_third"]); // both queued messages, one turn
  // order: first ended, then the next turn started
  const names = t.events.filter((e) => e.event === "turn.started" || e.event === "turn.ended").map((e) => e.event);
  assert.deepEqual(names, ["turn.started", "turn.ended", "turn.started", "turn.ended"]);
  await t.driver.followup("agent:main", "front", [msg("idle one")]);
  await waitFor(() => t.of("turn.ended").length === 3);
});

test("steer: words into a running turn are taken; an idle lane says false", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  assert.equal(await t.driver.steer("agent:main", "front", "nobody home"), false);
  await t.driver.send("agent:main", "front", [msg("SLOW work")]);
  assert.equal(await t.driver.steer("agent:main", "front", "GO now"), true);
  await waitFor(() => t.of("turn.ended").length === 1);
  assert.ok(t.log().some((l) => l.steer === "GO now"));
});

test("interrupt: the running turn ends cancelled, and what was queued waits for the next send", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("SLOW long")]);
  await t.driver.followup("agent:main", "front", [msg("queued")]);
  await t.driver.interrupt("agent:main", "front");
  await waitFor(() => t.of("turn.ended").length === 1);
  assert.equal((t.of("turn.ended")[0] as any).outcome, "cancelled");
  assert.equal(t.of("turn.started").length, 1); // not chained
  await t.driver.send("agent:main", "front", [msg("now this")]);
  await waitFor(() => t.of("turn.ended").length === 2);
  assert.deepEqual((t.of("turn.started")[1] as any).ids, ["m_queued", "m_now th"]);
});

test("inject: modules are put into the session without a turn", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  await t.driver.inject("agent:main", "front", { modules: [module_("user", "likes tea")], text: "also this" });
  assert.deepEqual(t.log().find((l) => l.inject)!.inject, "[user] likes tea\nalso this");
  assert.equal(t.of("turn.started").length, 0);
});

test("session.new opens another session; reload rewrites the baseline first; both report the new handle", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  const before = t.driver.session.get("agent:main", "front");
  const fresh = await t.driver.session.new("agent:main", "front");
  assert.notEqual(fresh.handle, before);
  assert.equal(t.driver.session.get("agent:main", "front"), fresh.handle);
  const reloaded = await t.driver.session.reload("agent:main", "front", { static: [module_("identity", "I am someone new")] });
  assert.equal(t.written[`/root/work/${BASELINE_FILE}`], "[identity] I am someone new\n");
  assert.notEqual(reloaded.handle, fresh.handle);
  const last = (t.of("handle.updated").at(-1) as any);
  assert.deepEqual([last.key, last.handle], ["front", reloaded.handle]);
  // a running lane is not reloaded
  await t.driver.send("agent:main", "front", [msg("SLOW x")]);
  await assert.rejects(t.driver.session.new("agent:main", "front"), (e: any) => e.code === "conflict");
  await assert.rejects(t.driver.session.reload("agent:main", "front", { static: [] }), (e: any) => e.code === "conflict");
  await t.driver.interrupt("agent:main", "front");
});

test("session.set resumes a handle (one the runtime does not know opens a new session); start resumes stored handles without resume opens a new session on start", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  const second = await t.driver.session.new("agent:main", "back");
  await t.driver.session.set("agent:main", "front", second.handle);
  assert.equal(t.driver.session.get("agent:main", "front"), second.handle);
  assert.ok(t.log().some((l) => l.resume === second.handle));
  await t.driver.session.set("agent:main", "front", "bogus"); // unknown to the runtime: a new session opens instead
  assert.notEqual(t.driver.session.get("agent:main", "front"), "bogus");
  // start with handles: resumed, no new session for that lane
  const u = setup();
  await u.driver.start("agent:main", spec({ sessions: { front: "s-9-1" } }));
  assert.ok(u.log().some((l) => l.resume === "s-9-1"));
  assert.equal(u.log().filter((l) => l.new).length, 1); // only back is new
  assert.equal(u.driver.session.get("agent:main", "front"), "s-9-1");
});

test("session.compact: compacts an idle lane; a running lane is a conflict", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  assert.deepEqual(await t.driver.session.compact("agent:main", "front"), { compacted: true, detail: "ok" });
  await t.driver.send("agent:main", "front", [msg("SLOW c")]);
  await assert.rejects(t.driver.session.compact("agent:main", "front"), (e: any) => e.code === "conflict");
  await t.driver.steer("agent:main", "front", "GO");
});

test("configure: sets a bare model name through the offered values, reads back what the runtime reports; the declared model goes onto new sessions", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec({ runtime: { kind: "dsh", model: "deepseek-flash", effort: "high" } }));
  assert.deepEqual(t.log().filter((l) => l.set).map((l) => [l.set, l.value]).slice(0, 2), [["model", '["p","deepseek-flash"]'], ["reasoning_effort", "high"]]);
  const now = await t.driver.configure("agent:main", "back");
  assert.equal(now.model, '["p","deepseek-flash"]');
  const changed = await t.driver.configure("agent:main", "back", { model: "m0" });
  assert.equal(changed.model, '["p","m0"]');
  assert.equal((await t.driver.configure("agent:main", "front")).model, '["p","deepseek-flash"]'); // per session
});

test("plugins, credentials and usage go through the extensions", async () => {
  const t = setup({ FAKE_EXT: "1" });
  await t.driver.start("agent:main", spec());
  assert.deepEqual(await t.driver.plugins("agent:main", "list"), { plugins: [{ id: "x" }] });
  assert.equal(await t.driver.credentialsHas!("agent:main", "DEEPSEEK_API_KEY"), false);
  await t.driver.credentialsSet!("agent:main", "DEEPSEEK_API_KEY", "fake-key-value");
  assert.equal(await t.driver.credentialsHas!("agent:main", "DEEPSEEK_API_KEY"), true);
  assert.deepEqual(await t.driver.usage!("agent:main", 50), { records: [{ at: 1, done: 100, model: "m", input: 5, output: 7, ok: true }] });
  assert.ok(!JSON.stringify(t.events).includes("fake-key-value"));
});

test("a runtime that speaks only standard ACP: the extensions degrade (steer false, inject before the next turn, compact/plugins unavailable)", async () => {
  const t = setup(); // no _ash/*
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("SLOW a")]);
  assert.equal(await t.driver.steer("agent:main", "front", "hey"), false);
  await t.driver.interrupt("agent:main", "front");
  await waitFor(() => t.of("turn.ended").length === 1);
  await t.driver.inject("agent:main", "front", { modules: [module_("user", "likes tea")] });
  await t.driver.send("agent:main", "front", [msg("next")]);
  await waitFor(() => t.of("turn.ended").length === 2);
  const second = t.log().filter((l) => l.prompt)[1]!;
  assert.match(second.text, /^\[user\] likes tea\n\[ash\]/);
  await assert.rejects(t.driver.session.compact("agent:main", "front"), (e: any) => e.code === "unavailable");
  await assert.rejects(t.driver.plugins("agent:main", "list"), (e: any) => e.code === "unavailable");
  // and without session/resume a stored handle falls back to a new session
  const u = setup({ FAKE_NO_RESUME: "1" });
  await u.driver.start("agent:main", spec({ sessions: { front: "s-9-1" } }));
  assert.equal(u.log().filter((l) => l.new).length, 2);
  assert.notEqual(u.driver.session.get("agent:main", "front"), "s-9-1");
});

test("images are sent as image blocks, other attachments are named in the text", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("look", { attachments: [{ name: "a.png", mime_type: "image/png", ref: "img" }, { name: "b.pdf", mime_type: "application/pdf", ref: "doc" }] })]);
  await waitFor(() => t.of("turn.ended").length === 1);
  const seen = t.log().find((l) => l.prompt)!;
  assert.equal(seen.images, 1);
  assert.match(seen.text, /\[attachment name="b\.pdf" type=application\/pdf ref=doc\]/);
});

test("the process dying is reported as ended (not as a finished turn); restart resumes the sessions; a stop that was asked for is silent", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  const handles = ["front", "back"].map((k) => t.driver.session.get("agent:main", k));
  await t.driver.send("agent:main", "front", [msg("DIE now")]);
  await waitFor(() => t.of("ended").length === 1, "ended");
  assert.equal(t.of("turn.ended").length, 0);
  assert.equal(t.driver.status("agent:main").state, "failed");
  // the hub starts it again with the handles it stored
  await t.driver.start("agent:main", spec({ sessions: { front: handles[0]!, back: handles[1]! } }));
  assert.deepEqual(t.log().filter((l) => l.resume).map((l) => l.resume), handles);
  // restart on purpose
  await t.driver.restart("agent:main");
  assert.equal(t.of("ended").length, 1);
  assert.deepEqual(["front", "back"].map((k) => t.driver.session.get("agent:main", k)), handles);
  await t.driver.stop("agent:main", "bye");
  assert.equal(t.of("ended").length, 1);
  assert.equal(t.driver.status("agent:main").state, "exited");
});

test("a runtime that cannot start fails the start with a reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-driver-"));
  dirs.push(dir);
  const driver = createDshDriver({ report: () => {}, writeFile: async () => {},
    spawn: () => nodeSpawn(process.execPath, ["-e", "process.exit(3)"], { stdio: ["pipe", "pipe", "pipe"] }) });
  await assert.rejects(driver.start("agent:main", spec()), (e: any) => e.code === "failed");
  assert.equal(driver.status("agent:main").state, "failed");
});

test("a stop that comes while the baseline file is still being written voids that start: the late boot spawns nothing, and the retry is the only process", async () => {
  const kids: ReturnType<typeof nodeSpawn>[] = [];
  const write = { calls: 0, release: () => {} };
  const held = new Promise<void>((r) => { write.release = r; });
  const driver = createDshDriver({ report: () => {},
    writeFile: async () => { if (write.calls++ === 0) await held; },
    spawn: () => { const c = nodeSpawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] }); kids.push(c); return c; } });
  drivers.push(driver);
  const first = driver.start("agent:main", spec()).then(() => "started", (e) => e as WordError);
  await waitFor(() => write.calls === 1);
  await driver.stop("agent:main", "start failed"); // what the hub does when the start times out
  await driver.start("agent:main", spec()); // the retry
  write.release();
  const outcome = await first;
  assert.ok(outcome instanceof WordError, "the old start was refused");
  assert.equal(kids.length, 1, "only the retry spawned a process");
  assert.equal(driver.status("agent:main").state, "running");
  assert.ok(kids[0]!.exitCode === null && kids[0]!.signalCode === null, "and that one is alive");
  await driver.stop("agent:main", "done");
});
