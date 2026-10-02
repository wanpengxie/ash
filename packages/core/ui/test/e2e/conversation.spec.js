import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

let root;
let home;
let running;
let ownerToken;
const recentMessages = () => running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });

async function showCard(card) {
  const sent = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false },
  { to: "person:owner", kind: "request", word: "show", body: { card }, wait: true });
  expect(sent.reply?.body.ok).toBe(true);
  return sent.id;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ash-ui-e2e-"));
  home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, "note.txt"), "E2E file body\n");
  writeFileSync(join(home, "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0",
    workspaces: { home }, agents: [{ id: "agent:main", runtime: "echo" }] });
  ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
});

test.afterAll(async () => {
  await running?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test("owner sends from the real UI and the echo brain replies in the conversation", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#t").fill("e2e hello");
  await page.locator("#send").click();
  await expect(page.locator("#log .msg.me")).toContainText("e2e hello");
  await expect(page.locator("#log .msg.ai")).toContainText("e2e hello");
  await expect(page.locator("#log .delivery")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#log .msg.me")).toContainText("e2e hello");
  await expect(page.locator("#log .msg.ai")).toContainText("e2e hello");
  await expect(page.locator("#log .delivery")).toHaveCount(1);
});

test("an owner bubble advances from sending to delivered to read", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#menu").click();
  await page.locator("#settingsPause").click();
  await expect(page.locator("#settingsFeedback")).toHaveText("已暂停 Ash");
  await page.locator("#drawer").evaluate((element) => element.classList.remove("open"));
  await expect(page.locator("#send")).toBeEnabled();

  const text = `delivery stages ${Date.now()}`;
  let releaseSend;
  const held = new Promise((resolve) => { releaseSend = resolve; });
  await page.route("**/api/send", async (route) => {
    if (route.request().method() === "POST" && JSON.parse(route.request().postData() || "{}").body?.text === text)
      await held;
    await route.continue();
  });
  try {
    await page.locator("#t").fill(text);
    await page.locator("#send").click();
    const pending = page.locator("#log .pending-local").filter({ hasText: text });
    await expect(pending.locator("xpath=following-sibling::span[contains(@class,'delivery')][1]")).toHaveText("发送中");
    releaseSend();
    const bubble = page.locator("#log .msg.me:not(.pending-local)").filter({ hasText: text });
    const delivery = bubble.locator("xpath=following-sibling::span[contains(@class,'delivery')][1]");
    await expect(delivery).toHaveText("已送达");
    await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(0);

    await page.locator("#menu").click();
    await page.locator("#settingsResume").click();
    await page.locator("#settingsResumeYes").click();
    await expect(page.locator("#settingsFeedback")).toHaveText("已恢复 Ash");
    await expect(delivery).toHaveText("已读");
    await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
  } finally {
    releaseSend();
    const latestAdmin = running.ledger.list({ limit: 1000 }).filter((message) =>
      message.to === "service:admin" && ["pause", "resume"].includes(message.word)).at(-1);
    if (latestAdmin?.word === "pause") {
      await page.locator("#drawer").evaluate((element) => element.classList.add("open"));
      await page.locator("#settingsResume").click();
      await page.locator("#settingsResumeYes").click();
    }
  }
});

test("the presence bar follows agent status and avatar independently of network status", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.evaluate(() => {
    window.ashWorkingObservedAt = null;
    new MutationObserver(() => {
      if (document.querySelector("#presence")?.dataset.state === "working" && window.ashWorkingObservedAt === null)
        window.ashWorkingObservedAt = Date.now();
    }).observe(document.querySelector("#presence"), { attributes: true, attributeFilter: ["data-state"] });
  });
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false };
  const working = await running.world.send(agent, { to: null, kind: "event", word: "status",
    body: { state: "working", text: "正在查看资料" } });
  expect(working.id).toBeTruthy();
  await expect(page.locator("#presence")).toHaveAttribute("data-state", "working");
  await expect(page.locator("#state")).toHaveText("正在查看资料");
  await expect(page.locator("#face img")).toHaveAttribute("src", /focused\.webp$/);
  const observedAt = await page.evaluate(() => window.ashWorkingObservedAt);
  expect(observedAt - running.ledger.byId(working.id).ts).toBeLessThan(500);
  await expect(page.locator("#connection")).toContainText("已连接");
  const resting = await running.world.send(agent, { to: null, kind: "event", word: "status",
    body: { state: "resting", text: "休息中" } });
  expect(resting.id).toBeTruthy();
  await expect(page.locator("#presence")).toHaveAttribute("data-state", "resting");
  await expect(page.locator("#face img")).toHaveAttribute("src", /resting\.webp$/);
});

