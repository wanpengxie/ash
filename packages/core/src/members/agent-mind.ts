import type { Message, ResponseBody } from "../../../sdk/src/api";

export interface MindSnapshot {
  soul: string | null;
  identity: string | null;
  user: string | null;
  memory: string | null;
  heartbeat: string | null;
}

export interface MindTurnRunner {
  runWake(message: Message, snapshot: MindSnapshot, signal: AbortSignal): Promise<void>;
}

/** The second session consumes wake requests serially; its ordinary text never enters the main conversation. */
export class AgentMind {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly runner: MindTurnRunner, private readonly snapshot: () => Promise<MindSnapshot>) {}

  handleWake(message: Message, signal: AbortSignal): Promise<ResponseBody> {
    if (this.closed) return Promise.resolve({ ok: false, error: { code: "offline", message: "mind unavailable" } });
    const run = async (): Promise<ResponseBody> => {
      if (this.closed || signal.aborted) return { ok: false, error: { code: "cancelled", message: "wake cancelled" } };
      try {
        await this.runner.runWake(message, await this.snapshot(), signal);
        return { ok: true, result: { accepted: true } };
      } catch {
        return { ok: false, error: { code: signal.aborted ? "cancelled" : "failed", message: "mind turn failed" } };
      }
    };
    const task = this.tail.then(run, run);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async close(): Promise<void> { this.closed = true; await this.tail; }
}
