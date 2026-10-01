// Isolated owner, disposable homes and Chrome profile. Never points at a personal workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const root = mkdtempSync(join(tmpdir(), "ash-self-chrome-"));
let owner, chrome;
const until = async (check, label) => {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
};
function cdp(socket) {
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    const item = pending.get(result.id);
    if (!item) return;
    pending.delete(result.id);
    result.error ? item.reject(new Error("isolated Chrome operation failed")) : item.resolve(result.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    socket.send(JSON.stringify({ id: next, method, params }));
  });
}
const requests = (word, path) => owner.ledger.list({ limit: 1000 }).filter((row) =>
  row.kind === "request" && row.to === "service:self" && row.word === word && row.body?.path === path);
const changes = (path) => owner.ledger.list({ limit: 1000 }).filter((row) => row.word === "self.changed" && row.body?.path === path);
const snapshots = async (path) => {
  const result = await owner.world.send({ transport: "api", transportPrincipal: "synthetic-self-probe", member: "person:owner",
    local: true, remote: false, ownerProxy: true }, { to: "service:self", kind: "request", word: "history", body: { path }, wait: true });
  assert.equal(result.reply?.body?.ok, true);
  return result.reply.body.result.versions;
};

try {
  owner = await startOwner({ stateDir: join(root, "state"), workspaces: { home: join(root, "home") }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "echo" }] });
  const ownerToken = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")[0];
  chrome = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(root, "chrome")}`,
    "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  const port = await until(() => {
    try { return Number(readFileSync(join(root, "chrome", "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { return 0; }
  }, "isolated Chrome start");
  const sockets = [];
  const tab = async (target) => {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = target ? pages.find((item) => item.id === target) : pages.find((item) => item.type === "page");
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    const call = cdp(socket);
    await call("Page.enable"); await call("Runtime.enable");
    const evalJs = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    return { call, evalJs };
  };
  const first = await tab();
  const secondTarget = await first.call("Target.createTarget", { url: "about:blank" });
  const second = await tab(secondTarget.targetId);
  const open = async (browserTab, section) => {
    await browserTab.call("Page.navigate", { url: `${owner.url}/?token=${ownerToken}` });
    await until(() => browserTab.evalJs("document.querySelector('#connection')?.textContent === '已连接'"), "registered browser screen");
    await browserTab.evalJs("document.querySelector('#presence').click()");
    await until(() => browserTab.evalJs("document.querySelector('#agentSheet')?.classList.contains('open')"), "agent sheet");
    if (section !== "identity") await browserTab.evalJs(`document.querySelector('#agentTabs button[data-tab=${section}]').click()`);
    await until(() => browserTab.evalJs(`Boolean(document.querySelector('#agentPanel section[data-tab=${section}] .markdown-source'))`), `${section} editor`);
  };
  const value = (browserTab, section) => browserTab.evalJs(`document.querySelector('#agentPanel section[data-tab=${section}] .markdown-source')?.value`);
  const fill = (browserTab, section, text) => browserTab.evalJs(`(() => { const input=document.querySelector('#agentPanel section[data-tab=${section}] .markdown-source'); input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));return input.value;})()`);
  const save = async (browserTab, section, expected) => {
    await browserTab.evalJs(`document.querySelector('#agentPanel section[data-tab=${section}] .editor-save').click()`);
    await until(() => browserTab.evalJs(`document.querySelector('#agentPanel section[data-tab=${section}] .editor-status, #agentPanel section[data-tab=${section}] .editor-warning')?.textContent.includes(${JSON.stringify(expected)})`), `save: ${expected}`);
  };
  const history = async (browserTab, section) => {
    await browserTab.evalJs(`document.querySelector('#agentPanel section[data-tab=${section}] .editor-history').click()`);
    await until(() => browserTab.evalJs(`Boolean(document.querySelector('#agentPanel section[data-tab=${section}] .editor-rollback'))`), "snapshot history");
  };
  const askForLatestRollback = async (priorCount) => {
    const request = await until(() => requests("rollback", "USER.md")[priorCount], "gate-protected rollback accepted");
    const gate = await until(() => owner.ledger.gateCase(request.id), "durable gate ask");
    return { request, gate };
  };
  const answer = async (browserTab, askId, choice, clientId) => browserTab.evalJs(`fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','Ash-Screen':sessionStorage.getItem('ash.screen.token.v2')},body:JSON.stringify({to:'service:gate',kind:'response',word:'ask',reply_to:${JSON.stringify(askId)},body:{ok:true,result:{choice:${JSON.stringify(choice)}}},client_id:${JSON.stringify(clientId)}})}).then(async r=>({status:r.status,value:await r.json()}))`);

  await open(first, "memory");
  await fill(first, "memory", "Synthetic owner fact A\n");
  await save(first, "memory", "已保存并核对当前版本");
  await fill(first, "memory", "Synthetic owner fact B\n");
  await save(first, "memory", "已保存并核对当前版本");
  assert.match(readFileSync(join(root, "home", "USER.md"), "utf8"), /version: 2[\s\S]*Synthetic owner fact B/);
  await history(first, "memory");
  await first.evalJs("window.confirm=()=>true");
  const beforeDenied = { snapshots: await snapshots("USER.md"), changes: changes("USER.md").length };

  // A denied gate ask cannot roll back or manufacture a new file version.
  let count = requests("rollback", "USER.md").length;
  await first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  let gated = await askForLatestRollback(count);
  const denial = await answer(first, gated.gate.askId, "deny", "synthetic-rollback-deny");
  assert.equal(denial.status, 200, JSON.stringify(denial.value));
  await until(() => owner.ledger.responseTo(gated.request.id), "denied rollback settled");
  assert.equal(owner.ledger.gateCase(gated.request.id)?.decision, "denied");
  assert.equal(owner.ledger.responseTo(gated.request.id)?.body?.ok, false);
  assert.match(readFileSync(join(root, "home", "USER.md"), "utf8"), /Synthetic owner fact B/);
  assert.deepEqual(await snapshots("USER.md"), beforeDenied.snapshots);
  assert.equal(changes("USER.md").length, beforeDenied.changes);

  // The same verified local screen can allow exactly one rollback, followed by canonical readback.
  count = requests("rollback", "USER.md").length;
  await first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  gated = await askForLatestRollback(count);
  assert.equal((await answer(first, gated.gate.askId, "once", "synthetic-rollback-once")).status, 200);
  await until(() => first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-status')?.textContent.includes('已读取当前版本')"), "rollback canonical readback");
  assert.match(await value(first, "memory"), /Synthetic owner fact A/);
  assert.match(readFileSync(join(root, "home", "USER.md"), "utf8"), /version: 3[\s\S]*Synthetic owner fact A/);
  assert.equal(changes("USER.md").length, 3);

  // Exercise the real router's deadline callback with a controlled clock, not a ten-minute wait.
  await fill(first, "memory", "Synthetic owner fact C\n");
  await save(first, "memory", "已保存并核对当前版本");
  await history(first, "memory");
  const beforeExpired = { bytes: readFileSync(join(root, "home", "USER.md"), "utf8"),
    snapshots: await snapshots("USER.md"), changes: changes("USER.md").length };
  count = requests("rollback", "USER.md").length;
  await first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  gated = await askForLatestRollback(count);
  const deadline = owner.world.pending.get(gated.gate.askId)?.timer;
  assert.equal(typeof deadline?._onTimeout, "function");
  const realNow = Date.now;
  try { Date.now = () => gated.gate.expiresAt; deadline._onTimeout(); }
  finally { Date.now = realNow; }
  await until(() => owner.ledger.responseTo(gated.request.id), "expired rollback settled");
  assert.equal(owner.ledger.gateCase(gated.request.id)?.decision, "timeout");
  assert.deepEqual(await snapshots("USER.md"), beforeExpired.snapshots);
  assert.equal(changes("USER.md").length, beforeExpired.changes);
  assert.equal(readFileSync(join(root, "home", "USER.md"), "utf8"), beforeExpired.bytes);
  const lateAnswer = await answer(first, gated.gate.askId, "once", "synthetic-late-rollback");
  assert.equal(lateAnswer.status, 400, "an expired ask cannot be approved afterward");

  // A second tab writes during the approval wait. Approval must not bypass expected_hash.
  count = requests("rollback", "USER.md").length;
  await first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  gated = await askForLatestRollback(count);
  await open(second, "memory");
  await fill(second, "memory", "Synthetic concurrent USER D\n");
  await save(second, "memory", "已保存并核对当前版本");
  const beforeStaleRollback = { bytes: readFileSync(join(root, "home", "USER.md"), "utf8"),
    snapshots: await snapshots("USER.md"), changes: changes("USER.md").length };
  assert.equal((await answer(first, gated.gate.askId, "once", "synthetic-stale-rollback")).status, 200);
  await until(() => owner.ledger.responseTo(gated.request.id), "stale approved rollback settled");
  assert.deepEqual(owner.ledger.responseTo(gated.request.id)?.body?.error, { code: "bad_request", message: "stale" });
  assert.equal(readFileSync(join(root, "home", "USER.md"), "utf8"), beforeStaleRollback.bytes);
  assert.deepEqual(await snapshots("USER.md"), beforeStaleRollback.snapshots);
  assert.equal(changes("USER.md").length, beforeStaleRollback.changes);
  await until(() => first.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-warning')?.textContent.includes('其他操作修改')"), "stale rollback warning");

  // MEMORY has snapshot timestamps and hashes, not USER's numeric version header.
  await second.evalJs("document.querySelector('#agentPanel section[data-tab=memory] nav button:nth-child(2)').click()");
  await until(() => second.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .markdown-source')?.value === ''"), "MEMORY editor ready");
  await fill(second, "memory", "Synthetic memory A\n");
  await save(second, "memory", "已保存并核对当前版本");
  await fill(second, "memory", "Synthetic memory B\n");
  await save(second, "memory", "已保存并核对当前版本");
  assert.equal(await second.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-version')?.textContent"), "已读取");
  await history(second, "memory");
  await second.evalJs("window.confirm=()=>true");
  const memoryCount = owner.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:self" && row.word === "rollback" && row.body?.path === "MEMORY.md").length;
  await second.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  const memoryRequest = await until(() => owner.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:self" && row.word === "rollback" && row.body?.path === "MEMORY.md")[memoryCount], "MEMORY rollback accepted");
  const memoryGate = await until(() => owner.ledger.gateCase(memoryRequest.id), "MEMORY gate ask");
  assert.equal((await answer(second, memoryGate.askId, "once", "synthetic-memory-rollback")).status, 200);
  await until(() => second.evalJs("document.querySelector('#agentPanel section[data-tab=memory] .editor-status')?.textContent.includes('已读取当前版本')"), "MEMORY rollback readback");
  assert.equal(await value(second, "memory"), "Synthetic memory A\n");
  assert.equal(readFileSync(join(root, "home", "MEMORY.md"), "utf8"), "Synthetic memory A\n");
  assert.equal(changes("MEMORY.md").length, 3);

  // A second tab changes SOUL after this tab has started a draft; stale save preserves the draft.
  await first.evalJs("document.querySelector('#agentTabs button[data-tab=identity]').click()");
  await until(() => first.evalJs("Boolean(document.querySelector('#agentPanel section[data-tab=identity] .markdown-source'))"), "first identity editor");
  await fill(first, "identity", "Synthetic initial SOUL\n");
  await save(first, "identity", "已保存并核对当前版本");
  await fill(first, "identity", "Synthetic stale local draft\n");
  await second.evalJs("document.querySelector('#agentTabs button[data-tab=identity]').click()");
  await second.evalJs("document.querySelector('#agentPanel section[data-tab=identity] .editor-refresh').click()");
  await until(() => second.evalJs("document.querySelector('#agentPanel section[data-tab=identity] .markdown-source')?.value === 'Synthetic initial SOUL\\n'"), "second tab reads current SOUL");
  await fill(second, "identity", "Synthetic background SOUL\n");
  await save(second, "identity", "已保存并核对当前版本");
  const before = { changes: changes("SOUL.md").length, writes: requests("write", "SOUL.md").length,
    snapshots: await snapshots("SOUL.md") };
  await save(first, "identity", "文件已被其他操作修改");
  assert.equal(await value(first, "identity"), "Synthetic stale local draft\n");
  assert.equal(readFileSync(join(root, "home", "SOUL.md"), "utf8"), "Synthetic background SOUL\n");
  assert.equal(changes("SOUL.md").length, before.changes, "stale write cannot emit an additional self.changed");
  assert.deepEqual(await snapshots("SOUL.md"), before.snapshots, "stale write cannot create a snapshot");
  assert.equal(requests("write", "SOUL.md").length, before.writes + 1, "rejected request remains auditable");
  console.log("PASS: local Chrome gate deny/once/deadline, USER/MEMORY canonical rollback, approval-time CAS, two-tab stale draft and zero extra effect");
  for (const socket of sockets) socket.close();
} finally {
  if (chrome?.pid) { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} }
  await owner?.close();
  rmSync(root, { recursive: true, force: true });
}
