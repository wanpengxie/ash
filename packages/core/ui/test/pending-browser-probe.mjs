// Run with: node --import tsx packages/core/ui/test/pending-browser-probe.mjs
// Isolated synthetic credentials, browser profile, ledger, and file bytes only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Ledger } from "../../src/world/ledger.ts";
import { WorldRouter } from "../../src/world/router.ts";
import { WorldMembers } from "../../src/world/member.ts";
import { EdgeRouter, startEdgeServer } from "../../src/server.ts";
import { PostPresenceMember } from "../../src/members/post.ts";
import { wordContract } from "../../../sdk/src/words.ts";

const directory = mkdtempSync(join(tmpdir(), "ash-pending-browser-"));
const profile = join(directory, "profile");
const ledger = await Ledger.open(join(directory, "ledger.db"));
const world = new WorldRouter(ledger, async () => true);
const members = new WorldMembers(world);
members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "say"), wordContract("agent:main", "typing")], handle: () => ({ ok: true, result: { accepted: true } }) });
const edge = new EdgeRouter(ledger, world, members, { api: { "synthetic-owner-A": "person:owner", "synthetic-owner-B": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 7) });
members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
const originalHandle = edge.handle.bind(edge);
const attempts = [];
let failOldScope = true;
let releaseHeld;
let holdLease = false;
edge.handle = async (request, caller) => {
  if (request.method === "POST" && request.url.pathname === "/api/send") {
    let wire;
    try { wire = JSON.parse(request.body?.toString("utf8") || "{}"); } catch { /* regular edge rejects malformed JSON */ }
    if (wire?.word === "say") {
      attempts.push({ client_id: wire.client_id, text: wire.body?.text, name: wire.body?.attachments?.[0]?.name, principal: caller?.transportPrincipal });
      if (wire.body?.text === "old-scope" && failOldScope) { failOldScope = false; return { status: 503, body: "{}" }; }
      if (["lease-test", "crash-lease"].includes(wire.body?.text) && holdLease) {
        const result = await originalHandle(request, caller);
        await new Promise((resolve) => { releaseHeld = resolve; });
        return result;
      }
    }
  }
  return originalHandle(request, caller);
};

