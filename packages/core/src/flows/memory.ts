import type { Claim, Edit, Message, ResponseBody, WorkerInputMap, WorkerName, WorkerResult } from "../../../sdk/src/api";
import type { WorkFlow, WorkRunContext } from "../members/work";
import type { Ledger } from "../world/ledger";

function result<T>(reply: ResponseBody): T {
  if (!reply.ok) throw new Error(`memory step failed: ${reply.error.code}`);
  return reply.result as T;
}
const changed = (value: WorkerResult): value is { no_change: { checked: string[]; details: string } } => "no_change" in value;

async function worker<N extends WorkerName>(ctx: WorkRunContext, name: N, input: WorkerInputMap[N], key: string): Promise<WorkerResult<N>> {
  return result<WorkerResult<N>>(await ctx.send({ to: `worker:${name}`, word: name, body: { run: ctx.run, input }, client_id: key }));
}

function approvedClaims(claims: Claim[], verdicts: { i: number; lens: "refute" | "grounded"; pass: boolean }[]): Claim[] {
  return claims.filter((_, i) => ["refute", "grounded"].every((lens) => verdicts.some((v) => v.i === i && v.lens === lens && v.pass)));
}

function approvedEdits(edits: Edit[], verdicts: { i: number; lens: "evidence" | "temporal" | "preservation"; pass: boolean }[]): Edit[] {
  return edits.filter((_, i) => ["evidence", "temporal", "preservation"].every((lens) => verdicts.some((v) => v.i === i && v.lens === lens && v.pass)));
}

function numbered(content: string): string {
  return content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
}

/** Existing WorkMember owns scheduling and the ledger; this flow only connects its six existing words. */
export function memoryFlow(ledger: Ledger): WorkFlow {
  return { name: "memory", triggers: ["cooldown", "hourly"], async execute(ctx) {
    const window = await ctx.step("evidence", () => ledger.memoryEvidenceWindow(ctx.run));
    if (!window.some((message) => message.from === "person:owner")) return "no_change";
    const claims: Claim[] = [];
    for (let start = 0; start < window.length; start += 50) {
      const chunk = window.slice(start, start + 50);
      const output = await ctx.step("extract", () => worker(ctx, "extract", { chunk, summary: "", known: [] }, `extract_${start}`));
      if (!changed(output)) claims.push(...output.claims);
    }
    if (!claims.length) return "no_change";
    const verified = await ctx.step("verify_claims", () => worker(ctx, "verify_claims", { claims, evidence: window }, "verify_claims"));
    if (changed(verified)) throw new Error("claim verifier did not judge candidates");
    const accepted = approvedClaims(claims, verified.verdicts);
    if (!accepted.length) return "no_change";

    // Finish every model judgment before the first managed-file effect. Bad worker output leaves files untouched.
    const plans: { path: "MEMORY.md" | "USER.md"; hash: string; edits: Edit[] }[] = [];
    for (const path of ["MEMORY.md", "USER.md"] as const) {
      const key = path === "MEMORY.md" ? "memory" : "user";
      const read = await ctx.step(`read_${key}`, () => ctx.send({ to: "service:self", word: "read", body: { path }, client_id: `read_${key}` }));
      if (!read.ok && read.error.code === "not_found") continue;
      const baseline = result<{ content: string; hash: string }>(read);
      const candidate = await ctx.step(`reconcile_${key}`, () => worker(ctx, "reconcile", { file: path, numbered: numbered(baseline.content), claims: accepted }, `reconcile_${key}`));
      if (changed(candidate) || !candidate.edits.length) continue;
      const checked = await ctx.step(`verify_plan_${key}`, () => worker(ctx, "verify_plan", { file: path, before: baseline.content, edits: candidate.edits }, `verify_plan_${key}`));
      if (changed(checked)) throw new Error("plan verifier did not judge edits");
      const edits = approvedEdits(candidate.edits, checked.verdicts);
      if (edits.length) plans.push({ path, hash: baseline.hash, edits });
    }

    const date = new Date().toISOString().slice(0, 10);
    const logPath = `memory/${date}.md`;
    await ctx.step("append_log", async () => {
      const read = await ctx.send({ to: "service:self", word: "read", body: { path: logPath }, client_id: "read_log" });
      if (!read.ok && read.error.code !== "not_found") throw new Error(`memory log read failed: ${read.error.code}`);
      const prior = read.ok ? result<{ content: string }>(read).content : "";
      const lines = new Set(prior.split("\n"));
      const text = accepted.map((claim) => `- ${JSON.stringify(claim)}`).filter((line) => !lines.has(line)).map((line) => `${line}\n`).join("");
      if (text) result(await ctx.send({ to: "service:self", word: "append", body: { path: logPath, text }, client_id: "append_log" }));
    });
    for (const plan of plans) {
      const key = plan.path === "MEMORY.md" ? "memory" : "user";
      await ctx.step(`apply_${key}`, async () => {
        result(await ctx.send({ to: "service:self", word: "apply_plan", body: { path: plan.path, expected_hash: plan.hash, edits: plan.edits }, client_id: `apply_${key}` }));
      });
    }
    return "done";
  } };
}
