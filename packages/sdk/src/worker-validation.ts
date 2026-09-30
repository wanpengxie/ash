import type { Claim, WorkerName, WorkerRequest } from "./api";
import { matchesSchema } from "./schema";
import { wordContract } from "./words";

function claimErrors(claims: Claim[], evidenceIds: Set<string>): string[] {
  const errors: string[] = [];
  for (const [i, claim] of claims.entries()) {
    if (["preference", "relationship", "boundary", "correction"].includes(claim.type) && !claim.quote?.trim()) errors.push(`claims[${i}]: quote required`);
    if (claim.type === "correction" && !claim.supersedes?.trim()) errors.push(`claims[${i}]: supersedes required`);
    for (const id of claim.evidence) if (!evidenceIds.has(id)) errors.push(`claims[${i}]: unknown evidence ${id}`);
  }
  return errors;
}

/** Structural and cross-field checks for a single tool-free worker result. */
export function workerResultErrors<N extends WorkerName>(name: N, request: WorkerRequest<N>, value: unknown): string[] {
  const contract = wordContract(`worker:${name}`, name);
  if (!contract?.result_schema) return [`${name}: missing result contract`];
  if (!matchesSchema(contract.result_schema, value)) return [`${name}: result schema mismatch`];
  if (typeof value !== "object" || value === null || "no_change" in value) return [];
  if (name === "extract") {
    const claims = (value as { claims: Claim[] }).claims;
    const ids = new Set((request.input as WorkerRequest<"extract">["input"]).chunk.map((message) => message.id));
    return claimErrors(claims, ids);
  }
  if (name === "reconcile") {
    const ids = new Set((request.input as WorkerRequest<"reconcile">["input"]).claims.flatMap((claim) => claim.evidence));
    const errors: string[] = [];
    for (const [i, edit] of (value as { edits: { evidence: string[] }[] }).edits.entries()) {
      for (const id of edit.evidence) if (!ids.has(id)) errors.push(`edits[${i}]: unknown evidence ${id}`);
    }
    return errors;
  }
  if (name === "verify_claims" || name === "verify_plan") {
    const length = name === "verify_claims" ? (request.input as WorkerRequest<"verify_claims">["input"]).claims.length : (request.input as WorkerRequest<"verify_plan">["input"]).edits.length;
    return (value as { verdicts: { i: number }[] }).verdicts.flatMap(({ i }) => i < 0 || i >= length ? [`verdict index ${i} out of range`] : []);
  }
  if (name === "proactive") {
    const suggestion = (value as { suggestion: { text: string; facts: number[] } }).suggestion;
    const facts = new Set((request.input as WorkerRequest<"proactive">["input"]).facts.map((fact) => fact.n));
    const errors: string[] = [];
    if ((suggestion.text.match(/[.!?。！？]/gu) ?? []).length > 2) errors.push("suggestion: more than two sentences");
    for (const n of suggestion.facts) if (!facts.has(n)) errors.push(`suggestion: unknown fact ${n}`);
    return errors;
  }
  return [];
}
