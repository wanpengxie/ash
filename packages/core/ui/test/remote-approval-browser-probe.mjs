// Controlled local gateway only: fresh unclaimed DO, synthetic pairing, isolated Chrome profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DeviceKey, GatewayClient } from "ash-gateway/client/client";
import { startOwner } from "../../src/main.ts";

const base = process.env.ASH_TEST_GATEWAY_URL;
const secret = process.env.ASH_TEST_BOOTSTRAP_SECRET;
if (!base || !secret || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error("an isolated loopback gateway and synthetic bootstrap secret are required");
const health = await (await fetch(`${base}/v1/health`)).json();
if (health.claimed !== false || health.bootstrap_configured !== true || health.owner_online !== false)
  throw new Error("gateway is not a fresh unclaimed test instance");

const directory = mkdtempSync(join(tmpdir(), "ash-v2-remote-approval-"));
let owner, browser, socket;
const until = async (check, label, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch {}
    await delay(100);
  }
  throw new Error(`timed out: ${label}`);
};
const cdp = (websocket) => {
  let next = 1;
  const waiting = new Map();
  websocket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(data);
    const slot = waiting.get(response.id);
    if (!slot) return;
    waiting.delete(response.id);
    response.error ? slot.reject(new Error("browser operation failed")) : slot.resolve(response.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    websocket.send(JSON.stringify({ id, method, params }));
  });
};

try {
  const stateDir = join(directory, "owner");
  mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(stateDir, "bootstrap-secret"), secret, { mode: 0o600 });
  owner = await startOwner({ stateDir, listen: "127.0.0.1:0", gateway: { url: base },
    agents: [{ id: "agent:main", runtime: "echo" }] });
  assert.equal(owner.link?.connected, true);
  const { ticket } = await owner.link.ticket();
  const key = await DeviceKey.generate();
  const gateway = new GatewayClient(base, key);
  const pairing = await gateway.requestPairing(ticket, "Synthetic remote browser");
  await until(() => [...owner.link.pending.values()].find((entry) => entry.request_id === pairing.request_id), "pairing request");
  await owner.link.approve(pairing.request_id, ["chat", "web_ui"]);
  await gateway.waitForApproval(pairing.request_id, pairing.owner_key);
  const session = await gateway.authenticate();
  const cookie = `ash_session=${session.token}`;
  const pairedHeaders = { cookie, origin: base };

  browser = spawn(process.env.ASH_PROBE_CHROME || "/usr/bin/google-chrome",
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      `--user-data-dir=${join(directory, "chrome-profile")}`, "--remote-debugging-port=0", "about:blank"],
    { stdio: "ignore", detached: true });
  const port = await until(() => {
    try { return Number(readFileSync(join(directory, "chrome-profile", "DevToolsActivePort"), "utf8").split("\n")[0]); }
    catch { return 0; }
  }, "isolated Chrome");
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  socket = new WebSocket(tabs.find((entry) => entry.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true });
  });
  const call = cdp(socket);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Network.setCookie", { name: "ash_session", value: session.token, url: base,
    secure: true, httpOnly: true, sameSite: "Strict" });
  const evaluate = async (expression) => (await call("Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.navigate", { url: base });
  await until(() => evaluate("document.querySelector('#connection')?.textContent === '已连接'"), "remote screen registration");
  assert.equal(await evaluate("Boolean(document.querySelector('#settingsAdmin'))"), false);
  await evaluate("document.querySelector('#t').value='remote synthetic hello'; document.querySelector('#f').requestSubmit()");
  await until(() => owner.ledger.list({ limit: 1000 }).find((item) => item.from === "person:owner" &&
    item.to === "agent:main" && item.word === "say" && item.body?.text === "remote synthetic hello"), "remote chat");
  const remoteSay = owner.ledger.list({ limit: 1000 }).find((item) => item.body?.text === "remote synthetic hello");
  assert.equal(remoteSay.origin?.label, "Computer browser");
  const remoteScreen = remoteSay.origin.screen;

  let effects = 0;
  owner.members.registerDevice({ id: "device:synthetic", kind: "device", name: "Synthetic device", online: true,
    capabilities: () => [{ name: "run", description: "Synthetic effect", label: "Run synthetic", risk: "outward",
      input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }],
    handle: () => { effects++; return { ok: true, result: {} }; } });
  const ownerToken = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")[0];
  const localHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const risky = async (n) => {
    const response = await fetch(`${owner.url}/api/send`, { method: "POST", headers: localHeaders,
      body: JSON.stringify({ to: "device:synthetic", kind: "request", word: "run", body: { n } }) });
    assert.equal(response.status, 200);
    const accepted = await response.json();
    const gate = await until(() => owner.ledger.gateCase(accepted.id), "durable gate ask");
    return gate.askId;
  };
  const openApprovals = async () => {
    await evaluate("document.querySelector('#presence').click()");
    await evaluate("document.querySelector('#agentTabs [data-tab=approvals]').click()");
  };
  const answer = async (askId, choice) => {
    await until(() => evaluate(`Boolean(document.querySelector('[data-ask-id="${askId}"] [data-choice="${choice}"]'))`), "remote approval choice");
    await evaluate(`document.querySelector('[data-ask-id="${askId}"] [data-choice="${choice}"]').click()`);
    await until(() => owner.ledger.responseTo(askId), "single settled ask");
    const responses = owner.ledger.list({ limit: 1000 }).filter((item) => item.kind === "response" && item.reply_to === askId);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].origin?.screen, remoteScreen);
    assert.equal(responses[0].body.result.choice, choice);
    return responses[0];
  };
  const first = await risky(1);
  await openApprovals();
  const screenToken = await evaluate("sessionStorage.getItem('ash.screen.token.v2')");
  assert.equal(typeof screenToken, "string");
  const beforeForged = owner.ledger.lastSeq();
  const forged = await fetch(`${base}/api/send`, { method: "POST",
    headers: { ...pairedHeaders, "content-type": "application/json", "Ash-Screen": screenToken },
    body: JSON.stringify({ to: "service:gate", kind: "response", word: "ask", reply_to: first,
      body: { ok: true, result: { choice: "forged" } }, client_id: "synthetic-forged-option" }) });
  assert.equal(forged.status, 400, "unoffered choice fails at the paired gateway edge");
  assert.equal(owner.ledger.lastSeq(), beforeForged);
  await answer(first, "once");
  await until(() => effects === 1, "one authorized effect");
  const second = await risky(2);
  await answer(second, "deny");
  assert.equal(effects, 1, "denied operation has zero effect");

  const beforeAdmin = owner.ledger.lastSeq();
  const admin = await fetch(`${base}/api/send`, { method: "POST", headers: { ...pairedHeaders, "content-type": "application/json" },
    body: JSON.stringify({ to: "service:admin", kind: "request", word: "pause", body: { local_management: true }, wait: true }) });
  assert.equal(admin.status, 403);
  assert.equal(owner.ledger.lastSeq(), beforeAdmin);
  console.log(JSON.stringify({ result: "PASS", pairedBrowser: true, remoteChat: true, once: true, deny: true,
    responseCount: 2, effects, forgedOptionStatus: forged.status,
    remoteAdminStatus: admin.status, remoteAdminLedgerDelta: 0 }));
} finally {
  socket?.close();
  if (browser?.pid) { try { process.kill(-browser.pid, "SIGKILL"); } catch {} }
  await owner?.close();
  rmSync(directory, { recursive: true, force: true });
}
