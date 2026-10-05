// Isolated emulator acceptance probe. JEV is scripted; DSH, Android and native UI are real.
// Never use this with the owner's ai.ash.agent package. Keys are read, never printed or deleted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";

const pkg = "ai.ash.agent.probe";
const adb = `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const shell = (...args) => execFileSync(adb, ["shell", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, check, ms = 120000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const value = await check(); if (value) return value; await sleep(1000); }
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
      if (questions.execution_screen) return void res.end(JSON.stringify({ answers: {
        execution_screen: { choice: JSON.stringify(state.owner_request).includes("SIM-STAY") ? "foreground_handoff" : "foreground_task", confidence: 0.99 } } }));
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
    // adb forwards can close a pooled idle socket. Use fresh connections and retry reads only.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`http://127.0.0.1:14763${path}`, { method, signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`,
          "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!res.ok) throw new Error(`core ${path}: ${res.status}`);
        return path.startsWith("/api/stream") ? await res.text() : await res.json();
      } catch (error) { if (method !== "GET" || attempt >= 2) throw error; await sleep(1000); }
    }
  };
  const rows = async () => (await api("/api/stream?follow=false&limit=200")).split("\n").filter((s) => s.startsWith("data:"))
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
    const send = async (mode, text = message(mode)) => {
      shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
      await waitFor("visible native page", async () => foreground().includes(`${pkg}/ai.ash.ui.HomeActivity`) &&
        (await evaluate("document.visibilityState==='visible'")).result?.value);
      // A foreground WebView need not own input focus yet. Tap its actual input like the owner.
      const dimensions = /(?:Override|Physical) size: (\d+)x(\d+)/.exec(shell("wm", "size"));
      shell("input", "tap", String(Number(dimensions[1]) * 0.4), String(Number(dimensions[2]) * 0.93));
      await waitFor("focused native input", async () => foreground().includes(`${pkg}/ai.ash.ui.HomeActivity`) &&
        (await evaluate("document.visibilityState==='visible' && document.hasFocus() && !document.querySelector('#send').disabled")).result?.value);
      await sleep(1000);
      const value = JSON.stringify(text);
      await evaluate(`(() => { const t=document.querySelector('#t'); t.value=${value}; t.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#send').click(); })()`);
    };
    const approveSettings = async (evidence, afterSeq) => {
      // Only the isolated probe's explicit, harmless Settings-open action. Never blanket approve.
      for (const asked of evidence.filter((r) => r.seq > afterSeq && r.word === "gate.asked")) {
        const action = evidence.find((r) => r.id === asked.body.request_id);
        const ask = evidence.find((r) => r.id === asked.body.ask_id);
        if (!action || !ask || action.to !== "device:phone" || action.word !== "apps.open" ||
          !Object.values(action.body).some((v) => ["com.android.settings", "com.google.android.deskclock"].includes(v)) || evidence.some((r) => r.reply_to === ask.id)) continue;
        const phone = JSON.parse(shell("cat", `/data/user/0/${pkg}/files/ash/ash.json`)).host.coreToken;
        const response = await fetch("http://127.0.0.1:14763/api/send", { method: "POST", headers: {
          authorization: `Bearer ${phone}`, "content-type": "application/json" }, body: JSON.stringify({
          to: "service:gate", kind: "response", word: "ask", reply_to: ask.id, body: { ok: true, result: { choice: "once" } } }) });
        assert.equal(response.status, 200, "isolated Settings approval");
      }
    };
    const turnEnd = (afterSeq, marker) => waitFor(marker, async () => {
      const evidence = await rows();
      await approveSettings(evidence, afterSeq);
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
      // A prior interrupted probe can leave its real DSH sleep running. Do not overlap test turns.
      await waitFor("previous task idle", async () => {
        const evidence = await rows();
        const start = evidence.findLast((r) => r.from === "agent:main" && r.word === "turn.start");
        return !start || evidence.some((r) => r.from === "agent:main" && r.word === "turn.end" && r.body.turn === start.body.turn);
      });
      console.log("isolated native UI ready", process.argv[2]);
      if (["capsule", "capsule-notice"].includes(process.argv[2])) {
        const output = `${homedir()}/ash-mini/task-capsule-evidence`;
        mkdirSync(output, { recursive: true });
        const capsuleWindow = () => shell("dumpsys", "window", "windows").split(/(?=  Window #\d+ Window\{)/).find((w) => w.includes("AshTaskCapsule") && w.includes("isVisible=true"));
        const visible = () => !!capsuleWindow();
        const shot = (name) => writeFileSync(`${output}/${name}.png`, execFileSync(adb, ["exec-out", "screencap", "-p"]));
        const dump = () => { shell("uiautomator", "dump", "--compressed", "/sdcard/ash-probe-ui.xml"); return shell("cat", "/sdcard/ash-probe-ui.xml"); };
        const tapLabel = (label) => {
          if (["Ash 任务状态，点击展开或拖动", "返回 Ash", "停止本次任务"].includes(label) && capsuleWindow()) {
            const b = /frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(capsuleWindow() ?? "");
            assert.ok(b, "visible capsule frame");
            const density = Number(/(?:Override|Physical) density: (\d+)/.exec(shell("wm", "density"))[1]) / 160;
            const y = label === "Ash 任务状态，点击展开或拖动" ? +b[2] + 40 :
              +b[4] - density * (6 + (label === "返回 Ash" ? 2.5 : 1.5) * 48);
            if (label !== "Ash 任务状态，点击展开或拖动") assert.ok(+b[4] - +b[2] > density * 200, "expanded native controls");
            shell("input", "tap", String((+b[1] + +b[3]) / 2), String(y)); return;
          }
          const xml = dump(); const nodes = xml.match(/<node\b[^>]+>/g) ?? [];
          const node = nodes.find((n) => n.includes(`text="${label}"`) || n.includes(`content-desc="${label}"`));
          assert.ok(node, `native control missing: ${label}`);
          const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
          assert.ok(b); shell("input", "tap", String((+b[1] + +b[3]) / 2), String((+b[2] + +b[4]) / 2));
        };
        const task = (mode, seconds) => `【${mode} SIM-STAY】先用 apps.open 打开时钟 com.google.android.deskclock。打开成功后，在你自己的容器内用 bash 执行 sleep ${seconds}，等命令完成再回复“测试完成”。不要返回 Ash，不要使用虚拟屏，不做其他操作。`;
        // The native transport can connect while a freshly updated DSH is still booting.
        const started = (after) => waitFor("real foreground task", async () => {
          const evidence = await rows(); await approveSettings(evidence, after);
          return foreground().includes("com.google.android.deskclock") && evidence.find((r) => r.seq > after && r.from === "agent:main" && r.kind === "request" &&
            r.word === "bash" && JSON.stringify(r.body).includes("sleep"));
        }, 300000);
        execFileSync(adb, ["shell", "appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow"]);
        execFileSync(adb, ["shell", "pm", "grant", pkg, "android.permission.POST_NOTIFICATIONS"]);
        let before = (await rows()).at(-1)?.seq ?? 0;
        if (process.argv[2] === "capsule") {
        await send("SIM-CAPSULE-RETURN", task("SIM-CAPSULE-RETURN", 35)); await started(before);
        await waitFor("floating capsule", visible); shot("collapsed");
        tapLabel("Ash 任务状态，点击展开或拖动");
        await waitFor("expanded window exposes controls", () => /Requested w=\d+ h=([4-9]\d\d|\d{4})/.test(capsuleWindow() ?? ""), 5000);
        shot("expanded");
        tapLabel("返回 Ash"); await waitFor("return Ash button", () => foreground().includes(`${pkg}/ai.ash.ui.HomeActivity`));
        await waitFor("hidden inside Ash", () => !visible());
        await turnEnd(before, "SIM-CAPSULE-RETURN"); console.log("CAPSULE return/expand/collapse passed");

        before = (await rows()).at(-1).seq;
        await send("SIM-CAPSULE-STOP", task("SIM-CAPSULE-STOP", 60)); await started(before);
        await waitFor("stop capsule", visible); tapLabel("Ash 任务状态，点击展开或拖动");
        await waitFor("expanded stop controls", () => /Requested w=\d+ h=([4-9]\d\d|\d{4})/.test(capsuleWindow() ?? ""), 5000);
        tapLabel("停止本次任务");
        const stopped = await turnEnd(before, "SIM-CAPSULE-STOP"); assert.equal(stopped.body.reason, "cancelled");
        shot("stopped"); await waitFor("completion dismiss", () => !visible());
        const stopRows = await rows(); assert.ok(stopRows.some((r) => r.word === "task.stop" && r.kind === "request" && r.from === "person:owner"));
        console.log("CAPSULE native stop passed");
        }

        execFileSync(adb, ["shell", "appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "deny"]);
        before = (await rows()).at(-1).seq;
        await send("SIM-CAPSULE-NOTICE", task("SIM-CAPSULE-NOTICE", 90)); await started(before);
        assert.equal(visible(), false);
        await waitFor("task notification", () => {
          const notification = shell("dumpsys", "notification", "--noredact");
          return notification.includes("ash.task") && notification.includes("停止本次任务");
        }, 15000);
        shell("cmd", "statusbar", "expand-notifications"); await sleep(800);
        // Low-priority notifications start collapsed; expand this task's row before its action.
        let notificationXml = dump();
        for (let expansion = 0; expansion < 3 && !notificationXml.includes('text="停止本次任务"'); expansion++) {
          const nodes = notificationXml.match(/<node\b[^>]+>/g) ?? [];
          const titleIndex = nodes.findIndex((n) => n.includes('text="Ash · '));
          assert.ok(titleIndex >= 0, "task notification title");
          // Group headers and child headers have different XML order. Match by vertical position.
          const nodeBounds = (n) => /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(n);
          const titleBounds = nodeBounds(nodes[titleIndex]); assert.ok(titleBounds);
          const center = (+titleBounds[2] + +titleBounds[4]) / 2;
          const expand = nodes.filter((n) => n.includes('resource-id="android:id/expand_button"'))
            .sort((a, b) => Math.abs((+nodeBounds(a)[2] + +nodeBounds(a)[4]) / 2 - center) -
              Math.abs((+nodeBounds(b)[2] + +nodeBounds(b)[4]) / 2 - center))[0];
          assert.ok(expand, "task/group expansion control");
          const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(expand);
          assert.ok(bounds);
          shell("input", "tap", String((+bounds[1] + +bounds[3]) / 2), String((+bounds[2] + +bounds[4]) / 2));
          await sleep(500); notificationXml = dump();
        }
        writeFileSync(`${output}/notification.xml`, notificationXml); shot("notification-fallback");
        tapLabel("停止本次任务");
        const noticeStopped = await turnEnd(before, "SIM-CAPSULE-NOTICE"); assert.equal(noticeStopped.body.reason, "cancelled");
        shell("cmd", "statusbar", "collapse");
        execFileSync(adb, ["shell", "appops", "set", pkg, "SYSTEM_ALERT_WINDOW", "allow"]);
        shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
        console.log("capsule simulator acceptance passed");
        writeFileSync(`${output}/${process.argv[2] === "capsule" ? "result" : "notification-result"}.json`, JSON.stringify({ package: pkg, at: new Date().toISOString(),
          realAndroid: true, realDsh: true, jev: "scripted", ...(process.argv[2] === "capsule" ? {
            expanded: true, returnButton: true, stopButton: true, completedHides: true } : {}),
          noOverlayNotification: true, notificationStop: true }, null, 2));
      } else if (process.argv[2] === "mask") {
        const output = `${homedir()}/ash-mini/task-capsule-evidence`;
        mkdirSync(output, { recursive: true });
        const visible = () => shell("dumpsys", "window", "windows").split(/(?=  Window #\d+ Window\{)/)
          .some((w) => w.includes("AshTaskCapsule") && w.includes("isVisible=true"));
        const before = (await rows()).at(-1)?.seq ?? 0;
        await send("SIM-CAPSULE-MASK", "【SIM-CAPSULE-MASK SIM-STAY】用 apps.open 打开时钟 com.google.android.deskclock，然后在自己的容器用 bash 执行 sleep 60。不要返回 Ash，不用虚拟屏，不做其他操作。");
        await waitFor("mask real task", async () => {
          const evidence = await rows(); await approveSettings(evidence, before);
          return visible() && evidence.some((r) => r.seq > before && r.from === "agent:main" && r.kind === "request" && r.word === "bash");
        }, 300000);
        const host = JSON.parse(shell("cat", `/data/user/0/${pkg}/files/ash/ash.json`)).host;
        execFileSync(adb, ["forward", "tcp:14764", "tcp:14764"]);
        const call = async (capability) => fetch("http://127.0.0.1:14764/call", { method: "POST", signal: AbortSignal.timeout(15000),
          headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", connection: "close" },
          body: JSON.stringify({ capability, args: {} }) }).then((r) => r.json());
        const tree = await call("screen.read"); assert.equal(tree.ok, true);
        assert.match(JSON.stringify(tree), /com.google.android.deskclock/);
        assert.doesNotMatch(JSON.stringify(tree), /Ash 任务状态|停止本次任务|返回 Ash/);
        await waitFor("capsule restored after read", visible, 5000);
        const seenScreen = await call("screen.see"); assert.equal(seenScreen.ok, true);
        const img = seenScreen.content.find((c) => c.type === "image"); assert.ok(img);
        writeFileSync(`${output}/agent-screen.jpg`, Buffer.from(img.data, "base64"));
        await waitFor("capsule restored after screenshot", visible, 5000);
        const evidence = await rows();
        const turn = evidence.findLast((r) => r.seq > before && r.from === "agent:main" && r.word === "turn.start")?.body.turn;
        assert.ok(turn);
        await fetch("http://127.0.0.1:14763/api/send", { method: "POST", headers: {
          authorization: `Bearer ${host.coreToken}`, "content-type": "application/json", connection: "close" }, body: JSON.stringify({
          to: "service:reflex", kind: "request", word: "task.stop", body: { turn }, client_id: `mask-stop-${turn}`, wait: true }) });
        const ended = await turnEnd(before, "SIM-CAPSULE-MASK"); assert.equal(ended.body.reason, "cancelled");
        shell("am", "start", "-n", `${pkg}/ai.ash.ui.HomeActivity`);
        writeFileSync(`${output}/mask-result.json`, JSON.stringify({ package: pkg, realAndroid: true, realDsh: true, jev: "scripted",
          screenReadExcludesCapsule: true, capsuleRestoresAfterRead: true, capsuleRestoresAfterScreenshot: true }, null, 2));
        console.log("capsule real-screen masking passed; inspect agent-screen.jpg for screenshot content");
      } else {
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
      assert.equal(stale.body.acted, false);
      // Focus loss may fence the effect as stale or cancel its host request as unavailable.
      // The behavioral invariant is stronger than either diagnostic: never reclaim the launcher.
      assert.ok(["stale", "unavailable"].includes(stale.body.skipped));
      assert.match(foreground(), /nexuslauncher|launcher/i);
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
      const output = `${homedir()}/ash-mini/task-capsule-evidence`;
      mkdirSync(output, { recursive: true });
      writeFileSync(`${output}/screen-decision-result.json`, JSON.stringify({ package: pkg, at: new Date().toISOString(),
        realAndroid: true, realDsh: true, jev: "scripted", returnToAsh: back.body,
        foregroundHandoff: stay.body, userFocusPrecedence: stale.body, remoteNoDecision: true }, null, 2));
      console.log("simulator acceptance passed");
      }
    } finally { ws.close(); }
  }
}
