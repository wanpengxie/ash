import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOwner } from "../../../dist/ash-core.mjs";

const install = process.env.ASH_TEST_DSH_ROOT;
test.skip(!install || !existsSync(join(install, "package.json")), "installed DSH required");
const digest = (text) => createHash("sha256").update(text).digest("hex");
const read = (path) => ({ name: "ash_send", input: { to: "service:self", word: "read", body: { path } } });
const write = (path, content, expected_hash) => ({ name: "ash_send", input: { to: "service:self", word: "write",
  body: { path, content, expected_hash, why: "owner explicitly approved this forget plan" } } });
const say = (text) => ({ name: "ash_say", input: { text, kind: "reply" } });

for (const approved of [false, true]) {
  test(`forget ${approved ? "approval" : "denial"} keeps the real self files honest`, async ({ page }) => {
    test.setTimeout(90_000);
    const root = mkdtempSync(join(tmpdir(), "ash-forget-production-"));
    const home = join(root, "home");
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "IDENTITY.md"), "- Name: Ash\n");
    const before = { "USER.md": "- Name: Test owner\n- Beverage: 无糖茶\n",
      "MEMORY.md": "- 用户喜欢无糖茶\n- 用户在做 Ash 项目\n" };
    const after = { "USER.md": "- Name: Test owner\n", "MEMORY.md": "- 用户在做 Ash 项目\n" };
    for (const [path, content] of Object.entries(before)) writeFileSync(join(home, path), content);
    const plan = "我会从当前 USER 和 MEMORY 记录移除无糖茶偏好；对话历史和文件版本可能仍有副本。这只是计划，等你明确同意再改。";
    const scripted = [read("USER.md"), read("MEMORY.md"), say(plan), null,
      ...(approved ? [read("USER.md"), read("MEMORY.md"),
        write("USER.md", after["USER.md"], digest(before["USER.md"])),
        write("MEMORY.md", after["MEMORY.md"], digest(before["MEMORY.md"])),
        read("USER.md"), read("MEMORY.md"), say("当前可编辑记录已移除这项偏好；历史版本与对话记录可能仍保留。"), null]
        : [say("你没有同意，我没有改动这些记录。"), null]),
    ];
    let serial = 0;
    const model = createServer(async (request, response) => {
      if (!request.url?.endsWith("/messages")) return void response.writeHead(404).end("{}");
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw);
      const latest = JSON.stringify((input.messages ?? []).filter((item) => item.role === "user").at(-1)?.content ?? "");
      const next = latest.includes("mind wake") || latest.includes("worker:") ? null : scripted.shift();
      if (next === undefined) return void response.writeHead(500).end("unexpected model turn");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event("message_start", { message: { id: `msg_forget_${++serial}`, type: "message", role: "assistant", model: "deepseek-flash",
        content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (next) {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_forget_${serial}`, name: next.name, input: {} } });
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
      await page.locator("#t").fill("请忘掉我喜欢无糖茶这件事");
      await page.locator("#send").click();
      await expect(page.locator("#log .msg.ai").filter({ hasText: plan })).toBeVisible();
      const messages = () => running.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
      expect(messages().filter((item) => item.to === "service:self" && item.word === "write")).toHaveLength(0);
      for (const [path, content] of Object.entries(before)) expect(readFileSync(join(home, path), "utf8")).toBe(content);
      await page.locator("#t").fill(approved ? "我明确同意刚才的范围，现在执行并复查" : "算了，不要删");
      await page.locator("#send").click();
      const finalLine = approved ? "当前可编辑记录已移除这项偏好" : "你没有同意，我没有改动这些记录";
      await expect(page.locator("#log .msg.ai").filter({ hasText: finalLine })).toBeVisible();
      const writes = messages().filter((item) => item.from === "agent:main" && item.to === "service:self" && item.word === "write");
      expect(writes).toHaveLength(approved ? 2 : 0);
      for (const item of writes) expect(running.ledger.responseTo(item.id)?.body.ok).toBe(true);
      for (const [path, content] of Object.entries(approved ? after : before)) {
        const actual = readFileSync(join(home, path), "utf8");
        expect(actual).toContain(content.trim());
        if (approved) expect(actual).not.toContain("无糖茶");
      }
      const reads = messages().filter((item) => item.from === "agent:main" && item.to === "service:self" && item.word === "read");
      expect(reads).toHaveLength(approved ? 6 : 2);
      if (approved) {
        expect(Math.min(...reads.slice(-2).map((item) => item.seq))).toBeGreaterThan(Math.max(...writes.map((item) => item.seq)));
        for (const item of reads.slice(-2)) {
          const reply = running.ledger.responseTo(item.id);
          expect(reply?.body.ok).toBe(true);
          expect(reply.body.result.content).not.toContain("无糖茶");
        }
      }
      // The visible reply precedes the model's closing turn; wait for that last scripted step to be taken.
      await expect.poll(() => scripted.length).toBe(0);
    } finally {
      await running?.close();
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });
}
