import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
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

for (const starter of ["organize", "reminder", "preference"]) {
  test(`a first-meeting ${starter} choice reaches its real action`, async ({ page }) => {
    test.setTimeout(90_000);
    const root = mkdtempSync(join(tmpdir(), `ash-starter-${starter}-`));
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "IDENTITY.md"), "- Name: Ash\n");
    const userBefore = "- Name: Test owner\n";
    writeFileSync(join(home, "USER.md"), userBefore);
    const options = [
      { id: "organize", text: "帮我理清今天要做的事" },
      { id: "reminder", text: "到某个时间提醒我" },
      { id: "preference", text: "记下一项我希望你以后知道的偏好" },
    ];
    const prompts = {
      organize: "把今天要做的事告诉我，我来帮你排顺序。",
      reminder: "告诉我提醒的时间和内容。",
      preference: "告诉我具体想记住的偏好。",
    };
    const details = {
      organize: "今天先写报告，再买菜",
      reminder: "明天早上九点提醒我喝水",
      preference: "我喜欢无糖茶",
    };
    const action = starter === "organize"
      ? { name: "ash_say", input: { text: "先写报告，再买菜；报告是今天的第一步。", kind: "reply" } }
      : starter === "reminder"
        ? { name: "ash_send", input: { to: "service:clock", word: "set", body: {
          at: Date.now() + 86_400_000, to: "person:owner", word: "say", body: { text: "喝水", kind: "due" }, label: "喝水",
        } } }
        : { name: "ash_send", input: { to: "service:self", word: "read", body: { path: "USER.md" } } };
    const scripted = [
      { name: "ash_show", input: { card: { type: "options", prompt: "先试一件事", options } } },
      null,
      { name: "ash_say", input: { text: prompts[starter], kind: "reply" } },
      null,
      action,
      starter === "organize" ? null : starter === "reminder"
        ? { name: "ash_say", input: { text: "提醒已设好。", kind: "reply" } }
        : { name: "ash_send", input: { to: "service:self", word: "write", body: {
          path: "USER.md", content: `${userBefore}- 饮品偏好: 无糖茶\n`, why: "owner confirmed preference",
          expected_hash: createHash("sha256").update(userBefore).digest("hex"),
        } } },
      null,
    ];
    if (starter === "organize") scripted.pop();
    if (starter === "preference") scripted.splice(6, 0, { name: "ash_say", input: { text: "已记下你喜欢无糖茶。", kind: "reply" } });
    const captured = [];
    let serial = 0;
    const model = createServer(async (request, response) => {
      if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      captured.push(input);
      const latest = JSON.stringify((input.messages ?? []).filter((item) => item.role === "user").at(-1)?.content ?? "");
      const next = latest.includes("mind wake") || latest.includes("worker:") ? null : scripted.shift();
      if (next === undefined) return void response.writeHead(500).end("unexpected model turn");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_starter_${++serial}`, type: "message", role: "assistant", model: input.model,
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (next) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_starter_${serial}`, name: next.name, input: {} } });
        event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(next.input) } });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Done." } });
      }
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: next ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } });
      event("message_stop", {});
      response.end();
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    let running;
    try {
      running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0",
        agents: [{ id: "agent:main", runtime: "dsh" }], dsh: { root: install, home: join(root, "dsh"), env: {
          DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/anthropic`,
        } } });
      const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")[0];
      await page.goto(`${running.url}/?token=${token}`);
      await expect(page.locator("#connection")).toContainText("已连接", { timeout: 20_000 });
      await page.locator("#t").fill("展示起步选项");
      await page.locator("#send").click();
      const card = page.locator("#log .card").filter({ hasText: "先试一件事" });
      await expect(card.getByRole("button", { name: options.find((item) => item.id === starter).text })).toBeEnabled();
      await card.getByRole("button", { name: options.find((item) => item.id === starter).text }).click();
      await expect(card.getByRole("button", { name: options.find((item) => item.id === starter).text })).toBeDisabled();
      await expect(page.locator("#log .msg.ai").filter({ hasText: prompts[starter] })).toBeVisible();
      await page.locator("#t").fill(details[starter]);
      await page.locator("#send").click();
      const messages = () => running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
      if (starter === "organize") {
        await expect(page.locator("#log .msg.ai").filter({ hasText: "先写报告，再买菜；报告是今天的第一步。" })).toBeVisible();
      } else if (starter === "reminder") {
        await expect.poll(() => messages().filter((item) => item.from === "agent:main" && item.to === "service:clock" && item.word === "set").length).toBe(1);
        await expect(page.locator("#log .msg.ai").filter({ hasText: "提醒已设好。" })).toBeVisible();
        const set = messages().find((item) => item.from === "agent:main" && item.to === "service:clock" && item.word === "set");
        expect(running.ledger.responseTo(set.id)?.body.ok).toBe(true);
      } else {
        await expect.poll(() => readFileSync(join(home, "USER.md"), "utf8")).toContain("无糖茶");
        await expect(page.locator("#log .msg.ai").filter({ hasText: "已记下你喜欢无糖茶。" })).toBeVisible();
        expect(messages().filter((item) => item.from === "agent:main" && item.to === "service:self" && item.word === "read")).toHaveLength(1);
        expect(messages().filter((item) => item.from === "agent:main" && item.to === "service:self" && item.word === "write")).toHaveLength(1);
        for (const item of messages().filter((message) => message.from === "agent:main" && message.to === "service:self" && ["read", "write"].includes(message.word))) {
          expect(running.ledger.responseTo(item.id)?.body.ok).toBe(true);
        }
      }
      const cards = messages().filter((item) => item.from === "agent:main" && item.word === "show" && item.body.card?.type === "options");
      expect(cards).toHaveLength(1);
      expect(messages().filter((item) => item.from === "person:owner" && item.body.in_reply_to === cards[0].id && item.body.option_id === starter)).toHaveLength(1);
      expect(JSON.stringify(captured)).toContain(options.find((item) => item.id === starter).text);
      await expect.poll(() => scripted.length).toBe(0);
    } finally {
      await running?.close();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
