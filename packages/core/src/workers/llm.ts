import type { Message, ResponseBody, WordSpec, WorkerName, WorkerRequest } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import type { Member, WorldMembers } from "../world/member";
import type { RouteHandlerContext } from "../world/router";
import { compileWorker } from "./compile";
import { parseWorkerJson } from "./schema";
import { validateWorkerResult, workerInputErrors } from "./validate";

export const WORKER_NAMES = ["extract", "verify_claims", "reconcile", "verify_plan", "proactive", "opener"] as const satisfies readonly WorkerName[];
export interface WorkerCompletion { text: string; finish: "stop" | "incomplete" }
export interface WorkerModel {
  complete(prompt: { system: string; user: string }, signal: AbortSignal): Promise<WorkerCompletion>;
}

/** Call during owner startup before router recovery; never register a placeholder model. */
export function registerWorkerMembers(members: WorldMembers, model: WorkerModel): void {
  for (const name of WORKER_NAMES) members.register(new WorkerMember(name, model));
}

/** One member per worker word; the model has no router or file-write authority. */
export class WorkerMember<N extends WorkerName> implements Member {
  readonly id: `worker:${N}`;
  readonly kind = "worker" as const;
  readonly online = true;
  readonly name: string;
  private readonly spec: WordSpec;

  constructor(readonly worker: N, private readonly model: WorkerModel) {
    this.id = `worker:${worker}`;
    this.name = worker;
    const spec = wordContract(this.id, worker);
    if (!spec || spec.kind !== "request") throw new Error(`missing worker word: ${worker}`);
    this.spec = spec;
  }

  words(): readonly WordSpec[] { return [this.spec]; }

  async handle(message: Message, context: RouteHandlerContext): Promise<ResponseBody> {
    const request = message.body as unknown as WorkerRequest<N>;
    const inputErrors = workerInputErrors(this.worker, request);
    if (inputErrors.length) return { ok: false, error: { code: "bad_request", message: "invalid worker input" } };
    const prompt = compileWorker(this.worker, request);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "worker cancelled" } };
      let completed: WorkerCompletion;
      try {
        completed = await this.model.complete(prompt, context.signal);
      } catch {
        if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "worker cancelled" } };
        return { ok: false, error: { code: "failed", message: "worker model call failed" } };
      }
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled", message: "worker cancelled" } };
      try {
        if (completed.finish !== "stop") throw new Error("model output incomplete");
        const result = validateWorkerResult(this.worker, request, parseWorkerJson(completed.text));
        return { ok: true, result };
      } catch { /* Invalid raw output is never reflected into the ledger. */ }
    }
    return { ok: false, error: { code: "failed", message: "worker output invalid after retry" } };
  }
}
