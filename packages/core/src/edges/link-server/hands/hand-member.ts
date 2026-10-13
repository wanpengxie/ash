/**
 * A hand's capabilities as a member (HUB-MODULES §2.3): `device:<hand_id>`, and for a bound computer `body:<hand_id>`.
 * Both are the same thing to the router: a `handle` that sends a `call` frame down the hand's connection and waits
 * for the `result` frame.
 */
import type { CapabilitySpec } from "../../../../../sdk/src/link";
import { WordError, type HandleContext, type Message, type WordResult } from "../../../../../sdk/src/message";
import { upstreamDoingLabel } from "../../../../../sdk/src/labels";
import { DEFAULT_CALLERS, wordEffect, type Member, type Risk, type WordContract } from "../../../../../sdk/src/word";
import { wordsOf } from "../../../../../sdk/src/words";
import { LinkError, type LinkSession } from "../../../../../link/src/server";

/** The deadline when a capability names none: the router's own defaults (reads 60 s, everything else 600 s). */
const READ_TIMEOUT_MS = 60_000;
const ACT_TIMEOUT_MS = 600_000;

/** What the hand declared in its manifest, as the contract of a word of `member`. The hand's effect and risk stand. */
export function capabilityContract(member: string, cap: CapabilitySpec, deviceName?: string): WordContract {
  return {
    member, word: cap.name, kind: "request", direction: "in", description: cap.description,
    input_schema: cap.input_schema,
    ...(cap.result_schema ? { result_schema: cap.result_schema } : {}),
    effect: wordEffect(cap), risk: cap.risk,
    ...(cap.per_call_risk ? { per_call_risk: true } : {}),
    ...(cap.foreground ? { foreground: true } : {}),
    callers: [...(cap.callers ?? DEFAULT_CALLERS)],
    ...(cap.timeout_ms ? { timeout_ms: cap.timeout_ms } : {}),
    // Seen on approval cards and the island: the hand's own label, else the device's name; never the capability's raw name.
    label: { doing: cap.label?.trim() ? cap.label : upstreamDoingLabel({ word: cap.name, ...(deviceName ? { owner: deviceName } : {}), ownerId: member, noun: "能力" }) },
  };
}

/** Events go to the fixed service of their namespace; nothing is broadcast (SPEC-03 §4.3). */
export const EVENT_TARGETS: Readonly<Record<string, string>> = { sense: "service:senses", widget: "service:widgets", config: "service:devices", checkup: "service:admin", codex: "service:devices" };

/**
 * An event the hand declared in its manifest, as a word the hand itself sends: the router lets a sender emit what its
 * own words declare. The schema is the one of the service the event goes to; an event that service does not know keeps
 * any object.
 */
export function eventContract(member: string, word: string): WordContract {
  const target = EVENT_TARGETS[word.slice(0, word.indexOf("."))];
  const known = target ? wordsOf(target).find((c) => c.word === word && c.kind === "event") : undefined;
  if (known) return { ...known, member, direction: "out" };
  return {
    member, word, kind: "event", direction: "out", description: `The hand reports ${word}, which it declared in its manifest.`,
    input_schema: { type: "object", additionalProperties: true }, effect: "read", risk: "none", callers: ["kernel"], label: { doing: `在报告 ${word}` },
  };
}

export interface HandMemberInit {
  /** `device:<hand_id>` or `body:<hand_id>`. */
  id: string;
  kind: "device" | "body";
  name: string;
  capabilities: readonly CapabilitySpec[];
  /** The events the manifest declares (only a device sends them; a body does not). */
  events?: readonly string[];
  /** The hand's live connection with the device channel open, or null when it is gone. */
  session(): LinkSession | null;
  /** The hand is on the local link: `registry.findByWord` prefers it. */
  local: boolean;
  now?(): number;
}

export class HandMember implements Member {
  readonly id: string;
  readonly kind: "device" | "body";
  readonly name: string;
  readonly local: boolean;
  private readonly contracts: WordContract[];
  private readonly byWord = new Map<string, WordContract>();

  constructor(private readonly init: HandMemberInit) {
    this.id = init.id;
    this.kind = init.kind;
    this.name = init.name;
    this.local = init.local;
    this.contracts = [...init.capabilities.map((cap) => capabilityContract(init.id, cap, init.name)), ...(init.events ?? []).map((word) => eventContract(init.id, word))];
    for (const contract of this.contracts) if (contract.kind === "request") this.byWord.set(contract.word, contract);
  }

  words(): WordContract[] { return this.contracts; }

  async handle(msg: Message, ctx: HandleContext): Promise<WordResult> {
    const contract = this.byWord.get(msg.word);
    if (!contract) throw new WordError("not_found", `${this.id} has no capability ${msg.word}`);
    const session = this.init.session();
    if (!session) throw new WordError("offline", `${this.name} is not connected`);
    try {
      const timeout = contract.timeout_ms ?? (contract.effect === "read" ? READ_TIMEOUT_MS : ACT_TIMEOUT_MS);
      const result = await session.call({
        capability: msg.word, args: argsOf(msg, ctx), signal: ctx.signal,
        deadline: (this.init.now ?? Date.now)() + timeout,
        caller: { member: ctx.caller.member, label: contract.label.doing, ...(ctx.caller.turn ? { turn: ctx.caller.turn } : {}) },
      });
      if (!result.ok) throw new WordError(result.error.code, result.error.message, { detail: result.error.detail, recovery_hint: result.error.recovery_hint });
      return { content: result.content, ...(result.data !== undefined ? { data: result.data } : {}) };
    } catch (error) {
      throw error instanceof LinkError ? linkProblem(error, this.name, contract) : error;
    }
  }

  /** The risk of one call, asked of the hand (the gate's `GateDeps.assess`); null = use the declared risk. */
  async assess(msg: Message): Promise<Risk | null> {
    if (!this.byWord.get(msg.word)?.per_call_risk) return null;
    const answer = await this.init.session()?.assess(msg.word, argsOf(msg));
    return answer?.risk ?? null;
  }
}

/** The request body as the hand must get it: the in-memory original (secret fields included), not the ledger's copy. */
function argsOf(msg: Message, ctx?: HandleContext): Record<string, unknown> {
  const body = ctx?.raw ?? msg.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * The connection ended or the deadline passed while the call was out. A read changes nothing, so it is `offline` /
 * `timeout` (certainly nothing done); anything else may have happened: `result_unknown` (SPEC-03 §4.4, §8).
 */
function linkProblem(error: LinkError, name: string, contract: WordContract): WordError {
  const read = contract.effect === "read";
  if (error.kind === "closed") return read ? new WordError("offline", `${name} disconnected during the call`) : new WordError("result_unknown", `${name} disconnected while ${contract.word} was running`);
  if (error.kind === "deadline") return read ? new WordError("timeout", error.message) : new WordError("result_unknown", error.message);
  return new WordError("unavailable", error.message);
}
