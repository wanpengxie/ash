// Isolated Chrome + real inbox/HTTP/SSE conversation probe; no personal browser profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentMember } from "../../src/members/agent.ts";
import { OwnerMember } from "../../src/members/owner.ts";
import { PostPresenceMember } from "../../src/members/post.ts";
import { EdgeRouter, startEdgeServer } from "../../src/server.ts";
import { Ledger } from "../../src/world/ledger.ts";
import { WorldMembers } from "../../src/world/member.ts";
import { WorldRouter } from "../../src/world/router.ts";

function cdp(socket) {
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    if (!packet.id) return;
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

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`timed out: ${label}`);
}

const directory = mkdtempSync(join(tmpdir(), "ash-conversation-probe-"));
mkdirSync(join(directory, "workspace"));
writeFileSync(join(directory, "workspace", "card.txt"), "card file bytes");
writeFileSync(join(directory, "workspace", "card.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tS8AAAAASUVORK5CYII=", "base64"));
const ledger = await Ledger.open(join(directory, "ledger.db"));
const world = new WorldRouter(ledger, async () => true);
const members = new WorldMembers(world);
const runnerMessages = [];
let readRelease;
const readGate = new Promise((resolve) => { readRelease = resolve; });
let firstSendRelease;
const firstSendGate = new Promise((resolve) => { firstSendRelease = resolve; });
let firstSendHeld = false;
let readHeld = false;
const originalSend = world.send.bind(world);
world.send = async (caller, message, ...rest) => {
  if (!readHeld && caller?.member === "agent:main" && message?.word === "read") {
    readHeld = true;
    await readGate;
  }
  return originalSend(caller, message, ...rest);
};
const agent = createAgentMember({ ledger, router: world, stateDir: join(directory, "agent"), runner: {
  async runTurn(input, emit) {
    for (const message of input.messages) runnerMessages.push(message.id);
    if (input.messages.some((message) => message.body?.text === "first synthetic message")) {
      const target = input.messages.find((message) => message.body?.text === "first synthetic message");
      await world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, turn: input.turn },
        { to: "person:owner", kind: "request", word: "react", body: { message_id: target.id, emoji: "👍" }, client_id: `probe-react:${target.id}` });
      await emit({ id: "probe-first", text: "first reply" });
      await emit({ id: "probe-second", text: "second reply" });
    } else await emit({ id: `probe-${input.turn}`, text: "offline reply" });
    return { reason: "completed" };
  },
} });
members.register(new OwnerMember("Owner", ledger));
members.register(agent);
const edge = new EdgeRouter(ledger, world, members, { api: { "probe-owner-token": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 7), workspaces: { home: join(directory, "workspace") } });
members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
const originalHandle = edge.handle.bind(edge);
edge.handle = async (request, caller) => {
  if (!firstSendHeld && request.method === "POST" && request.url.pathname === "/api/send") {
    let message;
    try { message = JSON.parse(request.body.toString("utf8")); } catch { /* not a send */ }
    if (message?.word === "say" && message.body?.text === "first synthetic message") {
      firstSendHeld = true;
      await firstSendGate;
    }
  }
  return originalHandle(request, caller);
};
let server;
let browser;
let socket;
let secondSocket;
try {
  agent.prepareRecovery();
  await world.recover();
  await agent.start();
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(directory, "profile")}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore", detached: true });
  const debugFile = join(directory, "profile", "DevToolsActivePort");
  const port = await until(() => { try { return Number(readFileSync(debugFile, "utf8").split("\n")[0]); } catch { return 0; } }, "browser debug port");
  const tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.type === "page");
  assert.ok(tab?.webSocketDebuggerUrl);
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  const browserErrors = [];
  socket.addEventListener("message", (event) => {
    const packet = JSON.parse(event.data);
    if (packet.method === "Runtime.exceptionThrown") browserErrors.push(packet.params?.exceptionDetails?.text + ": " + packet.params?.exceptionDetails?.exception?.description);
  });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${base}/?token=probe-owner-token` });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "registered browser screen").catch(async (error) => {
    console.error("registration state", await evaluate("({url:location.href,connection:document.querySelector('#connection')?.textContent,transport:document.querySelector('#connection')?.dataset.transport,error:document.querySelector('#connection')?.title,body:document.body?.textContent.slice(0,160)})"), browserErrors);
    throw error;
  });
  await evaluate("document.querySelector('#t').value='first synthetic message';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await until(() => firstSendHeld, "first request held before acceptance");
  await until(() => evaluate("document.querySelector('.pending-local + .delivery')?.textContent === '发送中'"), "sending stage");
  firstSendRelease();
  await until(() => readHeld, "read event held after received");
  const first = await until(() => ledger.list({ after: 0, limit: 100 }).find((message) => message.word === "say" && message.from === "person:owner" && message.body?.text === "first synthetic message"), "first accepted owner say");
  assert.equal(ledger.list({ after: first.seq, limit: 100 }).some((message) => message.from === "agent:main" && message.word === "received" && message.body.ids.includes(first.id)), true);
  assert.equal(ledger.list({ after: first.seq, limit: 100 }).some((message) => message.from === "agent:main" && message.word === "read"), false);
  await until(() => evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent==='first synthetic message') && [...document.querySelectorAll('#log .delivery')].some(x=>x.textContent==='已送达')"), "delivered stage");
  readRelease();
  await until(() => evaluate("[...document.querySelectorAll('#log .delivery')].some(x=>x.textContent==='已读')"), "read stage");
  await until(() => evaluate("[...document.querySelectorAll('#log .msg.ai')].filter(x=>x.textContent==='first reply'||x.textContent==='second reply').length===2"), "two assistant bubbles");
  const live = await evaluate("(() => {const rows=[...document.querySelectorAll('#log .msg')];const first=rows.find(x=>x.textContent.startsWith('first synthetic message'));const replies=rows.filter(x=>x.classList.contains('ai')&&(x.textContent==='first reply'||x.textContent==='second reply'));return {reaction:first?.querySelector('.reaction')?.textContent,first:replies[0]?.className,second:replies[1]?.className,replyCount:replies.length};})()");
  assert.equal(live.reaction, "👍");
  assert.match(live.first, /group-first/);
  assert.match(live.second, /group-last/);
  assert.equal(live.replyCount, 2);

  await call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await evaluate("document.querySelector('#t').value='offline synthetic message';document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
  await until(() => evaluate("[...document.querySelectorAll('#log .pending-local')].some(x=>x.textContent==='offline synthetic message') && [...document.querySelectorAll('#log .pending-local + .delivery')].some(x=>x.textContent==='未发送')"), "offline unsent stage");
  assert.equal(ledger.list({ after: first.seq, limit: 1000 }).filter((message) => message.word === "say" && message.from === "person:owner" && message.body?.text === "offline synthetic message").length, 0);
  await call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const second = await until(() => ledger.list({ after: first.seq, limit: 1000 }).find((message) => message.word === "say" && message.from === "person:owner" && message.body?.text === "offline synthetic message"), "offline queued message accepted once", 20_000);
  await until(() => evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent==='offline synthetic message')"), "offline message projected after reconnect", 20_000);
  await until(() => runnerMessages.includes(second.id), "inbox processes restored send", 20_000);
  assert.equal(ledger.list({ after: first.seq, limit: 1000 }).filter((message) => message.word === "say" && message.from === "person:owner" && message.body?.text === "offline synthetic message").length, 1);
  assert.equal(runnerMessages.filter((id) => id === second.id).length, 1);
  assert.equal(await evaluate("[...document.querySelectorAll('#log .msg')].filter(x=>x.textContent==='offline synthetic message').length"), 1);
  const originalImageBytes = await evaluate(`(async () => {
    const canvas=document.createElement('canvas');canvas.width=4096;canvas.height=1024;
    const context=canvas.getContext('2d');const pixels=context.createImageData(canvas.width,canvas.height);
    let random=0x12345678;
    for(let i=0;i<pixels.data.length;i+=4){random^=random<<13;random^=random>>>17;random^=random<<5;
      pixels.data[i]=random&255;pixels.data[i+1]=(random>>>8)&255;pixels.data[i+2]=(random>>>16)&255;pixels.data[i+3]=255;}
    context.putImageData(pixels,0,0);
    const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const transfer=new DataTransfer();transfer.items.add(new File([png],'synthetic-photo.png',{type:'image/png'}));
    transfer.items.add(new File(['literal file bytes'],'note.txt',{type:'text/plain'}));
    document.querySelector('#file').files=transfer.files;
    document.querySelector('#t').value='attachment test';
    document.querySelector('#f').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    return png.size;
  })()`);
  const imageRow = await until(() => ledger.postRead((db) => db.prepare("SELECT id FROM messages WHERE \"from\"='person:owner' AND word='say' AND json_extract(body,'$.text')='attachment test' ORDER BY seq DESC LIMIT 1").get()), "compressed image and document accepted", 30_000);
  const imageMessage = ledger.byId(imageRow.id);
  const [photo, document] = imageMessage.body.attachments;
  const jpegBytes = Buffer.from(photo.data, "base64");
  assert.equal(photo.name, "synthetic-photo.jpg");
  assert.equal(photo.mime_type, "image/jpeg");
  assert.equal(jpegBytes[0], 255);
  assert.equal(jpegBytes[1], 216);
  assert.ok(jpegBytes.length < originalImageBytes, "converted static image did not grow");
  assert.equal(document.name, "note.txt");
  assert.equal(document.mime_type, "text/plain");
  assert.equal(Buffer.from(document.data, "base64").toString(), "literal file bytes");
  await until(() => evaluate("[...document.querySelectorAll('#log .msg')].some(x=>x.textContent.includes('synthetic-photo.jpg')&&x.textContent.includes('note.txt'))"), "compressed image and original document projected", 30_000);
  await evaluate("[...document.querySelectorAll('#log button.attachment')].find(x=>x.textContent==='synthetic-photo.jpg').click()");
  await until(() => evaluate("[...document.querySelectorAll('#log .atts img')].some(x=>x.naturalWidth===2048&&x.naturalHeight===512)"), "authorized 2048-pixel JPEG preview", 30_000);
  const optionCard = (await world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false },
    { to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", prompt: "Pick one", options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }] } } })).id;
  await until(() => evaluate("[...document.querySelectorAll('#log .card')].some(x=>x.textContent.includes('Pick one'))"), "option card visible");
  await evaluate("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Pick one')).querySelector('button').click()");
  await until(() => ledger.list({ limit: 1000 }).some((message) => message.from === "person:owner" && message.word === "say" && message.body?.in_reply_to === optionCard), "option reply accepted");
  await until(() => evaluate("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Pick one'))?.textContent.includes('已选择')"), "option card locked");
  const answer = ledger.list({ limit: 1000 }).find((message) => message.from === "person:owner" && message.word === "say" && message.body?.in_reply_to === optionCard);
  assert.deepEqual({ text: answer.body.text, option_id: answer.body.option_id }, { text: "Yes", option_id: "yes" });
  const created = await call("Target.createTarget", { url: base });
  const secondTab = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.id === created.targetId), "second browser tab");
  secondSocket = new WebSocket(secondTab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { secondSocket.addEventListener("open", resolve, { once: true }); secondSocket.addEventListener("error", reject, { once: true }); });
  const secondCall = cdp(secondSocket);
  await secondCall("Page.enable");
  await secondCall("Runtime.enable");
  const evaluateSecond = async (expression) => (await secondCall("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await until(() => evaluateSecond("document.querySelector('#connection')?.textContent === '已连接'"), "second registered browser screen");
  const racedCard = (await world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false },
    { to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", prompt: "Race choice", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] } } })).id;
  const hasRacedCard = "[...document.querySelectorAll('#log .card')].some(x=>x.textContent.includes('Race choice'))";
  await until(async () => await evaluate(hasRacedCard) && await evaluateSecond(hasRacedCard), "both screens see option card");
  await Promise.all([
    evaluate("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Race choice')).querySelectorAll('button')[0].click()"),
    evaluateSecond("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Race choice')).querySelectorAll('button')[1].click()"),
  ]);
  await until(() => ledger.list({ limit: 1000 }).some((message) => message.from === "person:owner" && message.word === "say" && message.body?.in_reply_to === racedCard), "first cross-screen option accepted");
  await until(async () => await evaluate("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Race choice'))?.textContent.includes('已选择')") &&
    await evaluateSecond("[...document.querySelectorAll('#log .card')].find(x=>x.textContent.includes('Race choice'))?.textContent.includes('已选择')"), "both screens show locked card");
  assert.equal(ledger.list({ limit: 1000 }).filter((message) => message.from === "person:owner" && message.word === "say" && message.body?.in_reply_to === racedCard).length, 1);
  for (const card of [
    { type: "file", workspace: "home", path: "card.txt", name: "card.txt", mime_type: "text/plain", size: 15 },
    { type: "image", workspace: "home", path: "card.png", alt: "one pixel" },
    { type: "link", url: "https://example.com/path", title: "Example" },
  ]) await world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false },
    { to: "person:owner", kind: "request", word: "show", body: { card } });
  await until(() => evaluate("[...document.querySelectorAll('#log .card a')].some(x=>x.textContent==='card.txt') && [...document.querySelectorAll('#log .card img')].some(x=>x.alt==='one pixel'&&x.naturalWidth===1) && [...document.querySelectorAll('#log .card a')].some(x=>x.textContent==='Example')"), "file image and link cards rendered");
  const openedCards = await evaluate("(async()=>{const links=[...document.querySelectorAll('#log .card a')];const file=links.find(x=>x.textContent==='card.txt');const external=links.find(x=>x.textContent==='Example');return {bytes:await(await fetch(file.href)).text(),link:external.href,target:external.target}})()");
  assert.deepEqual(openedCards, { bytes: "card file bytes", link: "https://example.com/path", target: "_blank" });
  console.log(JSON.stringify({ result: "PASS", browser: "Chrome", sendingDeliveredRead: true, groupedReplies: 2, reactionOnOwnerBubble: true, offlineAccepted: 1, offlineRunnerReceipts: 1,
    staticImageConverted: "PNG→JPEG", originalImageBytes, compressedImageBytes: jpegBytes.length, previewDimensions: [2048, 512], documentBytesPreserved: true, optionReply: "locked", crossScreenOptionAccepted: 1, fileImageLinkCards: true }));
} finally {
  firstSendRelease();
  readRelease();
  socket?.close();
  secondSocket?.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch { /* already exited */ } }
  if (browser && browser.exitCode === null && browser.signalCode === null) await new Promise((resolve) => browser.once("exit", resolve));
  await agent.close();
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  ledger.close();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
