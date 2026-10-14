import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HELPER, appState, appBroken, appTrouble, isSystemEntry, SYSTEM_FILES, SYSTEM_FOLDERS, pluginName, providerName, appsSummary, balanceSentence, deviceDiagnosis, keyProblems, keyStateText, quietOf, relayText } from "../js/home-text.js";

const dev = (letter) => `device:${letter.repeat(22)}`;

const health = (provider, status, extra = {}) => ({ provider, ref: provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY", configured: true, status, ...extra });

test("key words for the owner: verified, refused with the reason, not verified; and the refused ones become problems", () => {
  assert.equal(keyStateText(health("deepseek", "ok", { checked_at: 1 })), "已保存，已验证可用。");
  assert.equal(keyStateText(health("openrouter", "rejected", { reason: "已过期" })), "已失效（已过期），请换一把新的 Key。");
  assert.equal(keyStateText(health("openrouter", "rejected")), "已失效（无效），请换一把新的 Key。");
  assert.equal(keyStateText(health("deepseek", "unknown", { reason: "连不上服务商" })), "已保存，暂时没验证上（连不上服务商）。");
  assert.equal(keyStateText(health("deepseek", "unknown")), "已保存，暂时没验证上。");
  assert.equal(keyStateText(health("deepseek", "low_balance", { reason: "余额不足" })), "已验证，但余额不足，她暂时无法对话。");
  assert.equal(keyStateText(undefined), "已保存。", "the hub could not be asked: no claim either way");
  assert.deepEqual(keyProblems([health("deepseek", "rejected", { reason: "无效" }), health("openrouter", "rejected", { reason: "已过期" })]), [
    "对话模型的 DeepSeek Key 已失效（无效），她暂时无法对话。", "快速判断的 OpenRouter Key 已失效（已过期），快速判断只能靠关键词。"]);
  assert.deepEqual(keyProblems([health("deepseek", "low_balance", { reason: "余额不足" }), health("openrouter", "ok")]), ["对话模型的 DeepSeek 账户余额不足，她暂时无法对话。"]);
  assert.deepEqual(keyProblems([health("deepseek", "ok"), health("openrouter", "unknown"), { ...health("openrouter", "rejected"), configured: false }]), []);
  assert.deepEqual(keyProblems(undefined), []);
});


test("a device's diagnosis reads as plain words, not a raw record", () => {
  const device = { device: dev("P"), name: "PC", online: true, via: "gateway" };
  assert.equal(deviceDiagnosis({ device, connections: [{}, {}], diagnosis: { ok: true, findings: [] } }), "在线（经中转站）。\n现在有 2 条连接。\n没有发现问题。");
  assert.equal(deviceDiagnosis({ device, diagnosis: { ok: false, findings: [{ code: "a", message: "没有回应" }, { code: "b", message: "版本太旧" }] } }), "在线（经中转站）。\n发现这些问题：\n· 没有回应\n· 版本太旧");
  assert.doesNotMatch(deviceDiagnosis({}), /[{}"]|undefined/);
  assert.equal(deviceDiagnosis({}), "离线。");
});

test("the relay, the setup state and the balances read in plain words", () => {
  assert.equal(relayText({ configured: false, connected: false }), "还没有设置中转站，其他设备暂时连不上。");
  assert.equal(relayText({ configured: true, connected: true, url: "https://r.test" }), "中转站已连接（https://r.test）。");
  assert.match(relayText({ configured: true, connected: false, last_error: "timed out" }), /暂时连不上：timed out/);
  assert.equal(balanceSentence({ balances: [] }), "账户余额：无数据");
  assert.equal(balanceSentence({ balances: [{ provider: "openrouter", balance: { available: false, balances: [{ currency: "USD", total: "3" }] } }] }), "账户余额：OpenRouter 约 ¥20.22（账户当前不可用）");
});

test("an app's state and the line for the apps read in plain words", () => {
  assert.equal(appState({ granted: false }), "未授权");
  assert.equal(appState({ granted: true, enabled: false }), "已停用");
  assert.equal(appState({ granted: true, enabled: true, running: true }), "已启用 · 运行中");
  assert.equal(appState({ granted: true, enabled: true }), "已启用 · 还没运行起来");
  assert.equal(appState({ granted: false, problem: "manifest", error: "app.json: x" }), "出错了");
  assert.equal(appsSummary([]), "还没有应用");
  assert.equal(appsSummary([{ granted: true, enabled: true }, { granted: false }]), "2 个应用 · 1 个已启用");
});

test("quiet hours: a missing key means the default, an empty one means none, a malformed one cannot be read", () => {
  assert.equal(quietOf({}), "21:30-09:00");
  assert.equal(quietOf({ "delivery.quiet_hours": "" }), "");
  assert.equal(quietOf({ "delivery.quiet_hours": "22:00-08:30" }), "22:00-08:30");
  assert.equal(quietOf({ "delivery.quiet_hours": "later" }), null);
});

test("plugin names, providers and her settings files read the way the page says them", () => {
  assert.equal(pluginName("@deepseek-ai/dsh-plugin-manager/tools"), "manager tools");
  assert.equal(pluginName("@deepseek-ai/dsh-llm"), "llm");
  assert.equal(pluginName("cordis:include"), "cordis include");
  assert.equal(providerName("deepseek-chat"), "DeepSeek");
  assert.equal(providerName("some-new-model"), "some-new-model");
  assert.equal(providerName(undefined), "");
  const file = (name) => ({ name, type: "file" });
  assert.ok(["AGENTS.md", "identity.md", "SOUL.md", "PULSE.md", "USER.md", "MEMORY.md", "PROACTIVE.md", ".hidden"].every((name) => isSystemEntry(file(name))));
  assert.ok(["装备清单.xlsx", "notes.md", "README.md", "SPEC.md", "ACCEPTANCE.md"].every((name) => !isSystemEntry(file(name))), "documents for a job stay");
  assert.ok(isSystemEntry({ name: "memory", type: "directory" }) && isSystemEntry({ name: "skills", type: "directory" }));
  assert.ok(!isSystemEntry({ name: "reports", type: "directory" }) && !isSystemEntry({ name: "memory", type: "file" }));
  assert.equal(HELPER, "一个帮手");
});

test("an app whose app.json is broken is not one that wants in, and its trouble is told in plain words, not the hub's line", () => {
  const bad = { granted: false, problem: "manifest", error: "app.json: 不是合法的 JSON：Unexpected token" };
  assert.equal(appBroken(bad), true);
  assert.equal(appBroken({ granted: false, error: "app.json: x" }), true, "an older hub gave no kind");
  assert.equal(appBroken({ granted: true, enabled: true, error: "start failed: x" }), false);
  assert.equal(appBroken({ granted: false }), false);
  assert.match(appTrouble(bad), /说明文件写得不对，装不了/);
  assert.match(appTrouble({ ...bad, granted: true }), /说明文件写得不对，打不开.*收回全部权限/);
  assert.match(appTrouble({ granted: true, problem: "folder", error: "x" }), /文件夹已经不在了/);
  assert.match(appTrouble({ granted: true, enabled: true, error: "start failed: ENOENT" }), /没能正常跑起来/);
  assert.equal(appTrouble({ granted: true }), null);
  for (const app of [bad, { ...bad, granted: true }]) assert.doesNotMatch(appTrouble(app), /app\.json|JSON|Unexpected/);
});

test("the system's files named here are the ones the hub's sources name", () => {
  const read = (path) => readFileSync(new URL(`../../core/src/${path}`, import.meta.url), "utf8");
  const baseline = /BASELINE_FILE = "([^"]+)"/.exec(read("edges/agents/dsh/driver.ts"))?.[1];
  const persona = [.../PERSONA_FILES = \[([^\]]+)\]/.exec(read("services/semantic/persona.ts"))[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const pulse = /GUIDANCE = "([^"]+)"/.exec(read("services/semantic/pulse.ts"))?.[1];
  const memory = [...read("edges/agents/modules.ts").matchAll(/this\.text\("([A-Z]+\.md)"\)/g)].map((m) => m[1]);
  for (const name of [baseline, ...persona, pulse, ...memory]) assert.ok(SYSTEM_FILES.includes(name), `${name} is written or read by the hub but is not in SYSTEM_FILES`);
  assert.deepEqual([...memory].sort(), ["MEMORY.md", "USER.md"]);
  assert.ok(read("edges/agents/modules.ts").includes('path: "skills"') && SYSTEM_FOLDERS.includes("skills"));
  assert.ok(read("services/semantic/daily.ts").includes("memory/YYYY-MM-DD.md") && SYSTEM_FOLDERS.includes("memory"));
});
