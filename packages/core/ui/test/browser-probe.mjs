// Run with: node --import tsx packages/core/ui/test/browser-probe.mjs
// Uses an isolated browser profile and a temporary ledger, never a personal profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Ledger } from "../../src/world/ledger.ts";
import { WorldRouter } from "../../src/world/router.ts";
import { WorldMembers } from "../../src/world/member.ts";
import { EdgeRouter, startEdgeServer } from "../../src/server.ts";
import { wordContract } from "../../../sdk/src/words.ts";

const directory = mkdtempSync(join(tmpdir(), "ash-ui-browser-"));
const ledger = await Ledger.open(join(directory, "ledger.db"));
const world = new WorldRouter(ledger, async () => true);
const members = new WorldMembers(world);
members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say"), wordContract("agent:main", "typing")], handle: () => ({ ok: true, result: { accepted: true } }) });
const edge = new EdgeRouter(ledger, world, members, { api: { "probe-owner-token": "person:owner" }, mcp: {} });
let browser;
let socket;
let socket2;
let server;

function cdp(websocket) {
  let next = 1;
  const waiting = new Map();
  websocket.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data);
    if (!parsed.id) return;
    const entry = waiting.get(parsed.id);
    if (!entry) return;
    waiting.delete(parsed.id);
    parsed.error ? entry.reject(new Error(parsed.error.message)) : entry.resolve(parsed.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
}

