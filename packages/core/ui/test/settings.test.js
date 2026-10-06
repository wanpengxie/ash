import assert from "node:assert/strict";
import test from "node:test";
import { SettingsControls } from "../js/settings.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this.listeners = new Map(); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
  find(id) { return this.id === id ? this : this.children.map((child) => child.find(id)).find(Boolean); }
}

test("Android settings configure the gateway privately and clear the one-time secret", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "https://appassets.androidplatform.net" };
  const calls = [];
  globalThis.__ashGatewayConfig = async (operation, url, secret) => {
    calls.push({ operation, url, secret });
    return { ok: true, configured: true, url: "https://ash.example.test" };
  };
  try {
    const panel = new Element("div");
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request() { throw new Error("Gateway bootstrap secret must not use /api/send"); } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    const url = panel.find("settingsGatewayUrl");
    const secret = panel.find("settingsGatewaySecret");
    url.value = " https://ash.example.test ";
    secret.value = " one-time-test-secret ";
    panel.find("settingsGatewaySave").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secret.value, "");
    assert.deepEqual(calls, [{ operation: "save", url: "https://ash.example.test", secret: "one-time-test-secret" }]);
    assert.match(panel.find("settingsGatewayConfigStatus").textContent, /网关已保存/);
    settings.network("offline");
    assert.equal(panel.find("settingsGatewayUrl"), undefined);
  } finally {
    delete globalThis.document; delete globalThis.location; delete globalThis.__ashGatewayConfig;
  }
});

test("settings hide management on old, remote, malformed, or disconnected registration", () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const net = { token: "screen-token", localManagement: false, sendAdmin: async () => ({ ok: false }) };
    const settings = new SettingsControls(panel, net);
    settings.registration({}); settings.network("online");
    assert.equal(panel.find("settingsAdmin"), undefined);
    settings.registration({ local_management: false });
    assert.equal(panel.find("settingsAdmin"), undefined);
    settings.registration({ local_management: "true" });
    assert.equal(panel.find("settingsAdmin"), undefined);
    net.localManagement = true;
    settings.registration({ local_management: true });
    assert.ok(panel.find("settingsAdmin"));
    settings.network("offline");
    assert.equal(panel.find("settingsAdmin"), undefined);
  } finally { delete globalThis.document; }
});

test("resume requires a second explicit click and never labels an unpaired result as success", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    let calls = 0;
    let result = { ok: false, reason: "HTTP 403" };
    const net = { token: "screen-token", localManagement: true, async sendAdmin(word) { calls++; assert.equal(word, "resume"); return result; } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsResume").click();
    assert.equal(calls, 0);
    assert.equal(panel.find("settingsResumeConfirmation").hidden, false);
    panel.find("settingsResumeYes").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(panel.find("settingsFeedback").textContent, /未确认/);
    result = { ok: true, paused: false };
    panel.find("settingsResume").click();
    panel.find("settingsResumeYes").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsFeedback").textContent, "已恢复 Ash");
  } finally { delete globalThis.document; }
});

test("quiet hours load and save only after a paired local settings reply", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const sent = [];
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word,
          body: { ok: true, result: { delivery: { quiet: wire.word === "settings.get" ? "22:00-08:00" : wire.body.delivery.quiet } } } } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsQuietRow").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsQuietStart").value, "22:00");
    assert.equal(panel.find("settingsQuietEnd").value, "08:00");
    panel.find("settingsQuietStart").value = "23:00";
    panel.find("settingsQuietSave").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((item) => [item.word, item.body]), [
      ["settings.get", {}], ["settings.set", { delivery: { quiet: "23:00-08:00" } }]]);
    assert.equal(panel.find("settingsQuietStatus").textContent, "已保存免打扰时段。");
    assert.equal(panel.find("settingsQuietRow").sub.textContent, "每天 23:00 到 08:00 不主动找你");
    settings.network("offline");
    assert.equal(panel.find("settingsQuiet"), undefined);
  } finally { delete globalThis.document; }
});

