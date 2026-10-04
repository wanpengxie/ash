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
    const lastOwner = history.filter((message) => message.kind === "request" && message.from === "person:owner" &&
      message.to === "agent:main" && message.word === "say").at(-1);
    // A topic is safe to resume only when the ledger proves its turn did not complete. Completed exchanges are omitted,
    // so the opener cannot turn a stale topic summary into a second execution after the app is reopened.
    const start = lastOwner && history.find((message) => message.seq > lastOwner.seq && message.kind === "event" &&
      message.from === "agent:main" && message.word === "turn.start" && Array.isArray(message.body.ids) && message.body.ids.includes(lastOwner.id));
    const turn = typeof start?.body.turn === "string" ? start.body.turn : "";
    const replies = turn ? history.filter((message) => message.seq > start!.seq && message.turn === turn && message.kind === "request" &&
      message.from === "agent:main" && message.to === "person:owner" && message.word === "say") : [];
    const end = turn ? history.find((message) => message.seq > start!.seq && message.kind === "event" && message.from === "agent:main" &&
      message.word === "turn.end" && message.body.turn === turn) : undefined;
    const completed = end?.body.reason === "completed" && replies.length > 0;
    const lastTopic = completed || !lastOwner || !turn ? "" :
      `上次对话没有完成凭据。只能询问主人是否要继续，不能声称已经处理，也不能自动重做：${String(lastOwner.body.text ?? "")}`;
    const pending = history.filter((message) => message.kind === "event" && message.from === "device:phone" &&
      message.word === "sense.calendar" && message.body.kind === "upcoming" && message.ts >= screen.ts - awayMs)
      .slice(-20).map((message) => message.body.event);
    const changes = history.filter((message) => message.kind === "event" && message.from === "device:phone" &&
      message.word === "sense.calendar" && message.body.kind === "changed" && message.ts >= screen.ts - awayMs)
      .slice(-20).map((message) => message.body.event);
    const reply = await ctx.step("judge", () => ctx.send({ to: "worker:opener", word: "opener", body: { run: ctx.run,
      input: { away_ms: awayMs, last_topic: lastTopic, pending, changes } }, client_id: "judge" }));
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
