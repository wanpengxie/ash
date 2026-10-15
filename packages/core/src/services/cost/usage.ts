// The usage table: one row per model call. `cost` is NULL when no price is known and is never turned into 0; a sum of
// costs adds up the known ones and counts the calls without a price next to it.
import type { Ledger } from "../../kernel/ledger";

export interface UsageRow {
  at: number; caller: string; provider: string; model: string;
  input_tokens: number; output_tokens: number; cost?: number; ok: boolean;
}
export interface Totals { calls: number; input_tokens: number; output_tokens: number; cost_usd: number; unpriced_calls: number }
export interface UsageCall { at: number; caller: string; provider: string; model: string; input_tokens: number; output_tokens: number; cost_usd: number | null; ok: boolean }

type Db = ReturnType<Ledger["db"]>;
type Row = Record<string, unknown>;

export function createTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      caller TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost REAL,
      ok INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cost_usage_at ON cost_usage(at);
    CREATE INDEX IF NOT EXISTS cost_usage_caller ON cost_usage(caller, at);
    CREATE TABLE IF NOT EXISTS cost_balance (
      provider TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      data TEXT NOT NULL
    );`);
}

export function insertUsage(db: Db, row: UsageRow): void {
  db.prepare("INSERT INTO cost_usage(at,caller,provider,model,input_tokens,output_tokens,cost,ok) VALUES(?,?,?,?,?,?,?,?)")
    .run(row.at, row.caller, row.provider, row.model, row.input_tokens, row.output_tokens, row.cost ?? null, row.ok ? 1 : 0);
}

export function readUsage(db: Db, since: number, caller?: string): UsageCall[] {
  const rows = (caller === undefined
    ? db.prepare("SELECT * FROM cost_usage WHERE at>=? ORDER BY at, id").all(since)
    : db.prepare("SELECT * FROM cost_usage WHERE at>=? AND caller=? ORDER BY at, id").all(since, caller)) as Row[];
  return rows.map((row) => ({ at: Number(row.at), caller: String(row.caller), provider: String(row.provider), model: String(row.model),
    input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens),
    cost_usd: row.cost === null ? null : Number(row.cost), ok: row.ok === 1 }));
}

const zero = (): Totals => ({ calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, unpriced_calls: 0 });
function add(into: Totals, call: UsageCall): void {
  into.calls++;
  into.input_tokens += call.input_tokens;
  into.output_tokens += call.output_tokens;
  if (call.cost_usd === null) into.unpriced_calls++; else into.cost_usd += call.cost_usd;
}

export function dayFormatter(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (at) => format.format(new Date(at));
}

/** Today, the last 7 and 30 days, by caller (7 days), by day (`days` of them), and the newest calls. */
export function summarize(db: Db, days: number, now: number, timeZone: string) {
  const span = Math.min(Math.max(Math.trunc(days) || 7, 1), 90);
  const dayOf = dayFormatter(timeZone);
  const dayStart = (offset: number) => dayOf(now - offset * 86_400_000);
  const first = dayStart(Math.max(span, 30) - 1);
  const today = dayOf(now), week = dayStart(6), month = dayStart(29), shown = dayStart(span - 1);
  const periods = { today: zero(), "7d": zero(), "30d": zero() };
  const byCaller = new Map<string, Totals>();
  const byCallerToday = new Map<string, Totals>();
  const byDay = new Map<string, Totals>();
  const recent: UsageCall[] = [];
  for (const call of readUsage(db, now - (Math.max(span, 30) + 1) * 86_400_000)) {
    const day = dayOf(call.at);
    if (day < first || day > today) continue;
    if (day >= month) add(periods["30d"], call);
    if (day >= week) { add(periods["7d"], call); add(byCaller.get(call.caller) ?? byCaller.set(call.caller, zero()).get(call.caller)!, call); }
    if (day === today) { add(periods.today, call); add(byCallerToday.get(call.caller) ?? byCallerToday.set(call.caller, zero()).get(call.caller)!, call); }
    if (day >= shown) add(byDay.get(day) ?? byDay.set(day, zero()).get(day)!, call);
    recent.push(call);
  }
  return {
    as_of: now, currency: "USD", estimated: true, periods,
    by_caller: [...byCaller].map(([caller, totals]) => ({ caller, ...totals })).sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls),
    by_caller_today: [...byCallerToday].map(([caller, totals]) => ({ caller, ...totals })).sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls),
    by_day: [...byDay].map(([date, totals]) => ({ date, ...totals })).sort((a, b) => a.date.localeCompare(b.date)),
    recent: recent.slice(-15).reverse(),
  };
}

/** Tokens (in plus out) one caller has used since the local day began. */
export function tokensToday(db: Db, caller: string, now: number, timeZone: string): number {
  const dayOf = dayFormatter(timeZone);
  const today = dayOf(now);
  return readUsage(db, now - 48 * 3_600_000, caller).filter((call) => dayOf(call.at) === today)
    .reduce((sum, call) => sum + call.input_tokens + call.output_tokens, 0);
}
