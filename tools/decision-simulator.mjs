// Isolated emulator acceptance probe. JEV is scripted; DSH, Android and native UI are real.
// Never use this with the owner's ai.ash.agent package. Keys are read, never printed or deleted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";

const pkg = "ai.ash.agent.probe";
const adb = `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const shell = (...args) => execFileSync(adb, ["shell", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, check, ms = 120000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await check(); if (value) return value; await sleep(250); }
  throw new Error(`${label} timeout`);
};

if (process.argv[2] === "serve") {
  let seen = [];
  createServer((req, res) => {
    let data = "";
    req.on("data", (part) => { data += part; });
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/seen") return void res.end(JSON.stringify(seen));
      const { state, questions } = JSON.parse(data);
      if (!questions.real_screen) return void res.end(JSON.stringify({ answers: {
        intent: { choice: "unrelated", confidence: 0.99 }, targets_current: { noul: 0 }, urgency: { score: 0 } } }));
      const text = JSON.stringify(state.owner_request ?? "");
      const mode = text.includes("SIM-STAY") ? "stay" : "return_to_ash";
      seen.push({ at: Date.now(), mode, stale: text.includes("SIM-STALE") });
      console.log("JEV scripted", JSON.stringify(seen.at(-1)));
      if (text.includes("SIM-STALE")) await sleep(4000);
      res.end(JSON.stringify({ answers: { real_screen: { choice: mode, confidence: 0.99 },
        virtual_screen: { choice: "none", confidence: 0.99 } } }));
    });
  }).listen(14980, "0.0.0.0", () => console.log("scripted JEV ready"));
} else {
  execFileSync(adb, ["forward", "tcp:14763", "tcp:14763"]);
  const token = await waitFor("core", () => {
    try { return /token=([^\s]+)/.exec(shell("cat", `/data/user/0/${pkg}/files/ash/state/ui-url`))?.[1]; } catch { return null; }
  }, 300000);
  const api = async (path, method = "GET", body) => {
    const res = await fetch(`http://127.0.0.1:14763${path}`, { method, headers: { authorization: `Bearer ${token}`,
      "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(`core ${path}: ${res.status}`);
    return path.startsWith("/api/stream") ? res.text() : res.json();
  };
  const rows = async () => (await api("/api/stream?follow=false&limit=1000")).split("\n").filter((s) => s.startsWith("data:"))
    .map((s) => JSON.parse(s.slice(5))).filter((r) => r.word);
  const seen = () => fetch("http://127.0.0.1:14980/seen").then((r) => r.json());
  const foreground = () => shell("dumpsys", "activity", "activities").split("\n").find((s) => /mResumedActivity|topResumedActivity/.test(s)) ?? "";
  await waitFor("core listening", async () => { try { await api("/api/describe"); return true; } catch { return false; } }, 300000);
  if (process.argv[2] === "keys") {
    await api("/api/vault/DEEPSEEK_API_KEY", "PUT", { value: readFileSync(`${homedir()}/.ash/test-deepseek-key`, "utf8").trim() });
    await api("/api/vault/OPENROUTER_API_KEY", "PUT", { value: "synthetic-local-jev-only" });
    // Exact access grant only in the isolated probe's own ledger.
    await api("/api/send", "POST", { to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:phone/apps.open" }, wait: true });
    console.log("isolated test credentials configured (values hidden)");
  } else {
    const pid = shell("pidof", pkg).split(" ")[0];
    execFileSync(adb, ["forward", "tcp:14981", `localabstract:webview_devtools_remote_${pid}`]);
    const page = await waitFor("WebView", async () => {
      try { return (await fetch("http://127.0.0.1:14981/json").then((r) => r.json())).find((p) => p.type === "page" && p.url.includes("ash-ui")); } catch { return null; }
    });
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
    let serial = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const result = JSON.parse(String(data)), next = pending.get(result.id);
      if (next) { pending.delete(result.id); result.error ? next.reject(new Error(result.error.message)) : next.resolve(result.result); }
    };
    const command = (method, params) => new Promise((resolve, reject) => {
      const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = (expression) => command("Runtime.evaluate", { expression, returnByValue: true });
    await waitFor("native chat", async () => (await evaluate("Boolean(document.querySelector('#t') && !document.querySelector('#send').disabled && document.querySelector('#connection')?.textContent==='已连接')")).result?.value);
    const message = (mode) => `【${mode}】这是屏幕回收测试。请用 apps.open 打开系统设置 com.android.settings，打开成功后只回复“测试完成”。不要自行返回 Ash，不要做其他操作。`;
    const send = async (mode) => {
      shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
      await sleep(700);
      const value = JSON.stringify(message(mode));
      await evaluate(`(() => { const t=document.querySelector('#t'); t.value=${value}; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#send').click(); })()`);
    };
    const turnEnd = (afterSeq, marker) => waitFor(marker, async () => {
      const evidence = await rows();
      const input = evidence.find((r) => r.seq > afterSeq && r.from === "person:owner" && r.to === "agent:main" &&
        r.kind === "request" && r.word === "say" && String(r.body.text).includes(marker));
      const read = input && evidence.find((r) => r.from === "agent:main" && r.word === "read" && r.body.ids?.includes(input.id));
      return read && evidence.find((r) => r.from === "agent:main" && r.word === "turn.end" && r.turn === read.body.turn);
    });
    const afterTurn = async (afterSeq, marker, inputMarker = `SIM-${marker}`) => {
      const end = await turnEnd(afterSeq, inputMarker);
      const decision = await waitFor("decision", async () => (await rows()).find((r) => r.word === "decision.applied" && r.turn === end.body.turn));
      console.log(marker, JSON.stringify({ reason: end.body.reason, outcome: decision.body.outcome, acted: decision.body.acted,
        skipped: decision.body.skipped, foreground: foreground() }));
      return decision;
    };
    try {
      let before = (await rows()).at(-1)?.seq ?? 0;
      await send("SIM-RETURN");
      const back = await afterTurn(before, "RETURN");
      assert.equal(back.body.acted, true); await waitFor("returned HomeActivity", () => foreground().includes(`${pkg}/ai.ash.ui.HomeActivity`));
      before = (await rows()).at(-1).seq;
      await send("SIM-STAY");
      const stay = await afterTurn(before, "STAY");
      assert.equal(stay.body.acted, false); assert.match(foreground(), /com.android.settings/);
      before = (await rows()).at(-1).seq;
      const count = (await seen()).length;
      await send("SIM-STALE");
      await waitFor("JEV pending", async () => (await seen()).length > count);
      shell("input", "keyevent", "KEYCODE_HOME");
      const stale = await afterTurn(before, "USER-PRECEDENCE", "SIM-STALE");
      assert.equal(stale.body.acted, false); assert.equal(stale.body.skipped, "stale");
      const unchanged = foreground();
      before = (await rows()).at(-1).seq;
      const countRemote = (await seen()).length;
      await api("/api/send", "POST", { to: "agent:main", kind: "request", word: "say", body: { text: message("SIM-REMOTE") }, client_id: `remote-${Date.now()}` });
      const remote = await turnEnd(before, "SIM-REMOTE");
      await sleep(700);
      assert.equal((await seen()).length, countRemote);
      assert.equal((await rows()).some((r) => r.word === "decision.started" && r.body.route === "screen.reconcile" && r.turn === remote.body.turn), false);
      console.log("REMOTE", JSON.stringify({ reason: remote.body.reason, decisionCalls: 0, foreground: foreground(), priorForeground: unchanged }));
      shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
      console.log("simulator acceptance passed");
    } finally { ws.close(); }
  }
}
