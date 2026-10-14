/**
 * `service:directory`: which words the caller can use (HUB-MODULES §3). The one place this filter lives; the tool
 * surface's `capability_list` / `capability_describe` call these words and only reshape the answer.
 *
 *   list {member?}              the members that have words the caller may call, each word as {name, label, needs_approval?}
 *   describe {member, word?}    the full contracts (description, schemas, effect, risk) of those words
 *
 * A word is visible when it is a request someone can call, the caller's kind passes the contract's `callers`
 * (`mayCall`; the kernel sees everything), and for an
 * agent also its own declaration (`tools` and `words`) allows it. That is the same decision as step 3 of the router.
 * Words that need the owner's approval are listed and marked `needs_approval` in `describe`.
 */
import { WordError, type Caller, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import { mayCall, wordEffect, type CallerKind, type Member, type WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { agentMay, type AgentPolicy } from "../../kernel/router";
import type { Registry } from "../../kernel/types";

export const DIRECTORY_ID = "service:directory";

export type { AgentPolicy };

export interface DirectoryOptions {
  registry: Pick<Registry, "list" | "describe">;
  /** The declaration of an agent, or null when there is no such agent. */
  agentPolicy(agent: string): AgentPolicy | null;
  /** The `member/word` patterns a fixed tool stands for; a meta tool stands for none. */
  toolWords?(tool: string): readonly string[];
  /** An app sees only what it was granted (the apps module keeps the grants). Default: nothing. */
  appGranted?(app: string, member: string, word: string): boolean;
}

const KIND: Record<Caller["via"], CallerKind | null> = { human: "owner", agent: "agent", app: "app", service: "kernel", hand: null };

/** Does the call put a question to the owner? An indication from the contract; the gate decides. */
export const needsApproval = (contract: WordContract): boolean | "per_call" => (contract.per_call_risk ? "per_call" : contract.risk !== "none");

export function createDirectoryService(options: DirectoryOptions): Member {
  const { registry } = options;

  function visible(member: string, caller: Caller): WordContract[] {
    const kind = KIND[caller.via];
    if (!kind) return [];
    const policy = caller.via === "agent" ? options.agentPolicy(caller.member) : null;
    if (caller.via === "agent" && !policy) return [];
    return (registry.describe(member)?.words ?? []).filter((c) =>
      c.kind === "request" && c.direction === "in" && mayCall(c.callers, kind)
      && (!policy || agentMay(policy, member, c.word, options.toolWords ?? (() => [])))
      && (caller.via !== "app" || options.appGranted?.(caller.member, member, c.word) === true));
  }

  const describeWord = (c: WordContract, flag: boolean) => ({
    word: c.word, label: c.label.doing, description: c.description, input_schema: c.input_schema, result_schema: c.result_schema ?? null,
    effect: wordEffect(c), risk: c.risk, ...(c.per_call_risk ? { per_call_risk: true } : {}),
    ...(flag && needsApproval(c) ? { needs_approval: needsApproval(c) } : {}), timeout_ms: c.timeout_ms ?? null,
  });

  return {
    id: DIRECTORY_ID, kind: "service", name: "Directory",
    words: (): WordContract[] => wordsOf(DIRECTORY_ID),
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      const body = (msg.body ?? {}) as { member?: string; word?: string };
      const caller = ctx.caller;
      if (msg.word === "list") {
        const flagged = caller.via === "agent" || caller.via === "app";
        const members = registry.list().map((info) => ({ info, words: visible(info.id, caller) })).filter((m) => m.words.length)
          .map(({ info, words }) => ({ id: info.id, kind: info.kind, name: info.name, online: true,
            words: words.map((c) => ({ name: c.word, label: c.label.doing, ...(flagged && needsApproval(c) ? { needs_approval: needsApproval(c) } : {}) })) }));
        if (body.member === undefined) return { data: { members } };
        const chosen = members.filter((m) => m.id === body.member);
        if (!chosen.length) throw new WordError("not_found", `no member ${body.member} with words you may call; members are ${members.map((m) => m.id).join(", ") || "none"}`);
        return { data: { members: chosen } };
      }
      if (msg.word === "describe") {
        const member = body.member!;
        const words = visible(member, caller);
        const chosen = body.word === undefined ? words : words.filter((c) => c.word === body.word);
        if (!chosen.length) throw new WordError("not_found", registry.describe(member) ? `${member} has no word ${body.word ?? ""} that you may call` : `no member ${member}`);
        return { data: { member, words: chosen.map((c) => describeWord(c, caller.via === "agent" || caller.via === "app")) } };
      }
      throw new WordError("not_found", `service:directory has no word ${msg.word}`);
    },
  };
}
