// Native lifecycle probe only: no model call, approval, credentials change or owner-app mutation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
const out = `${homedir()}/ash-mini/task-capsule-v2-evidence`;
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
  assert.equal(r.status, 200); return r.json();
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
const turn = `t_capsule_smoke_${Date.now()}`;
const started_at = Date.now();
const frame = (state = "working", text = "正在查找订单（界面测试）") => post("/task/status", {
  session, revision: ++revision, turn, started_at, state, text,
  steps: ["正在打开应用", "正在查找订单"], can_stop: state !== "done",
});
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
const expandedRead = await post("/call", { capability: "screen.read", args: {} });
assert.equal(expandedRead.ok, true); assert.match(JSON.stringify(expandedRead), /com.google.android.deskclock/);
assert.doesNotMatch(JSON.stringify(expandedRead), /Ash 任务状态|停止本次任务|返回 Ash/);
shell("input", "tap", String((b[0] + b[2]) / 2), String(b[1] + density * 16));
await wait("owner collapses capsule", () => bounds()[3] - bounds()[1] < density * 120);
const image = await post("/call", { capability: "screen.see", args: {} });
assert.equal(image.ok, true);
writeFileSync(`${out}/agent-screen.jpg`, Buffer.from(image.content.find(c => c.type === "image").data, "base64"));
await wait("restored after capture", win);
await frame(); await sleep(32000); assert.ok(win(), "lost heartbeat must stay visible beyond 30 seconds"); shot("disconnected");
await frame("done", "已完成"); await wait("completion remains briefly", win); shot("done");
await sleep(4500); assert.equal(win(), undefined, "completion hides after four seconds");
writeFileSync(`${out}/result.json`, JSON.stringify({ package: pkg, model: "not used; native status fixture", centered: true,
  visibleInAsh: true, visibleOutside: true, readExcludesOverlay: true, touchPassesThrough: true,
  captureRestores: true, disconnectedRemainsVisible: true, completionHides: true }, null, 2));
console.log("capsule native lifecycle checks passed (no model or owner-app changes)");
// Drop the synthetic projection session without deleting anything; ordinary core status can resume.
shell("am", "force-stop", pkg);
shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
