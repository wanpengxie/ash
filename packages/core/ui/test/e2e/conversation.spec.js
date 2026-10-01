import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

let root;
let running;
let ownerToken;

async function showCard(card) {
  const sent = await running.world.send({ member: "agent:main", transport: "agent", transportPrincipal: "agent:main",
    local: true, remote: false, ownerProxy: false },
  { to: "person:owner", kind: "request", word: "show", body: { card }, wait: true });
  expect(sent.reply?.body.ok).toBe(true);
  return sent.id;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ash-ui-e2e-"));
  const home = join(root, "home");
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

test("two live screens see the same messages without conversation control buttons", async ({ page, context }) => {
  const second = await context.newPage();
  try {
    await page.goto(`${running.url}/?token=${ownerToken}`);
    await second.goto(`${running.url}/`);
    await expect(page.locator("#connection")).toContainText("已连接");
    await expect(second.locator("#connection")).toContainText("已连接");
    const text = `two screens ${Date.now()}`;
    await page.locator("#t").fill(text);
    await page.locator("#send").click();
    await expect(page.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
    await expect(second.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
    await expect(second.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
    for (const screen of [page, second]) {
      await expect(screen.locator("#log button").filter({ hasText: /停止|插话|编辑|撤回/ })).toHaveCount(0);
    }
  } finally { await second.close(); }
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
    const replies = running.ledger.list().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.in_reply_to === cardId);
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
    expect(running.ledger.list().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text)).toHaveLength(0);
  } finally { await context.setOffline(false); }
  await expect(page.locator("#connection")).toContainText("已连接", { timeout: 15_000 });
  await expect.poll(() => running.ledger.list().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text).length, { timeout: 15_000 }).toBe(1);
  await expect(page.locator("#log .msg.me").filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator("#log .msg.ai").filter({ hasText: text })).toHaveCount(1);
  expect(running.ledger.list().filter((message) => message.from === "person:owner" && message.word === "say" && message.body.text === text)).toHaveLength(1);
});
