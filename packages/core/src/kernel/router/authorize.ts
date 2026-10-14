/**
 * Step 3 of `send` (SPEC-01 §5.2). An event is allowed when the sender's own words declare it. A request first meets the
 * contract's `callers`, then what the caller's own declaration allows (agents), then the few
 * structural rules, each of which has a test. Returns the refusal or null.
 */
import { isAgentId, OWNER_ID } from "../../../../sdk/src/ids";
import { errorBody, type ErrorBody } from "../../../../sdk/src/message";
import { mayCall, type CallerKind } from "../../../../sdk/src/word";
import type { Ledger } from "../ledger";
import type { Caller, Message, WordContract } from "../types";
import { mayReadAttachment } from "./attachments";
import { agentMay, type AgentPolicy } from "./policy";

export type { AgentPolicy } from "./policy";

export interface AuthDeps {
  ledger: Pick<Ledger, "db" | "get">;
  /** The declaration of an agent, or null when there is no such agent (SPEC-08; the agents module owns it). */
  agentPolicy(agentId: string): AgentPolicy | null;
  /** The `member/word` patterns a fixed tool stands for. Meta tools stand for none: they reach what `words` allows. */
  toolWords?(toolOrPattern: string): string[];
  /** Structural rule: a sub-agent speaks to the owner only in a turn where it was addressed directly. Default: yes. */
  mayTalkToOwner?(caller: Caller, word: string): boolean;
  /** Structural rule: `service:agents/answer` is for the agent that was asked, in the turn that took the question. Default: any turn of an agent. */
  mayAnswer?(caller: Caller, body: unknown): boolean;
  /** Structural rule: an app uses only what it was granted (`app-grants`, kept by the apps module). Default: nothing. */
  appGranted?(appId: string, to: string, word: string): boolean;
}

const forbid = (message: string, hint?: string): ErrorBody => errorBody("forbidden", message, hint ? { recovery_hint: hint } : {});

const KIND: Record<Caller["via"], CallerKind | null> = { human: "owner", agent: "agent", app: "app", service: "kernel", hand: null };

/** `senderDeclares`: for an event, the sender's own words include it. */
export function authorize(msg: Pick<Message, "to" | "word" | "kind" | "body">, contract: WordContract | null, caller: Caller, deps: AuthDeps, senderDeclares: boolean): ErrorBody | null {
  // An event: whoever sends it must have it among its own words (a hand in its manifest, a service, an app, an agent).
  if (msg.kind === "event") return senderDeclares ? null : forbid(`${caller.member} does not declare the event ${msg.word}`);

  // A hand sends events and nothing else.
  if (caller.via === "hand") return forbid("a hand can only send events");

  if (contract) {
    const kind = KIND[caller.via]!;
    if (!mayCall(contract.callers, kind)) return forbid(`${msg.to}/${msg.word} is not for a ${kind}`);
  }

  if (caller.via === "agent") {
    const policy = deps.agentPolicy(caller.member);
    if (!policy) return forbid(`${caller.member} is not a declared agent`);
    if (!agentMay(policy, msg.to ?? "", msg.word, deps.toolWords ?? (() => []))) return forbid(`${caller.member} may not use ${msg.to}/${msg.word}`, "Its declaration does not include this word.");
    // agents never say things to each other as if the owner spoke
    if (isAgentId(msg.to) && msg.word === "say") return forbid("agents cannot say to each other; use tell or ask");
    if (msg.to === OWNER_ID && deps.mayTalkToOwner && !deps.mayTalkToOwner(caller, msg.word)) return forbid("this agent may speak to the owner only in a turn where it was addressed directly");
    if (msg.to === "service:agents" && msg.word === "answer" && !(caller.turn && (deps.mayAnswer?.(caller, msg.body) ?? true))) return forbid("an answer comes from the agent that was asked, in the turn that took the question");
  }

  if (caller.via === "app" && !deps.appGranted?.(caller.member, msg.to ?? "", msg.word)) return forbid(`${caller.member} was not granted ${msg.to}/${msg.word}`, "The owner grants what an app may use when installing it.");

  // attachments follow the messages that hold them
  if (msg.to === "service:blobs" && caller.via !== "service") {
    const hash = (msg.body as { hash?: unknown } | null)?.hash;
    if (typeof hash === "string" && !mayReadAttachment(deps.ledger, caller, hash)) return forbid("this attachment belongs to messages you cannot see");
  }
  return null;
}
