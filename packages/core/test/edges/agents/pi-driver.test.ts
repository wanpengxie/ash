/**
 * The pi driver against a stand-in for `pi --mode rpc` (fake-pi-rpc.mjs): the front lane's own process slot and the one slot every
 * other lane shares, a turn at a time; warm reuse and the end of a warm process; steer and interrupt; a crash that fails only its
 * turn; the way to the model (proxy, direct, none) chosen with a fake probe; the switch to the fallback model and back; Codex's login
 * through `configure`; and the notice event reaching the owner.
 */
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { WordError } from "../../../../sdk/src/message";
import type { AgentDriver, AgentEvent, AgentStartSpec, DriverMessage } from "../../../../sdk/src/driver";
import { createPiDriver, BASELINE_FILE } from "../../../src/edges/agents/pi";
import { fixture, settle } from "./helpers";

const FAKE = new URL("./fake-pi-rpc.mjs", import.meta.url).pathname;
const FAKE_LOGIN = new URL("./fake-pi-login.mjs", import.meta.url).pathname;
const dirs: string[] = [];
const live: AgentDriver[] = [];
after(async () => { for (const d of live) for (const a of ["agent:main", "agent:w"]) await d.stop(a, "test").catch(() => {}); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const waitFor = async (pred: () => boolean, what = "condition") => {
  const until = Date.now() + 8000;
  while (!pred()) { if (Date.now() > until) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Opts { env?: Record<string, string>; hotMs?: number; recoverMs?: number; store?: { checked_at: number; upstream_at: number } | null; catalogRefreshMs?: number; catalogRetryMs?: number; catalogStartDelayMs?: number; probe?: (route: "proxy" | "direct") => Promise<boolean> }
function setup(o: Opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-driver-"));
  dirs.push(dir);
  const logFile = join(dir, "pi.log");
  // The model tables were checked a moment ago unless the test says otherwise (null: never).
  if (o.store !== null) writeFileSync(`${logFile}.store`, JSON.stringify(o.store ?? { checked_at: Date.now(), upstream_at: 1_700_000_000_000 }));
  const events: AgentEvent[] = [];
  const written: Record<string, string> = {};
  const open = { proxy: false, direct: false };
  const probed: string[] = [];
  const driver = createPiDriver({
    report: (e) => events.push(e),
    spawn: (argv, opts) => {
      const [program, ...rest] = argv;
      const script = program === "pi" ? FAKE : FAKE_LOGIN;
      return nodeSpawn(process.execPath, [script, ...rest], { env: { ...process.env, FAKE_LOG: logFile, FAKE_LOGIN_READY: "1", ...(o.env ?? {}), ...(opts?.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    },
    writeFile: async (path, content) => { written[path] = content; },
    argv: ["pi", "--mode", "rpc"],
    loginArgv: ["login-helper"],
    timeZone: () => "Asia/Shanghai",
    proxyUrl: "http://127.0.0.1:20171",
    probe: o.probe ?? (async (route) => { probed.push(route); return open[route]; }),
    hotMs: o.hotMs ?? 60_000,
    recoverMs: o.recoverMs ?? 60_000,
    routeTtlMs: 0,
    catalogRefreshMs: o.catalogRefreshMs ?? 24 * 3600_000, catalogRetryMs: o.catalogRetryMs ?? 3600_000, catalogStartDelayMs: o.catalogStartDelayMs ?? 3600_000,
  });
  live.push(driver);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  const starts = () => log().filter((l) => l.start);
  const prompts = () => log().filter((l) => l.prompt !== undefined);
  const of = <T extends AgentEvent["event"]>(name: T) => events.filter((e) => e.event === name) as Extract<AgentEvent, { event: T }>[];
  const ended = (agent = "agent:main", key = "front") => of("turn.ended").filter((e) => e.agent === agent && e.key === key);
  return { driver, events, log, starts, prompts, of, ended, written, open, probed };
}

const spec = (over: Partial<AgentStartSpec> = {}): AgentStartSpec => ({
  runtime: { kind: "pi" }, native: { on: "body:main", cwd: "/root/work" }, tools: { mcp_url: "http://127.0.0.1:1/mcp", tokens: { front: "tok-front", back: "tok-back" }, allowed: [] },
  modules: { static: [{ id: "identity", version: "a", content: "[identity] I am Ash" }] }, lanes: ["front", "back"], sessions: {}, ...over,
});
const msg = (text: string, over: Partial<DriverMessage> = {}): DriverMessage => ({ id: `m_${text.slice(0, 6)}`, from: "person:owner", word: "say", text, lane: "front", at: 1_700_000_000_000, ...over });

test("start starts no process: it records the lanes, writes the baseline and the tool surface, and reports a session handle per lane", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  assert.deepEqual(t.driver.status("agent:main"), { state: "running" });
  assert.equal(t.starts().length, 0, "nothing runs while nothing is going on");
  assert.equal(t.written[`/root/work/${BASELINE_FILE}`], "[identity] I am Ash\n");
  const mcp = JSON.parse(t.written["/root/.pi/agent/mcp.json"]!);
  assert.deepEqual(mcp.mcpServers.ash, { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer ${ASH_TOKEN}" }, exposure: "direct", timeout: 900 });
  const handles = t.of("handle.updated");
  assert.deepEqual(handles.map((h) => h.key), ["front", "back"]);
  assert.equal(t.driver.session.get("agent:main", "front"), handles[0]!.handle);
  assert.notEqual(handles[0]!.handle, handles[1]!.handle);
  assert.equal(t.driver.session.get("agent:main", "nope"), null);
  const again = setup();
  await again.driver.start("agent:main", spec({ sessions: { front: "s_kept" } }));
  assert.equal(again.driver.session.get("agent:main", "front"), "s_kept", "a handle the hub gives back is kept");
});

test("a front turn: one process on the lane's session with its own token and no proxy; the turn, the speech and the tool are reported; the envelope names time, source, lane and id", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("hello THINK TOOL", { origin: { channel: "app", client: "client:a", label: "手机 · 对话" } })]);
  await waitFor(() => t.ended().length === 1, "turn end");
  const start = t.starts()[0]!;
  const session = t.driver.session.get("agent:main", "front")!;
  assert.deepEqual(start.argv, ["--mode", "rpc", "--session-id", session, "--provider", "deepseek", "--model", "deepseek-flash"]);
  assert.equal(start.env.ASH_TOKEN, "tok-front");
  assert.equal(start.env.HTTPS_PROXY, "", "the phone's own proxy never reaches pi; DeepSeek is direct");
  assert.match(start.env.NO_PROXY, /127\.0\.0\.1.*api\.deepseek\.com/);
  assert.equal(start.env.OFFLINE, "1");
  const order = t.events.filter((e) => e.event !== "handle.updated").map((e) => e.event);
  assert.deepEqual(order, ["turn.started", "tool", "tool", "thought", "output", "turn.ended"]);
  assert.deepEqual(t.of("turn.started")[0]!.ids, ["m_hello "]);
  assert.equal(t.of("output")[0]!.text, "echo[deepseek/deepseek-flash]: hello THINK TOOL");
  assert.deepEqual(t.of("tool").map((e) => [e.phase, e.name, e.summary, e.ok]), [["start", "bash", "在跑命令", undefined], ["end", "bash", "在跑命令", true]]);
  assert.equal(t.of("turn.ended")[0]!.outcome, "completed");
  assert.match(t.prompts()[0]!.prompt, /^\[ash\] 2023-11-15 Wed 06:13:20 Asia\/Shanghai \(UTC\+08:00\) · 手机 · 对话 · lane front · say · id m_hello /);
});

test("the front lane has a slot of its own and the other lanes share one, a turn at a time in order: two processes at most", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.start("agent:w", spec());
  await t.driver.send("agent:main", "back", [msg("A SLOW", { lane: "back" })]);
  await t.driver.send("agent:w", "back", [msg("B", { lane: "back" })]);
  await t.driver.send("agent:main", "front", [msg("F SLOW")]);
  await waitFor(() => t.ended("agent:main", "front").length === 1 && t.ended("agent:w", "back").length === 1, "all three");
  const order = t.events.filter((e) => e.event === "turn.started" || e.event === "turn.ended").map((e) => `${e.event}:${e.agent}:${(e as any).key}`);
  const idx = (s: string) => order.indexOf(s);
  assert.ok(idx("turn.started:agent:w:back") > idx("turn.ended:agent:main:back"), "the second back-lane turn waits for the first to end");
  assert.ok(idx("turn.started:agent:main:front") < idx("turn.ended:agent:main:back"), "the front turn does not wait for the back lane");
  const pids = new Set(t.starts().map((s) => s.pid));
  assert.equal(pids.size, 3, "front, then agent:main's back and agent:w's back one after the other");
  const back = t.starts().filter((s) => s.env.ASH_TOKEN === "tok-back");
  assert.equal(back.length, 2);
});

test("a warm process is reused by the next turn of the same session, and ends when nothing comes for hotMs; another session on the shared slot replaces it, and the first one is picked up again by its session id", async () => {
  const t = setup({ hotMs: 250 });
  await t.driver.start("agent:main", spec());
  await t.driver.start("agent:w", spec());
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  await t.driver.send("agent:main", "front", [msg("two")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.starts().length, 1, "the second turn used the warm process");
  const pid = t.starts()[0]!.pid;
  await waitFor(() => !alive(pid), "the warm process to end");

  await t.driver.send("agent:main", "back", [msg("m1", { lane: "back" })]);
  await waitFor(() => t.ended("agent:main", "back").length === 1);
  await t.driver.send("agent:main", "back", [msg("m2", { lane: "back" })]);
  await waitFor(() => t.ended("agent:main", "back").length === 2);
  const shared = () => t.starts().filter((s) => s.env.ASH_TOKEN === "tok-back");
  assert.equal(shared().length, 1, "the same session twice in a row: one process");
  await t.driver.send("agent:w", "back", [msg("w1", { lane: "back" })]);
  await waitFor(() => t.ended("agent:w", "back").length === 1);
  await t.driver.send("agent:main", "back", [msg("m3", { lane: "back" })]);
  await waitFor(() => t.ended("agent:main", "back").length === 3);
  const sessions = shared().map((s) => s.argv[s.argv.indexOf("--session-id") + 1]);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0], sessions[2], "agent:main's back session is resumed by its id");
  assert.notEqual(sessions[0], sessions[1]);
});

test("steer reaches the running turn; it is refused (false) when nothing runs; interrupt aborts and the turn ends cancelled; a busy lane is a conflict", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  assert.equal(await t.driver.steer("agent:main", "front", "x"), false);
  await t.driver.send("agent:main", "front", [msg("SLOW please")]);
  await waitFor(() => t.prompts().length === 1);
  await assert.rejects(t.driver.send("agent:main", "front", [msg("again")]), (e) => e instanceof WordError && e.code === "conflict");
  assert.equal(await t.driver.steer("agent:main", "front", "stop and do this"), true);
  assert.equal(t.log().filter((l) => l.cmd === "steer")[0]!.message, "stop and do this");
  await t.driver.interrupt("agent:main", "front");
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.ended()[0]!.outcome, "cancelled");
  assert.ok(t.log().some((l) => l.cmd === "abort"));
});

test("a process that dies fails the turn it was in (error), not the agent: no `ended`, and the next turn gets a new process", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("CRASH now")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.ended()[0]!.outcome, "error");
  assert.match(t.ended()[0]!.error ?? "", /exited/);
  assert.equal(t.of("ended").length, 0, "the agent is not reported ended: the agents module would restart all of it");
  assert.deepEqual(t.driver.status("agent:main"), { state: "running" });
  await t.driver.send("agent:main", "front", [msg("fine")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.ended()[1]!.outcome, "completed");
  assert.equal(t.starts().length, 2);
});

test("inject is kept and goes in front of the next turn; a followup during a turn becomes the next turn; compact borrows the slot; stop ends the process without a word", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.inject("agent:main", "front", { modules: [{ id: "user", version: "v", content: "[user] likes tea" }], text: "extra" });
  await t.driver.send("agent:main", "front", [msg("SLOW first")]);
  await waitFor(() => t.prompts().length === 1);
  assert.match(t.prompts()[0]!.prompt, /^\[user\] likes tea\n\nextra\n\n\[ash\]/);
  await t.driver.followup("agent:main", "front", [msg("then this")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.prompts().length, 2);
  assert.match(t.prompts()[1]!.prompt, /then this/);
  const got = await t.driver.session.compact("agent:main", "front");
  assert.equal(got.compacted, true);
  assert.ok(t.log().some((l) => l.cmd === "compact"));
  await t.driver.send("agent:main", "front", [msg("SLOW last")]);
  await waitFor(() => t.prompts().length === 3);
  const before = t.events.length;
  const pid = t.starts()[0]!.pid;
  await t.driver.stop("agent:main", "test");
  await waitFor(() => !alive(pid), "the process to end");
  await settle();
  assert.deepEqual(t.events.slice(before).filter((e) => e.event === "turn.ended" || e.event === "ended"), [], "a stopped agent's turn is cut by the agents module, not ended by the driver");
  assert.deepEqual(t.driver.status("agent:main"), { state: "exited", detail: "not started" });
});

test("keys the hub gives go to a process through its environment, never its arguments", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  assert.equal(await t.driver.credentialsHas!("agent:main", "DEEPSEEK_API_KEY"), false);
  await t.driver.credentialsSet!("agent:main", "DEEPSEEK_API_KEY", "sk-secret");
  assert.equal(await t.driver.credentialsHas!("agent:main", "DEEPSEEK_API_KEY"), true);
  await assert.rejects(t.driver.credentialsSet!("agent:main", "OTHER", "x"), (e) => e instanceof WordError && e.code === "bad_request");
  await t.driver.send("agent:main", "front", [msg("hi")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.starts()[0]!.env.KEY, "set");
  assert.ok(!JSON.stringify(t.starts()[0]!.argv).includes("sk-secret"));
});

test("the way to a Codex model is chosen when the process is taken: the proxy if it answers, else direct, else DeepSeek with a word to the owner", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  const out = await t.driver.configure("agent:main", undefined, { model: "gpt-5.5" });
  assert.equal(out.model, "openai-codex/gpt-5.5", "a bare model name that is not DeepSeek's is Codex's");
  const turn = async (text: string) => { const n = t.ended().length; await t.driver.send("agent:main", "front", [msg(text)]); await waitFor(() => t.ended().length === n + 1); };

  t.open.proxy = true; t.open.direct = true;
  await turn("via proxy");
  let s = t.starts().at(-1)!;
  assert.equal(s.env.HTTPS_PROXY, "http://127.0.0.1:20171");
  assert.deepEqual(s.argv.slice(-4), ["--provider", "openai-codex", "--model", "gpt-5.5"]);

  t.open.proxy = false; t.open.direct = true; // the phone's VPN is on, v2rayA is not needed
  await turn("direct");
  s = t.starts().at(-1)!;
  assert.equal(s.env.HTTPS_PROXY, "");
  assert.equal(s.argv[s.argv.indexOf("--provider") + 1], "openai-codex");
  assert.equal(t.of("notice").length, 0);

  t.open.direct = false; // neither way
  await turn("nothing");
  s = t.starts().at(-1)!;
  assert.equal(s.argv[s.argv.indexOf("--provider") + 1], "deepseek", "this turn goes to DeepSeek");
  assert.equal(t.of("notice").length, 1);
  assert.match(t.of("notice")[0]!.text, /连不上 Codex.*DeepSeek/);
  await turn("still nothing");
  assert.equal(t.of("notice").length, 1, "told once, not at every turn");
  const back = await t.driver.configure("agent:main", undefined);
  assert.equal(back.fallback, "network");
  assert.equal(back.model, "deepseek/deepseek-flash");
  assert.equal(back.model_wanted, "openai-codex/gpt-5.5");
});

