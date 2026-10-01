import type { WorkerName, WorkerRequest } from "../../packages/sdk/src/api";

export const workerCases: Array<{
  id: string;
  worker: WorkerName;
  request: WorkerRequest<WorkerName>;
  expect: "result" | "no_change" | "quiet";
  focus: string;
}>;
