import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { openLedger } from "../../kernel/ledger/helpers";
import { createCostService, type BalanceProvider } from "../../../src/services/cost";

const ctx: HandleContext = { signal: new AbortController().signal, caller: { member: "person:owner", via: "human", local: true }, raw: null };
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const HOUR = 3_600_000, DAY = 24 * HOUR;

function setup(extra: Partial<Parameters<typeof createCostService>[0]> = {}) {
  const { ledger } = openLedger();
  const service = createCostService({ ledger, now: () => NOW, timeZone: "UTC", ...extra });
  const send = (word: string, body: unknown, kind: "request" | "event" = "request"): Promise<WordResult | void> =>
    service.handle({ seq: 0, id: "m_x", ts: NOW, from: "service:llm", to: "service:cost", kind, word, body } as Message, ctx);
  const record = (body: Record<string, unknown>) => send("usage.recorded", { provider: "deepseek", model: "deepseek-flash", ok: true, at: NOW - HOUR, input_tokens: 100, output_tokens: 50, caller: "agent:main", ...body }, "event");
  const call = async (word: string, body: unknown = {}) => (await send(word, body)) as WordResult;
  return { ledger, service, record, call };
}
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; } assert.fail("expected a WordError"); };

test("the member is service:cost with the contract words of the sdk", () => {
  const { service } = setup();
  assert.equal(service.id, "service:cost");
  assert.deepEqual(service.words().map((w) => w.word).sort(), ["balance.get", "quota.check", "usage.get", "usage.recorded"]);
});

test("usage.recorded events land in the usage table", async () => {
  const f = setup();
  await f.record({ cost: 0.002 });
  await f.record({ caller: "service:reflex", provider: "openrouter", model: "typesafe/jev-1.13", ok: false });
  const rows = f.ledger.db().prepare("SELECT caller,provider,model,input_tokens,output_tokens,cost,ok FROM cost_usage ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { caller: "agent:main", provider: "deepseek", model: "deepseek-flash", input_tokens: 100, output_tokens: 50, cost: 0.002, ok: 1 },
    { caller: "service:reflex", provider: "openrouter", model: "typesafe/jev-1.13", input_tokens: 100, output_tokens: 50, cost: null, ok: 0 },
  ]);
  assert.equal(await code(f.record({ input_tokens: "many" })), "bad_request");
});

test("an unknown cost stays unknown: NULL in the table, counted as unpriced, never added as 0", async () => {
  const f = setup();
  await f.record({ model: "mystery-1" });                 // no cost field, and no rates for the model
  await f.record({ model: "mystery-1", cost: "free" });   // not a number: same thing
  await f.record({ model: "mystery-1", cost: 0.5 });
  assert.deepEqual(f.ledger.db().prepare("SELECT cost FROM cost_usage ORDER BY id").all().map((r) => r.cost), [null, null, 0.5]);
  const today = (await f.call("usage.get")).data as any;
  assert.equal(today.periods.today.calls, 3);
  assert.equal(today.periods.today.cost_usd, 0.5);
  assert.equal(today.periods.today.unpriced_calls, 2);
  assert.deepEqual(today.recent.map((c: any) => c.cost_usd), [0.5, null, null]);
});

test("a call without a stated cost is priced from the published DeepSeek rates; a stated cost and an unknown model are left alone", async () => {
  const f = setup();
  const offPeak = Date.UTC(2026, 9, 10, 12, 0, 0);   // Saturday
  const peak = Date.UTC(2026, 9, 12, 7, 0, 0);       // Monday 07:00 UTC
  // the case that was 36 unpriced calls: DSH's provider id and the current Flash model
  await f.record({ provider: "deepseek-official", model: "deepseek-flash", at: offPeak, input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 });
  await f.record({ provider: "deepseek-official", model: "deepseek-flash", at: peak, input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000 });
  await f.record({ provider: "deepseek-official", model: "deepseek-v4-pro", at: offPeak, input_tokens: 1_000_000, output_tokens: 0 });
  await f.record({ provider: "deepseek", model: "deepseek-flash", at: offPeak, input_tokens: 1_000_000, output_tokens: 0, cost: 9 });   // the reporter's own price stays
  await f.record({ provider: "openrouter", model: "deepseek-flash", at: offPeak });                                                    // not DeepSeek's price list
  const costs = f.ledger.db().prepare("SELECT cost FROM cost_usage ORDER BY id").all().map((r) => r.cost as number | null);
  const close = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  close(costs[0]!, 0.15 + 0.6 + 0.003);
  close(costs[1]!, 0.3 + 1.2 + 0.006);
  close(costs[2]!, 0.66);
  assert.equal(costs[3], 9);
  assert.equal(costs[4], null);
});

test("usage.get totals the periods, by caller and by day, and keeps older calls out of the short ones", async () => {
  const f = setup();
  await f.record({ at: NOW - HOUR, cost: 0.01 });                                          // today
  await f.record({ at: NOW - 3 * DAY, caller: "service:reflex", input_tokens: 10, output_tokens: 5, cost: 0.001 });   // within 7 days
  await f.record({ at: NOW - 20 * DAY, input_tokens: 1000, output_tokens: 0, cost: 0.1 }); // within 30 days only
  await f.record({ at: NOW - 60 * DAY });                                                  // too old for any period
  const data = (await f.call("usage.get", { days: 7 })).data as any;
  assert.equal(data.currency, "USD");
  assert.equal(data.periods.today.calls, 1);
  assert.equal(data.periods["7d"].calls, 2);
  assert.equal(data.periods["7d"].input_tokens, 110);
  assert.equal(data.periods["30d"].calls, 3);
  assert.equal(data.periods["30d"].input_tokens, 1110);
  assert.deepEqual(data.by_caller.map((c: any) => c.caller), ["agent:main", "service:reflex"]);
  assert.deepEqual(data.by_day.map((d: any) => d.date), ["2026-10-07", "2026-10-10"]);
  assert.equal(data.recent.length, 3);
  assert.equal(await code(f.call("usage.get", { days: 0 })), "bad_request");
});