test("the approval page shows the two modes, saves a choice only after a paired reply, and the row says which is on", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const sent = [];
    let confirm = true;
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        const result = wire.word === "settings.get" ? { delivery: { quiet: "22:00-08:00" }, approval: { mode: "auto" } }
          : { approval: { mode: confirm ? wire.body.approval.mode : "auto" } };
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word, body: { ok: true, result } } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsApprovalRow").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsApproval_auto").children[1].textContent, "✓");
    assert.equal(panel.find("settingsApproval_always").children[1].textContent, "");
    assert.match(panel.find("settingsApproval_auto").children[0].children[1].textContent, /先问你/);
    panel.find("settingsApproval_always").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((item) => [item.word, item.body]), [["settings.get", {}], ["settings.set", { approval: { mode: "always" } }]]);
    assert.equal(panel.find("settingsApproval_always").children[1].textContent, "✓");
    assert.equal(panel.find("settingsApprovalRow").sub.textContent, "每次都问");
    assert.equal(panel.find("settingsApprovalStatus").textContent, "已保存。");
    confirm = false;
    panel.find("settingsApproval_always").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsApprovalStatus").textContent, "保存未确认，请重试。");
  } finally { delete globalThis.document; }
});

test("local settings switches an installed DSH plugin and refreshes its actual state", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    let enabled = false;
    const sent = [];
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        if (wire.word === "plugins.op") enabled = wire.body.enabled;
        const result = wire.word === "plugins.list"
          ? { plugins: [{ entryId: "include:sample", moduleName: "sample", enabled }] }
          : { application: "applied", changed: true };
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word, body: { ok: true, result } } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsDevRow").click();
    await new Promise((resolve) => setImmediate(resolve));
    const state = () => panel.find("settingsPluginsList").children[0].children[0].children.map((item) => item.textContent).join(" · ");
    assert.equal(state(), "sample · 已停用");
    panel.find("settingsPluginsList").children[0].children[1].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state(), "sample · 已启用");
    assert.deepEqual(sent.filter((item) => item.word !== "settings.get").map((item) => [item.word, item.body]), [
      ["plugins.list", {}], ["plugins.op", { op: "plugin", id: "include:sample", enabled: true }], ["plugins.list", {}]]);
    settings.network("offline");
    assert.equal(panel.find("settingsPlugins"), undefined);
  } finally { delete globalThis.document; }
});

test("local settings saves the DSH main-model choice and reports restart", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const sent = [];
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        const result = wire.word === "settings.get"
          ? { model: { provider: "deepseek", model: "deepseek-chat" } }
          : { ...wire.body, restart_required: true };
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word, body: { ok: true, result } } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsDevRow").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsModelName").value, "deepseek-chat");
    panel.find("settingsModelName").value = "deepseek-reasoner";
    panel.find("settingsModelSave").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.filter((item) => item.word !== "plugins.list").map((item) => [item.word, item.body]), [
      ["settings.get", {}], ["model.set", { provider: "deepseek", model: "deepseek-reasoner" }]]);
    assert.equal(panel.find("settingsModelStatus").textContent, "已保存；重启 Ash 后主模型生效。");
  } finally { delete globalThis.document; }
});

