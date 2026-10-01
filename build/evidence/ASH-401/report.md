# ASH-401 keyword reflex checkpoint

This implementation adds a no-Key reflex member using the existing outbound `reflex.judged` and internal `cancel_turn` words. There is no new wire field and no JEV call. Only newly accepted `person:owner` → `agent:main/say` requests that arrive while the agent inbox has a durable active turn are judged. An idle `say` remains ordinary inbox input and does not generate `cancel_turn`.

The fallback grammar recognizes only complete, normalized short stop commands (at most six Unicode code points), including `停`, `别发了`, `算了`, `stop`, and `wait`. A keyword substring does not grant stop authority: `别忘了明天带伞`, `我停在楼下了`, and longer/embedded English phrases are non-stops. Busy non-stops get a `reflex.judged` event with `acted:false`. A qualifying stop sends the existing request with stable client ID and original message ID as `by`; the resulting judgement records `acted:true` only if the paired response actually reports `cancelled:true`. The stop message itself remains in the durable inbox for the next turn.

The production assembly injects a read-only busy-turn accessor, so `reflex.ts` does not import another member (AR1). The reflex stamps its captured turn in the trusted internal route context; `AgentMember` refuses a stale reflex cancellation if a different turn has started before dispatch. Its normal admin cancellation path is unchanged. The existing agent cancellation implementation settles in-flight requests before aborting the DSH session; this card does not duplicate that mechanism.

Focused tests cover strict positive/negative grammar, a held synthetic turn, idle input, judged-event pairing, and a stale-turn fence. A real installed DSH test uses a synthetic model endpoint and controlled fake device held in flight: both ambiguous owner messages stay queued, a short `停` cancels in under one second without releasing the fake device, and the next model batch contains the queued text and stop fact. No real external device or user data is used.

Reproduce from the repository root:

```sh
node --import tsx --test packages/core/test/members/reflex.test.ts packages/core/test/world/describe.test.ts
ASH_TEST_DSH_ROOT=/path/to/installed/@deepseek-ai/dsh node --expose-internals --import tsx --test packages/core/test/world/reflex-dsh.test.ts
ASH_TEST_DSH_ROOT=/path/to/installed/@deepseek-ai/dsh npm test
npm run -s typecheck
npm run -s build:core
npm run -s test:public-terms -- --terms-file "$PRIVATE_TERMS_FILE"
```

Current results: synthetic+AR1 focused 9/9; real DSH reflex 1/1; installed-DSH full suite 317 passed, 59 conditional skips, 0 failures, natural exit; typecheck/build pass; public-term scan 0 findings across 446 files. The first full run correctly caught an AR1 cross-member import; it was removed and the full suite rerun green.

Scope remains narrow. JEV, semantic ambiguity resolution, pause/admin linkage, and crash-gap repair of a missing judgement event belong to later integration. This checkpoint does not mark the broader reflex feature complete or self-sign the card.