test("two live screens see the same messages without conversation control buttons", async ({ page, context }) => {
  const second = await context.newPage();
  try {
    await page.goto(`${running.url}/?token=${ownerToken}`);
    await second.goto(`${running.url}/`);
    await expect(page.locator("#connection")).toContainText("已连接");
    await expect(second.locator("#connection")).toContainText("已连接");
    await second.evaluate(() => sessionStorage.setItem("ash.screen.label.v2", "E2E phone"));
    await second.reload();
    await expect(second.locator("#connection")).toContainText("已连接");
    const text = `two screens ${Date.now()}`;
    await second.locator("#t").fill(text);
    await second.locator("#send").click();
    await expect(page.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
    await expect(second.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
    await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
    await expect(page.locator("#log .from").filter({ hasText: "E2E phone" })).toHaveCount(1);
    const source = recentMessages().find((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text);
    expect(source.origin?.label).toBe("E2E phone");
    for (const screen of [page, second]) {
      await expect(screen.locator("#log button").filter({ hasText: /停止|插话|编辑|撤回/ })).toHaveCount(0);
    }
  } finally { await second.close(); }
});

test("a remote screen can chat and answer an approval but cannot manage Ash", async ({ page }) => {
  const caller = { member: "person:owner", transportPrincipal: "gateway:e2e", pairedDeviceId: "e2e-browser",
    local: false, remote: true, ownerProxy: true, transport: "web_ui" };
  const statuses = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([, value]) => typeof value === "string"));
    const result = await running.edge.handle({ method: request.method,
      url: new URL(request.url, "http://remote"), headers, body }, caller);
    if (request.url === "/api/send") statuses.push(result.status);
    response.writeHead(result.status, result.headers ?? {});
    if ("stream" in result) result.stream((chunk) => response.write(chunk),
      (close) => { if (response.destroyed || response.writableEnded) close(); else response.once("close", close); },
      () => response.end());
    else response.end(result.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let effects = 0;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await expect(page.locator("#connection")).toContainText("已连接");
    await expect(page.locator("#settingsAdmin")).toHaveCount(0);
    await page.locator("#t").fill("remote e2e hello");
    await page.locator("#send").click();
    await expect(page.locator("#log .msg.me").filter({ hasText: "remote e2e hello" })).toHaveCount(1);

    running.members.registerDevice({ id: "device:remote-e2e", kind: "device", name: "Remote E2E", online: true,
      capabilities: () => [{ name: "run", description: "Remote approval E2E", label: "Run remote E2E", risk: "outward",
      input_schema: { type: "object", properties: {}, additionalProperties: false } }],
      handle: () => { effects++; return { ok: true, result: {} }; } });
    const grant = await fetch(`${running.url}/api/send`, { method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
        body: { member: "agent:main", scope: "device:remote-e2e/run" }, wait: true }) });
    expect(grant.status).toBe(200);
    const request = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false },
    { to: "device:remote-e2e", kind: "request", word: "run", body: {} });
    await expect.poll(() => Boolean(running.ledger.gateCase(request.id))).toBe(true);
    const gate = running.ledger.gateCase(request.id);
    expect(gate?.askId).toBeTruthy();
    await page.locator("#presence").click();
    await page.locator("#agentTabs [data-tab=approvals]").click();
    await page.locator(`[data-ask-id="${gate.askId}"] [data-choice="once"]`).click();
    await expect.poll(() => effects).toBe(1);
    expect(running.ledger.responseTo(gate.askId)?.body.result.choice).toBe("once");

    const token = await page.evaluate(() => sessionStorage.getItem("ash.screen.token.v2"));
    const forbidden = await fetch(`${base}/api/send`, { method: "POST", headers: { "content-type": "application/json", "Ash-Screen": token },
      body: JSON.stringify({ to: "service:admin", kind: "request", word: "pause", body: {}, wait: true }) });
    expect(forbidden.status).toBe(403);
    expect(effects).toBe(1);
    expect(statuses).toContain(403);
  } finally {
    await page.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a same-turn burst groups its bubbles and puts the reaction on the cited owner message", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const ownerText = `reaction target ${Date.now()}`;
  await page.locator("#t").fill(ownerText);
  await page.locator("#send").click();
  const findOwner = () => running.ledger.list({ limit: 1000 }).find((message) =>
    message.from === "person:owner" && message.word === "say" && message.body.text === ownerText);
  await expect.poll(() => findOwner()?.id).toBeTruthy();
  const owner = findOwner();
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false, turn: `t_burst_${Date.now()}` };
  for (const text of ["Burst first", "Burst second"]) {
    const sent = await running.world.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text, kind: "reply" }, wait: true });
    expect(sent.reply?.body.ok).toBe(true);
  }
  const reaction = await running.world.send(agent, { to: "person:owner", kind: "request", word: "react",
    body: { message_id: owner.id, emoji: "👍" }, wait: true });
  expect(reaction.reply?.body.ok).toBe(true);
  await expect(page.locator("#log .msg.ai").filter({ hasText: "Burst first" })).toHaveClass(/group-first/);
  await expect(page.locator("#log .msg.ai").filter({ hasText: "Burst second" })).toHaveClass(/group-last/);
  const bubble = page.locator("#log .msg.me").filter({ hasText: ownerText });
  await expect(bubble.locator(".reaction")).toHaveText("👍");
  await expect(page.locator("#log .msg.ai").filter({ hasText: "Burst first" }).locator(".reaction")).toHaveCount(0);
});

