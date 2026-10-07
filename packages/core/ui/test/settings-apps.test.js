import assert from "node:assert/strict";
import test from "node:test";
import { SettingsControls } from "../js/settings.js";
import { appState, appsSummary, needText } from "../js/settings-apps.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.listeners = new Map(); this.attributes = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { this.listeners.get("click")?.(); }
  find(id) { return this.id === id ? this : this.children.map((child) => child.find?.(id)).find(Boolean); }
  all() { return [this, ...this.children.flatMap((child) => child.all?.() ?? [])]; }
  get text() { return [this.textContent ?? "", ...this.children.map((child) => child.text ?? "")].join(""); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("an app's needs, state and the home line read in plain words", () => {
  assert.equal(needText({ member: "device:phone", words: ["health.read", "sensors.steps"], why: "读取你的健康数据" }), "· 读取你的健康数据（device:phone：health.read、sensors.steps）");
  assert.equal(needText({ notify: true, why: "体重变化较大时提醒你" }), "· 体重变化较大时提醒你（提醒你）");
  assert.equal(needText({ card: true, why: "每周一放一张小结卡片" }), "· 每周一放一张小结卡片（在对话里放入口卡片）");
  assert.equal(needText(null), "");
  assert.equal(appState({ granted: false }), "未授权");
  assert.equal(appState({ granted: true, enabled: false }), "已停用");
  assert.equal(appState({ granted: true, enabled: true, running: true }), "已启用 · 运行中");
  assert.equal(appsSummary([]), "还没有应用");
  assert.equal(appsSummary([{ granted: true, enabled: true }, { granted: false }]), "2 个应用 · 1 个已启用");
});

test("settings list the apps and install, disable, enable and revoke them through service:apps words", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const health = { id: "health", name: "健康", version: "1.0.1", summary: "体重、步数、睡眠", enabled: false, granted: false, running: false,
    needs: [{ member: "device:phone", words: ["health.read"], why: "读取你的健康数据" }, { notify: true, why: "提醒你" }] };
  const sent = [];
  const net = { token: "t", screen: "screen:local", currentScope: "s", localManagement: true,
    async request(path, init) {
      if (path !== "/api/send") return { ok: false };
      const message = JSON.parse(init.body);
      if (message.to !== "service:apps") return { ok: false };
      sent.push([message.word, message.body]);
      let result = {};
      if (message.word === "apps.list" || message.word === "apps.refresh") result = { apps: [{ ...health }] };
      if (message.word === "apps.install" || message.word === "apps.enable") Object.assign(health, { granted: true, enabled: true, running: true });
      if (message.word === "apps.disable") Object.assign(health, { enabled: false, running: false });
      if (message.word === "apps.revoke") Object.assign(health, { granted: false, enabled: false, running: false });
      return { ok: true, json: async () => ({ id: "m1", reply: { kind: "response", reply_to: "m1", from: message.to, to: "person:owner", word: message.word, body: { ok: true, result } } }) };
    } };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    settings.opened();
    await settle();
    assert.equal(panel.find("settingsAppsRow").sub.textContent, "1 个应用 · 都没启用");
    panel.find("settingsAppsRow").click();
    await settle();
    assert.equal(panel.find("settingsApps").hidden, false);
    const card = () => panel.find("settingsAppsList").children[0];
    const control = (word) => card().all().find((item) => item.attributes?.["data-app-word"] === word);
    assert.equal(card().attributes["data-app-id"], "health");
    assert.match(card().text, /未授权/);
    assert.match(card().text, /· 读取你的健康数据（device:phone：health.read）\n· 提醒你（提醒你）/);
    sent.length = 0;
    control("apps.install").click();
    await settle();
    assert.deepEqual(sent, [], "the first tap only says what installing allows");
    assert.equal(control("apps.install").textContent, "确认安装");
    control("apps.install").click();
    await settle();
    assert.deepEqual(sent[0], ["apps.install", { id: "health" }]);
    assert.match(card().text, /已启用 · 运行中/);
    assert.match(panel.find("settingsAppsStatus").textContent, /已安装「健康」/);
    control("apps.disable").click();
    await settle();
    assert.match(card().text, /已停用/);
    control("apps.enable").click();
    await settle();
    assert.match(card().text, /已启用/);
    sent.length = 0;
    control("apps.revoke").click();
    await settle();
    assert.deepEqual(sent, [], "taking back every grant takes a second tap");
    control("apps.revoke").click();
    await settle();
    assert.deepEqual(sent[0], ["apps.revoke", { id: "health" }]);
    assert.match(card().text, /未授权/);
    panel.find("settingsAppsRefresh").click();
    await settle();
    assert.equal(sent.at(-1)[0], "apps.refresh");
  } finally { delete globalThis.document; }
});
