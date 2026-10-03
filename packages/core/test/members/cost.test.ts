import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CostMember, type UsageCollector, type UsageRecord } from "../../src/members/cost";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic",
  local: true, remote: false, ownerProxy: true };
const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 3, 12);

async function fixture(rates: (provider: string, model: string) => Promise<any>) {
  const price = async (r: UsageRecord) => { const rate = await rates(r.provider, r.model); return rate ? (r.input * rate.input + r.output * rate.output + r.cacheRead * rate.cacheRead) / 1e6 : null; };
  const dir = mkdtempSync(join(tmpdir(), "ash-cost-member-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  let emit!: (record: UsageRecord) => void;
  let balance: () => Promise<unknown> = async () => ({ available: true, balances: [] });
  const collector: UsageCollector = { onUsage(listener) { emit = listener; return () => { emit = () => {}; }; }, balance: () => balance() };
  const member = new CostMember({ ledger, router, collector, price, timeZone: "UTC", now: () => NOON });
  new WorldMembers(router).register(member);
  const usage = async (days?: number) => (await router.send(owner, { to: "service:cost", kind: "request", word: "usage.get", body: days ? { days } : {}, wait: true })).reply!.body;
  return { ledger, router, member, usage, emit: (r: Partial<UsageRecord>) => emit({ at: NOON, ms: 10, scope: "chat", provider: "deepseek-official", model: "m",
    input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ok: true, ...r }),
    setBalance: (fn: () => Promise<unknown>) => { balance = fn; }, close: () => { member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("each measured call becomes one priced fact; unpriced calls are counted apart, never as zero", async () => {
  const f = await fixture(async (_p, model) => model === "known" ? { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } : null);
  try {
    f.emit({ model: "known" });
    f.emit({ model: "known", scope: "mind", input: 0, output: 1_000_000 });
    f.emit({ model: "mystery", scope: "background" });
    const body = (await f.usage()) as any;
    assert.equal(body.ok, true);
    const { periods, by_scope } = body.result;
    assert.equal(periods.today.calls, 3);
    assert.equal(periods.today.unpriced_calls, 1);
    assert.equal(periods.today.cost_usd, 10);
    assert.deepEqual(by_scope.map((row: any) => [row.scope, row.cost_usd, row.unpriced_calls]), [["mind", 8, 0], ["chat", 2, 0], ["background", 0, 1]]);
    const facts = f.ledger.list({ limit: 100 }).filter((m) => m.word === "usage.recorded");
    assert.equal(facts.length, 3);
    assert.equal(facts.find((m) => m.body.model === "mystery")!.body.cost_usd, null);
    assert.equal(facts.every((m) => m.from === "service:cost"), true);
  } finally { f.close(); }
});

test("periods follow the local day and a failed price lookup records the call unpriced", async () => {
  const f = await fixture(async (_p, model) => { if (model === "boom") throw new Error("catalog"); return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }; });
  try {
    f.emit({ at: NOON - 2 * DAY });
    f.emit({ at: NOON - 20 * DAY });
    f.emit({ at: NOON - 40 * DAY });
    f.emit({ model: "boom" });
    const { periods, by_day } = ((await f.usage(7)) as any).result;
    assert.deepEqual([periods.today.calls, periods["7d"].calls, periods["30d"].calls], [1, 2, 3]);
    assert.equal(periods.today.unpriced_calls, 1);
    assert.deepEqual(by_day.map((row: any) => row.date), ["2026-10-01", "2026-10-03"]);
  } finally { f.close(); }
});

test("a balance that cannot be read is an error, not a zero; the key never appears in the answer", async () => {
  const f = await fixture(async () => null);
  try {
    f.setBalance(async () => { throw new Error("the provider answered HTTP 401"); });
    const failed = (await f.router.send(owner, { to: "service:cost", kind: "request", word: "balance.get", body: {}, wait: true })).reply!.body as any;
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /HTTP 401/);
    f.setBalance(async () => ({ available: true, balances: [{ currency: "CNY", total: "1.00", granted: "0", topped_up: "1.00" }] }));
    const ok = (await f.router.send(owner, { to: "service:cost", kind: "request", word: "balance.get", body: {}, wait: true })).reply!.body as any;
    assert.equal(ok.result.balances[0].total, "1.00");
  } finally { f.close(); }
});