test("an option card is settled by one ordinary owner message on both screens", async ({ page, context }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  const second = await context.newPage();
  try {
    await second.goto(`${running.url}/`);
    await expect(second.locator("#connection")).toContainText("已连接");
    const cardId = await showCard({ type: "options", prompt: "E2E choice", options: [{ id: "yes", text: "Yes" }] });
    const firstCard = page.locator("#log .card").filter({ hasText: "E2E choice" });
    const secondCard = second.locator("#log .card").filter({ hasText: "E2E choice" });
    await expect(firstCard.getByRole("button", { name: "Yes" })).toBeEnabled();
    await expect(secondCard.getByRole("button", { name: "Yes" })).toBeEnabled();
    await firstCard.getByRole("button", { name: "Yes" }).click();
    await expect(firstCard.getByRole("button", { name: "Yes" })).toBeDisabled();
    await expect(secondCard.getByRole("button", { name: "Yes" })).toBeDisabled();
    const replies = recentMessages().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.in_reply_to === cardId);
    expect(replies).toHaveLength(1);
    expect(replies[0].body.option_id).toBe("yes");
  } finally { await second.close(); }
});

test("file, image, link and permission cards render their intended actions", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await showCard({ type: "file", workspace: "home", path: "note.txt", name: "note.txt", mime_type: "text/plain", size: 14 });
  const file = page.locator("#log .card").filter({ hasText: "note.txt" });
  const downloadPromise = page.waitForEvent("download");
  await file.getByRole("link", { name: "note.txt" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("note.txt");

  await showCard({ type: "image", workspace: "home", path: "dot.png", alt: "E2E image" });
  const image = page.locator("#log .card").getByRole("img", { name: "E2E image" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);

  await showCard({ type: "link", url: "https://example.com", title: "E2E link" });
  await expect(page.locator("#log .card").getByRole("link", { name: "E2E link" })).toHaveAttribute("href", "https://example.com/");
  await showCard({ type: "permission", permission: "calendar", why: "E2E calendar permission" });
  const permission = page.locator("#log .card").filter({ hasText: "E2E calendar permission" });
  await expect(permission.getByRole("button", { name: "去授权" })).toBeDisabled();
});

test("an offline owner message is shown locally and delivered once after reconnect", async ({ page, context }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const text = `offline ${Date.now()}`;
  await context.setOffline(true);
  try {
    await page.locator("#t").fill(text);
    await page.locator("#send").click();
    await expect(page.locator("#log .pending-local").filter({ hasText: text })).toHaveCount(1);
    expect(recentMessages().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text)).toHaveLength(0);
  } finally { await context.setOffline(false); }
  await expect(page.locator("#connection")).toContainText("已连接", { timeout: 15_000 });
  await expect.poll(() => recentMessages().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text).length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
  expect(recentMessages().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text)).toHaveLength(1);
});

