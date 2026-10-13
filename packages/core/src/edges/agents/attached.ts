/**
 * Callers that live outside Ash and are attached to it through a computer: the Codex App on a
 * computer that runs the Ash program. Each computer has one, named `agent:codex-<computer>`.
 *
 * It is an agent as far as the hub's rules go (the router judges its calls by the agent declaration, the ledger records
 * them under its id), but Ash does not run it: it is never started or stopped, gets no prompt, is no member of the
 * registry (so nobody can `ask` or `tell` it, and it is not in the agents' lists) and has no turns of its own. Its
 * declaration is the default one: no limit on tools or words beyond what the contracts say agents may call, the same
 * as an agent declared without `tools` and `words`. The gate asks the owner exactly as it does for any agent.
 *
 * The declaration lives in memory: it is made when the computer's first call arrives and goes when the computer's
 * connection ends.
 */
import type { AgentPolicy } from "../../kernel/router";

export interface AttachedCaller {
  /** `agent:codex-<computer>` */
  id: string;
  /** For the owner to read: 「<computer> 上的 Codex」. */
  name: string;
  /** The computer's hand id. */
  computer: string;
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export class AttachedCallers {
  private readonly byComputer = new Map<string, AttachedCaller>();
  private readonly byId = new Map<string, AttachedCaller>();

  /** The caller of this computer, made on first use. */
  declare(computer: string, computerName: string): AttachedCaller {
    const known = this.byComputer.get(computer);
    if (known) return known;
    const base = `agent:codex-${slug(computerName) || slug(computer).slice(0, 8) || "pc"}`.slice(0, 32).replace(/-+$/, "");
    // Two computers with one name: the second one gets the start of its hand id.
    const id = this.byId.has(base) ? `${base.slice(0, 23)}-${slug(computer).slice(0, 8)}`.replace(/-+$/, "") : base;
    const caller = { id, name: `${computerName} 上的 Codex`, computer };
    this.byComputer.set(computer, caller);
    this.byId.set(id, caller);
    return caller;
  }

  has(id: string): boolean { return this.byId.has(id); }
  get(id: string): AttachedCaller | undefined { return this.byId.get(id); }

  /** The default declaration: no `tools`, no `words`. */
  policyOf(id: string): AgentPolicy | null { return this.byId.has(id) ? {} : null; }

  /** The computer's connection ended. */
  drop(computer: string): void {
    const caller = this.byComputer.get(computer);
    if (!caller) return;
    this.byComputer.delete(computer);
    this.byId.delete(caller.id);
  }
}

/** The turn id the ledger records for a call of an attached caller: its app's session when it said which, else one per caller. */
export function attachedTurn(session: unknown): string {
  const text = typeof session === "string" ? session.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) : "";
  return text ? `codex-${text}` : "codex-session";
}
