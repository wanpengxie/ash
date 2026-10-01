import type { WorkerName, WorkerRequest } from "../../../sdk/src/api";
import { DATA_NOT_INSTRUCTIONS_RULE } from "./rules.generated";
import { workerSchemas } from "./schema";

const steps: Record<WorkerName, string> = {
  extract: "Identify candidate claims that the supplied conversation actually supports. Preserve the supporting message ids and exact owner wording when relevant.",
  verify_claims: "Judge each candidate against the supplied messages for contradiction and grounding. Return a verdict for each considered index.",
  reconcile: "Propose only line edits justified by the supplied claims and numbered file. Do not apply edits yourself.",
  verify_plan: "Evaluate each proposed edit against the before text for evidence, time consistency, and preservation.",
  proactive: "Judge whether the supplied facts warrant a useful suggestion. Cite the numbered facts that support it.",
  opener: "Judge whether there is a timely reason to open with a short message after the absence.",
};

const selected: Record<WorkerName, readonly string[]> = {
  extract: [DATA_NOT_INSTRUCTIONS_RULE],
  verify_claims: [DATA_NOT_INSTRUCTIONS_RULE],
  reconcile: [DATA_NOT_INSTRUCTIONS_RULE],
  verify_plan: [DATA_NOT_INSTRUCTIONS_RULE],
  proactive: [DATA_NOT_INSTRUCTIONS_RULE],
  opener: [DATA_NOT_INSTRUCTIONS_RULE],
};
const safeJson = (value: unknown): string => JSON.stringify(value).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");

/** Pure prompt compiler. Formal validation remains in code, independent of these words. */
export function compileWorker<N extends WorkerName>(name: N, request: WorkerRequest<N>): { system: string; user: string } {
  const { result } = workerSchemas(name);
  if (!steps[name]) throw new Error(`unknown worker: ${name}`);
  return {
    system: [
      "这是后台的一步，你不直接对用户说话",
      steps[name],
      ...selected[name],
      "Return exactly one JSON value. A no_change object is allowed when the evidence does not support a result.",
    ].join("\n\n"),
    user: `<data source="worker:${name}/input">\n${safeJson(request.input)}\n</data>\n\nOutput schema: ${JSON.stringify(result)}`,
  };
}