test("a suggested page opens only when the owner accepts its chip", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await expect.poll(() => recentMessages().findLast((message) => message.word === "visible" && message.origin?.screen)?.origin?.screen).toMatch(/^screen:/);
  const screen = recentMessages().findLast((message) => message.word === "visible" && message.origin?.screen).origin.screen;
  const sent = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false },
  { to: screen, kind: "request", word: "ui.open", body: { target: "activity", mode: "suggest" } });
  const suggestion = page.locator("#suggestions .suggestion");
  await expect(suggestion).toContainText("Ash 建议查看活动");
  await expect(page.locator("#agentSheet")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => running.ledger.responseTo(sent.id)?.body?.result?.opened).toBe(false);
  await suggestion.getByRole("button", { name: "打开" }).click();
  await expect(page.locator("#agentSheet")).toHaveAttribute("aria-hidden", "false");
  await expect(page.locator("#agentTabs [data-tab=activity]")).toHaveAttribute("aria-selected", "true");
  await expect(suggestion).toHaveCount(0);
  await page.locator("#agentClose").click();
  const dismissed = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false },
  { to: screen, kind: "request", word: "ui.open", body: { target: "memory", mode: "suggest" } });
  await expect(suggestion).toContainText("Ash 建议查看记忆");
  await suggestion.getByRole("button", { name: "关闭" }).click();
  await expect(suggestion).toHaveCount(0);
  await expect(page.locator("#agentSheet")).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => running.ledger.responseTo(dismissed.id)?.body?.result?.opened).toBe(false);
});

test("the upcoming page removes a scheduled item after its confirmed cancel", async ({ page }) => {
  const label = `E2E reminder ${Date.now()}`;
  const set = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false },
  { to: "service:clock", kind: "request", word: "set", body: { to: "agent:main", word: "say",
    body: { text: "E2E reminder" }, label, at: Date.now() + 3_600_000 }, wait: true });
  expect(set.reply?.body?.ok).toBe(true);
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#presence").click();
  await page.locator("#agentTabs [data-tab=upcoming]").click();
  const item = page.locator("#agentPanel [data-tab=upcoming] .upcoming-timer").filter({ hasText: label });
  await expect(item).toHaveCount(1);
  await item.getByRole("button", { name: "删除计划" }).click();
  await expect(item).toHaveCount(0);
  await expect(page.locator("#agentPanel [data-tab=upcoming]")).toContainText("暂无计划");
  expect(recentMessages().filter((message) => message.to === "service:clock" && message.word === "cancel" && message.kind === "request" && message.from === "person:owner")).toHaveLength(1);
});

test("finished work opens its activity and can become a composer context chip", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const text = `E2E activity ${Date.now()}`;
  await page.locator("#t").fill(text);
  await page.locator("#send").click();
  await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
  const progress = page.locator("#progress .progress-button");
  await expect(progress).toContainText(/做了 \d+ 步/);
  await expect(progress).not.toContainText(/agent:|service:|device:|\.run\b/);
  await progress.click();
  const activity = page.locator("#agentPanel [data-tab=activity] .activity-turn").filter({ hasText: text });
  await expect(activity).toHaveCount(1);
  await activity.getByRole("button", { name: "问问她这件事" }).click();
  await expect(page.locator("#agentSheet")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#context .context-chip")).toContainText("关于这件事");
  await expect(page.locator("#t")).toHaveValue(`关于${text}，`);
  await page.locator("#context .context-remove").click();
  await expect(page.locator("#context .context-chip")).toHaveCount(0);
});