test("local gateway controls approve a pending device and revoke an existing device", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const sent = [];
    let pending = true, device = true;
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        if (wire.word === "gateway.op" && wire.body.op === "approve") pending = false;
        if (wire.word === "gateway.op" && wire.body.op === "revoke") device = false;
        const result = wire.word === "gateway.state"
          ? { configured: true, connected: true,
            pending: pending ? [{ request_id: "request-1", name: "Phone", fingerprint: "abc" }] : [],
            devices: device ? [{ id: "device:laptop", name: "Laptop", online: true }] : [] }
          : { approved: true, revoked: true };
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word, body: { ok: true, result } } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsGatewayRow").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsGatewayList").children.length, 2);
    panel.find("settingsGatewayList").children[0].children[1].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsGatewayList").children.length, 1);
    const revoke = panel.find("settingsGatewayList").children[0].children[1];
    revoke.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.filter((item) => item.body.op === "revoke").length, 0, "one tap only says what removing does");
    assert.match(panel.find("settingsGatewayStatus").textContent, /重新配对/);
    revoke.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsGatewayList").children.length, 0);
    assert.deepEqual(sent.map((item) => [item.word, item.body]), [
      ["gateway.state", {}],
      ["gateway.op", { op: "approve", request_id: "request-1", permissions: ["chat", "web_ui", "expose_capability"] }],
      ["gateway.state", {}], ["gateway.op", { op: "revoke", device: "device:laptop" }], ["gateway.state", {}]]);
  } finally { delete globalThis.document; }
});

test("local gateway controls show a one-time pairing code with where to use it", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const sent = [];
    let fail = false;
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request(_path, init) {
        const wire = JSON.parse(init.body);
        sent.push(wire);
        const body = fail ? { ok: false, error: { code: "failed", message: "gateway operation failed" } }
          : { ok: true, result: { ticket: "pair-XYZ-123", expires_in: 300, gateway: "https://gw.example" } };
        return new Response(JSON.stringify({ id: "request-1", reply: { kind: "response", reply_to: "request-1",
          from: "service:admin", to: "person:owner", word: wire.word, body } }), { status: 200 });
      } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsGatewayPair").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.map((item) => [item.word, item.body]), [["gateway.op", { op: "ticket" }]]);
    const shown = panel.find("settingsGatewayPairResult").textContent;
    assert.match(shown, /pair-XYZ-123/);
    assert.match(shown, /5 分钟/);
    assert.match(shown, /https:\/\/gw\.example/);
    fail = true;
    panel.find("settingsGatewayPair").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(panel.find("settingsGatewayPairResult").textContent, /生成失败/);
    assert.doesNotMatch(panel.find("settingsGatewayPairResult").textContent, /pair-XYZ-123/);
  } finally { delete globalThis.document; }
});

test("Android settings clear every browser login only after a second tap", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "https://appassets.androidplatform.net" };
  let cleared = 0, ok = true;
  globalThis.__ashBrowserLogins = async () => { cleared++; return { ok }; };
  try {
    const panel = new Element("div");
    const net = { token: "screen-token", screen: "screen:local", currentScope: "owner-scope", localManagement: true,
      async request() { throw new Error("browser logins must not use /api/send"); } };
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    const button = panel.find("settingsBrowserClear");
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 0, "one tap only asks");
    assert.match(button.textContent, /再点一次/);
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 1);
    assert.match(panel.find("settingsBrowserStatus").textContent, /已清除/);
    ok = false;
    button.click(); button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cleared, 2);
    assert.match(panel.find("settingsBrowserStatus").textContent, /清除失败/);
  } finally { delete globalThis.document; delete globalThis.location; delete globalThis.__ashBrowserLogins; }
});

test("outside the Android app there is no browser-login control", () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, { token: "t", screen: "screen:local", currentScope: "s", localManagement: true, async request() { return new Response("{}"); } });
    settings.registration({ local_management: true }); settings.network("online");
    assert.equal(panel.find("settingsBrowserClear"), undefined);
  } finally { delete globalThis.document; }
});

