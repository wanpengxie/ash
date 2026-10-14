import assert from "node:assert/strict";
import test from "node:test";
import { echoAgent, eventually, gateAsk, openPage, OWNER, requested, withBrowser } from "./support.js";
import { homeHub, openHome, sent } from "./home-support.js";

const turn = (kernel, id, { lane = "front", ids = [], tools = [], outcome = "completed", agent = "agent:main" } = {}) => {
  const event = (word, body) => kernel.append({ from: agent, kind: "event", word, turn: id, body: { turn: id, ...body } });
  event("turn.started", { lane, ids });
  for (const name of tools) { event("agent.tool", { name, phase: "start", summary: `在查 ${name.replace(/_/g, " ")}` }); event("agent.tool", { name, phase: "end", ok: true }); }
  if (outcome) event("turn.ended", { lane, outcome });
};
const screen = (page, name) => page.locator(`#home .hm-screen[data-page="${name}"]`);
const open = async (page, section, extra = {}) => { await openHome(page, { page: "home", section, ...extra }, `#home .hm-screen[data-page="${section}"]`); return screen(page, section); };

test(...withBrowser("devices: a pairing code is shown to the owner only, a request is approved, a device is removed", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const connect = await open(page, "connect");
  await connect.locator("#homePair").click();
  await connect.locator("#homePairText", { hasText: "粘贴下面这行命令" }).waitFor();
  assert.match(await connect.locator("#homePairCommand").textContent(), /^curl -fsSL https:\/\/github\.com\/.*install\.sh \| sh -s -- https:\/\/relay\.example ABCD-1234 SECRET-5678$/);
  assert.deepEqual(sent(kernel, "service:devices", "pair_start")[0].body.kind, "computer");
  hub.pairs = [{ pair_id: "pair1", state: "requested", kind: "computer", name: "我的电脑" }];
  await connect.locator("#homePairText", { hasText: "命令已运行" }).waitFor({ timeout: 8000 });
  const hands = await open(page, "hands");
  await hands.getByText("等你批准").waitFor();
  await hands.getByText("我的电脑").click();
  const pending = screen(page, "device");
  await pending.locator("#homePendingApprove").click();
  const device = `device:${"N".repeat(22)}`;
  assert.deepEqual(Object.keys(sent(kernel, "service:devices", "pair_approve")[0].body).sort(), ["body", "lend", "local_agents", "pair_id", "tier"]);
  await hands.getByText("我的电脑").waitFor();
  await hands.getByText("我的电脑").click();
  const one = screen(page, "device");
  await one.locator("#homeDeviceRevoke").click();
  assert.equal(sent(kernel, "service:devices", "revoke").length, 0, "removing takes two taps");
  await one.getByText(/需要重新配对才能连上/).waitFor();
  await one.locator("#homeDeviceRevoke").click();
  await eventually(() => hub.devices[0].revoked_at, "device removed");
  assert.equal(sent(kernel, "service:devices", "revoke")[0].body.device, device);
}));

test(...withBrowser("the relay: an existing one is used by address", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const connect = await open(page, "connect");
  await connect.locator("#homeRelayUrl").fill("https://relay.example");
  await connect.locator("#homeRelayUse").click();
  await eventually(() => hub.relay.configured, "relay set");
  assert.deepEqual(sent(kernel, "service:link", "gateway.use")[0].body, { url: "https://relay.example" });
  await connect.locator("#homeRelayResult", { hasText: "已设置中转站" }).waitFor();
}));

test(...withBrowser("apps (in a browser): the grid, one app's page, installing with a second tap, and stopping", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  await openHome(page, { page: "apps" }, '#home .hm-screen[data-page="apps"]');
  const apps = screen(page, "apps");
  await apps.getByText("1 个应用等你批准").waitFor();
  await apps.locator('[data-app-id="weather"]').click();
  const one = screen(page, "app");
  assert.doesNotMatch(await one.textContent(), /service:/, "what the app needs is told in words, not in members");
  await one.locator('[data-app-word="apps.install"]').click();
  assert.equal(kernel.requests.filter((r) => r.to === "service:apps" && r.word === "apps.install").length, 0);
  await one.locator('[data-app-word="apps.install"]', { hasText: "确认安装" }).click();
  await one.locator("[data-app-state]", { hasText: "已启用" }).waitFor();
  await one.locator('[data-app-word="apps.disable"]').click();
  await one.locator("[data-app-state]", { hasText: "已停用" }).waitFor();
  assert.deepEqual(kernel.requests.filter((r) => r.to === "service:apps" && r.word !== "apps.list").map((r) => r.word), ["apps.install", "apps.disable"]);
}));

