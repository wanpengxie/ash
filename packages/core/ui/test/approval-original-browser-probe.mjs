// Local fake approvals only: exercises real UI rendering without device or model calls.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const ui = fileURLToPath(new URL("../", import.meta.url));
const original = "echo '生成报表'\n" + "完整内容 ".repeat(160) + "\nEND_OF_ORIGINAL\n<img src=x onerror=window.injected=true>";
const message = { id: "approval-fixture", seq: 1, ts: 1, from: "service:gate", to: "person:owner", kind: "request", word: "ask",
  body: { title: "需要你确认", detail: "执行命令：生成报表……（点击查看原文可查看完整命令）", expires_at: Date.now() + 600000,
    options: [{ id: "once", label: "允许这一次" }, { id: "deny", label: "不允许" }],
    source: { word: "shell.run", to: "device:phone", body_preview: "摘要", body_full: original } } };
const source = `
  import {appendConversation} from "./js/conversation.js";
  import {renderApprovalsSheet} from "./js/sheet-approvals.js";
  import {fold,initialView} from "./js/project.js";
  const view=fold(initialView(),${JSON.stringify(message)});
  window.answers=[];
  appendConversation(document.querySelector("#chat"),view.conversation,{onAnswerAsk:async(_ask,choice)=>window.answers.push(choice)});
  renderApprovalsSheet(document.querySelector("#sheet"),view,{onAnswer:async(_ask,choice)=>window.answers.push(choice)});
  window.ready=true;
`;
const bundle = await build({ stdin: { contents: source, resolveDir: ui, sourcefile: "approval-probe.js" },
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", logLevel: "silent" });
const style = readFileSync(new URL("../index.html", import.meta.url), "utf8").match(/<style>([\s\S]*?)<\/style>/)[1];
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>${style}body{display:block;padding:16px;overflow:auto}#sheet{margin-top:24px}</style>
  <h3>对话里的审批卡</h3><div id="chat"></div><h3>审批页</h3><div id="sheet"></div>
  <script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`;
const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.ready);
  for (const id of ["chat", "sheet"]) {
    const disclosure = page.locator(`#${id} details.approval-original`);
    assert.equal(await disclosure.count(), 1);
    assert.equal(await disclosure.locator("pre").isVisible(), false);
    await disclosure.locator("summary").click();
    assert.equal(await disclosure.locator("pre").isVisible(), true);
    assert.equal(await disclosure.locator("pre").textContent(), original);
    assert.equal(await disclosure.locator("img").count(), 0);
    await disclosure.locator("pre").evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.equal(await disclosure.locator("pre").evaluate(element => element.scrollTop > 0), true);
  }
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => window.answers), [], "opening originals does not grant approval");
  await page.locator("#chat button").filter({ hasText: "允许这一次" }).click();
  assert.deepEqual(await page.evaluate(() => window.answers), ["once"]);
  assert.deepEqual(errors, []);
  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
  console.log("PASS: both approval surfaces expand the full original, preserve plain text, and do not approve on expansion.");
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