test("settings show usage by period and part of Ash, and an unreadable balance is not shown as zero", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "http://127.0.0.1" };
  const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
  const summary = { estimated: true, periods: { today: { ...zero, calls: 3, cost_usd: 0.0042, input_tokens: 12000, unpriced_calls: 1 }, "7d": { ...zero, calls: 9, cost_usd: 1.5 }, "30d": zero },
    by_scope: [{ ...zero, scope: "chat", calls: 7, cost_usd: 1.2 }, { ...zero, scope: "background", calls: 2, cost_usd: 0.3 }] };
  const seen = [];
  const net = { token: "t", screen: "screen:local", currentScope: "s", localManagement: true,
    async request(_path, init) {
      const sent = JSON.parse(init.body); seen.push(sent.word);
      const body = sent.word === "usage.get" ? { ok: true, result: summary } : { ok: false, error: { code: "failed", message: "HTTP 401" } };
      return { ok: true, json: async () => ({ id: "m1", reply: { kind: "response", reply_to: "m1", from: sent.to, to: "person:owner", word: sent.word, body } }) };
    } };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    panel.find("settingsUsageCard").click();
    for (let i = 0; i < 50 && !panel.find("settingsUsageBalance")?.textContent; i++) await new Promise((resolve) => setImmediate(resolve));
    const text = (item) => item.children.length ? item.children.map(text).join("|") : item.textContent ?? "";
    const table = panel.find("settingsUsageTable").children.flatMap((box) => box.children.at(-1).children.map(text));
    assert.match(table[0], /^今天\|3 次调用 · 输入 12\.0k.*另有 1 次没有价格\|¥0\.03$/);
    assert.match(table[1], /^近 7 天\|9 次调用.*\|¥10\.11$/);
    assert.match(table[2], /¥0\.00$/);
    assert.ok(table.some((row) => /^对话\|.*¥8\.09$/.test(row)) && table.some((row) => /^后台任务\|.*¥2\.02$/.test(row)));
    assert.equal(panel.find("settingsUsageCard").children[1].textContent, "¥0.03");
    assert.deepEqual(seen.slice(0, 2), ["usage.get", "balance.get"]);
    assert.match(panel.find("settingsUsageBalance").textContent, /读不到（不是零）/);
    assert.match(panel.find("settingsUsageStatus").textContent, /估算/);
    assert.match(panel.find("settingsUsageStatus").textContent, /1 美元 ≈ 6\.74 元固定换算/);
  } finally { delete globalThis.document; delete globalThis.location; }
});


test("the vault section saves and removes keys through the owner route, clears the field, and shows only saved or not", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "http://127.0.0.1" };
  const calls = [];
  const saved = new Set();
  const net = { token: "t", screen: "screen:local", currentScope: "s", localManagement: true,
    async request(path, init) {
      calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, token: init.headers["x-ash-screen"] ?? init.headers["X-Ash-Screen"] });
      if (init.method === "PUT") saved.add(path.split("/").pop());
      if (init.method === "DELETE") saved.delete(path.split("/").pop());
      const body = init.method === "GET" ? { entries: ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"].map((ref) => ({ ref, label: ref, kind: "model", configured: saved.has(ref) })) } : { ok: true };
      return { ok: true, json: async () => body };
    } };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    const wait = async (check) => { for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setImmediate(resolve)); };
    const status = () => panel.find("settingsVault_DEEPSEEK_API_KEY_status").textContent;
    panel.find("settingsVaultRow").click();
    await wait(() => /还没有保存/.test(status()));
    assert.match(status(), /还没有保存.*无法对话/);
    const row = panel.find("settingsVault_DEEPSEEK_API_KEY");
    const field = panel.find("settingsVault_DEEPSEEK_API_KEY_value");
    field.value = "  sk-vault-test  ";
    const actions = row.children.at(-1);
    actions.children.find((item) => item.textContent === "保存").click();
    await wait(() => /^已保存/.test(status()));
    assert.equal(field.value, "");
    assert.match(status(), /^已保存/);
    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual([put.path, put.body], ["/api/vault/DEEPSEEK_API_KEY", { value: "sk-vault-test" }]);
    assert.doesNotMatch(JSON.stringify(panel), /sk-vault-test/);
    const remove = actions.children.find((item) => item.textContent === "移除");
    assert.equal(remove.hidden, false);
    remove.click();
    assert.match(status(), /^移除后，Ash 无法对话/);
    assert.ok(!calls.some((call) => call.method === "DELETE"), "one tap only says what removing does");
    remove.click();
    await wait(() => /还没有保存/.test(status()));
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/api/vault/DEEPSEEK_API_KEY"));
  } finally { delete globalThis.document; delete globalThis.location; }
});