test("live progress shows two human steps, then folds into a turn-grouped activity without raw tool data", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const text = `Progress topic ${Date.now()}`;
  await page.locator("#t").fill(text);
  await page.locator("#send").click();
  await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
  const owner = recentMessages().find((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text);
  expect(owner?.id).toBeTruthy();
  const turn = `t_progress_${Date.now()}`;
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false, turn };
  await running.world.send(agent, { to: null, kind: "event", word: "turn.start", body: { turn, ids: [owner.id] } });
  await running.world.send(agent, { to: null, kind: "event", word: "status", body: { state: "working", text: "正在理解问题" } });
  await running.world.send(agent, { to: "service:self", kind: "request", word: "read", body: { path: "USER.md" }, wait: true });
  await running.world.send(agent, { to: null, kind: "event", word: "status", body: { state: "working", text: "正在核对资料" } });
  await running.world.send(agent, { to: null, kind: "event", word: "status", body: { state: "working", text: "正在整理答复" } });
  const progress = page.locator(`#progress .progress-button[data-turn="${turn}"]`);
  await expect(progress).toContainText("正在核对资料 · 正在整理答复");
  await expect(progress).not.toContainText("正在理解问题");
  await expect(progress).not.toContainText(/service:self|USER\.md|\bread\b/);
  await running.world.send(agent, { to: null, kind: "event", word: "turn.end", body: { turn, reason: "completed" } });
  await expect(progress).toContainText(/做了 \d+ 步 · \d+ 秒 · 查看活动/);
  await progress.click();
  const activity = page.locator(`#agentPanel [data-tab=activity] .activity-turn[data-turn="${turn}"]`);
  await expect(activity).toContainText(text);
  await expect(activity.locator(".activity-step")).toHaveCount(3);
  await expect(activity).not.toContainText(/service:self|USER\.md|\bread\b/);
  await expect(page.locator("#log")).not.toContainText(/service:self|USER\.md|\bread\b/);
});

test("a committed background run appears in its own activity group with human step names", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const topic = `Background grouping ${Date.now()}`;
  await page.locator("#t").fill(topic);
  await page.locator("#send").click();
  await expect(page.locator("#log .msg.ai").filter({ hasText: topic })).toHaveCount(1);
  const started = running.ledger.workStartScheduled("memory", "event", `e2e:background:${Date.now()}`);
  expect(started.run).toBeTruthy();
  running.world.publishWorkEvent(started.event);
  running.world.publishWorkEvent(running.ledger.workStep({ run: started.run, step: "extract", state: "started" }));
  running.world.publishWorkEvent(running.ledger.workStep({ run: started.run, step: "extract", state: "done" }));
  running.world.publishWorkEvent(running.ledger.workFinish(started.run, "done", "completed"));
  await page.locator("#presence").click();
  await page.locator("#agentTabs [data-tab=activity]").click();
  const activity = page.locator(`#agentPanel [data-tab=activity] .activity-turn[data-turn="${started.run}"]`);
  await expect(activity).toContainText("整理记忆");
  await expect(activity.locator(".activity-step")).toHaveText("提取记忆");
  await expect(page.locator("#agentPanel [data-tab=activity] .activity-group")).toContainText(["对话", "后台任务"]);
  await expect(activity).not.toContainText(/service:work|\bextract\b/);
  await expect(page.locator("#progress")).not.toContainText("提取记忆");
});

test("the composer compresses a static image and keeps a document intact", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const originalSize = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 512;
    const drawing = canvas.getContext("2d");
    const pixels = drawing.createImageData(canvas.width, canvas.height);
    let random = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      pixels.data[index] = random & 255;
      pixels.data[index + 1] = random >>> 8 & 255;
      pixels.data[index + 2] = random >>> 16 & 255;
      pixels.data[index + 3] = 255;
    }
    drawing.putImageData(pixels, 0, 0);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([png], "photo.png", { type: "image/png" }));
    transfer.items.add(new File(["exact document bytes"], "memo.txt", { type: "text/plain" }));
    const picker = document.querySelector("#file");
    picker.files = transfer.files;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    return png.size;
  });
  await expect(page.locator("#selected")).toContainText("2 个附件");
  const text = `E2E attachments ${Date.now()}`;
  await page.locator("#t").fill(text);
  await page.locator("#send").click();
  await expect.poll(() => recentMessages().find((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text)?.body.attachments?.length).toBe(2);
  const message = recentMessages().find((item) => item.from === "person:owner" && item.word === "say" && item.body.text === text);
  expect(message.body.attachments[0].name).toBe("photo.jpg");
  expect(message.body.attachments[0].mime_type).toBe("image/jpeg");
  expect(Buffer.from(message.body.attachments[0].data, "base64").byteLength).toBeLessThan(originalSize);
  expect(message.body.attachments[1].name).toBe("memo.txt");
  expect(Buffer.from(message.body.attachments[1].data, "base64").toString()).toBe("exact document bytes");
  await expect(page.locator("#log .msg.me").filter({ hasText: text })).toContainText("memo.txt");
});

