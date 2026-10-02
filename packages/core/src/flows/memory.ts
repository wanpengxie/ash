import type { Claim, Edit, Message, ResponseBody, WorkerInputMap, WorkerName, WorkerResult } from "../../../sdk/src/api";
import type { WorkFlow, WorkRunContext } from "../members/work";
import type { Ledger } from "../world/ledger";
import { applySelfEdits } from "../members/self";

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
export function memoryFlow(ledger: Ledger, afterApplied?: (run: string) => void): WorkFlow {
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
    const plans: { path: "MEMORY.md" | "USER.md"; hash: string | null; edits: Edit[] }[] = [];
    for (const path of ["MEMORY.md", "USER.md"] as const) {
      const key = path === "MEMORY.md" ? "memory" : "user";
      const read = await ctx.step(`read_${key}`, () => ctx.send({ to: "service:self", word: "read", body: { path }, client_id: `read_${key}` }));
      // A file that does not exist yet starts empty; the loop creates it rather than never remembering anything.
      const baseline = !read.ok && read.error.code === "not_found" ? { content: "", hash: null } : result<{ content: string; hash: string }>(read);
      const candidate = await ctx.step(`reconcile_${key}`, () => worker(ctx, "reconcile", { file: path, numbered: numbered(baseline.content), claims: accepted }, `reconcile_${key}`));
      if (changed(candidate) || !candidate.edits.length) continue;
      // The verifier judges support against the cited messages themselves, not bare ids.
      const cited = new Set(candidate.edits.flatMap((edit) => edit.evidence));
      const evidence = window.filter((message) => cited.has(message.id));
      const checked = await ctx.step(`verify_plan_${key}`, () => worker(ctx, "verify_plan", { file: path, before: baseline.content, edits: candidate.edits, evidence }, `verify_plan_${key}`));
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
        result(await ctx.send(plan.hash === null
          ? { to: "service:self", word: "write", body: { path: plan.path, content: applySelfEdits("", plan.edits), why: "memory loop", expected_hash: null }, client_id: `apply_${key}` }
          : { to: "service:self", word: "apply_plan", body: { path: plan.path, expected_hash: plan.hash, edits: plan.edits }, client_id: `apply_${key}` }));
      });
    }
    afterApplied?.(ctx.run);
    return "done";
  } };
}
