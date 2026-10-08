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

/** How a wake turn ended, told to whoever asked to hear (a log, a service keeping its own history). */
export interface WakeOutcome { ok: boolean; cancelled: boolean; error?: string }

/** A turn that runs longer than this is stopped so the queue behind it never stalls (a safety net, not a deadline for work). */
export const WAKE_TURN_MAX_MS = 20 * 60_000;

/**
 * The second session consumes wake requests serially; its ordinary text never enters the main conversation.
 * A wake is a trigger: the request is answered once it is queued, and the turn then lives on its own — its success or
 * failure is the agent's business (what it did it records itself), not something the request waits for or is cancelled by.
 */
export class AgentMind {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private epoch = new AbortController();

  constructor(private readonly runner: MindTurnRunner, private readonly snapshot: () => Promise<MindSnapshot>,
    private readonly settled?: (message: Message, outcome: WakeOutcome) => void) {}

  handleWake(message: Message, _signal: AbortSignal): Promise<ResponseBody> {
    if (this.closed) return Promise.resolve({ ok: false, error: { code: "offline", message: "mind unavailable" } });
    const turnSignal = this.epoch.signal;
    const run = async (): Promise<void> => {
      if (this.closed || turnSignal.aborted) { this.tell(message, { ok: false, cancelled: true }); return; }
      const limit = new AbortController();
      const stop = () => limit.abort();
      turnSignal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, WAKE_TURN_MAX_MS);
      try {
        await this.runner.runWake(message, await this.snapshot(), limit.signal);
        this.tell(message, { ok: true, cancelled: false });
      } catch (error) {
        this.tell(message, { ok: false, cancelled: limit.signal.aborted, error: error instanceof Error ? error.message : String(error) });
      } finally { clearTimeout(timer); turnSignal.removeEventListener("abort", stop); }
    };
    this.tail = this.tail.then(run, run);
    return Promise.resolve({ ok: true, result: { accepted: true } });
  }

  /** Stop the running wake turn and drop the ones queued behind it (the owner's pause). Later wakes are accepted again. */
  cancelAll(): void { this.epoch.abort(); this.epoch = new AbortController(); }

  /** Resolves when every queued wake has run (tests and orderly shutdown). */
  async idle(): Promise<void> { await this.tail; }

  async close(): Promise<void> { this.closed = true; this.epoch.abort(); await this.tail; }

  private tell(message: Message, outcome: WakeOutcome): void {
    try { this.settled?.(message, outcome); } catch { /* a listener never stops the queue */ }
  }
}
