// Model-free production test brain. Intake, receipts, turn events and restart
// semantics are owned by the real AgentMember durable inbox, not this runner.
import { randomUUID } from "node:crypto";
import type { AgentTurnRunner } from "../members/agent";

export class EchoTurnRunner implements AgentTurnRunner {
  async runTurn({ rendered }: Parameters<AgentTurnRunner["runTurn"]>[0], emit: Parameters<AgentTurnRunner["runTurn"]>[1], signal: AbortSignal): ReturnType<AgentTurnRunner["runTurn"]> {
    if (signal.aborted) return { reason: "error", error: "cancelled" };
    await emit({ id: randomUUID(), text: `echo: ${rendered}` });
    if (signal.aborted) return { reason: "error", error: "cancelled" };
    return { reason: "completed" };
  }
}
