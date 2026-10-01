# ASH-201 — durable agent inbox

Status: implementation submitted for independent review; card acceptance is not self-certified.

## Scope

- `createAgentMember` exposes one real `agent:main` `say` endpoint and an injectable turn runner. The endpoint returns accepted only after a synchronous durable inbox transaction keyed by the original ledger message ID. Only `say` opts into idempotent route recovery.
- A private SQLite WAL/FULL inbox records pending/read state and turn boundaries. Before runner dispatch, every accepted message receives a `received` event; an entire pending batch is claimed atomically in sequence order; `read` and `turn.start` precede the runner. Event client IDs are stable across repair. Completion records `turn.end`.
- On restart, a claimed active turn is ended with an explicit interruption error and never blindly rerun. Unread messages remain pending and form the next batch. Successful output has a stable per-turn/output client ID; a changed body under the same output ID is rejected.
- The runner receives full control records and a separately bounded text rendering. The default text cap is 32 KiB UTF-8, not a guarantee about a model's total context. The index and excerpt markers are budgeted first; body space is fairly shared. Truncation states exact omitted UTF-8 bytes. If the index cannot fit, the turn fails visibly without claiming messages or hot retrying.
- Close cancels cooperative work, does not wait forever for a non-cooperative runner, and prevents delayed lifecycle sends from touching a closed inbox or starting a new runner. A retained emit callback cannot publish after its turn ends. An internal abort signal is checked at the router's append boundary, so an output delayed before acceptance cannot publish after close; already accepted messages or external effects are not undone by this check.

## Reproduction

From the repository root with dependencies installed:

```sh
npm run -s typecheck
node --expose-internals --import tsx --test packages/core/test/members/agent-inbox.test.ts
npm test
npm run -s build:core
```

The focused suite includes a real child-process SIGKILL after the first reply and three durable unread messages. Recovery verifies the old turn ends in error, the three unread messages run once in sequence, no first reply is replayed, and received IDs remain unique. It also covers delayed receipt/read/start sends during close (zero new runner calls), a retained emit after turn completion, a non-cooperative runner's late emit, and an outbound reply held before router acceptance while close occurs.

Observed locally: focused 11/11; full suite 156 passed, 57 intentional skips, 0 failed; typecheck and core build passed. Repository architecture and configured public-term checks passed (0 findings).

## Boundaries

- This card does not implement turn cancellation, live model execution, or the HTTP edge. Those integrations belong to later cards. The model adapter must use `rendered` only; serializing `messages` into a model request would bypass the text cap.
- Independent verification and integration into the production edge remain pending. No card is marked complete by this report.