async function until(check, label, ms = 12_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  const owner = { member: "person:owner", transportPrincipal: "probe", local: true, remote: false, ownerProxy: true, transport: "web_ui" };
  const registrationResult = await edge.handle({ method: "GET", url: new URL("http://local/api/stream?after=0&follow=true&label=Negative%20probe"), headers: {}, body: null }, owner);
  assert.equal(registrationResult.status, 200);
  let control = "";
  let closeNegative = () => {};
  registrationResult.stream((chunk) => { control += chunk; }, (cleanup) => { closeNegative = cleanup; }, () => {});
  try {
    const isolatedToken = JSON.parse(control.split("\ndata: ")[1].split("\n\n")[0]).token;
    const absentPost = await edge.handle({ method: "POST", url: new URL("http://local/api/send"), headers: { "ash-screen": isolatedToken }, body: Buffer.from(JSON.stringify({ to: "service:post", kind: "event", word: "visible", body: {} })) }, owner);
    assert.equal(absentPost.status, 404);
  } finally { closeNegative(); }
  members.register({ id: "service:post", kind: "service", name: "Post", words: () => [wordContract("service:post", "visible")], handle: () => ({ ok: true, result: {} }) });
  for (let n = 1; n <= 120; n++) await world.send({ member: "person:owner", transport: "api", transportPrincipal: "fixture", local: true, remote: false, ownerProxy: true }, { to: "agent:main", kind: "request", word: "say", body: { text: `fixture ${n}` }, client_id: `fixture-${n}` });
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const streamHeaders = [];
  server.on("request", (request) => { if (request.url?.startsWith("/api/stream?follow=true")) streamHeaders.push(request.headers["last-event-id"] ?? null); });
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(directory, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  const debugFile = join(directory, "profile", "DevToolsActivePort");
  const port = await until(() => { try { return Number(readFileSync(debugFile, "utf8").split("\n")[0]); } catch { return 0; } }, "browser debug port");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find((entry) => entry.type === "page");
  assert.ok(tab?.webSocketDebuggerUrl);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable");
  await call("Page.bringToFront");
  await call("Runtime.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${base}/?token=probe-owner-token` });
  const firstRenderMs = await until(async () => await evaluate("document.querySelectorAll('#log .msg').length === 100 ? Math.round(performance.now() - performance.getEntriesByType('navigation')[0].fetchStart) : 0"), "latest 200 ledger records");
  console.log("timing", await evaluate("({fetch:performance.getEntriesByType('navigation')[0].fetchStart,boot:performance.getEntriesByName('shell.boot')[0]?.startTime,render:performance.getEntriesByName('shell.history-rendered')[0]?.startTime})"));
  assert.ok(firstRenderMs < 1000, `latest 200 took ${firstRenderMs}ms`);
  console.log("latest-ready", firstRenderMs);
  await until(() => ledger.list({ after: 240 }).some((entry) => entry.word === "visible"), "registered visible event");
  console.log("visible-ready");
  assert.equal(await evaluate("document.querySelector('#log .msg')?.textContent"), "fixture 21");
  await evaluate("document.querySelector('#log').scrollTop = 0; document.querySelector('#log').dispatchEvent(new Event('scroll'))");
  await until(async () => await evaluate("document.querySelectorAll('#log .msg').length") === 120, "older finite page");
  console.log("older-ready");
  assert.equal(await evaluate("document.querySelector('#log .msg')?.textContent"), "fixture 1");
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base + "/")}`, { method: "PUT" })).json();
  socket2 = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket2.addEventListener("open", resolve, { once: true }); socket2.addEventListener("error", reject, { once: true }); });
  const call2 = cdp(socket2);
  await call2("Page.enable");
  await call2("Runtime.enable");
  await call2("Page.bringToFront");
  const evaluate2 = async (expression) => (await call2("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await until(async () => await evaluate2("document.querySelector('#state')?.textContent") === "已连接", "second tab registration");
  await evaluate2("sessionStorage.setItem('ash.screen.label.v2','Second tab')");
  await call2("Page.reload");
  await until(() => ledger.list({ after: 240, limit: 1000 }).some((entry) => entry.word === "visible" && entry.origin?.label === "Second tab"), "second tab visible");
  await evaluate2("document.querySelector('#t').value = 'from second tab'; document.querySelector('#f').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}))");
  const crossTab = await until(() => ledger.list({ after: 240, limit: 1000 }).find((entry) => entry.word === "say" && entry.body?.text === "from second tab"), "second tab message");
  const firstVisible = ledger.list({ after: 240, limit: 1000 }).find((entry) => entry.word === "visible" && entry.origin?.label === "Computer browser");
  const secondVisible = ledger.list({ after: 240, limit: 1000 }).find((entry) => entry.word === "visible" && entry.origin?.label === "Second tab");
  assert.equal(crossTab.origin?.label, "Second tab");
  assert.equal(crossTab.origin?.screen, secondVisible?.origin?.screen);
  assert.notEqual(firstVisible?.origin?.screen, secondVisible?.origin?.screen);
  await until(async () => await evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent==='from second tab')"), "first tab sees second tab");
  await until(async () => await evaluate2("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent==='from second tab')"), "second tab sees own message");
  assert.equal(await evaluate("[...document.querySelectorAll('#log .from')].some(x=>x.textContent==='来自 Second tab')"), true);
  server.closeAllConnections();
  await world.send({ member: "person:owner", transport: "api", transportPrincipal: "fixture", local: true, remote: false, ownerProxy: true }, { to: "agent:main", kind: "request", word: "say", body: { text: "after reconnect" }, client_id: "after-reconnect" });
  await until(async () => await evaluate("[...document.querySelectorAll('#log .msg')].some(x => x.textContent === 'after reconnect')"), "reconnected record");
  assert.ok(streamHeaders.length >= 2);
  assert.match(String(streamHeaders.at(-1)), /^[1-9][0-9]*$/);
  assert.equal(await evaluate("[...document.querySelectorAll('#log .msg')].filter(x => x.textContent === 'after reconnect').length"), 1);
  console.log(JSON.stringify({ browser: "Chrome", firstRenderMs, latestRecords: 200, olderRows: 20, crossTab: true, reconnectLastEventId: streamHeaders.at(-1), visibleRecorded: true, result: "PASS" }));
} finally {
  socket?.close();
  socket2?.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already exited */ } }
  if (browser && browser.exitCode === null && browser.signalCode === null) await new Promise((resolve) => browser.once("exit", resolve));
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  ledger.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
