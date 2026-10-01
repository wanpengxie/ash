// Isolated production owner, temporary managed home, and isolated Chrome profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const dir = mkdtempSync(join(tmpdir(), "ash-preferences-browser-"));
let first, second, proxy, remoteServer, browser, socket, remoteSocket;
let currentOwner;
let dropNextWrite = false;
const writtenIds = [];
const remoteStatuses = [];
const until = async (check, label) => {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
};
function cdp(websocket) {
  let next = 1;
  const waiting = new Map();
  websocket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    const slot = waiting.get(frame.id);
    if (!slot) return;
    waiting.delete(frame.id);
    frame.error ? slot.reject(new Error("browser operation failed")) : slot.resolve(frame.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
const ownerToken = (running) => Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
const writes = (running) => running.ledger.list({ limit: 1000 }).filter((row) => row.to === "service:self" && row.word === "write" && row.kind === "request");

try {
  first = await startOwner({ stateDir: join(dir, "first-state"), listen: "127.0.0.1:0", workspaces: { home: join(dir, "first-home") },
    agents: [{ id: "agent:main", runtime: "echo" }] });
  currentOwner = first;
  proxy = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url, currentOwner.url);
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      let intercepted = false;
      if (target.pathname === "/api/send" && body.length) {
        try {
          const wire = JSON.parse(body.toString("utf8"));
          if (wire.to === "service:self" && wire.word === "write") {
            writtenIds.push(wire.client_id);
            if (dropNextWrite) { intercepted = true; dropNextWrite = false; }
          }
        } catch {}
      }
      const upstream = httpRequest(target, { method: incoming.method,
        headers: { ...incoming.headers, host: target.host } }, (result) => {
        if (intercepted) {
          result.resume();
          result.on("end", () => { outgoing.writeHead(503); outgoing.end(); });
        } else { outgoing.writeHead(result.statusCode, result.headers); result.pipe(outgoing); }
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      upstream.end(body);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${proxy.address().port}`;
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(dir, "profile")}`, "--remote-debugging-port=0", "about:blank"],
  { stdio: "ignore", detached: true });
  const port = await until(() => { try { return Number(readFileSync(join(dir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; } }, "isolated Chrome");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find((entry) => entry.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable"); await call("Runtime.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  const status = () => evaluate("document.querySelector('#settingsProactive [role=status]')?.textContent");
  const load = () => evaluate("document.querySelector('#settingsProactive button:first-of-type').click()");
  const save = () => evaluate("document.querySelector('#settingsProactive button:last-of-type').click()");
  const setDraft = (text) => evaluate(`document.querySelector('#settingsProactiveText').value=${JSON.stringify(text)}`);
  await call("Page.navigate", { url: `${localUrl}/?token=${ownerToken(first)}` });
  await until(() => evaluate("Boolean(document.querySelector('#settingsProactive'))"), "local preferences panel");
  await load();
  await until(async () => (await status())?.includes("不存在"), "missing-file read");
  await setDraft("Synthetic preference A\n"); await save();
  await until(async () => (await status()) === "已保存并重新核对。", "create and verified readback");
  assert.equal(readFileSync(join(dir, "first-home", "PROACTIVE.md"), "utf8"), "Synthetic preference A\n");
  assert.equal(writes(first).length, 1);

  await load();
  await until(async () => (await status())?.includes("已读取当前"), "reload current hash");
  const initialHash = (await first.world.send({ transport: "api", transportPrincipal: "preferences-fixture", member: "person:owner",
    local: true, remote: false, ownerProxy: true }, { to: "service:self", kind: "request", word: "read", body: { path: "PROACTIVE.md" }, wait: true })).reply.body.result.hash;
  const external = await first.world.send({ transport: "api", transportPrincipal: "preferences-fixture", member: "person:owner",
    local: true, remote: false, ownerProxy: true }, { to: "service:self", kind: "request", word: "write",
    body: { path: "PROACTIVE.md", content: "Synthetic preference B\n", why: "Synthetic concurrent edit", expected_hash: initialHash }, wait: true });
  assert.equal(external.reply.body.ok, true);
  await setDraft("Must not overwrite\n"); await save();
  await until(async () => (await status())?.includes("未覆盖"), "stale hash denial");
  assert.equal(readFileSync(join(dir, "first-home", "PROACTIVE.md"), "utf8"), "Synthetic preference B\n");

  await load();
  await until(async () => (await evaluate("document.querySelector('#settingsProactiveText').value")) === "Synthetic preference B\n", "fresh baseline");
  dropNextWrite = true;
  await setDraft("Synthetic preference C\n"); await save();
  await until(async () => (await status())?.includes("未确认"), "accepted write with missing ACK");
  assert.equal(readFileSync(join(dir, "first-home", "PROACTIVE.md"), "utf8"), "Synthetic preference C\n");
  const beforeRetry = writes(first).length;
  await save();
  await until(async () => (await status()) === "已保存并重新核对。", "same-ID retry and readback");
  assert.equal(writes(first).length, beforeRetry, "retry did not create a second write");
  assert.equal(writtenIds.at(-1), writtenIds.at(-2));

  second = await startOwner({ stateDir: join(dir, "second-state"), listen: "127.0.0.1:0", workspaces: { home: join(dir, "second-home") },
    agents: [{ id: "agent:main", runtime: "echo" }] });
  currentOwner = second;
  await call("Page.navigate", { url: `${localUrl}/?token=${ownerToken(second)}` });
  await until(() => evaluate("Boolean(document.querySelector('#settingsProactive'))"), "new-scope local screen");
  assert.notEqual(await evaluate("document.querySelector('#settingsProactiveText').value"), "Synthetic preference C\n");
  await load();
  await until(async () => (await status())?.includes("不存在"), "new scope has no old plaintext");
  assert.equal(writes(second).length, 0);

  const remoteCaller = { member: "person:owner", transportPrincipal: "gateway:preferences-fixture", pairedDeviceId: "preferences-fixture",
    local: false, remote: true, ownerProxy: true, transport: "web_ui" };
  remoteServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
    const result = await second.edge.handle({ method: request.method, url: new URL(request.url, "http://remote"), headers,
      body: chunks.length ? Buffer.concat(chunks) : null }, remoteCaller);
    if (request.url === "/api/send" && chunks.length && Buffer.concat(chunks).includes('"service:self"')) remoteStatuses.push(result.status);
    response.writeHead(result.status, result.headers ?? {});
    if ("stream" in result) result.stream((chunk) => response.write(chunk),
      (close) => { if (response.destroyed || response.writableEnded) close(); else response.once("close", close); }, () => response.end());
    else response.end(result.body);
  });
  await new Promise((resolve) => remoteServer.listen(0, "127.0.0.1", resolve));
  const target = await call("Target.createTarget", { url: "about:blank" });
  const remoteTab = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.id === target.targetId), "remote tab");
  remoteSocket = new WebSocket(remoteTab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { remoteSocket.addEventListener("open", resolve, { once: true }); remoteSocket.addEventListener("error", reject, { once: true }); });
  const remoteCall = cdp(remoteSocket);
  await remoteCall("Page.enable"); await remoteCall("Runtime.enable");
  const remoteEval = async (expression) => (await remoteCall("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await remoteCall("Page.navigate", { url: `http://127.0.0.1:${remoteServer.address().port}` });
  await until(() => remoteEval("document.querySelector('#connection')?.textContent === '已连接'"), "remote registration");
  assert.equal(await remoteEval("Boolean(document.querySelector('#settingsProactive'))"), false);
  const beforeRemote = second.ledger.lastSeq();
  const remoteToken = await remoteEval("sessionStorage.getItem('ash.screen.token.v2')");
  assert.equal(typeof remoteToken, "string");
  const forbidden = await remoteEval(`fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','Ash-Screen':${JSON.stringify(remoteToken)}},body:JSON.stringify({to:'service:self',kind:'request',word:'write',body:{path:'PROACTIVE.md',content:'remote',why:'synthetic',expected_hash:null},wait:true})}).then(r=>r.status)`);
  assert.equal(forbidden, 403);
  assert.deepEqual(remoteStatuses, [403]);
  assert.equal(second.ledger.lastSeq(), beforeRemote);
  console.log("PASS: production self/Chrome create, conflict, ACK-loss stable-ID retry, scope separation, remote 403 zero ledger effect");
} finally {
  remoteSocket?.close(); socket?.close();
  if (remoteServer) await new Promise((resolve) => { remoteServer.close(resolve); remoteServer.closeAllConnections(); });
  if (proxy) await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections(); });
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  await second?.close(); await first?.close();
  rmSync(dir, { recursive: true, force: true });
}
