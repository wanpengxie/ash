import type { JsonSchema, WorkerName } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";

/** The route contract is the single source for both model instructions and validation. */
export function workerSchemas(name: WorkerName): { input: JsonSchema; result: JsonSchema } {
  const contract = wordContract(`worker:${name}`, name);
  if (!contract?.input_schema || !contract.result_schema) throw new Error(`missing worker contract: ${name}`);
  return { input: contract.input_schema, result: contract.result_schema };
}

export function parseWorkerJson(text: string): unknown {
  if (!text.trim()) throw new Error("empty worker output");
  // A fenced block, a second object, or surrounding commentary is not a JSON result.
  return JSON.parse(text) as unknown;
}