test(...withBrowser("backstage: a key is saved and removed through the vault words and its text never comes back; the model and a plugin change; the spending is shown", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const keys = await open(page, "keys");
  await keys.locator("#homeKey_DEEPSEEK_API_KEY_value").fill("sk-test-secret-value");
  await keys.locator("#homeKey_DEEPSEEK_API_KEY_save").click();
  await keys.locator("#homeKey_DEEPSEEK_API_KEY_status", { hasText: "已验证可用" }).waitFor();
  assert.equal(hub.vault.has("DEEPSEEK_API_KEY"), true);
  assert.equal(await keys.locator("#homeKey_DEEPSEEK_API_KEY_value").inputValue(), "");
  const remove = keys.locator("#homeKey_DEEPSEEK_API_KEY_remove");
  await remove.click();
  assert.equal(hub.vault.has("DEEPSEEK_API_KEY"), true, "removing takes two taps");
  await remove.click();
  await eventually(() => !hub.vault.has("DEEPSEEK_API_KEY"), "key removed");
  assert.equal((await page.content()).includes("sk-test-secret-value"), false, "the page does not keep the key");
  const model = await open(page, "model");
  await model.locator("#homeModelName").fill("deepseek-reasoner");
  await model.locator("#homeModelProvider").fill("deepseek");
  await model.locator("#homeModelSave").click();
  await model.locator("#homeModelStatus", { hasText: "已保存" }).waitFor();
  assert.equal(hub.model, "deepseek-reasoner");
  const advanced = await open(page, "advanced");
  await advanced.getByText("她的扩展", { exact: true }).waitFor();
  assert.doesNotMatch(await advanced.textContent(), /DSH|@deepseek|dsh-/);
  await advanced.locator('[data-plugin-id="p1"] .sw').click();
  await eventually(() => hub.plugins[0].enabled === false, "plugin off");
  assert.deepEqual(sent(kernel, "service:admin", "plugins.op")[0].body, { op: "plugin", id: "p1", enabled: false });
  const usage = await open(page, "usage");
  await usage.getByText("近 7 天", { exact: true }).first().waitFor();
  await usage.getByText("快速判断").waitFor();
  await usage.getByText("账户余额：DeepSeek ¥12.50").waitFor();
  assert.equal(sent(kernel, "service:cost", "usage.get")[0].body.days, 7);
}));

test(...withBrowser("pause is at once; resume needs a second, explicit tap", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const backstage = await open(page, "backstage");
  await backstage.locator("#homePause").click();
  await backstage.getByText("已暂停").waitFor();
  assert.equal(hub.paused, true);
  await backstage.locator("#homeResume").click();
  assert.equal(sent(kernel, "service:admin", "resume").length, 0, "one tap only asks");
  await backstage.locator("#homeResumeYes").click();
  await backstage.getByText("已恢复").waitFor();
  assert.deepEqual(sent(kernel, "service:admin", "resume")[0].body, { confirmed: true });
  assert.equal(hub.paused, false);
}));

test(...withBrowser("a page that is not on the hub's machine gets the pages and the hub's refusal of the local-only words", async ({ kernel, browser }) => {
  homeHub(kernel);
  const { page } = await openPage(browser, kernel);
  const backstage = await open(page, "backstage");
  await backstage.getByText(/只能在她所在的手机上操作/).waitFor();
  await backstage.locator("#homePause").click();
  await backstage.getByText(/状态未确认/).waitFor();
}, { local: false }));

test(...withBrowser("an agent's own page is the same page with its letter, its waiting questions and its turns", async ({ kernel, browser }) => {
  homeHub(kernel);
  kernel.append({ id: "q2", from: "agent:xiaoyan", to: OWNER, kind: "request", word: "ask", body: { title: "资料放哪里？", human_kind: "question", expires_at: Date.now() + 3_600_000, options: [{ id: "a", label: "桌面" }] } });
  turn(kernel, "t_x", { agent: "agent:xiaoyan", tools: ["read"] });
  const { page } = await openPage(browser, kernel);
  await openHome(page, { page: "home", agent: "agent:xiaoyan" });
  const home = screen(page, "home");
  await home.locator("#homeName", { hasText: "小研" }).waitFor();
  await home.getByText("资料放哪里？").waitFor();
  assert.equal(await home.locator("#homeStatDone .hm-stat-n").textContent(), "1");
  assert.equal(await home.getByText("她记得你").count(), 0, "a helper has no memory page of its own");
}));

test(...withBrowser("the file list of her work directory opens a file in the reader", async ({ kernel, browser }) => {
  const hub = homeHub(kernel);
  hub.files.set("notes.txt", "第一行\n第二行");
  const { page } = await openPage(browser, kernel);
  const files = await open(page, "files");
  await files.getByText("notes.txt").click();
  await page.getByRole("dialog", { name: "文件", exact: true }).locator(".files-text").getByText("第二行").waitFor();
}));
