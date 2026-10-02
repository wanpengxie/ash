import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

const install = process.env.ASH_TEST_DSH_ROOT;
test.skip(!install || !existsSync(join(install, "package.json")), "installed DSH required");

test("local settings toggles an installed DSH plugin through the production admin word", async ({ page }) => {
  test.setTimeout(60_000);
  const root = mkdtempSync(join(tmpdir(), "ash-plugin-ui-"));
  const home = join(root, "home");
  mkdirSync(home);
  let running;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: "http://127.0.0.1:1/anthropic",
      } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
    await page.goto(`${running.url}/?token=${token}`);
    await expect(page.locator("#connection")).toContainText("已连接", { timeout: 20_000 });
    await page.locator("#menu").click();
    await page.locator("#settingsPluginsLoad").click();
    await expect(page.locator("#settingsPluginsStatus")).toContainText("已读取");
    const row = page.locator('#settingsPluginsList .settings-plugin[data-plugin-id="include:tool-plugin-manager"]');
    await expect(row).toContainText("已停用");
    await row.getByRole("button", { name: "启用" }).click();
    await expect(row).toContainText("已启用");
    await expect(page.locator("#settingsPluginsStatus")).toHaveText("已更新插件。");
    const op = running.ledger.list({ limit: 1000 }).findLast((message) => message.to === "service:admin" && message.word === "plugins.op");
    expect(op?.body).toEqual({ op: "plugin", id: "include:tool-plugin-manager", enabled: true });
  } finally {
    await running?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
