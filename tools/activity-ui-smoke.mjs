// Deterministic real-browser acceptance: isolated ledger, synthetic task, no model key or owner data.
// node --import tsx tools/activity-ui-smoke.mjs
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../packages/core/src/world/ledger.ts";
import { WorldRouter } from "../packages/core/src/world/router.ts";
import { WorldMembers } from "../packages/core/src/world/member.ts";
import { EdgeRouter, startEdgeServer } from "../packages/core/src/server.ts";
import { PostPresenceMember } from "../packages/core/src/members/post.ts";
import { wordContract } from "../packages/sdk/src/words.ts";
import { TaskStatusBridge } from "../packages/core/src/task-status.ts";
const dir = mkdtempSync(join(tmpdir(), "ash-activity-ui-"));
const out = "build/evidence/activity-v3"; mkdirSync(out, { recursive: true });
const ledger = await Ledger.open(join(dir, "ledger.db"));
const world = new WorldRouter(ledger, () => true), members = new WorldMembers(world);
members.register({ id: "agent:main", kind: "agent", name: "Ash", words: () => [wordContract("agent:main", "say"), wordContract("agent:main", "typing")], handle: () => ({ ok: true, result: { accepted: true } }) });
const edge = new EdgeRouter(ledger, world, members, { api: { "synthetic-activity-owner": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 2) });
members.register(new PostPresenceMember((screen) => edge.screens.markVisible(screen)));
let server, browser;
const frames = [];
const bridge = new TaskStatusBridge(world, async (frame) => { frames.push(frame); });
const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, turn: "t_activity" };
try {
  const owner = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "看下我的书架（界面测试）" } }).message;
  await world.send(agent, { to: null, kind: "event", word: "turn.start", body: { turn: "t_activity", ids: [owner.id] } });
  world.recordActivitySummary("t_activity", "先读取当前书架，再检查列表是否还有下一页。", "agent:main", false);
  const opened = world.recordDshToolCall("t_activity", "open", "mcp__ash__capability_call", JSON.stringify({ member: "device:phone", word: "apps.open", body: { package: "sample.reader" }, purpose: "打开阅读应用" }));
  world.recordDshToolResult(opened.id, true, '{"ok":true,"result":{"opened":true}}');
  const read = world.recordDshToolCall("t_activity", "read", "mcp__ash__capability_call", JSON.stringify({ member: "device:phone", word: "screen.read", body: {}, purpose: "读取书架里的书名" }));
  server = await startEdgeServer(edge, "127.0.0.1", 0);
  browser = await chromium.launch({ headless: true, executablePath: process.env.ASH_PROBE_CHROME || "/opt/google/chrome/chrome", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 412, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?token=synthetic-activity-owner`);
  await page.locator("#presence").click(); await page.getByRole("tab", { name: "活动", exact: true }).click();
  const panel = page.locator('section[data-tab="activity"]');
  await panel.getByText("读取书架里的书名", { exact: true }).waitFor();
  assert.equal(await panel.locator(".activity-step").count(), 3);
  assert.match(await panel.innerText(), /screen.read · 进行中/);
  assert.doesNotMatch(await panel.innerText(), /在动手|在跑命令|已确认/);
  await page.screenshot({ path: `${out}/activity-running.png` });
  world.recordDshToolResult(read.id, true, JSON.stringify({ ok: true, result: { books: ["示例书名甲", "示例书名乙"], token: "PRIVATE_SYNTHETIC_TOKEN" } }));
  await panel.getByText(/screen.read · 调用完成/).waitFor();
  const row = panel.locator(".activity-step").filter({ hasText: "读取书架里的书名" });
  await row.locator("summary").click();
  await row.locator("pre").getByText(/示例书名甲/).waitFor();
  assert.doesNotMatch(await row.innerText(), /PRIVATE_SYNTHETIC_TOKEN/);
  assert.match(await row.innerText(), /已隐藏/);
  await page.screenshot({ path: `${out}/activity-detail.png` });
  const pending = world.recordDshToolCall("t_activity", "pending", "bash", JSON.stringify({ description: "检查阅读应用是否仍在运行", command: "printf 'fixture'\nprintf 'TAIL'" }));
  world.recordDshToolResult(pending.id, true, '{"status":"accepted","request_id":"receipt_fixture"}');
  await panel.getByText(/bash · 已受理，等待结果/).waitFor();
  await bridge.settled();
  const active = frames.findLast((f) => f.tool === "screen.read");
  assert.equal(active.text, "读取书架里的书名");
  writeFileSync(`${out}/capsule-frame.json`, JSON.stringify(active));
  assert.deepEqual(errors, []);
  writeFileSync(`${out}/result.json`, JSON.stringify({ ok: true, checks: ["purpose", "actual-tool", "summary-labelled", "live-result", "expand-details", "redaction", "accepted-not-complete", "same-capsule-title"], errors }, null, 2));
  console.log("Activity browser smoke passed");
} finally {
  await browser?.close(); await bridge.close();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  ledger.close(); rmSync(dir, { recursive: true, force: true });
}
