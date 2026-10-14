// `service:llm`: the hub's small model for the owner, agents and apps (HUB-MODULES §2.9). `complete` calls `edges/llm`'s
// `complete` in the name of whoever asked, so the cost service counts the use against the caller. `keys.status` and
// `keys.check` tell whether each model key is accepted by its provider (never the key); a key saved in the vault is
// checked at once (`vault.changed`), and a removed one is forgotten.
import { WordError, type ErrorCode, type HandleContext, type Message, type WordResult } from "../../../../sdk/src/message";
import type { Member, WordContract } from "../../../../sdk/src/word";
import { wordsOf } from "../../../../sdk/src/words";
import { DEFAULT_MODEL, KEY_REF, LlmError, type Llm, type LlmMessage, type LlmErrorCode, type Provider } from "./index";

export const LLM_ID = "service:llm";
/** A completion asked for through the word may take longer than the hub's own quick judgements (5 s), within the word's 60 s. */
export const SERVICE_TIMEOUT_MS = 30_000;
/** An agent asking `keys.check` again within this long gets the last answer, so none can loop on the provider (an app cannot call it at all). The owner always asks afresh. */
export const KEY_CHECK_COOLDOWN_MS = 30_000;

const CODES: Record<LlmErrorCode, ErrorCode> = {
  bad_request: "bad_request", unknown_model: "bad_request", unavailable: "unavailable", timeout: "timeout", failed: "failed",
};
const HINTS: Partial<Record<LlmErrorCode, string>> = {
  unavailable: "No key for that model is set. The owner can set it; do not retry until then.",
  unknown_model: "Leave model out for the default, or name deepseek-flash, deepseek:<id> or openrouter:<id>.",
};

export function createLlmService(llm: Pick<Llm, "complete"> & Partial<Pick<Llm, "keys" | "verify" | "forget">>): Member {
  return {
    id: LLM_ID,
    kind: "service",
    name: "llm",
    words: (): WordContract[] => wordsOf(LLM_ID),
    listens: ["vault.changed"],
    async handle(msg: Message, ctx: HandleContext): Promise<WordResult | void> {
      if (msg.kind === "event") {
        const { ref, action } = (msg.body ?? {}) as { ref?: unknown; action?: unknown };
        const provider = (Object.keys(KEY_REF) as Provider[]).find((p) => KEY_REF[p] === ref);
        if (msg.word !== "vault.changed" || !provider || !llm.forget || !llm.verify) return;
        llm.forget(provider);
        if (action === "saved") await llm.verify(provider).catch(() => {});
        return;
      }
      if (msg.word === "keys.status" || msg.word === "keys.check") {
        if (!llm.keys || !llm.verify) throw new WordError("unavailable", "key checks are not available");
        const only = (msg.body as { provider?: Provider } | null)?.provider;
        if (msg.word === "keys.check") {
          await Promise.all((only ? [only] : (Object.keys(KEY_REF) as Provider[])).map((p) => llm.verify!(p, {})));
        }
        return { data: { keys: llm.keys().filter((k) => !only || k.provider === only) } };
      }
      if (msg.word !== "complete") throw new WordError("not_found", `${LLM_ID} has no word ${msg.word}`);
      const body = msg.body as { model?: string; messages: LlmMessage[]; max_tokens?: number };
      try {
        const out = await llm.complete(ctx.caller.member, {
          ...(body.model === undefined ? {} : { model: body.model }), messages: body.messages,
          ...(body.max_tokens === undefined ? {} : { max_tokens: body.max_tokens }), timeout_ms: SERVICE_TIMEOUT_MS,
        });
        return { data: { text: out.text, model: body.model ?? DEFAULT_MODEL, usage: { input_tokens: out.usage.input_tokens, output_tokens: out.usage.output_tokens } } };
      } catch (error) {
        if (error instanceof LlmError) throw new WordError(CODES[error.code], error.message, HINTS[error.code] ? { recovery_hint: HINTS[error.code] } : {});
        throw error;
      }
    },
  };
}
