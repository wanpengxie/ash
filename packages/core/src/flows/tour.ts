import type { WorkFlow } from "../members/work";
import type { Ledger } from "../world/ledger";

const hints = [
  "把今天最想解决的一件事发我，我帮你拆成第一步。",
  "有个确定时间要记着吗？告诉我时间和内容，我可以试着设提醒。",
  "你可以告诉我一个偏好；我会先确认能否把它留到以后。",
  "贴一段难读的文字给我，我帮你压成一句重点。",
  "如果某个安排很挤，把时间和必须做的事告诉我，我们一起留点余地。",
  "想换我说话的方式，直接说‘短一点’或‘先给结论’就行。",
  "这一周有什么没帮到你的地方？指出一处，我先改接下来的回答。",
] as const;

/** A whole message that only declines ("不用了", "不用了，谢谢", "别发了") stops the remaining hints; a request that merely starts with 不需要 does not. */
export function declinesTour(text: string): boolean {
  return /^[\s，。！!,.~～]*(不用了|不需要了|别再?发了|不要再发了?)[\s，。！!,.~～]*(谢谢你?|谢了|多谢)?[\s，。！!,.~～]*$/u.test(text);
}

/** Daily one-line feature invitation. The first real owner turn starts the seven-day clock. */
export function tourFlow(ledger: Ledger, now: () => number = Date.now): WorkFlow {
  return { name: "tour", triggers: ["hourly", "event"], periodMinutes: 1440, async execute(ctx) {
    const first = ledger.ownerSays({ limit: 1 })[0];
    if (!first) return "no_change";
    const day = Math.floor((now() - first.ts) / 86_400_000) + 1;
    if (day < 1 || day > 7) return "no_change";
    // At most one done run per day exists, so the done runs are the whole history however many no_change runs there were.
    const prior = ledger.workRuns("tour", 50, "done").filter((run) => run.run !== ctx.run);
    if (prior.some((run) => Math.floor((run.started_at - first.ts) / 86_400_000) + 1 === day)) return "no_change";
    const firstTour = prior.at(-1)?.ended_at;
    if (firstTour !== undefined && firstTour !== null) {
      for (let after = 0, page = ledger.ownerSays({ afterTs: firstTour, limit: 1000 }); page.length; after = page.at(-1)!.seq,
        page = ledger.ownerSays({ after, afterTs: firstTour, limit: 1000 }))
        if (page.some((message) => declinesTour(String(message.body.text ?? "")))) return "no_change";
    }
    await ctx.step("wake", async () => {
      const reply = await ctx.send({ to: "agent:main", word: "wake", body: { reason: "first_week_tour",
        context: { day, hint: hints[day - 1] } }, client_id: "wake" });
      if (!reply.ok || !(reply.result as { accepted?: boolean }).accepted) throw new Error("tour wake failed");
    });
    return "done";
  } };
}
