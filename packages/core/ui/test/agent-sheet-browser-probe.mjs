// Production owner + temporary homes + isolated Chrome. No personal workspace is read.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const dir = mkdtempSync(join(tmpdir(), "ash-agent-sheet-"));
let first, second, targetOwner, proxy, remoteServer, browser, socket, remoteSocket;
let holdNextRead = false;
let releaseHeldRead = null;
let holdNextCancel = false;
let releaseHeldCancel = null;
const until = async (check, label) => {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
};
function cdp(websocket) {
  let sequence = 1;
  const pending = new Map();
  websocket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    const waiting = pending.get(result.id);
    if (!waiting) return;
    pending.delete(result.id);
    result.error ? waiting.reject(new Error("browser operation failed")) : waiting.resolve(result.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = sequence++;
    pending.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
const token = (owner) => Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")[0];
const selfWrites = (owner) => owner.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:self" && row.word === "write");

try {
  first = await startOwner({ stateDir: join(dir, "first-state"), listen: "127.0.0.1:0", workspaces: { home: join(dir, "first-home") },
    agents: [{ id: "agent:main", runtime: "echo" }] });
  targetOwner = first;
  proxy = createServer((incoming, outgoing) => {
    const destination = new URL(incoming.url, targetOwner.url);
    const sendUpstream = (body, held) => {
      const upstream = httpRequest(destination, { method: incoming.method, headers: { ...incoming.headers, host: destination.host } }, (result) => {
        if (held) {
          const chunks = [];
          result.on("data", (chunk) => chunks.push(chunk));
          result.on("end", () => { const release = (drop = false) => {
            if (drop) { outgoing.writeHead(502); outgoing.end(); return; }
            if (!outgoing.destroyed) { outgoing.writeHead(result.statusCode, result.headers); outgoing.end(Buffer.concat(chunks)); }
          }; if (held === "cancel") releaseHeldCancel = release; else releaseHeldRead = release; });
        } else { outgoing.writeHead(result.statusCode, result.headers); result.pipe(outgoing); }
      });
      upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      if (body) upstream.end(body);
      else incoming.pipe(upstream);
    };
    if (destination.pathname !== "/api/send") { sendUpstream(null, false); return; }
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      let held = false;
      try {
        const wire = JSON.parse(body.toString("utf8"));
        if (holdNextRead && wire.to === "service:self" && wire.word === "read") held = "read";
        if (holdNextCancel && wire.to === "service:clock" && wire.word === "cancel") held = "cancel";
      }
      catch { /* edge still validates malformed requests */ }
      if (held === "read") holdNextRead = false;
      if (held === "cancel") holdNextCancel = false;
      sendUpstream(body, held);
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const localBase = `http://127.0.0.1:${proxy.address().port}`;
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(dir, "profile")}`, "--remote-debugging-port=0", "about:blank"],
  { stdio: "ignore", detached: true });
  const port = await until(() => { try { return Number(readFileSync(join(dir, "profile", "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; } }, "isolated Chrome");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find((entry) => entry.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable"); await call("Runtime.enable"); await call("Network.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  const identityText = "#agentPanel section[data-tab=identity] .markdown-source";
  const memoryText = "#agentPanel section[data-tab=memory] .markdown-source";
  const fill = (selector, value) => evaluate(`(() => {const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));return field.value})()`);
  const clickTab = (name) => evaluate(`document.querySelector('#agentTabs button[data-tab=${name}]').click()`);
  await call("Page.navigate", { url: `${localBase}/?token=${token(first)}` });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "local registered screen");
  await evaluate("document.querySelector('#presence').click()");
  await until(() => evaluate("document.querySelector('#agentSheet')?.classList.contains('open')"), "avatar opens sheet");
  assert.equal(await evaluate("document.querySelectorAll('#agentTabs button').length"), 5);
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(identityText)}))`), "identity editor");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(identityText)}).disabled`), false);
  await fill(identityText, "Synthetic SOUL A\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-save').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-status')?.textContent === '已保存并核对当前版本。'"), "SOUL write/readback");
  assert.equal(readFileSync(join(dir, "first-home", "SOUL.md"), "utf8"), "Synthetic SOUL A\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] nav button:nth-child(2)').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .markdown-source')?.value === ''"), "identity file ready");
  await fill(identityText, "# 我的名片\n- 名字：小舟\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-save').click()");
  await until(() => evaluate("document.querySelector('#title')?.textContent === '小舟'"), "name refreshed from canonical identity");
  assert.equal(await evaluate("document.querySelector('#presence').getAttribute('aria-label')"), "打开 小舟 人物页");
  assert.equal(await evaluate("document.querySelector('#agentSheetHeader h2').textContent"), "小舟");
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] nav button:nth-child(1)').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .markdown-source')?.value === 'Synthetic SOUL A\\n'"), "SOUL editor restored");

  await clickTab("memory");
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(memoryText)}))`), "memory editor");
  await fill(memoryText, "Synthetic owner fact A\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-save').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-status')?.textContent === '已保存并核对当前版本。'"), "USER write/readback");
  assert.match(readFileSync(join(dir, "first-home", "USER.md"), "utf8"), /version: 1/);
  await fill(memoryText, "Synthetic owner fact B\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-save').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-status')?.textContent === '已保存并核对当前版本。'"), "USER second version");
  await evaluate("window.confirm=()=>true;document.querySelector('#agentPanel section[data-tab=memory] .editor-history').click()");
  await until(() => evaluate("Boolean(document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback'))"), "USER version history");
  assert.equal(await evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').disabled"), false);
  await evaluate("document.querySelector('#agentPanel section[data-tab=memory] .editor-rollback').click()");
  const rollbackRequest = await until(() => first.ledger.list({ limit: 1000 }).find((row) => row.kind === "request" && row.to === "service:self" && row.word === "rollback" && row.body?.path === "USER.md"), "USER rollback accepted");
  const rollbackGate = await until(() => first.ledger.gateCase(rollbackRequest.id), "USER rollback gate ask");
  const denial = await evaluate(`fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','Ash-Screen':sessionStorage.getItem('ash.screen.token.v2')},body:JSON.stringify({to:'service:gate',kind:'response',word:'ask',reply_to:${JSON.stringify(rollbackGate.askId)},body:{ok:true,result:{choice:'deny'}},client_id:'synthetic-sheet-rollback-deny'})}).then(r=>r.status)`);
  assert.equal(denial, 200);
  await until(() => first.ledger.responseTo(rollbackRequest.id), "denied rollback settled");
  assert.equal(first.ledger.gateCase(rollbackRequest.id)?.decision, "denied");
  assert.match(readFileSync(join(dir, "first-home", "USER.md"), "utf8"), /Synthetic owner fact B/);

  await clickTab("identity");
  const baseline = await first.world.send({ transport: "api", transportPrincipal: "sheet-fixture", member: "person:owner", local: true,
    remote: false, ownerProxy: true }, { to: "service:self", kind: "request", word: "read", body: { path: "SOUL.md" }, wait: true });
  const external = await first.world.send({ transport: "api", transportPrincipal: "sheet-fixture", member: "person:owner", local: true,
    remote: false, ownerProxy: true }, { to: "service:self", kind: "request", word: "write",
    body: { path: "SOUL.md", content: "Synthetic external update\n", why: "synthetic concurrent edit", expected_hash: baseline.reply.body.result.hash }, wait: true });
  assert.equal(external.reply.body.ok, true);
  await fill(identityText, "Must not overwrite\n");
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-save').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-warning')?.textContent.includes('其他操作修改')"), "stale draft warning");
  assert.equal(readFileSync(join(dir, "first-home", "SOUL.md"), "utf8"), "Synthetic external update\n");

  await fill("#t", "Synthetic weather task");
  await evaluate("document.querySelector('#f').requestSubmit()");
  await until(() => first.ledger.list({ limit: 1000 }).some((row) => row.from === "agent:main" && row.word === "turn.start"), "real turn recorded");
  await clickTab("activity");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=activity]').textContent.includes('Synthetic weather task')"), "real turn shown in activity");
  assert.doesNotMatch(await evaluate("document.querySelector('#agentPanel section[data-tab=activity]').textContent"), /service:|device:|calendar\.list/);
  const clockSet = await first.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false }, { to: "service:clock", kind: "request", word: "set",
    body: { to: "agent:main", word: "say", body: { text: "synthetic reminder" }, label: "synthetic umbrella", at: Date.now() + 3600000 }, wait: true });
  assert.equal(clockSet.reply?.body?.ok, true, `clock set rejected: ${clockSet.reply?.body?.error?.code || "unknown"}`);
  await clickTab("upcoming");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent.includes('synthetic umbrella')"), "authoritative clock timer visible");
  assert.equal(await evaluate("Boolean(document.querySelector('#agentPanel section[data-tab=upcoming] .upcoming-cancel'))"), true);
  holdNextCancel = true;
  await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming] .upcoming-cancel').click()");
  await until(() => Boolean(releaseHeldCancel), "clock cancel response held after durable effect");
  assert.match(await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent"), /synthetic umbrella/, "no optimistic removal");
  const clockCancelRows = () => first.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:clock" && row.word === "cancel");
  assert.equal(clockCancelRows().length, 1);
  releaseHeldCancel(true); releaseHeldCancel = null;
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming] .sheet-error')?.textContent"), "lost cancel acknowledgement is visible");
  assert.match(await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent"), /synthetic umbrella/);
  await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming] .upcoming-cancel').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent.includes('暂无计划')"), "same-client retry then authoritative list");
  assert.equal(clockCancelRows().length, 1, "acknowledgement retry cannot create a second clock command");

  const alreadyGone = await first.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false }, { to: "service:clock", kind: "request", word: "set",
    body: { to: "agent:main", word: "say", body: { text: "synthetic stale timer" }, label: "synthetic stale", at: Date.now() + 3600000 }, wait: true });
  assert.equal(alreadyGone.reply?.body?.ok, true);
  await clickTab("activity"); await clickTab("upcoming");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent.includes('synthetic stale')"), "second timer visible");
  const externalCancel = await first.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false }, { to: "service:clock", kind: "request", word: "cancel",
    body: { id: alreadyGone.reply.body.result.id }, wait: true });
  assert.equal(externalCancel.reply?.body?.result?.cancelled, true);
  await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming] .upcoming-cancel').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming] .sheet-error')?.textContent"), "cancelled false shown as not confirmed");
  assert.match(await evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent"), /synthetic stale/, "failed cancel does not remove a row");
  await clickTab("activity"); await clickTab("upcoming");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent.includes('暂无计划')"), "fresh list sees externally removed timer");
  await clickTab("approvals");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=approvals]').textContent.includes('已拒绝')"), "real gate history visible");
  assert.match(await evaluate("document.querySelector('#agentPanel section[data-tab=approvals]').textContent"), /当前没有生效的规则/);

  await clickTab("identity");
  holdNextRead = true;
  await evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-refresh').click()");
  await until(() => Boolean(releaseHeldRead), "held original-screen read reply");
  await evaluate("window.dispatchEvent(new Event('offline'))");
  assert.equal(await evaluate("document.querySelector('#agentSheet')?.getAttribute('aria-hidden')"), "true");
  releaseHeldRead(); releaseHeldRead = null;
  await delay(250);
  assert.equal(await evaluate("document.querySelector('#agentPanel').textContent"), "", "late file reply cannot repopulate a closed sheet");

  remoteServer = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const caller = { member: "person:owner", transportPrincipal: "gateway:sheet-fixture", pairedDeviceId: "sheet-fixture",
      local: false, remote: true, ownerProxy: true, transport: "web_ui" };
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
    const result = await first.edge.handle({ method: request.method, url: new URL(request.url, "http://remote"), headers,
      body: chunks.length ? Buffer.concat(chunks) : null }, caller);
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
  await until(() => remoteEval("document.querySelector('#connection')?.textContent === '已连接'"), "remote registered screen");
  await remoteEval("document.querySelector('#presence').click()");
  await until(() => remoteEval(`Boolean(document.querySelector(${JSON.stringify(identityText)}))`), "remote read-only identity");
  await until(() => remoteEval("document.querySelector('#title')?.textContent === '小舟'"), "remote reads current identity name");
  assert.equal(await remoteEval(`document.querySelector(${JSON.stringify(identityText)}).disabled`), true);
  assert.equal(await remoteEval("document.querySelector('#agentPanel section[data-tab=identity] .editor-save').disabled"), true);
  await remoteEval("document.querySelector('#agentTabs button[data-tab=upcoming]').click()");
  await delay(1000);
  assert.match(await remoteEval("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent"), /计划列表暂不可用/);
  assert.doesNotMatch(await remoteEval("document.querySelector('#agentPanel section[data-tab=upcoming]').textContent"), /暂无计划/);
  assert.equal(await remoteEval("Boolean(document.querySelector('#agentPanel section[data-tab=upcoming] .upcoming-cancel'))"), false);
  const remoteDeniedTimer = await first.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false }, { to: "service:clock", kind: "request", word: "set",
    body: { to: "agent:main", word: "say", body: { text: "remote deny fixture" }, label: "remote deny fixture", at: Date.now() + 3600000 }, wait: true });
  assert.equal(remoteDeniedTimer.reply?.body?.ok, true);
  const beforeRemoteClock = first.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:clock" && row.word === "cancel").length;
  const remoteScreen = await remoteEval("sessionStorage.getItem('ash.screen.token.v2')");
  const deniedClock = await remoteEval(`fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','Ash-Screen':${JSON.stringify(remoteScreen)}},body:JSON.stringify({to:'service:clock',kind:'request',word:'cancel',body:{id:${JSON.stringify(remoteDeniedTimer.reply.body.result.id)}},wait:true,client_id:'synthetic-remote-deny'})}).then(async r=>({status:r.status,body:(await r.json()).reply?.body}))`);
  assert.equal(deniedClock.status, 200, "router can account for a rejected remote request");
  assert.deepEqual({ ok: deniedClock.body?.ok, code: deniedClock.body?.error?.code }, { ok: false, code: "forbidden" });
  assert.equal(first.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:clock" && row.word === "cancel").length, beforeRemoteClock + 1);
  const beforeRemoteSelf = first.ledger.lastSeq();
  const denied = await remoteEval(`fetch('/api/send',{method:'POST',headers:{'content-type':'application/json','Ash-Screen':${JSON.stringify(remoteScreen)}},body:JSON.stringify({to:'service:self',kind:'request',word:'write',body:{path:'SOUL.md',content:'remote',why:'synthetic',expected_hash:null},wait:true})}).then(r=>r.status)`);
  assert.equal(denied, 403);
  assert.equal(first.ledger.lastSeq(), beforeRemoteSelf);
  const stillScheduled = await first.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false }, { to: "service:clock", kind: "request", word: "list", body: {}, wait: true });
  assert.equal(stillScheduled.reply?.body?.result?.timers?.some((timer) => timer.id === remoteDeniedTimer.reply.body.result.id), true);

  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await evaluate("window.dispatchEvent(new Event('offline'))");
  await until(() => evaluate("document.querySelector('#agentSheet')?.getAttribute('aria-hidden') === 'true'"), "offline discards private sheet");
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  second = await startOwner({ stateDir: join(dir, "second-state"), listen: "127.0.0.1:0", workspaces: { home: join(dir, "second-home") },
    agents: [{ id: "agent:main", runtime: "echo" }] });
  targetOwner = second;
  await call("Page.navigate", { url: `${localBase}/?token=${token(second)}` });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "new owner scope");
  assert.equal(await evaluate("document.querySelector('#agentSheet')?.getAttribute('aria-hidden')"), "true");
  await evaluate("document.querySelector('#presence').click()");
  await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(identityText)}))`), "new scope identity");
  assert.equal(await evaluate("document.querySelector('#title').textContent"), "Ash");
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(identityText)}).value`), "");
  assert.equal(selfWrites(second).length, 0);
  console.log("PASS: authoritative name read/write refresh, remote name/scope reset, avatar sheet, real clock cancel with lost ACK retry and failed cancel retained, activity work-source boundary, local SOUL/USER save/history, denied rollback, remote 403, offline and delayed reply discarded");
} finally {
  remoteSocket?.close(); socket?.close();
  if (remoteServer) await new Promise((resolve) => { remoteServer.close(resolve); remoteServer.closeAllConnections(); });
  if (proxy) await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections(); });
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  await second?.close(); await first?.close();
  rmSync(dir, { recursive: true, force: true });
}