let server;
let browser;
let socket;
let secondSocket;
const until = async (check, label, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch { /* page may be navigating */ }
    await delay(80);
  }
  throw new Error(`timed out: ${label}`);
};
function cdp(websocket, onEvent = () => {}) {
  let next = 1;
  const pending = new Map();
  websocket.addEventListener("message", (event) => {
    const item = JSON.parse(event.data);
    if (!item.id) { void onEvent(item); return; }
    const saved = pending.get(item.id); if (!saved) return;
    pending.delete(item.id);
    item.error ? saved.reject(new Error(item.error.message)) : saved.resolve(item.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}
async function startChrome() {
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  const port = await until(() => { try { return Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; } }, "isolated browser debug port");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find((entry) => entry.type === "page");
  assert.ok(tab?.webSocketDebuggerUrl);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  return { port, tab, socket };
}
async function stopChrome() {
  socket?.close(); secondSocket?.close(); socket = null; secondSocket = null;
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already exited */ } }
  if (browser && browser.exitCode === null && browser.signalCode === null) await new Promise((resolve) => browser.once("exit", resolve));
  browser = null;
  try { unlinkSync(join(profile, "DevToolsActivePort")); } catch { /* already removed */ }
}
const records = (text) => ledger.list({ after: 0, limit: 1000 }).filter((item) => item.kind === "request" && item.word === "say" && item.body.text === text);

try {
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  let { port } = await startChrome();
  let droppedAck = false;
  let call;
  call = cdp(socket, async (event) => {
    if (event.method !== "Fetch.requestPaused") return;
    const params = event.params;
    let data = params.request.postData || "";
    if (!data) try { data = (await call("Fetch.getRequestPostData", { requestId: params.requestId })).postData; } catch { /* non-post request */ }
    if (!droppedAck && params.responseStatusCode && data.includes("ack-loss-attachment.txt")) {
      droppedAck = true;
      await call("Fetch.failRequest", { requestId: params.requestId, errorReason: "Aborted" });
    } else await call("Fetch.continueRequest", { requestId: params.requestId });
  });
  await call("Page.enable"); await call("Runtime.enable"); await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/send", requestStage: "Response" }] });
  const eval1 = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${base}/?token=synthetic-owner-A` });
  await until(() => eval1("document.querySelector('#state')?.textContent === '已连接'"), "first owner registration");
  await eval1(`(() => { const f = new File(['SYNTHETIC_ATTACHMENT_BYTES'], 'ack-loss-attachment.txt', {type:'text/plain'}); const d = new DataTransfer(); d.items.add(f); document.querySelector('#file').files = d.files; document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true; })()`);
  await until(() => droppedAck && records("").length === 1, "server accepted attachment but response lost");
  await until(() => eval1("document.querySelector('.pending-local + .delivery')?.textContent === '未发送'"), "pending attachment retained after ACK loss");
  const beforeRestart = await eval1(`new Promise((resolve,reject)=>{const q=indexedDB.open('ash-v2-owner-pending-say');q.onsuccess=()=>{const t=q.result.transaction('pending');const r=t.objectStore('pending').getAll();r.onsuccess=()=>resolve(r.result.filter(x=>x.wire?.body?.attachments?.[0]?.name==='ack-loss-attachment.txt').map(x=>({client_id:x.client_id,hasBytes:!!x.wire.body.attachments[0].data,id:x.id,status:x.status})));};q.onerror=()=>reject(Error('IDB unavailable'))})`);
  assert.equal(beforeRestart.length, 1);
  assert.equal(beforeRestart[0].hasBytes, true);
  assert.equal(beforeRestart[0].id, null);
  const clientId = beforeRestart[0].client_id;
  await stopChrome();
  ({ port } = await startChrome());
  call = cdp(socket);
  await call("Page.enable"); await call("Runtime.enable");
  const eval2 = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  // A hard browser kill may discard its session cookie; re-open the same synthetic credential.
  await call("Page.navigate", { url: `${base}/?token=synthetic-owner-A` });
  await until(() => attempts.filter((item) => item.name === "ack-loss-attachment.txt").length === 2, "same-id retry after browser kill").catch(async (error) => {
    console.log("retry-debug", { attempts: attempts.filter((item) => item.name === "ack-loss-attachment.txt").length,
      page: await eval2("({path:location.pathname,state:document.querySelector('#state')?.textContent || '',status:document.readyState})").catch(() => ({ path: "unavailable" })) });
    throw error;
  });
  await until(() => eval2("document.querySelectorAll('.pending-local').length === 0"), "accepted attachment leaves local outbox");
  assert.equal(records("").length, 1);
  assert.deepEqual(attempts.filter((item) => item.name === "ack-loss-attachment.txt").map((item) => item.client_id), [clientId, clientId]);
  const afterAck = await eval2(`new Promise((resolve)=>{const q=indexedDB.open('ash-v2-owner-pending-say');q.onsuccess=()=>{const r=q.result.transaction('pending').objectStore('pending').getAll();r.onsuccess=()=>resolve(r.result.filter(x=>x.client_id==='${clientId}').length)}})`);
  assert.equal(afterAck, 0);

  await eval2(`(() => {document.querySelector('#t').value='old-scope';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
  await until(() => attempts.filter((item) => item.text === "old-scope").length === 1, "old credential pending item");
  assert.equal(records("old-scope").length, 0);
  await call("Page.navigate", { url: `${base}/?token=synthetic-owner-B` });
  await until(() => eval2("document.querySelector('#state')?.textContent === '已连接'"), "second credential registration");
  await delay(500);
  assert.equal(attempts.filter((item) => item.text === "old-scope").length, 1);
  assert.equal(records("old-scope").length, 0);
  await call("Page.navigate", { url: `${base}/?token=synthetic-owner-A` });
  await until(() => records("old-scope").length === 1, "old scope restored only under original credential");
  assert.equal(attempts.filter((item) => item.text === "old-scope").length, 2);

  holdLease = true;
  await eval2(`(() => {document.querySelector('#t').value='lease-test';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
  await until(() => Boolean(releaseHeld), "first tab holds send lease");
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "/")}`, { method: "PUT" })).json();
  secondSocket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { secondSocket.addEventListener("open", resolve, { once: true }); secondSocket.addEventListener("error", reject, { once: true }); });
  const callSecond = cdp(secondSocket);
  await callSecond("Runtime.enable");
  const evalSecond = async (expression) => (await callSecond("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await until(() => evalSecond("document.querySelector('#state')?.textContent === '已连接'"), "second tab registered while first holds lease");
  assert.equal(attempts.filter((item) => item.text === "lease-test").length, 1);
  holdLease = false; releaseHeld();
  await until(() => eval2("document.querySelectorAll('.pending-local').length === 0"), "first tab settled lease item");
  assert.equal(records("lease-test").length, 1);
  assert.equal(attempts.filter((item) => item.text === "lease-test").length, 1);
  releaseHeld = null;
  holdLease = true;
  await evalSecond(`(() => {document.querySelector('#t').value='crash-lease';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));return true})()`);
  await until(() => Boolean(releaseHeld), "second tab accepted then holds ACK").catch(async (error) => {
    console.log("lease-debug", { attempts: attempts.filter((item) => item.text === "crash-lease").length,
      second: await evalSecond("({state:document.querySelector('#state')?.textContent,pending:document.querySelector('#pending')?.textContent,local:document.querySelectorAll('.pending-local').length})").catch(() => null) });
    throw error;
  });
  const firstCrashAttempt = attempts.find((item) => item.text === "crash-lease");
  await call("Page.reload");
  await until(() => eval2("document.querySelector('#state')?.textContent === '已连接'"), "surviving tab registered behind lease");
  const crashAt = Date.now();
  await call("Target.closeTarget", { targetId: created.id });
  holdLease = false;
  await until(() => attempts.filter((item) => item.text === "crash-lease").length === 2, "surviving tab retries expired lease", 60_000);
  const elapsed = Date.now() - crashAt;
  assert.ok(elapsed >= 40_000 && elapsed < 60_000, `lease retry timing ${elapsed}`);
  assert.equal(records("crash-lease").length, 1);
  assert.deepEqual(attempts.filter((item) => item.text === "crash-lease").map((item) => item.client_id), [firstCrashAttempt.client_id, firstCrashAttempt.client_id]);
  console.log(JSON.stringify({ result: "PASS", attachmentOnly: true, ackLossRetrySameClientId: true, ledgerAcceptance: 1, credentialScopeFreeze: true, twoTabLeaseSingleSend: true, crashedTabLeaseRecoveryMs: elapsed }));
} finally {
  if (releaseHeld) releaseHeld();
  await stopChrome();
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  ledger.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