test("recent history paints promptly and upward scroll loads the earlier page", async ({ page }) => {
  const batch = `E2E history ${Date.now()}`;
  for (let index = 0; index < 225; index++) running.ledger.append({ from: "person:owner", to: "agent:main",
    kind: "request", word: "say", body: { text: `${batch} item ${index}` } });
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await expect(page.locator("#log .msg.me").filter({ hasText: `${batch} item 224` })).toHaveCount(1);
  await expect(page.locator("#log .msg.me").filter({ hasText: `${batch} item 0` })).toHaveCount(0);
  const paintMs = await page.evaluate(() => {
    const boot = performance.getEntriesByName("shell.boot").at(-1);
    const painted = performance.getEntriesByName("shell.history-rendered").at(-1);
    return painted.startTime - boot.startTime;
  });
  expect(paintMs).toBeLessThan(1000);
  await page.locator("#log").evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
  await expect(page.locator("#log .msg.me").filter({ hasText: `${batch} item 0` })).toHaveCount(1);
});

test("the approval page saves an exact calendar rule and revokes it", async ({ page }) => {
  let effects = 0;
  const device = "device:calendar_e2e";
  running.members.registerDevice({ id: device, kind: "device", name: "Calendar probe", online: true,
    capabilities: () => [{ name: "calendar.create", description: "Add an event", label: "Adding a calendar event", risk: "outward",
      input_schema: { type: "object", properties: { calendar_id: { type: "integer" }, title: { type: "string" } },
        required: ["calendar_id", "title"], additionalProperties: false } }],
    handle: () => { effects++; return { ok: true, result: {} }; } });
  const grantResponse = await fetch(`${running.url}/api/send`, { method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: `${device}/calendar.create` }, wait: true }) });
  expect(grantResponse.status).toBe(200);
  const grant = await grantResponse.json();
  expect(grant.reply?.body.ok).toBe(true);
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false };
  const create = (calendar_id, title) => running.world.send(agent,
    { to: device, kind: "request", word: "calendar.create", body: { calendar_id, title } });
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const first = await create(7, "first event");
  await page.locator("#presence").click();
  await page.locator("#agentTabs [data-tab=approvals]").click();
  await expect(page.locator("#agentPanel .sheet-approval.pending")).toHaveCount(1);
  await expect(page.locator("#agentPanel .sheet-approval.pending")).toContainText("first event");
  await page.locator("#agentPanel .sheet-approval.pending").getByRole("button", { name: "Allow this calendar for 30 days" }).click();
  await expect.poll(() => effects).toBe(1);
  expect(running.ledger.responseTo(first.id)?.body.ok).toBe(true);

  await page.locator("#agentTabs [data-tab=activity]").click();
  await page.locator("#agentTabs [data-tab=approvals]").click();
  await expect(page.locator("#agentPanel .sheet-rule")).toHaveCount(1);
  await expect(page.locator("#agentPanel .sheet-rule")).toContainText("日历 7");
  await expect(page.locator("#agentPanel .sheet-history").filter({ hasText: "以后都允许" })).toHaveCount(1);
  const same = await create(7, "another event");
  await expect.poll(() => effects).toBe(2);
  expect(running.ledger.gateCase(same.id)).toBe(null);
  const other = await create(8, "different calendar");
  await expect(page.locator("#agentPanel .sheet-approval.pending")).toHaveCount(1);
  expect(effects).toBe(2);
  await page.locator("#agentPanel .sheet-approval.pending").getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => running.ledger.responseTo(other.id)?.body.ok).toBe(false);

  await page.locator("#agentPanel .sheet-rule").getByRole("button", { name: "撤销规则" }).click();
  await expect(page.locator("#agentPanel .sheet-rule")).toHaveCount(0);
  const revoked = await create(7, "after revoke");
  await expect(page.locator("#agentPanel .sheet-approval.pending")).toHaveCount(1);
  expect(effects).toBe(2);
  await page.locator("#agentPanel .sheet-approval.pending").getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => running.ledger.responseTo(revoked.id)?.body.ok).toBe(false);
});

