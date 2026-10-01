import type { WorkerName, WorkerRequest, WorkerResult } from "../../../sdk/src/api";
import { schemaErrors } from "../../../sdk/src/schema";
import { workerResultErrors } from "../../../sdk/src/worker-validation";
import { workerSchemas } from "./schema";

export function workerInputErrors<N extends WorkerName>(name: N, request: WorkerRequest<N>): string[] {
  return schemaErrors(workerSchemas(name).input, request);
}

export function validateWorkerResult<N extends WorkerName>(name: N, request: WorkerRequest<N>, value: unknown): WorkerResult<N> {
  const errors = workerResultErrors(name, request, value);
  if (name === "extract" && errors.length === 0 && value && typeof value === "object" && "claims" in value) {
    const messages = new Map((request as WorkerRequest<"extract">).input.chunk.map((message) => [message.id, message]));
    for (const [index, claim] of (value as { claims: { type: string; quote?: string; evidence: string[] }[] }).claims.entries()) {
      if (!["preference", "relationship", "boundary", "correction"].includes(claim.type)) continue;
      const quote = claim.quote?.trim();
      if (!quote) continue; // The shared cross-field validator reports the missing quote.
      const grounded = claim.evidence.some((id) => {
        const message = messages.get(id);
        return message?.from === "person:owner" && typeof message.body.text === "string" && message.body.text.includes(quote);
      });
      if (!grounded) errors.push(`claims[${index}]: quote not found in cited owner message`);
    }
  }
  if (errors.length) throw new Error(errors.join("; "));
  return value as WorkerResult<N>;
}
