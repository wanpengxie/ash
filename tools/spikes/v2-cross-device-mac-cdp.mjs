// Isolated Chrome/CDP companion for the cross-device screen probe.
// The synthetic URL lives in a private mode-0600 file and is never logged.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
const [mode, urlFile, stateFile] = process.argv.slice(2);
if (!["start", "resume", "verify", "stop"].includes(mode) || !urlFile || !stateFile) throw new Error("usage: node mac-cdp.mjs start|resume|verify|stop private-url private-state");
const port = 14763;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const testUrl = readFileSync(urlFile, "utf8").trim();
const parsed = new URL(testUrl);
if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "14762" || parsed.pathname !== "/" || !parsed.searchParams.has("token")) throw new Error("invalid isolated URL");

async function pageTarget() {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  const targets = await response.json();
  return targets.find((item) => item.type === "page" && item.url?.startsWith("http://127.0.0.1:14762/"));
}

async function connect() {
  let target;
  for (let i = 0; i < 80; i++) {
    try { target = await pageTarget(); if (target?.webSocketDebuggerUrl) break; } catch {}
    await pause(250);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("isolated Chrome page unavailable");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP connect timeout")), 5000);
    ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP connection failed")); }, { once: true });
  });
  ws.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    const item = pending.get(packet.id);
    if (!item) return;
    pending.delete(packet.id);
    clearTimeout(item.timeout);
    packet.error ? item.reject(new Error(packet.error.message)) : item.resolve(packet.result);
  });
  const evaluate = async (expression) => {
    const id = nextId++;
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error("CDP evaluate timeout")); }, 5000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    if (result.exceptionDetails) throw new Error("page evaluation failed");
    return result.result?.value;
  };
  return { ws, evaluate };
}

async function until(evaluate, expression, description) {
  for (let i = 0; i < 80; i++) {
    // Chrome may expose the page target before its first document is ready.
    try { const value = await evaluate(expression); if (value) return value; } catch {}
    await pause(250);
  }
  throw new Error(`${description} not observed`);
}

let state;
if (mode === "start") {
  if (existsSync(stateFile)) throw new Error("isolated profile already has state");
  // A second profile is essential: do not attach CDP to an existing user browser.
  const profile = mkdtempSync(join(tmpdir(), "ash-v2-mac-cdp-"));
  const chrome = process.env.ASH_PROBE_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const child = spawn(chrome, [`--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, "--no-first-run", "--new-window", testUrl], { detached: true, stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("isolated Chrome could not start")));
    });
  } catch {
    rmSync(profile, { recursive: true, force: true });
    throw new Error("isolated Chrome could not start");
  }
  child.unref();
  state = { pid: child.pid, profile, port };
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  chmodSync(stateFile, 0o600);
} else {
  state = JSON.parse(readFileSync(stateFile, "utf8"));
  if (state.port !== port || !Number.isSafeInteger(state.pid) || !state.profile.startsWith(join(tmpdir(), "ash-v2-mac-cdp-"))) throw new Error("unexpected profile state");
}

if (mode === "start" || mode === "resume") {
  const { ws, evaluate } = await connect();
  try {
    await until(evaluate, "(() => { try { return location.origin === 'http://127.0.0.1:14762' && Boolean(sessionStorage.getItem('ash.screen.token.v2')) } catch { return false } })()", "screen registration");
    const androidSeen = await evaluate("[...document.querySelectorAll('#log .msg')].some(e => e.textContent === 'android_probe_one')");
    const androidLabel = await evaluate("[...document.querySelectorAll('#log .from')].some(e => e.textContent.includes('手机浏览器'))");
    if (!androidSeen || !androidLabel) throw new Error("prior Android message/source missing in Mac DOM");
    const macSeen = await evaluate("[...document.querySelectorAll('#log .msg')].some(e => e.textContent === 'mac_probe_one')");
    if (!macSeen) await evaluate("(() => { const t=document.querySelector('#t'); t.value='mac_probe_one'; document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()");
    await until(evaluate, "[...document.querySelectorAll('#log .msg')].some(e => e.textContent === 'mac_probe_one')", "Mac message");
    process.stdout.write(JSON.stringify({ chromePid: state.pid, profile: state.profile, registered: true, androidSeen: true, androidLabel: true, macSent: true }) + "\n");
  } finally { ws.close(); }
} else if (mode === "verify") {
  const { ws, evaluate } = await connect();
  try {
    const androidSeen = await until(evaluate, "[...document.querySelectorAll('#log .msg')].some(e => e.textContent === 'android_probe_two')", "second Android message");
    const androidLabel = await evaluate("[...document.querySelectorAll('#log .from')].some(e => e.textContent.includes('手机浏览器'))");
    process.stdout.write(JSON.stringify({ registered: Boolean(await evaluate("sessionStorage.getItem('ash.screen.token.v2')")), androidSeen: Boolean(androidSeen), androidLabel: Boolean(androidLabel) }) + "\n");
  } finally { ws.close(); }
} else {
  try { process.kill(-state.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await pause(500);
  rmSync(state.profile, { recursive: true, force: true });
  rmSync(stateFile);
  process.stdout.write(JSON.stringify({ stopped: true, profileRemoved: true }) + "\n");
}
}

// Never print underlying spawn/fetch/CDP errors: they may contain the synthetic URL.
await main().catch(() => {
  process.stderr.write("isolated Mac screen probe failed\n");
  process.exitCode = 1;
});