test("local settings change quiet hours through the live admin word", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#menu").click();
  await expect(page.locator("#settingsQuiet")).toBeVisible();
  await page.locator("#settingsQuiet").getByRole("button", { name: "读取时段" }).click();
  await expect(page.locator("#settingsQuietStatus")).toHaveText("已读取当前时段。");
  await page.locator("#settingsQuietStart").fill("22:00");
  await page.locator("#settingsQuietEnd").fill("08:00");
  await page.locator("#settingsQuietSave").click();
  await expect(page.locator("#settingsQuietStatus")).toHaveText("已保存免打扰时段。");
  const saved = running.ledger.list({ limit: 1000 }).findLast((message) =>
    message.to === "service:admin" && message.word === "settings.set");
  expect(saved?.body).toEqual({ delivery: { quiet: "22:00-08:00" } });
  await page.reload();
  await page.locator("#menu").click();
  await page.locator("#settingsQuiet").getByRole("button", { name: "读取时段" }).click();
  await expect(page.locator("#settingsQuietStart")).toHaveValue("22:00");
  await expect(page.locator("#settingsQuietEnd")).toHaveValue("08:00");
});

test("visible heartbeats stop in the background and resume when the screen returns", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const visibleCount = () => running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:post" && message.word === "visible").length;
  await expect.poll(visibleCount).toBeGreaterThan(0);
  const before = visibleCount();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(60_000);
  expect(visibleCount()).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(visibleCount).toBe(before + 1);
});

test("an approval can allow once but becomes inert after its deadline", async ({ page }) => {
  await page.clock.install();
  const device = "device:approval_expiry_e2e";
  let effects = 0;
  running.members.registerDevice({ id: device, kind: "device", name: "Approval expiry probe", online: true,
    capabilities: () => [{ name: "run", description: "Run once", label: "Running once", risk: "outward",
      input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"], additionalProperties: false } }],
    handle: () => { effects++; return { ok: true, result: {} }; } });
  const grant = await fetch(`${running.url}/api/send`, { method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: `${device}/run` }, wait: true }) });
  expect((await grant.json()).reply?.body.ok).toBe(true);
  const agent = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false };
  const ask = (item) => running.world.send(agent, { to: device, kind: "request", word: "run", body: { item } });
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  const allowed = await ask("approved");
  const first = page.locator("#log .card.ask").filter({ hasText: "approved" });
  await expect(first.getByRole("button", { name: "Allow once" })).toBeEnabled();
  await first.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => effects).toBe(1);
  expect(running.ledger.responseTo(allowed.id)?.body.ok).toBe(true);

  const expired = await ask("expires");
  const second = page.locator("#log .card.ask").filter({ hasText: "expires" });
  await expect(second.getByRole("button", { name: "Allow once" })).toBeEnabled();
  await page.clock.fastForward(601_000);
  await expect(second).toContainText("已过期");
  await expect(second.getByRole("button", { name: "Allow once" })).toBeDisabled();
  await expect(second.getByRole("button", { name: "Deny" })).toBeDisabled();
  expect(running.ledger.responseTo(expired.id)).toBeNull();
  expect(effects).toBe(1);
});

test("local settings pause immediately and require a second tap to resume", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#menu").click();
  await expect(page.locator("#settingsAdmin")).toBeVisible();
  const before = running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:admin" && ["pause", "resume"].includes(message.word)).length;
  const beforeResumes = running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:admin" && message.word === "resume").length;
  await page.locator("#settingsPause").click();
  await expect(page.locator("#settingsFeedback")).toHaveText("已暂停 Ash");
  await page.locator("#settingsResume").click();
  await expect(page.locator("#settingsResumeConfirmation")).toBeVisible();
  expect(running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:admin" && message.word === "resume")).toHaveLength(beforeResumes);
  await page.locator("#settingsResumeYes").click();
  await expect(page.locator("#settingsFeedback")).toHaveText("已恢复 Ash");
  const commands = running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:admin" && ["pause", "resume"].includes(message.word));
  expect(commands.slice(before).map((message) => message.word)).toEqual(["pause", "resume"]);
});

