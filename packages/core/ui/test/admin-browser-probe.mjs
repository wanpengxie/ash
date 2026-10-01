// Run in a checkout containing both the screen controls and the admin member.
// Only a temporary ledger and an isolated headless browser profile are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const directory = mkdtempSync(join(tmpdir(), "ash-admin-browser-"));
let owner, browser, socket, remoteSocket, remoteServer;
const until = async (check, label) => {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
};
const cdp = (websocket) => {
  let next = 1;
  const waiting = new Map();
  websocket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    const slot = waiting.get(reply.id);
    if (!slot) return;
    waiting.delete(reply.id);
    reply.error ? slot.reject(new Error("browser operation failed")) : slot.resolve(reply.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
};
try {
  owner = await startOwner({ stateDir: join(directory, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  const token = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")[0];
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${join(directory, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  const port = await until(() => { try { return Number(readFileSync(join(directory, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; } }, "isolated browser");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find((entry) => entry.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable");
  await call("Runtime.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${owner.url}/?token=${token}` });
  await until(() => evaluate("Boolean(document.querySelector('#settingsAdmin'))"), "local management controls");
  assert.equal(await evaluate("document.querySelector('#settingsFeedback').textContent"), "当前暂停状态未核实。");
  await evaluate("document.querySelector('#settingsPause').click()");
  await until(() => evaluate("document.querySelector('#settingsFeedback')?.textContent === '已暂停 Ash'"), "paired pause reply");
  const paused = () => owner.ledger.list({ limit: 1000 }).filter((row) => row.to === "service:admin" && row.kind === "request" && row.word === "pause");
  assert.equal(paused().length, 1);
  await evaluate("document.querySelector('#settingsResume').click()");
  assert.equal(await evaluate("document.querySelector('#settingsResumeConfirmation').hidden"), false);
  assert.equal(owner.ledger.list({ limit: 1000 }).filter((row) => row.to === "service:admin" && row.word === "resume").length, 0, "first click has no effect");
  await evaluate("document.querySelector('#settingsResumeYes').click()");
  await until(() => evaluate("document.querySelector('#settingsFeedback')?.textContent === '已恢复 Ash'"), "paired resume reply");
  assert.equal(owner.ledger.list({ limit: 1000 }).filter((row) => row.to === "service:admin" && row.word === "resume").length, 1);
  const adminRequests = () => owner.ledger.list({ limit: 1000 }).filter((row) => row.to === "service:admin" && row.kind === "request");
  const beforeFailure = adminRequests().length;
  await call("Network.enable");
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  if (await evaluate("Boolean(document.querySelector('#settingsPause'))")) await evaluate("document.querySelector('#settingsPause').click()");
  await delay(250);
  assert.notEqual(await evaluate("document.querySelector('#settingsFeedback')?.textContent"), "已暂停 Ash", "offline is never a confirmed pause");
  assert.equal(adminRequests().length, beforeFailure, "offline management adds no request");
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await until(() => evaluate("Boolean(document.querySelector('#settingsPause'))"), "local reconnection");
  const liveToken = await evaluate("sessionStorage.getItem('ash.screen.token.v2')");
  assert.ok(liveToken && owner.edge.screens.registrations.has(liveToken));
  owner.edge.screens.registrations.get(liveToken).expiresAt = 0;
  await evaluate("document.querySelector('#settingsPause').click()");
  await until(() => evaluate("document.querySelector('#settingsFeedback')?.textContent.includes('未确认')"), "expired screen rejection");
  assert.equal(adminRequests().length, beforeFailure, "expired screen adds no admin request");
  const remoteCaller = { member: "person:owner", transportPrincipal: "gateway:isolated-probe", pairedDeviceId: "isolated-probe",
    local: false, remote: true, ownerProxy: true, transport: "web_ui" };
  let forgeDisplayHint = false;
  const remoteStatuses = [];
  remoteServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
    const result = await owner.edge.handle({ method: request.method, url: new URL(request.url, "http://remote"),
      headers, body: chunks.length ? Buffer.concat(chunks) : null }, remoteCaller);
    if (request.url === "/api/send" && chunks.length && Buffer.concat(chunks).includes('"service:admin"')) remoteStatuses.push(result.status);
    response.writeHead(result.status, result.headers ?? {});
    if ("stream" in result) result.stream((chunk) => response.write(forgeDisplayHint ? chunk.replace('"local_management":false', '"local_management":true') : chunk),
      (close) => { if (response.destroyed || response.writableEnded) close(); else response.once("close", close); }, () => response.end());
    else response.end(result.body);
  });
  await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
  const remoteBase = `http://127.0.0.1:${remoteServer.address().port}`;
  const target = await call("Target.createTarget", { url: "about:blank" });
  const remoteTab = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.id === target.targetId), "remote browser tab");
  remoteSocket = new WebSocket(remoteTab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { remoteSocket.addEventListener("open", resolve, { once: true }); remoteSocket.addEventListener("error", reject, { once: true }); });
  const remoteCall = cdp(remoteSocket);
  await remoteCall("Page.enable");
  await remoteCall("Runtime.enable");
  const remoteEval = async (expression) => (await remoteCall("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await remoteCall("Page.navigate", { url: remoteBase });
  await until(() => remoteEval("document.querySelector('#connection')?.textContent === '已连接'"), "remote registration");
  assert.equal(await remoteEval("Boolean(document.querySelector('#settingsAdmin'))"), false, "remote same bundle hides controls");
  const beforeForged = adminRequests().length;
  forgeDisplayHint = true;
  await remoteCall("Page.reload");
  await until(() => remoteEval("Boolean(document.querySelector('#settingsAdmin'))"), "forged display hint");
  await remoteEval("document.querySelector('#settingsPause').click()");
  await until(() => remoteEval("document.querySelector('#settingsFeedback')?.textContent.includes('未确认')"), "remote 403 feedback");
  assert.equal(adminRequests().length, beforeForged, "forged display hint cannot authorize a remote effect");
  assert.deepEqual(remoteStatuses, [403]);
  console.log("PASS: isolated Chrome local pause/resume; offline and expired fail closed; remote hidden; forged hint 403, zero admin effect");
} finally {
  remoteSocket?.close();
  socket?.close();
  if (remoteServer) await new Promise((resolve) => { remoteServer.close(resolve); remoteServer.closeAllConnections(); });
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  await owner?.close();
  rmSync(directory, { recursive: true, force: true });
}
