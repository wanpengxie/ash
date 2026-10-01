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
import { PostPresenceMember } from "../../src/members/post.ts";
import { wordContract } from "../../../sdk/src/words.ts";

const directory = mkdtempSync(join(tmpdir(), "ash-ui-browser-"));
const ledger = await Ledger.open(join(directory, "ledger.db"));
const world = new WorldRouter(ledger, async () => true);
const members = new WorldMembers(world);
members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say"), wordContract("agent:main", "typing")], handle: () => ({ ok: true, result: { accepted: true } }) });
const edge = new EdgeRouter(ledger, world, members, { api: { "probe-owner-token": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
let alternateLedger;
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
  members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
  if (process.env.ASH_PROBE_SWITCH === "1") {
    alternateLedger = await Ledger.open(join(directory, "alternate.db"));
    const alternateWorld = new WorldRouter(alternateLedger, async () => true);
    const alternateMembers = new WorldMembers(alternateWorld);
    alternateMembers.register({ id: "agent:main", kind: "agent", name: "Alternate", words: () => [wordContract("agent:main", "say"), wordContract("agent:main", "typing")], handle: () => ({ ok: true, result: { accepted: true } }) });
    const alternateEdge = new EdgeRouter(alternateLedger, alternateWorld, alternateMembers, { api: { "probe-owner-B": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
    alternateMembers.register(new PostPresenceMember((screen) => alternateEdge.screens.markVisible(screen)));
    for (let n = 1; n <= 3; n++) alternateLedger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: `account B ${n}` } });
    edge.tokens.api["probe-owner-B"] = "person:owner";
    const originalCaller = edge.localCaller.bind(edge);
    const originalHandle = edge.handle.bind(edge);
    const switched = (headers) => /(?:^|;\s*)ash_ui=probe-owner-B(?:;|$)/.test(headers.cookie ?? "");
    edge.localCaller = (headers) => switched(headers) ? alternateEdge.localCaller(headers) : originalCaller(headers);
    edge.handle = (request, caller) => switched(request.headers) ? alternateEdge.handle(request, caller) : originalHandle(request, caller);
  }
  for (let n = 1; n <= 120; n++) await world.send({ member: "person:owner", transport: "api", transportPrincipal: "fixture", local: true, remote: false, ownerProxy: true }, { to: "agent:main", kind: "request", word: "say", body: { text: `fixture ${n}` }, client_id: `fixture-${n}` });
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const streamHeaders = [];
  const rawReads = [];
  const rawStatuses = [];
  const alternateFinite = [];
  server.on("request", (request, response) => {
    if (request.url?.startsWith("/api/stream?follow=true")) streamHeaders.push(request.headers["last-event-id"] ?? null);
    if (request.url?.includes("follow=false") && request.url?.includes("limit=1") && !request.url?.includes("summary=true")) {
      rawReads.push(request.url);
      response.on("finish", () => rawStatuses.push(response.statusCode));
    }
    if (request.url?.includes("follow=false") && request.url?.includes("summary=true") && /(?:^|;\s*)ash_ui=probe-owner-B(?:;|$)/.test(request.headers.cookie ?? "")) alternateFinite.push(request.url);
  });
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
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
  const suggested = await world.send(agent, { to: secondVisible.origin.screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "suggest" } });
  await until(() => ledger.responseTo(suggested.id), "target tab suggestion acknowledgement");
  const suggestionReply = ledger.responseTo(suggested.id);
  assert.equal(suggestionReply.body.result.opened, false);
  assert.equal(suggestionReply.from, secondVisible.origin.screen);
  assert.equal(await evaluate2("document.querySelectorAll('#suggestions .chip').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('#suggestions .chip').length"), 0);
  const performed = await world.send(agent, { to: firstVisible.origin.screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "perform" } });
  await until(() => ledger.responseTo(performed.id), "unavailable perform acknowledgement");
  const performReply = ledger.responseTo(performed.id);
  assert.equal(performReply.body.result.opened, false);
  assert.equal(performReply.from, firstVisible.origin.screen);
  assert.equal(await evaluate("document.querySelectorAll('#suggestions .chip').length"), 0);
  assert.equal(await evaluate2("document.querySelectorAll('#suggestions .chip').length"), 1);
  assert.equal(ledger.list({ after: suggested.seq, limit: 1000 }).filter((message) => message.reply_to === suggested.id).length, 1);
  assert.equal(ledger.list({ after: performed.seq, limit: 1000 }).filter((message) => message.reply_to === performed.id).length, 1);
  server.closeAllConnections();
  await world.send({ member: "person:owner", transport: "api", transportPrincipal: "fixture", local: true, remote: false, ownerProxy: true }, { to: "agent:main", kind: "request", word: "say", body: { text: "after reconnect" }, client_id: "after-reconnect" });
  await until(async () => await evaluate("[...document.querySelectorAll('#log .msg')].some(x => x.textContent === 'after reconnect')"), "reconnected record");
  assert.ok(streamHeaders.length >= 2);
  assert.match(String(streamHeaders.at(-1)), /^[1-9][0-9]*$/);
  assert.equal(await evaluate("[...document.querySelectorAll('#log .msg')].filter(x => x.textContent === 'after reconnect').length"), 1);
  if (process.env.ASH_PROBE_LARGE === "1") {
    await evaluate("(() => { window.__fixtureBlobOpens=0; const original=URL.createObjectURL.bind(URL); URL.createObjectURL=(blob)=>{window.__fixtureBlobOpens++;return original(blob)}; return true; })()");
    for (const [index, mib] of [2, 19].entries()) {
      const name = `synthetic-${mib}.bin`;
      const beforeLarge = ledger.lastSeq();
      await evaluate(`(() => { const bytes = new Uint8Array(${mib} * 1024 * 1024).fill(7); const file = new File([bytes], ${JSON.stringify(name)}, { type: 'application/octet-stream' }); const transfer = new DataTransfer(); transfer.items.add(file); document.querySelector('#file').files = transfer.files; document.querySelector('#f').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); return true; })()`);
      const accepted = await until(() => ledger.postRead((db) => db.prepare("SELECT seq,id FROM messages WHERE seq>? AND word='say' AND json_extract(body,'$.attachments[0].name')=? ORDER BY seq LIMIT 1").get(beforeLarge, name)), `${mib} MiB ledger acceptance`, 30_000);
      await until(async () => await evaluate(`[...document.querySelectorAll('#log button.attachment')].some(x => x.textContent === ${JSON.stringify(name)})`), `${mib} MiB summary bubble`, 30_000);
      await evaluate(`[...document.querySelectorAll('#log button.attachment')].find(x => x.textContent === ${JSON.stringify(name)}).click()`);
      await until(() => rawReads.some((url) => url.includes(`before=${Number(accepted.seq) + 1}`)), `${mib} MiB authorized raw fetch`, 30_000);
      await until(async () => await evaluate("window.__fixtureBlobOpens") === index + 1, `${mib} MiB decoded raw attachment`, 30_000);
      assert.equal(rawStatuses[index], 200);
    }
  }
  if (process.env.ASH_PROBE_SWITCH === "1") {
    assert.equal(await evaluate("fetch('/?token=probe-owner-B',{credentials:'same-origin'}).then(r=>r.status)"), 200);
    server.closeAllConnections();
    await until(async () => await evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent==='account B 1')"), "new credential history after old high cursor", 30_000);
    assert.equal(await evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent?.startsWith('fixture '))"), false);
    assert.equal(await evaluate("[...document.querySelectorAll('#log .msg')].filter(x=>x.textContent?.startsWith('account B ')).length"), 3);
    assert.ok(alternateFinite.some((url) => /after=[1-9][0-9]{2,}/.test(url)), "first alternate page used the old high cursor");
    assert.ok(alternateFinite.some((url) => url.includes("limit=200") && !url.includes("after=")), "client refetched the latest page after scope reset");
  }
  console.log(JSON.stringify({ browser: "Chrome", firstRenderMs, latestRecords: 200, olderRows: 20, crossTab: true, targetScreenOpen: true, suggestAck: false, performAck: false, reconnectLastEventId: streamHeaders.at(-1), visibleRecorded: true,
    ...(process.env.ASH_PROBE_LARGE === "1" ? { largeAttachmentsMiB: [2, 19], authorizedRawReads: rawReads.length } : {}),
    ...(process.env.ASH_PROBE_SWITCH === "1" ? { sameOriginCredentialSwitch: true, oldSeqAboveNew: ledger.lastSeq() > alternateLedger.lastSeq(), staleCursorPageDiscarded: true } : {}), result: "PASS" }));
} finally {
  socket?.close();
  socket2?.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already exited */ } }
  if (browser && browser.exitCode === null && browser.signalCode === null) await new Promise((resolve) => browser.once("exit", resolve));
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  ledger.close();
  alternateLedger?.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
