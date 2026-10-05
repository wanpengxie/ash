import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

let running, home, token;
test.beforeAll(async () => {
  const state = mkdtempSync(join(tmpdir(), "ash-files-ui-"));
  home = join(state, "work"); mkdirSync(join(home, "reports"), { recursive: true });
  writeFileSync(join(home, "reports", "说明 一.md"), "# 我的报告\n\n**文件内容**\n\n[网页](./index.html)");
  writeFileSync(join(home, "reports", "style.css"), "h1 { color: rgb(12, 34, 56); }");
  writeFileSync(join(home, "reports", "index.html"), '<!doctype html><link rel="stylesheet" href="style.css"><h1>HTML 报告</h1><script>parent.window.fileEscape=true; fetch("/api/describe")</script>');
  writeFileSync(join(home, "data.pdf"), Buffer.from([0, 255, 1, 128, 42]));
  running = await startOwner({ stateDir: state, workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  token = Object.entries(running.tokens.api).find(([, id]) => id === "person:owner")[0];
});
test.afterAll(async () => { await running?.close(); });

test("long directory titles stay on one line on a phone", async ({ page }) => {
  const folder = "reader-demo-1791228693692-long-directory-name";
  mkdirSync(join(home, folder), { recursive: true });
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto(`${running.url}/?token=${token}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator(".files-row").filter({ hasText: folder }).click();
  const title = page.locator(".files-bar strong");
  await expect(title).toHaveText(folder);
  expect((await title.boundingBox()).height).toBeLessThan(32);
  expect(await page.locator(".files-bar").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
});

test("file area, Markdown message links and relative document links open one live reader; download preserves bytes", async ({ page }) => {
  await page.goto(`${running.url}/?token=${token}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false },
    { to: "person:owner", kind: "request", word: "say", body: { text: `[查看报告](<${home}/reports/说明 一.md>)`, kind: "reply" }, wait: true });
  await page.getByRole("link", { name: "查看报告" }).click();
  const reader = page.getByRole("dialog", { name: "文件", exact: true });
  await expect(reader.getByRole("heading", { name: "我的报告" })).toBeVisible();
  await reader.getByRole("link", { name: "网页" }).click();
  const frame = page.frameLocator(".files-html");
  await expect(frame.locator("h1")).toHaveText("HTML 报告");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(12, 34, 56)");
  expect(await page.evaluate(() => window.fileEscape)).toBeUndefined();
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await reader.getByRole("button", { name: "data.pdf" }).click();
  await expect(reader).toContainText("暂未接入内置阅读器");
  const pending = page.waitForEvent("download");
  await reader.getByRole("button", { name: "下载", exact: true }).click();
  const download = await pending;
  expect(readFileSync(await download.path())).toEqual(Buffer.from([0, 255, 1, 128, 42]));
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  writeFileSync(join(home, "reports", "说明 一.md"), "# 修改后的文件");
  await page.getByRole("link", { name: "查看报告" }).click();
  await expect(reader.getByRole("heading", { name: "修改后的文件" })).toBeVisible();
  await reader.getByRole("button", { name: "关闭", exact: true }).click();
  unlinkSync(join(home, "reports", "说明 一.md"));
  await page.getByRole("link", { name: "查看报告" }).click();
  await expect(reader).toContainText("文件不存在或已被移动");
});