test("local proactive preferences save through self and survive a page reload", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#menu").click();
  const preferences = page.locator("#settingsProactive");
  await expect(preferences).toBeVisible();
  await preferences.getByRole("button", { name: "加载偏好" }).click();
  await expect(preferences.getByRole("status")).toContainText(/已读取当前偏好|偏好文件尚不存在/);
  const content = `Only useful updates. ${Date.now()}\n`;
  await page.locator("#settingsProactiveText").fill(content);
  await preferences.getByRole("button", { name: "保存偏好" }).click();
  await expect(preferences.getByRole("status")).toHaveText("已保存并重新核对。");
  const writes = running.ledger.list({ limit: 1000 }).filter((message) =>
    message.from === "person:owner" && message.to === "service:self" && message.word === "write" && message.body.path === "PROACTIVE.md");
  expect(writes.at(-1)?.body.content).toBe(content);
  await page.reload();
  await page.locator("#menu").click();
  await page.locator("#settingsProactive").getByRole("button", { name: "加载偏好" }).click();
  await expect(page.locator("#settingsProactiveText")).toHaveValue(content);
});

test("memory page shows a versioned USER file and can roll back a snapshot", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#presence").click();
  await page.locator('#agentTabs button[data-tab="memory"]').click();
  const editor = page.locator('#agentPanel section[data-tab="memory"]');
  await expect(editor.locator(".markdown-source")).toBeEnabled();
  await editor.locator(".markdown-source").fill("Name: E2E first\n");
  await editor.locator(".editor-save").click();
  await expect(editor.locator(".editor-status")).toHaveText("已保存并核对当前版本。");
  await expect(editor.locator(".editor-version")).toHaveText("版本 1");
  const first = await editor.locator(".markdown-source").inputValue();
  await editor.locator(".markdown-source").fill(first.replace("Name: E2E first", "Name: E2E second"));
  await editor.locator(".editor-save").click();
  await expect(editor.locator(".editor-version")).toHaveText("版本 2");
  await editor.locator(".editor-history").click();
  await expect(editor.locator(".editor-rollback")).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await editor.locator(".editor-rollback").click();
  await expect(editor.locator(".markdown-source")).toHaveValue(/Name: E2E first/);
  await expect(editor.locator(".editor-version")).toHaveText("版本 3");
  const writes = running.ledger.list({ limit: 1000 }).filter((message) =>
    message.to === "service:self" && message.body.path === "USER.md" && ["write", "rollback"].includes(message.word));
  expect(writes.map((message) => message.word)).toEqual(["write", "write", "rollback"]);
});

test("memory editor keeps the owner draft when a background file change makes it stale", async ({ page }) => {
  await page.goto(`${running.url}/?token=${ownerToken}`);
  await expect(page.locator("#connection")).toContainText("已连接");
  await page.locator("#presence").click();
  await page.locator('#agentTabs button[data-tab="memory"]').click();
  const editor = page.locator('#agentPanel section[data-tab="memory"]');
  await editor.getByRole("button", { name: "MEMORY.md" }).click();
  await expect(editor.locator(".markdown-source")).toBeEnabled();
  writeFileSync(join(home, "MEMORY.md"), "Before background update\n");
  await editor.locator(".editor-refresh").click();
  await expect(editor.locator(".markdown-source")).toHaveValue("Before background update\n");
  await editor.locator(".markdown-source").fill("Owner draft must remain\n");
  writeFileSync(join(home, "MEMORY.md"), "Background update wins\n");
  await editor.locator(".editor-save").click();
  await expect(editor.locator(".editor-warning")).toContainText("文件已被其他操作修改");
  await expect(editor.locator(".markdown-source")).toHaveValue("Owner draft must remain\n");
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("Background update wins\n");
});
