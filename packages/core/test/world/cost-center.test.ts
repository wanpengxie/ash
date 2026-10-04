// The cost centre end to end: a real DSH process measures each model call, ash prices and shows it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startOwner } from "../../src/main";

const install = process.env.ASH_TEST_DSH_ROOT;
const skip = !install || !existsSync(join(install, "package.json")) ? "set ASH_TEST_DSH_ROOT to an installed runtime" :
  !process.execArgv.includes("--expose-internals") ? "needs node --expose-internals" : false;

test("real model calls become priced usage facts, and the owner can read totals and the account balance", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-cost-"));
  const home = join(root, "home"); mkdirSync(home);
  let balanceAuth = "";
  const provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => { raw += part; });
    req.on("end", () => {
      if (req.url === "/user/balance") {
        balanceAuth = String(req.headers.authorization);
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "12.34", granted_balance: "2.00", topped_up_balance: "10.34" }] }));
      }
      if (!req.url?.endsWith("/messages")) return void res.writeHead(404).end("{}");
      const request = JSON.parse(raw || "{}") as { model?: string };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (kind: string, data: object) => res.write(`event: ${kind}\ndata: ${JSON.stringify({ type: kind, ...data })}\n\n`);
      event("message_start", { message: { id: "msg_cost", type: "message", role: "assistant", model: request.model, content: [], stop_reason: null,
        usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 200 } } });
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
      event("content_block_stop", { index: 0 });
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } });
      event("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
  const port = (provider.address() as { port: number }).port;
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner({ stateDir: join(root, "state"), workspaces: { home }, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "dsh" }],
      dsh: { root: install!, home: join(root, "dsh"), costRoot: resolve("packages/ash-cost"), env: { DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: "sk-synthetic-cost",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic` } } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const call = async (body: object) => (await fetch(`${running!.url}/api/send`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<Record<string, any>>;
    const all = () => running!.ledger.list({ before: Number.MAX_SAFE_INTEGER, limit: 1000 });
    await call({ to: "agent:main", kind: "request", word: "say", body: { text: "hello" }, client_id: "cost-1" });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !all().some((m) => m.word === "usage.recorded" && m.body.scope === "chat")) await new Promise((r) => setTimeout(r, 30));
    const fact = all().find((m) => m.word === "usage.recorded" && m.body.scope === "chat");
    assert.ok(fact, "a chat call was measured");
    assert.equal(fact.from, "service:cost");
    assert.equal(fact.body.input_tokens, 1000);
    assert.equal(fact.body.output_tokens, 500);
    assert.equal(fact.body.cache_read_tokens, 200);
    assert.equal(typeof fact.body.cost_usd, "number", "DeepSeek's provider id resolves to the catalog price");
    assert.ok((fact.body.cost_usd as number) > 0);
    assert.doesNotMatch(JSON.stringify(fact), /sk-synthetic-cost/);

    const usage = await call({ to: "service:cost", kind: "request", word: "usage.get", body: {}, wait: true, client_id: "cost-usage" });
    const result = usage.reply.body.result;
    assert.equal(usage.reply.body.ok, true);
    assert.ok(result.periods.today.calls >= 1);
    assert.equal(result.periods.today.unpriced_calls, 0);
    assert.ok(result.by_scope.some((row: { scope: string }) => row.scope === "chat"));
    assert.equal(result.currency, "USD");

    const balance = await call({ to: "service:cost", kind: "request", word: "balance.get", body: {}, wait: true, client_id: "cost-balance" });
    assert.deepEqual(balance.reply.body.result, { available: true, balances: [{ currency: "CNY", total: "12.34", granted: "2.00", topped_up: "10.34" }] });
    assert.equal(balanceAuth, "Bearer sk-synthetic-cost");
    assert.doesNotMatch(JSON.stringify(all()), /sk-synthetic-cost/);
  } finally {
    await running?.close();
    provider.closeAllConnections(); await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
