import type { WorkerResult } from "../../../sdk/src/api";
import type { WorkFlow } from "../members/work";
import type { Ledger } from "../world/ledger";

/** An app-open sense event is the trigger; the worker judges whether Ash should greet. */
export function openerFlow(ledger: Ledger): WorkFlow {
  return { name: "opener", triggers: ["event"], async execute(ctx) {
    const history = ledger.list({ before: ledger.lastSeq() + 1, limit: 1000 });
    const screen = [...history].reverse().find((message) => message.kind === "event" && message.from === "device:phone" &&
      message.word === "sense.screen" && message.body.state === "app_open");
    const awayMs = Number(screen?.body.away_ms ?? 0);
    if (!screen || awayMs < 6 * 3_600_000) return "no_change";
    const lastTopic = history.filter((message) => message.kind === "request" && message.from === "person:owner" &&
      message.to === "agent:main" && message.word === "say").at(-1)?.body.text;
    const pending = history.filter((message) => message.kind === "event" && message.from === "device:phone" &&
      message.word === "sense.calendar" && message.body.kind === "upcoming" && message.ts >= screen.ts - awayMs)
      .slice(-20).map((message) => message.body.event);
    const changes = history.filter((message) => message.kind === "event" && message.from === "device:phone" &&
      message.word === "sense.calendar" && message.body.kind === "changed" && message.ts >= screen.ts - awayMs)
      .slice(-20).map((message) => message.body.event);
    const reply = await ctx.step("judge", () => ctx.send({ to: "worker:opener", word: "opener", body: { run: ctx.run,
      input: { away_ms: awayMs, last_topic: typeof lastTopic === "string" ? lastTopic : "", pending, changes } }, client_id: "judge" }));
    if (!reply.ok) throw new Error(`opener worker failed: ${reply.error.code}`);
    const result = reply.result as WorkerResult<"opener">;
    if ("no_change" in result || !result.speak) return "no_change";
    await ctx.step("wake", async () => {
      const wake = await ctx.send({ to: "agent:main", word: "wake", body: { reason: "app_open",
        context: { hint: result.hint ?? "", why: result.why, pending, changes } }, client_id: "wake" });
      if (!wake.ok || !(wake.result as { accepted?: boolean }).accepted) throw new Error("opener wake failed");
    });
    return "done";
  } };
}
