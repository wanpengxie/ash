# ASH-203 — durable turn cancellation

Status: author implementation for independent review; not self-certified as complete.

## Behavior

- Only trusted internal callers may request `cancel_turn`; an idle request returns `{cancelled:false}`. Both active and idle results are durably keyed by the original request ID, so retrying an old idle request cannot cancel a future turn.
- An active stop commits its intent and one next-turn stop fact before any cross-database effect. It then synchronously settles this agent's tracked requests for that turn through the router, wakes waiters, and aborts the runner. The turn records one `cancelled` terminal state without awaiting a non-cooperative runner. External effects already started are explicitly uncertain, not claimed to be undone.
- `prepareRecovery()` must run after endpoint registration and before `router.recover()`. It idempotently settles requests covered by durable cancel intents, including when no in-memory router pending entry exists. This prevents an otherwise recoverable device request from being replayed across a crash between the inbox and ledger steps.
- The next batch stays pending while the old runner has not proved session quiescence. `AgentTurnRunner.runTurn` settlement is the quiescence proof; a turn-end event alone is insufficient. Once settled, the next batch includes the durable stop fact in the bounded text rendering. A fact is consumed only after the receiving turn is durably `completed`; error, repeat cancellation, close, or crash leave it available for a later batch, even if that repeats the fact.
- No owner-facing direct cancellation action, model binding, secondary session, or native-tool interception is added in this card.

## Reproduction

From the repository root with dependencies installed:

```sh
npm run -s typecheck
node --expose-internals --import tsx --test packages/core/test/members/agent-cancel.test.ts packages/core/test/members/agent-cancel-kill.test.ts packages/core/test/world/bootstrap.test.ts
npm test
npm run -s build:core
```

The focused tests cover an uncooperative fake device and real elapsed cancellation under one second, a still-busy runner blocking a new batch, late device success suppression, unauthorized and idle/retried requests, cancellation after claim but before runner dispatch, an output delayed before router acceptance, agent-scoped settlement, and a real child-process SIGKILL after intent commit but before ledger settlement. Recovery verifies no device replay, one cancelled response and terminal, an intact unread next batch with the stop fact, then consumption of the fact after its completed turn. Separate regressions verify that an errored turn retains the fact, a second cancellation retains both facts, and only a completed turn consumes them.

Observed after integration with the production v2 entrypoint: focused cancellation and bootstrap tests 12/12; full suite 183 passed, 57 intentional skips, 0 failed; typecheck and core build passed. Repository architecture and configured public-term checks passed with 0 findings.

## Integration boundary

The production startup path now calls `agent.prepareRecovery()` after member registration and current authorization connection, before `router.recover()`, then `agent.start()` before opening ingress. A production bootstrap regression seeds a durable stop intent and unsettled outbound request, then verifies the request is cancelled rather than replayed and the turn ends once as cancelled. The future session adapter must make `runTurn` resolve only after its underlying session is idle; this fake-runner suite cannot certify that adapter. Physical file-write isolation and native-tool routing remain separate work.
