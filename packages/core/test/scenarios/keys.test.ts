/**
 * Model key health: a key saved in the vault is checked against its provider at once, and what the provider says can be
 * read back through `service:llm/keys.status` (never the key). The model server here is a fake of the scenario.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { dataOf, startScenario } from "./harness";
import { eventually } from "../fixtures/wait";

async function fakeProvider(t: { after(fn: () => void): void }) {
  const seen: { path: string; authorization: string }[] = [];
  const server: Server = createServer((req, res) => {
    const authorization = String(req.headers.authorization ?? "");
    seen.push({ path: String(req.url), authorization });
    const good = authorization === "Bearer sk-good-key";
    res.writeHead(good ? 200 : 401, { "content-type": "application/json" });
    res.end(good ? '{"is_available":true}' : '{"error":{"message":"API key expired","code":401}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

test("a key saved in the vault is verified at once; an expired one is reported as rejected, a replaced one as ok, with no key in the answer", async (t) => {
  const provider = await fakeProvider(t);
  const s = await startScenario(t, { llm: { baseUrl: provider.baseUrl } });
  const owner = await s.human();

  // the scenario's own key (sk-scenario) was saved in the first meeting and the fake provider refused it
  await eventually(async () => dataOf(await owner.call("service:llm", "keys.status", {})).keys.find((k: { provider: string }) => k.provider === "deepseek").status === "rejected", "the saved key to be checked");
  const first = dataOf(await owner.call("service:llm", "keys.status", {})).keys;
  const deepseek = first.find((k: { provider: string }) => k.provider === "deepseek");
  assert.deepEqual([deepseek.configured, deepseek.status, deepseek.reason, deepseek.detail], [true, "rejected", "已过期", "API key expired"]);
  assert.equal(typeof deepseek.checked_at, "number");
  assert.deepEqual(first.find((k: { provider: string }) => k.provider === "openrouter"), { provider: "openrouter", ref: "OPENROUTER_API_KEY", configured: false, status: "unknown" });
  assert.ok(provider.seen.some((r) => r.path === "/user/balance" && r.authorization === "Bearer sk-scenario"));

  await owner.call("service:vault", "set", { ref: "DEEPSEEK_API_KEY", value: "sk-good-key", kind: "key" });
  await eventually(async () => dataOf(await owner.call("service:llm", "keys.status", {})).keys.find((k: { provider: string }) => k.provider === "deepseek").status === "ok", "the new key to be checked");
  const after = JSON.stringify(dataOf(await owner.call("service:llm", "keys.status", {})));
  assert.doesNotMatch(after, /sk-good-key|sk-scenario/);

  // asking again by hand goes to the provider again
  const before = provider.seen.length;
  const checked = dataOf(await owner.call("service:llm", "keys.check", { provider: "deepseek" })).keys;
  assert.equal(checked[0].status, "ok");
  assert.ok(provider.seen.length > before);

  await owner.call("service:vault", "delete", { ref: "DEEPSEEK_API_KEY" });
  const removed = dataOf(await owner.call("service:llm", "keys.status", {})).keys.find((k: { provider: string }) => k.provider === "deepseek");
  assert.deepEqual([removed.configured, removed.status], [false, "unknown"]);
});
