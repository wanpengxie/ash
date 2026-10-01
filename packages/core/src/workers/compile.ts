import type { WorkerName, WorkerRequest } from "../../../sdk/src/api";
import { DATA_NOT_INSTRUCTIONS_RULE } from "./rules.generated";
import { WORKER_STEP_TEXT } from "./steps.generated";
import { workerSchemas } from "./schema";

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
  if (!WORKER_STEP_TEXT[name]) throw new Error(`unknown worker: ${name}`);
  return {
    system: [
      "这是后台的一步，你不直接对用户说话",
      WORKER_STEP_TEXT[name],
      ...selected[name],
      "Return exactly one JSON value. A no_change object is allowed when the evidence does not support a result.",
    ].join("\n\n"),
    user: `<data source="worker:${name}/input">\n${safeJson(request.input)}\n</data>\n\nOutput schema: ${JSON.stringify(result)}`,
  };
}
