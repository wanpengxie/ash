import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

let running, token;
let effects = 0;
const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, turn: "t_ui_human" };
test.beforeAll(async () => {
  running = await startOwner({ stateDir: mkdtempSync(join(tmpdir(), "ash-human-ui-")), listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
  running.world.setApprovalMode(() => "always");
  running.members.registerDevice({ id: "device:human_ui", kind: "device", name: "UI fixture", online: true,
    capabilities: () => [{ name: "write", description: "Fixture write", label: "保存测试文本", risk: "outward", input_schema: { type: "object" } }],
    handle: () => { effects++; return { ok: true, result: {} }; } });
});
test.afterAll(async () => { await running?.close(); });

test("approval card remains approved but unexecuted, then displays an explicit skip after reload", async ({ page }) => {
  await page.goto(`${running.url}/?token=${token}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const sent = await running.world.send({ ...agent, approval: { ttlMinutes: 10, purpose: "保存主人指定的完整文本" } },
    { to: "device:human_ui", kind: "request", word: "write", body: { text: "原文\n" + "长内容".repeat(100) + "末尾标记" } });
  await expect.poll(() => running.ledger.humanPending(sent.id)?.state).toBe("waiting");
  const ask = running.ledger.humanPending(sent.id);
  const card = page.locator("#log .card.ask").filter({ hasText: "保存主人指定的完整文本" }).last();
  await expect(card).toContainText("有效期至");
  await card.getByText("查看原文").click();
  await expect(card).toContainText("末尾标记");
  expect(effects).toBe(0);
  await card.getByRole("button", { name: "允许这一次", exact: true }).click();
  await expect.poll(() => running.ledger.humanPending(sent.id)?.state).toBe("answered");
  await expect(card).toContainText("已批准，等待 Ash 判断是否继续");
  expect(effects).toBe(0);
  running.world.withdrawHuman("agent:main", sent.id, "主人已经改了任务，不再保存", true);
  await expect(card).toContainText("不再继续");
  await page.reload();
  await expect(page.locator("#log .card.ask").filter({ hasText: ask.title }).last()).toContainText("主人已经改了任务，不再保存");
  await page.locator("#presence").click();
  await page.locator("#agentTabs [data-tab=approvals]").click();
  await expect(page.locator("#agentPanel .sheet-approval.resolved").last()).toContainText("不再继续");
  expect(effects).toBe(0);
});

test("a custom answer is tied to the original question and expires independently of turns", async ({ page }) => {
  await page.goto(`${running.url}/?token=${token}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const pending = running.world.createHumanQuestion(agent, { type: "question", title: "将包裹送到哪里？", detail: "请选地址或输入其他地址", purpose: "安排配送", ttlMinutes: 10,
    options: [{ id: "home", label: "家里" }, { id: "office", label: "公司" }], allowCustom: true });
  const card = page.locator("#log .card.ask").filter({ hasText: "将包裹送到哪里？" }).last();
  await card.getByPlaceholder("输入其他回答").fill("送到前台，下午三点后");
  await card.getByRole("button", { name: "发送回答" }).click();
  await expect.poll(() => running.ledger.humanPending(pending.pending_id)?.state).toBe("answered");
  expect(running.ledger.humanPending(pending.pending_id).answer.result).toEqual({ choice: "custom", text: "送到前台，下午三点后" });
  await expect(card).toContainText("已回答");
  await expect(card.getByRole("button", { name: "发送回答" })).toHaveCount(0);
  const notices = running.ledger.list({ limit: 1000 }).filter((m) => m.from === "service:gate" && m.to === "agent:main" && m.word === "say" && String(m.body.text).includes(pending.pending_id));
  expect(notices).toHaveLength(1);
  expect(String(notices[0].body.text)).toContain("安排配送");
});