test("an unavailable Android vault is explained and cannot be changed from settings", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "http://127.0.0.1" };
  const calls = [];
  const net = { token: "t", screen: "screen:local", currentScope: "s", localManagement: true,
    async request(path, init) {
      calls.push({ path, method: init.method });
      return { ok: true, json: async () => ({ entries: [], available: false }) };
    } };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    const wait = async (check) => { for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setImmediate(resolve)); };
    panel.find("settingsVaultRow").click();
    const status = panel.find("settingsVault_DEEPSEEK_API_KEY_status");
    await wait(() => /安全存储暂时不可用/.test(status.textContent));
    const field = panel.find("settingsVault_DEEPSEEK_API_KEY_value");
    const actions = panel.find("settingsVault_DEEPSEEK_API_KEY").children.at(-1);
    const save = actions.children.find((item) => item.textContent === "保存");
    const remove = actions.children.find((item) => item.textContent === "移除");
    assert.match(status.textContent, /原有密钥未被读取或修改/);
    assert.equal(field.disabled, true);
    assert.equal(save.disabled, true);
    assert.equal(remove.disabled, true);
    field.value = "sk-must-not-save";
    save.click(); remove.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
  } finally { delete globalThis.document; delete globalThis.location; }
});

test("opening settings reads what each row should say: quiet hours, pause, keys, devices and today's spend", async () => {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "http://127.0.0.1" };
  const zero = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, unpriced_calls: 0 };
  const results = {
    "settings.get": { delivery: { quiet: "22:00-07:30" }, paused: true },
    "usage.get": { periods: { today: { ...zero, cost_usd: 0.12 }, "7d": { ...zero, cost_usd: 1.5 }, "30d": { ...zero, cost_usd: 4 } }, by_scope: [] },
    "gateway.state": { configured: true, connected: true, devices: [{ id: "device:a", name: "A" }], pending: [{ request_id: "r", name: "B" }] },
  };
  const net = { token: "t", screen: "screen:local", currentScope: "s", localManagement: true,
    async request(path, init) {
      if (path === "/api/vault") return { ok: true, json: async () => ({ entries: [{ ref: "DEEPSEEK_API_KEY", configured: false }, { ref: "OPENROUTER_API_KEY", configured: true }] }) };
      const sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "m1", reply: { kind: "response", reply_to: "m1", from: sent.to, to: "person:owner", word: sent.word, body: { ok: true, result: results[sent.word] } } }) };
    } };
  try {
    const panel = new Element("div");
    const settings = new SettingsControls(panel, net);
    settings.registration({ local_management: true }); settings.network("online");
    settings.opened();
    for (let i = 0; i < 50 && panel.find("settingsUsageCard").children[1].textContent === "—"; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(panel.find("settingsQuietRow").sub.textContent, "每天 22:00 到 07:30 不主动找你");
    assert.equal(panel.find("settingsPause").hidden, true);
    assert.equal(panel.find("settingsResume").hidden, false);
    assert.equal(panel.find("settingsVaultRow").sub.textContent, "DeepSeek Key 未设置 · OpenRouter Key 已保存");
    assert.equal(panel.find("settingsVaultRow").sub.className, "set-sub warn");
    assert.equal(panel.find("settingsGatewayRow").sub.textContent, "1 台设备 · 1 个等你批准");
    assert.equal(panel.find("settingsUsageCard").children[1].textContent, "¥0.81");
    settings.setName("小灰");
    assert.equal(panel.find("settingsPause").textContent, "暂停 小灰");
  } finally { delete globalThis.document; delete globalThis.location; }
});
