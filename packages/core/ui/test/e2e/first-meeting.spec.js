import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

const install = process.env.ASH_TEST_DSH_ROOT;
test.skip(!install || !existsSync(join(install, "package.json")), "installed DSH required");

test("a new owner sees three first-meeting bubbles exactly once", async ({ page }) => {
  test.setTimeout(70_000);
  const root = mkdtempSync(join(tmpdir(), "ash-first-meeting-ui-"));
  const home = join(root, "home");
  mkdirSync(home);
  let serial = 0;
  const model = createServer(async (request, response) => {
    if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const current = JSON.stringify((input.messages ?? []).filter((item) => item.role === "user").at(-1)?.content ?? "");
    const firstMeeting = current.includes("Reason: first_meeting");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_first_${++serial}`, type: "message", role: "assistant", model: input.model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    if (firstMeeting) {
      for (let index = 0; index < 3; index++) {
        event("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_first_${serial}_${index}`, name: "ash_say", input: {} } });
        event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify({
          text: `FIRST_MEETING_${index + 1}`, kind: "reply" }) } });
        event("content_block_stop", { index });
      }
    } else {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } });
      event("content_block_stop", { index: 0 });
    }
    event("message_delta", { delta: { stop_reason: firstMeeting ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
    event("message_stop", {});
    response.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  let running;
  try {
    const port = model.address().port;
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`,
      } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
    await page.goto(`${running.url}/?token=${token}`);
    await expect(page.locator("#connection")).toContainText("已连接", { timeout: 20_000 });
    const bubbles = page.locator("#log .msg.ai").filter({ hasText: /^FIRST_MEETING_[1-3]$/ });
    await expect(bubbles).toHaveCount(3, { timeout: 25_000 });
    await expect(bubbles.nth(0)).toContainText("FIRST_MEETING_1");
    await expect(bubbles.nth(1)).toContainText("FIRST_MEETING_2");
    await expect(bubbles.nth(2)).toContainText("FIRST_MEETING_3");
    await page.reload();
    await expect(page.locator("#connection")).toContainText("已连接");
    await expect(page.locator("#log .msg.ai").filter({ hasText: /^FIRST_MEETING_[1-3]$/ })).toHaveCount(3);
    const messages = running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    expect(messages.filter((item) => item.word === "wake" && item.body.reason === "first_meeting")).toHaveLength(1);
    expect(messages.filter((item) => item.from === "agent:main" && item.to === "person:owner" &&
      item.word === "say" && /^FIRST_MEETING_[1-3]$/.test(item.body.text))).toHaveLength(3);
  } finally {
    await running?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing SOUL in the identity page reaches the next real DSH turn", async ({ page }) => {
  test.setTimeout(70_000);
  const root = mkdtempSync(join(tmpdir(), "ash-identity-next-turn-"));
  const home = join(root, "home");
  mkdirSync(home);
  const oldSoul = "SOUL_BEFORE_E2E_017";
  const newSoul = "SOUL_AFTER_E2E_017";
  writeFileSync(join(home, "IDENTITY.md"), "- Name: Ash\n");
  writeFileSync(join(home, "SOUL.md"), `${oldSoul}\n`);
  const captured = [];
  let serial = 0;
  const model = createServer(async (request, response) => {
    if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    captured.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", { message: { id: `msg_soul_${++serial}`, type: "message", role: "assistant", model: captured.at(-1).model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Synthetic turn complete." } });
    event("content_block_stop", { index: 0 });
    event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    event("message_stop", {});
    response.end();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  let running;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
      agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(root, "dsh"), env: {
        DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic", DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/anthropic`,
      } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
    await page.goto(`${running.url}/?token=${token}`);
    await expect(page.locator("#connection")).toContainText("已连接", { timeout: 20_000 });
    await page.locator("#t").fill("Before soul edit");
    await page.locator("#send").click();
    await expect.poll(() => running.ledger.list({ limit: 1000 }).filter((message) => message.word === "turn.end").length).toBe(1);
    expect(JSON.stringify(captured[0].messages)).toContain(oldSoul);

    await page.locator("#presence").click();
    const editor = page.locator("#agentPanel section[data-tab=identity] .markdown-source");
    await expect(editor).toHaveValue(`${oldSoul}\n`);
    await editor.fill(`${newSoul}\n`);
    await page.locator("#agentPanel section[data-tab=identity] .editor-save").click();
    await expect(page.locator("#agentPanel section[data-tab=identity] .editor-status")).toContainText("已保存并核对当前版本");
    expect(readFileSync(join(home, "SOUL.md"), "utf8")).toBe(`${newSoul}\n`);
    await page.locator("#agentClose").click();
    await page.locator("#t").fill("After soul edit");
    await page.locator("#send").click();
    await expect.poll(() => running.ledger.list({ limit: 1000 }).filter((message) => message.word === "turn.end").length).toBe(2);
    const after = JSON.stringify(captured.at(-1).messages);
    expect(after).toContain(newSoul);
    expect(after).toContain("self.changed");
  } finally {
    await running?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
