// Isolated native probe. Optional owner-input check sends one harmless conversation to the probe only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
const pkg = "ai.ash.agent.probe";
const adb = `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const shell = (...a) => execFileSync(adb, ["shell", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (label, fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(150); }
  throw new Error(`${label} timeout`);
};
const out = process.env.ASH_CAPSULE_EVIDENCE || `${homedir()}/ash-mini/task-capsule-v2-evidence`;
const sourceFrame = process.env.ASH_ACTIVITY_FRAME ? JSON.parse(readFileSync(process.env.ASH_ACTIVITY_FRAME, "utf8")) : null;
mkdirSync(out, { recursive: true });
let cfg = JSON.parse(shell("cat", `/data/user/0/${pkg}/files/ash/ash.json`));
assert.equal(cfg.host.url, "http://127.0.0.1:14764", "only isolated probe host");
execFileSync(adb, ["forward", "tcp:14764", "tcp:14764"]);
execFileSync(adb, ["forward", "tcp:14763", "tcp:14763"]);
// Updating the APK restarts its host. Probe readiness with reads, never retry a screen mutation.
for (let attempt = 0; ; attempt++) {
  try {
    cfg = JSON.parse(shell("cat", `/data/user/0/${pkg}/files/ash/ash.json`));
    const r = await fetch("http://127.0.0.1:14764/manifest", { signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${cfg.host.token}`, connection: "close" } });
    if (r.ok) { await r.json(); break; }
  } catch {}
  if (attempt >= 60) throw new Error("isolated host readiness timeout");
  await sleep(500);
}
// The native host can be ready before the freshly installed core sends its initial idle frame.
// Let that startup settle before injecting this independent display fixture.
for (let attempt = 0; ; attempt++) {
  try {
    const r = await fetch("http://127.0.0.1:14763/api/describe", { signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${cfg.host.coreToken}`, connection: "close" } });
    if (r.ok) { await r.json(); break; }
  } catch {}
  if (attempt >= 180) throw new Error("isolated core readiness timeout");
  await sleep(1000);
}
await sleep(2000);
const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:14764${path}`, { method: "POST", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${cfg.host.token}`, "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
  const result = await r.json();
  if (r.status !== 200) assert.match(result.message ?? "", /owner_input_busy/);
  return result;
};
const win = () => shell("dumpsys", "window", "windows").split(/(?=  Window #\d+ Window\{)/)
  .find(w => w.includes("AshTaskCapsule") && w.includes("isVisible=true"));
const bounds = () => {
  const b = /frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(win() ?? "");
  assert.ok(b, "capsule bounds"); return b.slice(1).map(Number);
};
const shot = name => writeFileSync(`${out}/${name}.png`, execFileSync(adb, ["exec-out", "screencap", "-p"]));
let revision = 0;
const session = `capsule-smoke-${Date.now()}`;
let turn = `t_capsule_smoke_${Date.now()}`;
const started_at = Date.now();
const frame = (state = "working", text = sourceFrame?.text ?? "正在查找订单（界面测试）") => post("/task/status", {
  session, revision: ++revision, turn, started_at, state, text,
  steps: sourceFrame?.steps ?? ["正在打开应用", "正在查找订单"], can_stop: state !== "done",
  tool: state === "done" ? "" : sourceFrame?.tool ?? "", step_started_at: started_at,
  outcome: state === "done" ? "completed" : "",
});
let inputPoint;
const waitKeyboard = () => wait("keyboard shown for overlay", () => shell("dumpsys", "window", "windows").split(/(?=  Window #\d+ Window\{)/)
  .some(w => /Window\{[^\n]* InputMethod\}/.test(w) && w.includes("isVisible=true")), 5000);
const tapLabel = label => {
  let xml = "";
  if (!win()?.includes("NOT_FOCUSABLE") || !["继续输入", "回到 Ash", "关闭通知"].includes(label)) {
    shell("uiautomator", "dump", "/data/local/tmp/ash-capsule-input.xml");
    xml = shell("cat", "/data/local/tmp/ash-capsule-input.xml");
  }
  const node = xml.match(/<node\b[^>]*>/g)?.find(n => n.includes(`text="${label}"`) || n.includes(`content-desc="${label}"`));
  if (!node) {
    // uiautomator dump returns the focused app only while our compact overlay is NOT_FOCUSABLE.
    // These fixed native rows are verified in screenshots; the editor becomes focusable after the tap.
    const [l, t, r, b] = bounds();
    let point;
    if (label === "继续输入") point = inputPoint = [(l + r) / 2, b - density * 24];
    if (label === "收起输入") point = inputPoint;
    if (label === "回到 Ash") point = [l + (r - l) * .25, b - density * 63];
    if (label === "关闭通知") point = [l + (r - l) * .75, b - density * 63];
    assert.ok(point, `visible interaction: ${label}`);
    shell("input", "tap", ...point.map(v => String(Math.round(v)))); return;
  }
  const a = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node).slice(1).map(Number);
  shell("input", "tap", String((a[0] + a[2]) / 2), String((a[1] + a[3]) / 2));
};
shell("appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow");
shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
await sleep(1000); await frame(); await wait("visible in Ash", win);
const [left, top, right, bottom] = bounds();
const size = /(?:Override|Physical) size: (\d+)x(\d+)/.exec(shell("wm", "size"));
const width = Number(size[1]), height = Number(size[2]);
assert.ok(Math.abs((left + right) / 2 - width / 2) < 10, "top centered");
assert.ok(top < height * .15, "near screen top"); shot("home");
shell("am", "start", "-n", "com.google.android.deskclock/com.android.deskclock.DeskClock");
await sleep(700); await wait("visible in another app", win); shot("clock");
const read = await post("/call", { capability: "screen.read", args: {} });
assert.equal(read.ok, true);
assert.match(JSON.stringify(read), /com.google.android.deskclock/);
assert.doesNotMatch(JSON.stringify(read), /Ash 任务状态|停止本次任务|返回 Ash/);
assert.ok(win(), "read must not hide overlay");
const tap = await post("/call", { capability: "screen.tap", args: { x: (left + right) / 2, y: (top + bottom) / 2 } });
assert.equal(tap.ok, true); await sleep(300);
assert.ok(win(), "touch must not hide overlay");
const density = Number(/(?:Override|Physical) density: (\d+)/.exec(shell("wm", "density"))[1]) / 160;
writeFileSync(`${out}/tap-diagnostic.json`, JSON.stringify({ tap, initialBounds: [left, top, right, bottom], afterBounds: bounds(), density }, null, 2));
assert.ok(bounds()[3] - bounds()[1] < density * 120, "agent tap passes through, never expands capsule");
const b = bounds(); shell("input", "tap", String((b[0] + b[2]) / 2), String(b[1] + density * 16));
await wait("owner expands capsule", () => bounds()[3] - bounds()[1] > density * 150);
shot("expanded");
const expandedRead = await post("/call", { capability: "screen.read", args: {} });
assert.equal(expandedRead.ok, true); assert.match(JSON.stringify(expandedRead), /com.google.android.deskclock/);
assert.doesNotMatch(JSON.stringify(expandedRead), /Ash 任务状态|停止本次任务|返回 Ash/);
shell("input", "tap", String((b[0] + b[2]) / 2), String(b[1] + density * 16));
await wait("owner collapses capsule", () => bounds()[3] - bounds()[1] < density * 120);
const image = await post("/call", { capability: "screen.see", args: {} });
assert.equal(image.ok, true);
writeFileSync(`${out}/agent-screen.jpg`, Buffer.from(image.content.find(c => c.type === "image").data, "base64"));
await wait("restored after capture", win);
// Input remains directly available while working, without expanding the step list.
tapLabel("继续输入"); await sleep(800);
await waitKeyboard();
shell("input", "text", "capsule-draft"); shot("input-working");
const blocked = await post("/call", { capability: "screen.tap", args: { x: 500, y: 600 } });
assert.match(JSON.stringify(blocked), /owner_input_busy/);
tapLabel("收起输入"); await sleep(500);
assert.match(shell("dumpsys", "activity", "activities"), /(?:mResumedActivity|topResumedActivity).*com.google.android.deskclock/);
await frame(); await sleep(32000); assert.ok(win(), "lost heartbeat must stay visible beyond 30 seconds"); shot("disconnected");
await frame("done", "已完成"); await wait("completion remains briefly", win); shot("done");
await sleep(17000); assert.ok(win(), "successful completion persists outside Ash without heartbeat"); shot("done-persistent");
tapLabel("继续输入"); await waitKeyboard(); shot("input-completed");
tapLabel("收起输入");
tapLabel("关闭通知"); await sleep(2500); assert.equal(win(), undefined, "explicit close stays closed");
await frame("done", "已完成"); await sleep(1200); assert.equal(win(), undefined, "same completion replay must not resurrect");
turn += "_next"; await frame(); await wait("new turn restores capsule", win);
await frame("done", "已完成"); tapLabel("回到 Ash"); await sleep(1200);
assert.equal(win(), undefined, "return consumes completion");
shell("am", "start", "-n", "com.google.android.deskclock/com.android.deskclock.DeskClock");
await sleep(1000); assert.equal(win(), undefined, "leaving Ash cannot resurrect consumed completion");
let ownerInputDelivered = false;
if (process.env.ASH_CAPSULE_TEST_INPUT === "1") {
  turn += "_input"; await frame(); await wait("input fixture visible", win);
  tapLabel("继续输入"); await waitKeyboard();
  tapLabel("给 Ash 的消息");
  shell("input", "keycombination", "113", "29"); // Ctrl+A: replace retained draft.
  const message = `capsule_input_${Date.now()}_reply_OK_only_no_tools`;
  // The emulator's IME drops synthetic key events from one very fast adb input text burst.
  // Pace input and verify the actual editor content before pressing Send; never accept a shortened match.
  for (const part of message.match(/.{1,8}/g)) { shell("input", "text", part); await sleep(300); }
  shell("uiautomator", "dump", "/data/local/tmp/ash-capsule-input.xml");
  const typed = shell("cat", "/data/local/tmp/ash-capsule-input.xml").match(/<node[^>]*class="android.widget.EditText"[^>]*>/)?.[0];
  assert.ok(typed?.includes(`text="${message}"`), "complete text in the editor before sending");
  shot("input-before-send"); tapLabel("发送"); await sleep(1500);
  assert.match(shell("dumpsys", "activity", "activities"), /(?:mResumedActivity|topResumedActivity).*com.google.android.deskclock/);
  const r = await fetch("http://127.0.0.1:14763/api/stream?follow=false&limit=1000", {
    headers: { authorization: `Bearer ${cfg.host.coreToken}` }, signal: AbortSignal.timeout(15000) });
  assert.equal(r.status, 200);
  const matches = (await r.text()).split("\n").filter(l => l.startsWith("data:")).map(l => JSON.parse(l.slice(5)))
    .filter(m => m.from === "person:owner" && m.to === "agent:main" && m.word === "say" && m.body?.text === message);
  assert.equal(matches.length, 1, "one authenticated owner conversation, no duplicate or activity switch");
  ownerInputDelivered = true; shot("input-sent");
}
writeFileSync(`${out}/result.json`, JSON.stringify({ package: pkg, statusSource: "native status fixture; optional input uses the real core conversation route", centered: true,
  activityTitle: sourceFrame?.text, activityTool: sourceFrame?.tool,
  visibleInAsh: true, visibleOutside: true, readExcludesOverlay: true, touchPassesThrough: true,
  captureRestores: true, disconnectedRemainsVisible: true, completionPersistsOutside: true, closeDoesNotResurrect: true,
  returnConsumesCompletion: true, inputAlwaysAvailable: true, inputKeyboard: true, inputPreventsAgentTouch: true,
  ownerInputDelivered }, null, 2));
console.log("capsule native lifecycle and input checks passed (isolated probe only)");
// Drop the synthetic projection session without deleting anything; ordinary core status can resume.
shell("am", "force-stop", pkg);
shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