test("quota.check: allowed under the daily limit, refused over it, counting today's tokens of that agent only", async () => {
  const limits: Record<string, number> = { "agent:main": 1000 };
  const f = setup({ dailyTokenLimit: (agent) => limits[agent] });
  await f.record({ input_tokens: 400, output_tokens: 100 });                                  // 500 today
  await f.record({ at: NOW - 2 * DAY, input_tokens: 9000 });                                  // yesterday's do not count
  await f.record({ caller: "agent:other", input_tokens: 9000 });                              // someone else's do not count
  assert.deepEqual((await f.call("quota.check", { agent: "agent:main" })).data, { allowed: true, used: 500, limit: 1000 });
  await f.record({ input_tokens: 600, output_tokens: 0 });                                    // 1100 now
  const over = (await f.call("quota.check", { agent: "agent:main" })).data as any;
  assert.equal(over.allowed, false); assert.equal(over.used, 1100); assert.equal(over.limit, 1000);
  assert.match(over.reason, /agent:main/);
  // no limit set for this agent: nothing to exceed
  assert.deepEqual((await f.call("quota.check", { agent: "agent:other" })).data, { allowed: true, used: 9050 });
  // the limit is read at every check, so a changed setting applies at once
  limits["agent:main"] = 5000;
  assert.equal(((await f.call("quota.check", { agent: "agent:main" })).data as any).allowed, true);
  assert.equal(await code(f.call("quota.check", {})), "bad_request");
});

test("quota.check without a limit function allows everything", async () => {
  const f = setup();
  await f.record({ input_tokens: 1e9 });
  assert.equal(((await f.call("quota.check", { agent: "agent:main" })).data as any).allowed, true);
});

test("a limit of 0 is a limit (nothing may be used); only no setting at all means no limit", async () => {
  const f = setup({ dailyTokenLimit: (agent) => (agent === "agent:main" ? 0 : undefined) });
  assert.equal(((await f.call("quota.check", { agent: "agent:main" })).data as any).allowed, false);
  assert.equal(((await f.call("quota.check", { agent: "agent:other" })).data as any).allowed, true);
});

test("any non-empty provider name is recorded, an empty one is refused", async () => {
  const f = setup();
  await f.record({ provider: "anthropic" });
  assert.equal(await code(f.record({ provider: "" })), "bad_request");
  assert.equal(f.ledger.db().prepare("SELECT provider FROM cost_usage").all().length, 1);
});

test("balance.get: what the providers report, skipping those that cannot be asked, and remembered for usage.get", async () => {
  const asked: BalanceProvider[] = [];
  const f = setup({ fetchBalance: async (p) => { asked.push(p); return p === "deepseek" ? { available: true, balances: [{ currency: "CNY", total: "12.30" }] } : null; } });
  const data = (await f.call("balance.get")).data as any;
  assert.deepEqual(asked, ["deepseek", "openrouter"]);
  assert.deepEqual(data.balances, [{ provider: "deepseek", at: NOW, balance: { available: true, balances: [{ currency: "CNY", total: "12.30" }] } }]);
  assert.deepEqual(data.errors, {});
  assert.equal(((await f.call("usage.get")).data as any).balances[0].provider, "deepseek");
});

test("balance.get: one provider failing is reported next to the other; all failing is an error, never a zero", async () => {
  const some = setup({ fetchBalance: async (p) => { if (p === "openrouter") throw new Error("HTTP 401"); return { total: "3" }; } });
  const data = (await some.call("balance.get")).data as any;
  assert.equal(data.balances.length, 1);
  assert.deepEqual(data.errors, { openrouter: "HTTP 401" });

  const none = setup({ fetchBalance: async () => { throw new Error("the provider answered HTTP 500"); } });
  await assert.rejects(none.call("balance.get"), (e: WordError) => e.code === "failed" && (e.detail as any).deepseek === "the provider answered HTTP 500");

  const nothing = setup({ fetchBalance: async () => null });
  assert.equal(await code(nothing.call("balance.get")), "unavailable");
  assert.equal(await code(setup().call("balance.get")), "unavailable");
});

test("team costs are today's totals per agent, with unknown prices kept visible", async () => {
  const f = setup();
  await f.record({ caller: "agent:h", cost: 8, at: NOW - DAY });
  await f.record({ caller: "agent:h", cost: 0.1 });
  await f.record({ caller: "agent:h", model: "unknown" });
  const data = (await f.call("usage.get")).data as any;
  assert.equal(data.by_caller_today.length, 1);
  assert.equal(data.by_caller_today[0].cost_usd, 0.1);
  assert.equal(data.by_caller_today[0].unpriced_calls, 1);
  assert.equal(data.by_caller[0].cost_usd, 8.1);
});
