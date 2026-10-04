import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
// @ts-expect-error plain ESM plugin shipped beside the package
import { apply, collector } from "../../ash-cost/index.mjs";

async function* chunks(...items: object[]) { for (const item of items) yield item; }
const drain = async (stream: AsyncIterable<unknown>) => { const out: unknown[] = []; for await (const chunk of stream) out.push(chunk); return out; };

test("the plugin passes every chunk through untouched and reports only calls that carried usage", async () => {
  let handler: ((options: object, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined;
  apply({ on: (_name: string, fn: typeof handler) => { handler = fn; }, get: () => undefined });
  const seen: any[] = [];
  const stop = collector.onUsage((record: object) => seen.push(record));
  collector.label("s-main", "chat");
  const usage = { type: "usage", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: -1 } };
  const source = [{ type: "text", text: "hi" }, usage];
  assert.deepEqual(await drain(handler!({ sessionId: "s-main", provider: "p", model: "m" }, () => chunks(...source))), source);
  await drain(handler!({ purpose: "session-title", provider: "p", model: "m" }, () => chunks(usage)));
  await drain(handler!({ provider: "p", model: "m" }, () => chunks(usage)));
  await drain(handler!({ sessionId: "unknown", provider: "p", model: "m" }, () => chunks(usage)));
  await drain(handler!({ sessionId: "s-main", provider: "p", model: "m" }, () => chunks({ type: "text", text: "cut off" })));
  await assert.rejects(drain(handler!({ provider: "p", model: "m" }, async function* () { yield usage; throw Object.assign(new Error("x"), { code: "aborted" }); })));
  stop();
  assert.deepEqual(seen.map((r) => r.scope), ["chat", "title", "background", "other", "background"]);
  assert.deepEqual([seen[0].input, seen[0].output, seen[0].cacheRead, seen[0].cacheWrite, seen[0].ok], [10, 4, 3, 0, true]);
  assert.equal(seen[4].ok, false);
});

test("balance asks the provider with the resolved key and returns only the balance", async () => {
  let auth = "";
  const server = createServer((req, res) => { auth = String(req.headers.authorization);
    res.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "3.50", granted_balance: "0", topped_up_balance: "3.50" }] })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    apply({ on() {}, get: (name: string) => name === "credentials" ? { resolve: async () => ({ value: "sk-from-dsh" }) } : undefined });
    const answer = await collector.balance({ baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/anthropic` });
    assert.equal(auth, "Bearer sk-from-dsh");
    assert.deepEqual(answer, { available: true, balances: [{ currency: "USD", total: "3.50", granted: "0", topped_up: "3.50" }] });
    await assert.rejects(collector.balance({ credential: "bad name" }), /invalid credential/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
