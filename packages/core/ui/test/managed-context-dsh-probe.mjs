// F-U17: disposable owner, scripted model and isolated Chrome.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main.ts";

const install = process.env.ASH_TEST_DSH_ROOT;
if (!install || !existsSync(join(install, "package.json")))
  throw new Error("ASH_TEST_DSH_ROOT must name a disposable-test capable installed DSH runtime");
if (!process.execArgv.includes("--expose-internals")) throw new Error("run with node --expose-internals");

const root = mkdtempSync(join(tmpdir(), "ash-managed-context-"));
const home = join(root, "home");
const oldSoul = "SYNTHETIC_SOUL_OLD_017";
const newSoul = "SYNTHETIC_SOUL_NEW_017";
const userFact = "SYNTHETIC_USER_FACT_017";
const memoryFact = "SYNTHETIC_MEMORY_FACT_017";
let model, owner, chrome, socket;
const captured = [];
const until = async (check, label) => {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(40);
  }
  throw new Error(`timed out: ${label}`);
};
function cdp(websocket) {
  let id = 0;
  const pending = new Map();
  websocket.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    const item = pending.get(result.id);
    if (!item) return;
    pending.delete(result.id);
    result.error ? item.reject(new Error("isolated browser operation failed")) : item.resolve(result.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    websocket.send(JSON.stringify({ id: next, method, params }));
  });
}
const currentTail = (request) => {
  const messages = request.messages ?? [];
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
  return JSON.stringify(messages.slice(lastAssistant + 1));
};

try {
  // startOwner creates this temporary home; seed it before DSH boot so first-turn capture is meaningful.
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "SOUL.md"), `${oldSoul}\n`, { mode: 0o600 });
  writeFileSync(join(home, "USER.md"), `---\nversion: 1\nupdated: 2026-01-01T00:00:00.000Z\n---\n${userFact}\n`, { mode: 0o600 });
  writeFileSync(join(home, "MEMORY.md"), `${memoryFact}\n`, { mode: 0o600 });
  let serial = 0;
  model = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/messages")) { response.writeHead(404).end("{}"); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let payload;
    try { payload = JSON.parse(raw); } catch { response.writeHead(400).end("{}"); return; }
    if (Array.isArray(payload.tools) && payload.tools.length) captured.push(payload);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (kind, data) => response.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_context_${++serial}`, type: "message", role: "assistant", model: payload.model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Synthetic model turn complete." } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    event("message_stop", {}); response.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelPort = model.address().port;
  owner = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(root, "dsh"), env: {
      DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/anthropic`,
    } } });
  const ownerToken = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")[0];
  const say = async (id) => {
    const response = await fetch(`${owner.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: `Synthetic context check ${id}` }, client_id: `context-${id}` }) });
    assert.equal(response.status, 200);
  };
  await say("before");
  await until(() => captured.length >= 1 && owner.ledger.list({ limit: 1000 }).some((message) => message.word === "turn.end" && message.body?.reason === "completed"), "first real DSH turn");

  chrome = spawn(process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", ["--headless=new", "--no-sandbox", "--disable-gpu",
    "--disable-dev-shm-usage", "--disable-breakpad", `--user-data-dir=${join(root, "chrome")}`, "--remote-debugging-port=0", "about:blank"],
  { stdio: "ignore", detached: true });
  const chromePort = await until(() => {
    try { return Number(readFileSync(join(root, "chrome", "DevToolsActivePort"), "utf8").split("\n")[0]); } catch { return 0; }
  }, "isolated Chrome");
  const pages = await (await fetch(`http://127.0.0.1:${chromePort}/json`)).json();
  socket = new WebSocket(pages.find((item) => item.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  const call = cdp(socket);
  await call("Page.enable"); await call("Runtime.enable");
  const evaluate = async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: `${owner.url}/?token=${ownerToken}` });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "registered local browser screen");
  await evaluate("document.querySelector('#presence').click()");
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .markdown-source')?.value === 'SYNTHETIC_SOUL_OLD_017\\n'"), "canonical old SOUL read");
  await evaluate(`(() => { const input=document.querySelector('#agentPanel section[data-tab=identity] .markdown-source');input.value=${JSON.stringify(`${newSoul}\n`)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#agentPanel section[data-tab=identity] .editor-save').click();})()`);
  await until(() => evaluate("document.querySelector('#agentPanel section[data-tab=identity] .editor-status')?.textContent.includes('已保存并核对当前版本')"), "Chrome SOUL write/readback");
  assert.equal(readFileSync(join(home, "SOUL.md"), "utf8"), `${newSoul}\n`);
  const changed = owner.ledger.list({ limit: 1000 }).filter((message) => message.word === "self.changed" && message.body?.path === "SOUL.md");
  assert.equal(changed.length, 1, "canonical file change must have one source event");
  assert.equal(typeof changed[0].body.summary, "string");

  await say("after");
  await until(() => captured.length >= 2 && owner.ledger.list({ limit: 1000 }).filter((message) => message.word === "turn.end" && message.body?.reason === "completed").length >= 2, "second real DSH turn");
  await say("later");
  await until(() => captured.length >= 3 && owner.ledger.list({ limit: 1000 }).filter((message) => message.word === "turn.end" && message.body?.reason === "completed").length >= 3, "third real DSH turn");
  // Ash places the current context before this turn's dynamic messages in one DSH followup.
  const beforeVisible = JSON.stringify(captured[0].messages ?? []);
  const afterVisible = JSON.stringify(captured[1].messages ?? []);
  const beforeTail = currentTail(captured[0]);
  const afterTail = currentTail(captured[1]);
  const laterTail = currentTail(captured[2]);
  const ordered = [oldSoul, "像在对话里帮一个熟悉的人办事", "当系统正在等对方答复", userFact, "Synthetic context check before"]
    .map((marker) => beforeTail.indexOf(marker));
  const observed = { firstHasOldSoul: beforeVisible.includes(oldSoul), firstHasUser: beforeVisible.includes(userFact),
    firstHasMemory: beforeVisible.includes(memoryFact), firstContextOrder: ordered.every((position, index) =>
      position >= 0 && (index === 0 || position > ordered[index - 1])), firstDynamicVisible: beforeTail.includes("Synthetic context check before"),
    secondHasNewSoul: afterVisible.includes(newSoul),
    secondCurrentHasNewSoul: afterTail.includes(newSoul), secondCurrentHasOldSoul: afterTail.includes(oldSoul),
    secondHasUser: afterVisible.includes(userFact), secondHasMemory: afterVisible.includes(memoryFact),
    secondHasChangedFact: afterTail.includes("self.changed") && afterTail.includes("SOUL.md") &&
      afterTail.includes(`by ${changed[0].body.by}`) && afterTail.includes(changed[0].body.summary), thirdHasChangedFact: laterTail.includes("self.changed") &&
      laterTail.includes(changed[0].body.summary) };
  console.log(JSON.stringify(observed)); // Synthetic marker booleans only; never dump the provider request or headers.
  assert.deepEqual(observed, { firstHasOldSoul: true, firstHasUser: true, firstHasMemory: true, firstContextOrder: true,
    firstDynamicVisible: true,
    secondHasNewSoul: true, secondCurrentHasNewSoul: true, secondCurrentHasOldSoul: false,
    secondHasUser: true, secondHasMemory: true, secondHasChangedFact: true, thirdHasChangedFact: false });
} finally {
  socket?.close();
  if (chrome?.pid) { try { process.kill(-chrome.pid, "SIGKILL"); } catch {} }
  await owner?.close();
  if (model) { model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); }
  rmSync(root, { recursive: true, force: true });
}
