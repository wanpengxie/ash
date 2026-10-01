import type { WorkFlow } from "../members/work";

/** The checklist belongs to Ash; an empty checklist never consumes a mind turn. */
export function heartbeatFlow(): WorkFlow {
  return { name: "heartbeat", triggers: ["hourly"], periodMinutes: 30, async execute(ctx) {
    const read = await ctx.step("read_heartbeat", () => ctx.send({ to: "service:self", word: "read",
      body: { path: "HEARTBEAT.md" }, client_id: "read_heartbeat" }));
    if (!read.ok) {
      if (read.error.code === "not_found") return "no_change";
      throw new Error(`heartbeat read failed: ${read.error.code}`);
    }
    const checklist = (read.result as { content: string }).content.trim();
    if (!checklist || checklist.split("\n").every((line) => !line.trim() || line.trim().startsWith("#"))) return "no_change";
    await ctx.step("wake", async () => {
      const reply = await ctx.send({ to: "agent:main", word: "wake", body: { reason: "heartbeat", context: { checklist } }, client_id: "wake" });
      if (!reply.ok || !(reply.result as { accepted?: boolean }).accepted) throw new Error("heartbeat wake failed");
    });
    return "done";
  } };
}
