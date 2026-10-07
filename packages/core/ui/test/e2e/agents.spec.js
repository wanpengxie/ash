import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

test("explicit recipient routes one message; work cards show scoped progress and full answer", async ({ page }, info) => {
  const running = await startOwner({ stateDir: mkdtempSync(join(tmpdir(), "ash-agents-ui-")), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
  const sent = [];
  await page.route("**/api/send", async route => {
    const wire = route.request().postDataJSON();
    if (wire.to === "service:agents" && wire.word === "list") return route.fulfill({ json: { id: "list", reply: { from: "service:agents", reply_to: "list", word: "list", body: { ok: true, result: { agents: [
      { id: "agent:main", name: "Ash", state: "idle", available: true },
      { id: "agent:writer", name: "文案", summary: "写作助手", state: "idle", available: true },
      { id: "agent:offline", name: "离线电脑", state: "idle", available: false },
    ] } } } } });
    if (wire.to === "agent:writer" && wire.word === "say") {
      sent.push(wire); running.ledger.append({ from: "person:owner", to: wire.to, kind: "request", word: "say", body: wire.body });
      return route.fulfill({ json: { id: "sent", reply: { body: { ok: true, result: { accepted: true } } } } });
    }
    return route.continue();
  });
  try {
    await page.setViewportSize({ width: 412, height: 915 }); await page.goto(`${running.url}/?token=${token}`);
    await expect(page.locator("#connection")).toContainText("已连接");
    await page.getByRole("button", { name: "@ Ash", exact: true }).click();
    await expect(page.getByRole("button", { name: "离线电脑 · 不可用", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "文案 · 写作助手", exact: true }).click();
    await page.locator("#t").fill("改一下这句话"); await page.locator("#send").click();
    await expect.poll(() => sent.length).toBe(1); expect(sent[0].to).toBe("agent:writer");
    const ledger = running.ledger, turn = "t_uiwork", thread = "w_uiwork";
    const delivery = ledger.append({ from: "service:agents", to: "agent:writer", kind: "request", word: "say", thread, body: { text: "整理调查报告", from_agent: "agent:main" } }).message;
    ledger.append({ from: "agent:writer", to: null, kind: "event", word: "turn.start", turn, thread, body: { turn, ids: [delivery.id] } });
    ledger.append({ from: "agent:writer", to: null, kind: "event", word: "activity.summary", turn, thread, body: { text: "正在核对三个来源", current: true } });
    ledger.append({ from: "agent:writer", to: "service:agents", kind: "request", word: "answer", turn, thread, body: { in_reply_to: delivery.id, text: "## 调查结果\n\n已经核对 **三个来源**。" } });
    ledger.append({ from: "agent:writer", to: null, kind: "event", word: "turn.end", turn, thread, body: { turn, reason: "completed" } });
    await page.reload();
    const card = page.locator(".work-thread"); await expect(card).toHaveCount(1); await card.locator("summary").click();
    await expect(card).toContainText("已完成"); await expect(card.locator("h2")).toHaveText("调查结果");
    await expect(card.locator("strong")).toHaveText("三个来源");
    await page.screenshot({ path: info.outputPath("agents-and-work-thread.png"), fullPage: true });
  } finally { await running.close(); }
});
