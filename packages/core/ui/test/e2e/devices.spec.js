import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

test("device settings separates browser grants, edits computer grants and confirms removal", async ({ page }, testInfo) => {
  const running = await startOwner({ stateDir: mkdtempSync(join(tmpdir(), "ash-device-ui-")), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
  const sent = []; let pending = [{ request_id: "ui-pair", name: "New browser", fingerprint: "ABCD-1234" }];
  let devices = [{ id: "device:pc", name: "My computer", kind: "laptop", online: true, access: "approval", local_agents: false, web_ui: false, capabilities: 8 }];
  // Controlled device transport; the production UI and screen registration are real.
  await page.route("**/api/send", async route => {
    const wire = route.request().postDataJSON();
    if (wire.to !== "service:devices") return route.continue();
    sent.push(wire);
    if (wire.word === "pair_approve") pending = [];
    if (wire.word === "access_set") devices[0] = { ...devices[0], ...wire.body };
    if (wire.word === "rename") devices[0].name = wire.body.name;
    if (wire.word === "revoke") devices = [];
    const result = wire.word === "gateway_status" ? { configured: true, connected: true, pending, devices }
      : wire.word === "diagnose" ? devices[0] : { updated: true };
    await route.fulfill({ json: { id: "ui-result", reply: { kind: "response", reply_to: "ui-result", from: "service:devices", to: "person:owner", word: wire.word, body: { ok: true, result } } } });
  });
  try {
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto(`${running.url}/?token=${token}`);
    await expect(page.locator("#connection")).toContainText("已连接");
    await page.locator("#menu").click(); await page.locator("#settingsGatewayRow").click();
    await expect(page.locator("#settingsGatewayList")).toContainText("ABCD-1234");
    await page.locator('[id="settingsPending-ui-pairKind"]').selectOption("browser");
    await expect(page.locator('[id="settingsPending-ui-pairAccess"]')).toBeDisabled();
    await expect(page.locator('[id="settingsPending-ui-pairAgents"]')).not.toBeChecked();
    await expect(page.locator('[id="settingsPending-ui-pairWeb"]')).toBeChecked();
    await page.locator('[id="settingsPending-ui-pairApprove"]').click();
    await expect(page.locator("#settingsGatewayList")).not.toContainText("ABCD-1234");
    expect(sent.find(w => w.word === "pair_approve").body).toEqual({ request_id: "ui-pair", kind: "browser", access: "approval", local_agents: false, web_ui: true });
    await page.getByText("名称、权限与诊断", { exact: true }).click();
    await page.locator('[id="settingsDevice-device:pcAccess"]').selectOption("full");
    await page.locator('[id="settingsDevice-device:pcAgents"]').check();
    await page.getByRole("button", { name: "保存权限", exact: true }).click();
    await expect.poll(() => sent.find(w => w.word === "access_set")?.body).toEqual({ device: "device:pc", access: "full", local_agents: true, web_ui: false });
    await page.getByText("名称、权限与诊断", { exact: true }).click();
    await expect(page.locator('[id="settingsDevice-device:pcAgents"]')).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("device-settings.png"), fullPage: true });
    await page.getByRole("button", { name: "移除", exact: true }).click();
    expect(sent.some(w => w.word === "revoke")).toBe(false);
    await page.getByRole("button", { name: "确定移除？", exact: true }).click();
    await expect(page.locator("#settingsGatewayStatus")).toContainText("还没有连接其他设备");
  } finally { await running.close(); }
});
