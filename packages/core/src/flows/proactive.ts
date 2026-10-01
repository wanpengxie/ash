import type { Message, WorkerResult } from "../../../sdk/src/api";
import type { WorkFlow, WorkRunContext } from "../members/work";
import type { Ledger } from "../world/ledger";

async function readManaged(ctx: WorkRunContext, path: "MEMORY.md" | "PROACTIVE.md", key: string): Promise<string> {
  const reply = await ctx.send({ to: "service:self", word: "read", body: { path }, client_id: key });
  if (!reply.ok) {
    if (reply.error.code === "not_found") return "";
    throw new Error(`proactive read failed: ${reply.error.code}`);
  }
  return (reply.result as { content: string }).content;
}

/** A worker nominates; the independent Ash mind session alone decides whether to speak. */
export function proactiveFlow(ledger: Ledger): WorkFlow {
  return { name: "proactive", triggers: ["hourly", "event"], async execute(ctx) {
    const [memory, prefs] = await ctx.step("sources", async () => Promise.all([
      readManaged(ctx, "MEMORY.md", "read_memory"), readManaged(ctx, "PROACTIVE.md", "read_prefs"),
    ]));
    const facts = memory.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
      .slice(-100).map((text, index) => ({ n: index + 1, text }));
    if (!facts.length) return "no_change";
    const history = ledger.list({ before: ledger.lastSeq() + 1, limit: 1000 });
    const recent = history.filter((message) => message.kind === "request" && message.word === "say" &&
      ((message.from === "person:owner" && message.to === "agent:main") || (message.from === "agent:main" && message.to === "person:owner"))).slice(-50);
    const delivered = history.filter((message) => message.kind === "request" && message.from === "agent:main" &&
      message.to === "person:owner" && message.word === "say" && ["offer", "heads_up"].includes(String(message.body.kind)))
      .slice(-50).map((message) => ({ id: message.id, ts: message.ts, text: message.body.text }));
    const response = await ctx.step("candidate", () => ctx.send({ to: "worker:proactive", word: "proactive",
      body: { run: ctx.run, input: { prefs, recent, facts, upcoming: [], delivered } }, client_id: "candidate" }));
    if (!response.ok) throw new Error(`proactive worker failed: ${response.error.code}`);
    const candidate = response.result as WorkerResult<"proactive">;
    if ("no_change" in candidate) return "no_change";
    const cited = candidate.suggestion.facts.map((n) => facts[n - 1]).filter(Boolean);
    if (!cited.length) return "no_change";
    const justSaid = recent.filter((message): message is Message => message.from === "person:owner" &&
      message.ts >= Date.now() - 600_000);
    if (cited.every((fact) => justSaid.some((message) => typeof message.body.text === "string" &&
      (message.body.text.includes(fact.text) || fact.text.includes(message.body.text))))) return "no_change";
    await ctx.step("handoff", async () => {
      const wake = await ctx.send({ to: "agent:main", word: "wake", body: { reason: "proactive_candidate",
        context: { suggestion: candidate.suggestion, cited_facts: cited, source_run: ctx.run } }, client_id: "handoff" });
      if (!wake.ok || !(wake.result as { accepted?: boolean }).accepted) throw new Error("Ash mind did not accept suggestion");
    });
    return "done";
  } };
}
