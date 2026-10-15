// The kernel's interfaces (HUB-MODULES §1.3–§1.7), written down before the modules so the tasks built in parallel
// (router and gate, hands, agents, the human edge) code against one definition. The ledger's own types live in
// ./ledger. Implementations: registry, router, gate, redact in their folders here; vault in ./vault.

import type { Caller, ErrorBody, Message, Outgoing, Reply } from "../../../sdk/src/message";
import type { MemberKind } from "../../../sdk/src/ids";
import type { Member, WordContract } from "../../../sdk/src/word";

export type { Caller, Member, Message, Outgoing, Reply, WordContract };

// ---------------------------------------------------------------------------------------------------------------------
// registry (§1.3): who is here now and which words each speaks. In memory only.
// ---------------------------------------------------------------------------------------------------------------------

export interface MemberInfo {
  id: string;
  kind: MemberKind;
  name: string;
}

export interface Registry {
  /** The same id again replaces the member (a hand reconnects, a manifest changes). */
  add(m: Member): void;
  remove(id: string): void;
  /** The member with this id, if it is here (a named event is delivered to it whether or not it declares the event). */
  get(id: string): Member | null;
  /** null when the member is not here (the router answers `offline`) or does not speak the word (`not_found`). */
  find(to: string, word: string): { member: Member; contract: WordContract } | null;
  /** Members that speak a word, e.g. who can do health.read; online local ones first. */
  findByWord(word: string, prefer?: { kind?: MemberKind }): Member[];
  /** Members that asked to hear this event (`listens`, exact or a prefix like "sense.*"). */
  listeners(word: string): Member[];
  list(filter?: { kind?: MemberKind }): MemberInfo[];
  describe(id: string): { info: MemberInfo; words: WordContract[] } | null;
  onChange(cb: (id: string, change: "added" | "removed") => void): () => void;
}

// ---------------------------------------------------------------------------------------------------------------------
// router (§1.4): the one way a word reaches a member, in seven fixed steps.
// ---------------------------------------------------------------------------------------------------------------------

export interface SendOptions {
  signal?: AbortSignal;
  /** The request's message id when the caller needs it before the reply (the human edge answers send at once). */
  id?: string;
  /** Approval metadata from an agent's tool call. */
  approval?: { ttl_minutes?: number; purpose?: string };
  /** Called when the router holds this call for the owner's answer for a little while (the fast path of an approval), with the time (Unix ms) it will hold until at most. */
  waiting?: (until: number) => void;
}

/** A reply, the id of the request, and the id of the response message when the ledger recorded it. */
export type SendReply = Reply & { id?: string; ref?: string };

/**
 * What the router lets an observer see of one message at its door: who, to whom, which word, how it came, and for the way out
 * whether it failed and why. Never the body. `in`: the message was stamped; `out`: the answer is leaving, whatever stopped it.
 */
export interface Traffic {
  phase: "in" | "out";
  kind: Message["kind"];
  from: string;
  to: string | null;
  word: string;
  via: Caller["via"];
  /** `out` only: the error code of a refused or failed answer. */
  error?: string;
}

export interface Router {
  /**
   * `id` is the request's message id (the router always sets it once the message is stamped, recorded or not; fakes may leave it out); `ref` is the id
   * of the response message when the ledger recorded it (a large result is an attachment of that message).
   */
  send(msg: Outgoing, caller: Caller, opts?: SendOptions): Promise<SendReply>;
  /** Read-only: the human edge's sync and the activity page. */
  subscribe(filter: { to?: string; from?: string; involving?: string; word?: string }, cb: (m: Message) => void): () => void;
  /** Once at start: unfinished dispatched requests become interrupted (`result_unknown`), never replayed. */
  recover(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// gate (§1.5): allow, ask the owner, or deny. Pure decision; asking is the router's job.
// ---------------------------------------------------------------------------------------------------------------------

export type Verdict = "allow" | "ask" | "deny";

export interface Decision {
  verdict: Verdict;
  /** Which step decided, for the audit. */
  by: string;
  /** The approval card may offer 「以后都可以」. */
  offer_always: boolean;
  reason?: string;
  /** The review model's one sentence about an "ask": what the command does and where the risk is. The approval card leads with it. */
  review_reason?: string;
  /** A line for the approval card that says what else is being allowed (a vault entry used on a body). */
  note?: string;
}

export interface Gate {
  decide(req: Message, contract: WordContract, caller: Caller): Promise<Decision>;
  /** 「以后都可以」 writes a rule; 「可以」 a five-minute carry (memory only). */
  answered(req: Message, answer: "once" | "always" | "deny"): void;
}

/** Injected at assembly; the gate touches nothing outside itself. */
export interface GateDeps {
  /** A hand's or borrowed body's tier; body:main is always "ask". */
  tier(target: string): "ask" | "full";
  mode(): "auto" | "always";
  /** Per-call assessment (10 s), e.g. a workspace write inside the work folder is "none". */
  assess?(req: Message): Promise<"none" | "outward" | "structure" | null>;
  /**
   * The vault entries a request uses by name (`$vault.<name>` in a command's environment) with the words the owner knows them by, and
   * where (「手机」, a computer's name); null when it uses none. The owner allows each name on each body once (or for good).
   */
  vaultUse?(req: Message): { names: { ref: string; label: string }[]; where: string } | null;
  /** The review model (through edges/llm); a timeout or error is "ask". `reason` is its one sentence for the owner (ask) or the agent (deny). */
  review(req: Message, contract: WordContract): Promise<{ verdict: "allow" | "ask" | "deny"; reason?: string }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// redact (§1.6): what must not reach the ledger or an agent, by contract.
// ---------------------------------------------------------------------------------------------------------------------

export interface Redact {
  /** x-ash-secret → {set: true, length: N}; x-ash-sensitive → masked. */
  forLedger(m: Message, contract: WordContract): Message;
  /** Only person:owner gets the original; everyone else the masked one. */
  forCaller(result: unknown, contract: WordContract, caller: Caller): unknown;
}

// ---------------------------------------------------------------------------------------------------------------------
// vault (§1.7): sealed keys. `use` is handed only to edges/llm and edges/agents.
// ---------------------------------------------------------------------------------------------------------------------

export interface Vault {
  set(ref: string, value: string): void;
  delete(ref: string): void;
  list(): { ref: string; set_at: number; length: number }[];
  /** Plaintext, or null when not set. */
  use(ref: string): string | null;
}

export type { ErrorBody };
