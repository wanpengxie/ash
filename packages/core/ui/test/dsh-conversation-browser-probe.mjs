// Real installed runtime and production owner startup, with an isolated scripted model and browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const install = process.env.ASH_TEST_DSH_ROOT;
if (!install || !existsSync(join(install, "package.json"))) throw new Error("set ASH_TEST_DSH_ROOT to an installed runtime");

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(30);
  }
  throw new Error(`timed out: ${label}`);
}

function cdp(socket) {
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    const target = pending.get(packet.id);
    if (!target) return;
    pending.delete(packet.id);
    packet.error ? target.reject(new Error(packet.error.message)) : target.resolve(packet.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

const directory = mkdtempSync(join(tmpdir(), "dsh-conversation-"));
const home = join(directory, "home");
mkdirSync(home);
const calls = [];
let model;
let running;
let browser;
let socket;
let releaseSend = () => {};
let releaseRead = () => {};
let releaseDevice = () => {};
let deviceEntered = false;
let holdIssued = false;
let deviceSettled = false;
try {
  model = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") ;
      const tools = (request.tools ?? []).map((tool) => tool.name);
      const user = (request.messages ?? []).filter((message) => message.role === "user").flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((part) => part.type === "text").map((part) => part.text ?? "") : []).join("\n");
      if (tools.length) calls.push({ tools, user });
      const step = calls.length;
      const hold = Boolean(tools.length && user.includes("start synthetic hold") && !holdIssued);
      if (hold) holdIssued = true;
      const toolUse = Boolean(tools.length && (step <= 4 || hold));
      const sourceId = /\bid=([A-Za-z0-9_-]+)/.exec(user)?.[1] ?? "missing";
      const name = hold ? "ash_send" : step <= 2 ? "ash_say" : "ash_react";
      const input = hold ? { to: "device:probe", word: "hold", body: {} } : step === 1 ? { text: "first runtime reply" } : step === 2 ? { text: "second runtime reply" } :
        { message_id: step === 3 ? sourceId : "missing", emoji: "👍" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind, data) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_${step}`, type: "message", role: "assistant", model: request.model,
        content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      if (toolUse) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${step}`, name, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        if (holdIssued && !user.includes("停") && Array.isArray(request.messages?.at(-1)?.content) &&
          request.messages.at(-1).content.some((part) => part.type === "tool_result"))
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "late synthetic reply" } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: toolUse ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const port = model.address().port;
  running = await startOwner({ stateDir: join(directory, "state"), workspaces: { home }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(directory, "dsh"), env: {
      DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
    } } });
  const deviceGate = new Promise((resolve) => { releaseDevice = resolve; });
  running.members.registerDevice({ id: "device:probe", kind: "device", name: "Synthetic probe", online: true,
    capabilities: () => [{ name: "hold", description: "Wait for an isolated test gate", input_schema: { type: "object", additionalProperties: false },
      result_schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false },
      risk: "none", label: "Synthetic wait" }],
    handle: async () => { deviceEntered = true; await deviceGate; deviceSettled = true; return { ok: true, result: { done: true } }; } });
  const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
  const access = await fetch(`${running.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`,
    "content-type": "application/json" }, body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:probe/hold" }, wait: true }) });
  assert.equal(access.status, 200);
  assert.equal((await access.json()).reply?.body?.ok, true);

  let sendHeld = false;
  let readHeld = false;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  const originalHandle = running.edge.handle.bind(running.edge);
  running.edge.handle = async (request, caller) => {
    if (!sendHeld && request.method === "POST" && request.url.pathname === "/api/send") {
      const payload = JSON.parse(request.body.toString("utf8"));
      if (payload.word === "say" && payload.body?.text === "synthetic runtime input") {
        sendHeld = true;
        await sendGate;
      }
    }
    return originalHandle(request, caller);
  };
  const originalSend = running.world.send.bind(running.world);
  running.world.send = async (caller, message, ...rest) => {
    if (!readHeld && caller?.member === "agent:main" && message?.word === "read") {
      readHeld = true;
      await readGate;
    }
    return originalSend(caller, message, ...rest);
  };

  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(directory, "profile")}`, "--remote-debugging-port=0", "about:blank"],
    { stdio: "ignore", detached: true });
  const debugFile = join(directory, "profile", "DevToolsActivePort");
  const debugPort = await until(() => { try { return Number(readFileSync(debugFile, "utf8").split("\n")[0]); } catch { return 0; } }, "browser debug port");
  const tab = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((entry) => entry.type === "page");
  assert.ok(tab?.webSocketDebuggerUrl);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${running.url}/?token=${ownerToken}` });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "registered browser screen");
  await evaluate("document.querySelector('#t').value='synthetic runtime input';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await until(() => sendHeld, "held HTTP send");
  await until(() => evaluate("document.querySelector('.pending-local + .delivery')?.textContent === '发送中'"), "sending stage");
  releaseSend();
  await until(() => readHeld, "held read receipt");
  const source = await until(() => running.ledger.list().find((message) => message.word === "say" && message.from === "person:owner" && message.body?.text === "synthetic runtime input"), "accepted owner message");
  const rows = () => running.ledger.list();
  assert.equal(rows().filter((message) => message.from === "agent:main" && message.word === "received" && message.body.ids.includes(source.id)).length, 1);
  assert.equal(rows().some((message) => message.from === "agent:main" && message.word === "read"), false);
  await until(() => evaluate("[...document.querySelectorAll('#log .delivery')].some(x=>x.textContent==='已送达')"), "delivered stage");
  releaseRead();
  await until(() => evaluate("[...document.querySelectorAll('#log .delivery')].some(x=>x.textContent==='已读')"), "read stage");
  await until(() => evaluate("[...document.querySelectorAll('#log .msg.ai')].filter(x=>x.textContent==='first runtime reply'||x.textContent==='second runtime reply').length===2"), "two real tool replies", 30000);
  await until(() => rows().filter((message) => message.from === "agent:main" && message.word === "react").length === 2, "real reactions");
  const says = rows().filter((message) => message.from === "agent:main" && message.to === "person:owner" && message.word === "say" && message.kind === "request");
  assert.deepEqual(says.map((message) => message.body.text), ["first runtime reply", "second runtime reply"]);
  assert.equal(new Set(says.map((message) => message.turn)).size, 1);
  const reacts = rows().filter((message) => message.from === "agent:main" && message.word === "react" && message.kind === "request");
  assert.deepEqual(reacts.map((message) => running.ledger.responseTo(message.id)?.body.ok), [true, false]);
  assert.equal(running.ledger.responseTo(reacts[1].id)?.body.error?.code, "not_found");
  assert.equal(reacts[0].body.message_id, source.id);
  await until(() => rows().filter((message) => message.word === "turn.end" && message.body.reason === "completed").length === 1, "single completed turn");
  const visible = await until(async () => {
    const projected = await evaluate("(() => {const rows=[...document.querySelectorAll('#log .msg')];const owner=rows.find(x=>x.textContent.startsWith('synthetic runtime input'));const replies=rows.filter(x=>x.classList.contains('ai')&&(x.textContent==='first runtime reply'||x.textContent==='second runtime reply'));return {reaction:owner?.querySelector('.reaction')?.textContent,first:replies[0]?.className,second:replies[1]?.className,count:replies.length};})()");
    return projected.reaction === "👍" && projected.count === 2 ? projected : null;
  }, "projected replies");
  assert.equal(visible.reaction, "👍");
  assert.match(visible.first, /group-first/);
  assert.match(visible.second, /group-last/);
  assert.equal(visible.count, 2);
  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await delay(300);
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await call("Page.reload", { ignoreCache: true });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "reconnected screen");
  await until(() => evaluate("[...document.querySelectorAll('#log .msg.ai')].filter(x=>x.textContent==='first runtime reply'||x.textContent==='second runtime reply').length===2"), "replayed dialogue after reload");
  assert.equal(await evaluate("[...document.querySelectorAll('#log .msg.ai')].filter(x=>x.textContent==='first runtime reply'||x.textContent==='second runtime reply').length"), 2);
  assert.equal(await evaluate("[...document.querySelectorAll('#log .reaction')].filter(x=>x.textContent==='👍').length"), 1);
  await evaluate("document.querySelector('#t').value='start synthetic hold';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await until(() => deviceEntered, "noncooperative test device entered", 30000);
  const holdRequest = rows().find((message) => message.from === "agent:main" && message.to === "device:probe" && message.word === "hold");
  assert.ok(holdRequest);
  await evaluate("document.querySelector('#t').value='停';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await until(() => rows().some((message) => message.word === "turn.end" && message.body.reason === "cancelled"), "cancelled turn", 5000);
  assert.equal(deviceSettled, false);
  const cancelled = rows().filter((message) => message.word === "turn.end" && message.body.reason === "cancelled");
  assert.equal(cancelled.length, 1);
  releaseDevice();
  await delay(100);
  assert.equal(rows().filter((message) => message.word === "turn.end" && message.body.reason === "cancelled").length, 1);
  assert.equal(rows().filter((message) => message.kind === "response" && message.reply_to === holdRequest.id).length, 1);
  assert.equal(running.ledger.responseTo(holdRequest.id)?.body.error?.code, "cancelled");
  assert.equal(rows().filter((message) => message.from === "agent:main" && message.word === "say" && message.turn === cancelled[0].turn).length, 0);
  console.log(JSON.stringify({ result: "PASS", runtime: "installed", browser: "Chrome", turnToolCalls: calls.length,
    ownerStages: ["sending", "delivered", "read"], sayCount: 2, reactResults: [true, false], reconnectDedup: true,
    cancelledWhileDevicePending: true, cancelledTerminals: 1 }));
} finally {
  releaseSend();
  releaseRead();
  releaseDevice();
  socket?.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already stopped */ } }
  if (browser && browser.exitCode === null && browser.signalCode === null) await new Promise((resolve) => browser.once("exit", resolve));
  await running?.close();
  if (model) { model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); }
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
