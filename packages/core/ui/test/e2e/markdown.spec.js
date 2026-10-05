import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

let running, token;
const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const sample = '# 耳机对比结果\n\n推荐 **Sony XM4**，更适合你在意的降噪。\n\n## 为什么选它\n\n- **降噪更好**：通勤更安静\n- 预算内：¥680\n  - 建议同城验货\n\n> 价格来自商品描述，尚未与卖家确认。\n\n| 型号 | 价格 | 建议 |\n| :--- | ---: | :--- |\n| Sony XM4 | ¥680 | 优先考虑 |\n| Bose QC35 II | ¥590 | 备选 |\n\n```javascript\nconst message = "<script>文本，不是代码</script>";\n  console.log(message);\n```\n\n[查看官方说明](https://example.com/help)\n\n- [x] 已完成价格对比\n- [ ] 等待你选择';

test.beforeAll(async () => {
  running = await startOwner({ stateDir: mkdtempSync(join(tmpdir(), "ash-markdown-")), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
});
test.afterAll(async () => { await running?.close(); });
async function say(text) { return running.world.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text, kind: "reply" }, wait: true }); }

test("real conversation renders Markdown, copies exact code and retains rendering after reload", async ({ page }) => {
  await page.goto(`${running.url}/?token=${token}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const sent = await say(sample);
  const bubble = page.locator(`.msg[data-seq="${sent.seq}"]`);
  await expect(bubble.locator("h1")).toHaveText("耳机对比结果");
  await expect(bubble.locator("table tbody tr")).toHaveCount(2);
  await expect(bubble.locator("blockquote")).toContainText("尚未与卖家确认");
  await expect(bubble.locator('input[type="checkbox"]')).toHaveCount(2);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedMarkdown = text; } } }); });
  await bubble.getByRole("button", { name: "复制代码" }).click();
  await expect(bubble.locator(".md-copy")).toHaveText("已复制");
  expect(await page.evaluate(() => window.copiedMarkdown)).toBe('const message = "<script>文本，不是代码</script>";\n  console.log(message);');
  await page.reload();
  await expect(bubble.locator("h1")).toHaveText("耳机对比结果");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#log").evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: '/tmp/ash-markdown-light.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: '/tmp/ash-markdown-dark.png' });
});

test("hostile Markdown remains inert and mobile tables/code scroll without widening the conversation", async ({ page }) => {
  const external = [];
  page.on("request", request => { if (request.url().includes('markdown-tracker.invalid')) external.push(request.url()); });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${running.url}/?token=${token}`);
  const long = "long_code_".repeat(50);
  const sent = await say('## 安全检查\n\n<script>window.markdownExecuted=true</script>\n\n<img src=x onerror="window.markdownExecuted=true">\n\n[unsafe](javascript:alert%281%29) ![图片](https://markdown-tracker.invalid/pixel)\n\n| A | B | C | D | E | F |\n|---|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 | 6 |\n\n```\n'+long+'\n```');
  const bubble = page.locator(`.msg[data-seq="${sent.seq}"]`);
  await expect(bubble.locator("h2")).toHaveText("安全检查");
  await expect(bubble.locator("script,img,iframe,svg")).toHaveCount(0);
  await expect(bubble.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.markdownExecuted)).toBeUndefined();
  expect(external).toEqual([]);
  const sizes = await bubble.evaluate(el => ({ bubble:el.getBoundingClientRect().width, log:document.getElementById('log').clientWidth,
    viewport:innerWidth, page:document.documentElement.scrollWidth, pre:el.querySelector('pre').clientWidth, code:el.querySelector('pre').scrollWidth,
    table:el.querySelector('.md-table-wrap').clientWidth, cells:el.querySelector('.md-table-wrap').scrollWidth }));
  expect(sizes.bubble).toBeLessThan(sizes.log);
  expect(sizes.page).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.code).toBeGreaterThan(sizes.pre);
  expect(sizes.cells).toBeGreaterThan(sizes.table);
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable:true, value:undefined }); document.execCommand = command => { window.copyFallbackUsed = command; return true; }; });
  await bubble.getByRole('button', { name:'复制代码' }).click();
  expect(await page.evaluate(() => window.copyFallbackUsed)).toBe('copy');
  await expect(page.locator('.md-copy-buffer')).toHaveCount(0);
});