test("while on the fallback the way is tried again every recoverMs, and the session goes back to Codex with a word to the owner", async () => {
  const t = setup({ recoverMs: 80 });
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openai-codex/gpt-5.5" } }));
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.of("output")[0]!.text.startsWith("echo[deepseek/"), true);
  assert.equal(t.of("notice").length, 1);
  t.open.proxy = true;
  await waitFor(() => t.of("notice").length === 2, "the word that Codex is back");
  assert.match(t.of("notice")[1]!.text, /又连上了/);
  await t.driver.send("agent:main", "front", [msg("two")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.of("output")[1]!.text.startsWith("echo[openai-codex/"), true);
  assert.equal((await t.driver.configure("agent:main", undefined)).fallback, null);
});

test("a network error in a turn is checked, and when the way is shut the same session goes on with DeepSeek (history kept: set_model, same process and session) and the owner is told", async () => {
  let calls = 0;
  const t = setup({ env: { FAKE_CODEX: "fail" }, probe: async (route) => (route === "proxy" ? calls++ === 0 : false) });
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openai-codex/gpt-5.5" } }));
  await t.driver.send("agent:main", "front", [msg("do it")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.ended()[0]!.outcome, "completed", "the turn was finished on the fallback");
  assert.equal(t.starts().length, 1, "the same process");
  const set = t.log().find((l) => l.cmd === "set_model")!;
  assert.deepEqual([set.provider, set.modelId], ["deepseek", "deepseek-flash"]);
  assert.equal(t.prompts().length, 2);
  assert.match(t.prompts()[1]!.prompt, /could not be reached.*deepseek\/deepseek-flash/);
  assert.equal(t.of("output").at(-1)!.text.startsWith("echo[deepseek/"), true);
  assert.equal(t.of("notice").length, 1);
});

test("an error that is not the network's (the way is open) is the turn's error and nothing is switched", async () => {
  const t = setup({ env: { FAKE_CODEX: "fail" } });
  t.open.proxy = true;
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openai-codex/gpt-5.5" } }));
  await t.driver.send("agent:main", "front", [msg("do it")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.ended()[0]!.outcome, "error");
  assert.equal(t.ended()[0]!.error, "fetch failed");
  assert.equal(t.of("notice").length, 0);
  assert.equal(t.log().filter((l) => l.cmd === "set_model").length, 0);
});

test("a Codex model before the owner has logged in runs on DeepSeek (told once); `configure login` gives the owner a link and a code, and when it is done the session goes to Codex", async () => {
  const t = setup({ env: { FAKE_LOGIN_READY: "0" } });
  t.open.proxy = true;
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openai-codex/gpt-5.5" } }));
  await t.driver.send("agent:main", "front", [msg("hello")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.of("output")[0]!.text.startsWith("echo[deepseek/"), true);
  assert.deepEqual(t.probed, [], "no login, so no probing of the way");
  assert.equal(t.of("notice").length, 1);
  assert.match(t.of("notice")[0]!.text, /Codex 还没登录/);
  assert.equal((await t.driver.configure("agent:main", undefined)).fallback, "login");

  const card = await t.driver.configure("agent:main", undefined, { login: "openai-codex" });
  assert.equal(card.url, "https://auth.example/oauth/authorize?x=1");
  assert.equal(card.codex_login, "pending");
  assert.equal(t.log().find((l) => l.login_helper === "login")!.env.HTTPS_PROXY, "http://127.0.0.1:20171", "the login goes the same way as the model");
  await waitFor(() => t.of("notice").some((n) => /登录成功/.test(n.text)), "the login to finish");
  const after = await t.driver.configure("agent:main", undefined);
  assert.equal(after.fallback, null);
  assert.equal(after.model, "openai-codex/gpt-5.5");
  await t.driver.send("agent:main", "front", [msg("again")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.of("output")[1]!.text.startsWith("echo[openai-codex/"), true);

  await assert.rejects(t.driver.configure("agent:main", undefined, { login: "other" }), (e) => e instanceof WordError && e.code === "bad_request");
});

test("a login that turns out stale in a turn switches that session to DeepSeek and says so; it stays there until the owner logs in again or picks a model", async () => {
  const t = setup({ env: { FAKE_CODEX: "auth" } });
  t.open.proxy = true;
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openai-codex/gpt-5.5" } }));
  await t.driver.send("agent:main", "front", [msg("hello")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.ended()[0]!.outcome, "completed");
  assert.match(t.of("notice")[0]!.text, /Codex 还没登录/);
  await t.driver.send("agent:main", "front", [msg("next")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.of("output")[1]!.text.startsWith("echo[deepseek/"), true, "the next turn does not try Codex again");
  assert.equal(t.of("notice").length, 1);
  await t.driver.configure("agent:main", undefined, { model: "openai-codex/gpt-5.5" });
  assert.equal((await t.driver.configure("agent:main", undefined)).fallback, null, "choosing the model again is a fresh start");
});

test("DeepSeek, the default, needs nothing: no probe of any way, no proxy in the environment; Codex probes the proxy", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  assert.deepEqual(t.probed, []);
  assert.equal(t.starts()[0]!.env.HTTPS_PROXY, "");
  t.open.proxy = true;
  await t.driver.configure("agent:main", undefined, { model: "openai-codex/gpt-5.5" });
  await t.driver.send("agent:main", "front", [msg("two")]);
  await waitFor(() => t.ended().length === 2);
  assert.deepEqual(t.probed.slice(0, 1), ["proxy"]);
});

test("a login with no way to OpenAI is refused with what to do; a login that fails afterwards is told to the owner", async () => {
  const none = setup();
  await none.driver.start("agent:main", spec());
  await assert.rejects(none.driver.configure("agent:main", undefined, { login: "openai-codex" }), (e) => e instanceof WordError && e.code === "unavailable" && /VPN/.test(e.message));
  const bad = setup({ env: { FAKE_LOGIN: "error" } });
  bad.open.direct = true;
  await bad.driver.start("agent:main", spec());
  await bad.driver.configure("agent:main", undefined, { login: "openai-codex" });
  await waitFor(() => bad.of("notice").some((n) => /登录没成功：expired/.test(n.text)), "the failure notice");
});

test("configure reads back the state: for a DeepSeek agent nothing is probed; for a Codex one the helper's status says whether a login is there", async () => {
  const t = setup({ env: { FAKE_LOGIN_READY: "1" } });
  await t.driver.start("agent:main", spec());
  const state = await t.driver.configure("agent:main", undefined);
  assert.equal(state.codex_login, "unknown", "nobody asked about Codex");
  assert.equal(state.model, "deepseek/deepseek-flash");
  assert.equal(state.proxy, "http://127.0.0.1:20171");
  assert.deepEqual(t.probed, []);
  await t.driver.configure("agent:main", undefined, { model: "openai-codex/gpt-5.5" });
  t.open.proxy = true;
  assert.equal((await t.driver.configure("agent:main", undefined)).codex_login, "ready");
  await t.driver.configure("agent:main", undefined, { effort: "high" });
  await t.driver.send("agent:main", "front", [msg("hi")]);
  await waitFor(() => t.ended().length === 1);
  assert.ok(t.log().some((l) => l.cmd === "set_thinking_level" && l.level === "high"));
});

test("settings per model: each model has its own effort, applied whenever it is the one in use (the fallback model too); the read-back tells what is in force and what is saved", async () => {
  const t = setup({ env: { FAKE_CODEX: "fail" }, probe: async () => false });
  const runtime = { kind: "pi", model: "deepseek/deepseek-flash", effort: "low", models: { "deepseek/deepseek-flash": { effort: "max" }, "openai-codex/gpt-5.5": { effort: "xhigh" } } };
  await t.driver.start("agent:main", spec({ runtime }));
  const first = await t.driver.configure("agent:main", undefined);
  assert.deepEqual(first.effective, { model: "deepseek/deepseek-flash", effort: "max", wanted: "deepseek/deepseek-flash", fallback: null, route: "unknown" }, "the model's own entry wins over the declaration's effort");
  assert.deepEqual(first.saved, runtime);
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  assert.deepEqual(t.log().filter((l) => l.cmd === "set_thinking_level").map((l) => l.level), ["max"]);
  // a temporary choice of model takes that model's settings; the way is shut, so it falls back, and the fallback model's own effort applies
  await t.driver.configure("agent:main", undefined, { model: "openai-codex/gpt-5.5", effort: "minimal" });
  const temp = await t.driver.configure("agent:main", undefined);
  assert.deepEqual(temp.temporary, { model: "openai-codex/gpt-5.5", efforts: { "openai-codex/gpt-5.5": "minimal" } });
  assert.deepEqual(temp.saved, runtime, "a temporary change leaves the lasting settings alone");
});

test("a declaration changed live (configure {runtime}): the next turn runs on the new model and effort in the same process, a temporary choice is let go", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  await t.driver.configure("agent:main", undefined, { model: "deepseek/deepseek-v4-pro" });
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.of("output")[0]!.text.startsWith("echo[deepseek/deepseek-v4-pro]"), true, "the temporary choice");
  const runtime = { kind: "pi", model: "deepseek/deepseek-flash", models: { "deepseek/deepseek-flash": { effort: "high" } } };
  const back = await t.driver.configure("agent:main", undefined, { runtime });
  assert.equal(back.temporary, undefined);
  assert.deepEqual((back.effective as any).model, "deepseek/deepseek-flash");
  await t.driver.send("agent:main", "front", [msg("two")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.of("output")[1]!.text.startsWith("echo[deepseek/deepseek-flash]"), true);
  assert.equal(t.starts().length, 1, "no new process: the model was switched in the warm one");
  assert.deepEqual(t.log().filter((l) => l.cmd === "set_model").map((l) => l.modelId), ["deepseek-flash"]);
  assert.ok(t.log().some((l) => l.cmd === "set_thinking_level" && l.level === "high"));
});

test("DSH's model pair and a bare model name are understood by configure", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  assert.equal((await t.driver.configure("agent:main", undefined, { model: '["deepseek","deepseek-v4-pro"]' })).model, "deepseek/deepseek-v4-pro");
});

test("a provider that needs a key (OpenRouter): without the key the turn goes to DeepSeek, told once; with the key it runs there", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec({ runtime: { kind: "pi", model: "openrouter/vendor/model-1" } }));
  await t.driver.send("agent:main", "front", [msg("one")]);
  await waitFor(() => t.ended().length === 1);
  assert.equal(t.of("output")[0]!.text.startsWith("echo[deepseek/"), true);
  assert.match(t.of("notice")[0]!.text, /OpenRouter 的密钥还没配好/);
  assert.deepEqual(t.probed, [], "OpenRouter is reached directly: nothing is probed");
  await t.driver.credentialsSet!("agent:main", "OPENROUTER_API_KEY", "sk-or");
  await t.driver.send("agent:main", "front", [msg("two")]);
  await waitFor(() => t.ended().length === 2);
  assert.equal(t.of("output")[1]!.text.startsWith("echo[openrouter/vendor/model-1"), true);
  assert.match(t.of("notice")[1]!.text, /密钥有了/);
  const s = t.starts().at(-1)!;
  assert.deepEqual(s.argv.slice(-4), ["--provider", "openrouter", "--model", "vendor/model-1"]);
});

test("the catalog: the providers Ash offers with pi's own model tables, what each needs, and what is in force", async () => {
  const t = setup({ env: { FAKE_LOGIN_READY: "0" } });
  await t.driver.start("agent:main", spec());
  const c = await t.driver.catalog!("agent:main", { kind: "pi" });
  assert.deepEqual(c.providers.map((p) => p.id), ["deepseek", "openai-codex", "openrouter"]);
  const by = Object.fromEntries(c.providers.map((p) => [p.id, p]));
  assert.deepEqual(by.deepseek!.auth, { kind: "key", ref: "DEEPSEEK_API_KEY" });
  assert.equal(by.deepseek!.needs_proxy, false);
  assert.deepEqual(by.deepseek!.models.map((m) => m.id), ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"]);
  assert.deepEqual(by.deepseek!.models[0]!.efforts, ["off", "low", "high", "max"]);
  assert.equal(by["openai-codex"]!.needs_proxy, true);
  assert.equal(by["openai-codex"]!.auth.kind, "login");
  assert.equal((by["openai-codex"]!.auth as any).state, "none");
  assert.match((by["openai-codex"]!.auth as any).how, /human_say/);
  assert.deepEqual(by.openrouter!.auth, { kind: "key", ref: "OPENROUTER_API_KEY" });
  assert.equal(by.openrouter!.models.length, 25);
  assert.equal((c.effective as any).model, "deepseek/deepseek-flash");
  assert.equal(t.log().filter((l) => l.login_helper === "catalog").length, 1);
  await t.driver.catalog!("agent:main", { kind: "pi" });
  assert.equal(t.log().filter((l) => l.login_helper === "catalog").length, 1, "the tables are read once");
  const ready = setup({ env: { FAKE_LOGIN_READY: "1" } });
  const c2 = await ready.driver.catalog!("agent:w", { kind: "pi" });
  assert.equal((c2.providers.find((p) => p.id === "openai-codex")!.auth as any).state, "ready", "also for an agent that has not been started");
  assert.equal(c2.effective, undefined);
});

test("the agents module passes a notice on to the owner as a heads-up that does not ring", async () => {
  const f = fixture();
  f.agents.manager.driver("dsh");
  f.driver().report({ event: "notice", agent: "agent:main", text: "连不上 Codex，先用 DeepSeek。" });
  await settle();
  const said = f.router.to("person:owner", "say");
  assert.equal(said.length, 1);
  assert.deepEqual(said[0]!.msg.body, { text: "连不上 Codex，先用 DeepSeek。", kind: "heads_up" });
});

const refreshes = (t: ReturnType<typeof setup>) => t.log().filter((l) => l.login_helper === "refresh");

test("the catalog says how new its tables are; fresh ones are not asked for again", async () => {
  const t = setup();
  await t.driver.start("agent:main", spec());
  const c = await t.driver.catalog!("agent:main", { kind: "pi" });
  assert.equal(typeof c.source!.checked_at, "number");
  assert.equal(c.source!.upstream_at, 1_700_000_000_000);
  assert.equal(c.source!.refreshing, false);
  assert.equal(refreshes(t).length, 0, "checked a moment ago: nothing to fetch");
});

test("stale tables are refreshed in the background when the catalog is read; the next read has the new date and the tables are read again", async () => {
  const t = setup({ store: null });
  await t.driver.start("agent:main", spec());
  const first = await t.driver.catalog!("agent:main", { kind: "pi" });
  assert.equal(first.source!.checked_at, null, "nothing was ever fetched");
  assert.equal(first.source!.refreshing, true);
  assert.equal(first.providers.length, 3, "the held tables are given at once, not after the fetch");
  await waitFor(() => refreshes(t).length === 1, "the refresh");
  await new Promise((r) => setTimeout(r, 300));
  const second = await t.driver.catalog!("agent:main", { kind: "pi" });
  assert.equal(typeof second.source!.checked_at, "number");
  assert.equal(t.log().filter((l) => l.login_helper === "catalog").length, 2, "the new tables are read");
  assert.equal(refreshes(t).length, 1, "and not fetched again");
  assert.equal(refreshes(t)[0]!.env.HTTPS_PROXY, "", "direct first, and nothing of the phone's own proxy");
});

test("upstream out of reach direct is tried through v2rayA when it answers (it is not started for this); out of reach both ways, the held tables stay and nothing fails", async () => {
  const t = setup({ store: null, env: { FAKE_REFRESH: "proxy-only" }, catalogRetryMs: 50 });
  t.open.proxy = true;
  await t.driver.start("agent:main", spec());
  await t.driver.catalog!("agent:main", { kind: "pi" });
  await waitFor(() => refreshes(t).length === 2, "direct, then the proxy");
  assert.deepEqual(refreshes(t).map((r) => r.env.HTTPS_PROXY), ["", "http://127.0.0.1:20171"]);

  const none = setup({ store: null, env: { FAKE_REFRESH: "fail" }, catalogRetryMs: 150 });
  await none.driver.start("agent:main", spec());
  await none.driver.catalog!("agent:main", { kind: "pi" });
  await waitFor(() => refreshes(none).length === 1, "the attempt");
  const c = await none.driver.catalog!("agent:main", { kind: "pi" });
  assert.equal(c.providers.length, 3, "the held tables are used");
  assert.equal(c.source!.checked_at, null);
  assert.equal(refreshes(none).length, 1, "not again before the retry time");
  await new Promise((r) => setTimeout(r, 200));
  await none.driver.catalog!("agent:main", { kind: "pi" });
  await waitFor(() => refreshes(none).length === 2, "tried again after the retry time");
});

test("once a day (and a little after the first agent starts, when the tables are stale) the tables are asked for again", async () => {
  const t = setup({ store: null, catalogStartDelayMs: 30, catalogRefreshMs: 120, catalogRetryMs: 10_000 });
  await t.driver.start("agent:main", spec());
  await waitFor(() => refreshes(t).length >= 1, "the first look after the start");
  await waitFor(() => refreshes(t).length >= 2, "the daily one");
});
