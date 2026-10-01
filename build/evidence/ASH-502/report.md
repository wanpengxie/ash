# ASH-502 work-controller foundation

This increment registers a real `service:work` member, but deliberately registers no production flow. Until a later flow implementation is present, `run` reports `not_found`, `runs` is empty, and no `run.start` is manufactured. Controlled tests inject a pure-code flow to exercise the controller without invoking a user model, device, or file operation.

The run row and `run.start` event commit in one SQLite transaction. The terminal row and `run.end` event do likewise. A partial transaction is rolled back; an active run found after restart becomes one failed/unknown terminal record and is not replayed. Each flow has one active-run mutex. The in-process hourly trigger records a unique slot, consumes a paused slot without later backfill, and never creates a second host alarm. A cooldown trigger uses the latest completed main turn and waits five minutes without an intervening owner message. These are process-level foundations, not an Android sleep/Doze guarantee.

The SDK constrains run IDs, program-owned flow and step names, outcome and trigger enums, terminal detail codes, and bounded `runs` metadata. `run.step` is outbound-only and contains no task result. A controlled flow sends through the ordinary paired router with a stable run-scoped call key. Pause/cancel settles a blocked run without waiting for a non-cooperative task, and late completion cannot create a second `run.end`; cancellation does not claim to undo an unknown external effect.

## Reproduction

From the repository root:

```sh
node --expose-internals --import tsx --test packages/core/test/members/work.test.ts packages/core/test/world/work-http.test.ts packages/core/test/world/gate-router.test.ts packages/core/test/world/gate-ledger.test.ts packages/sdk/test/work-contract.test.ts packages/sdk/test/gate-contract.test.ts
ASH_TEST_DSH_ROOT=/path/to/installed/dsh node --expose-internals --import tsx --test --test-concurrency=1 packages/*/test/*.test.ts packages/core/test/arch/*.test.ts packages/core/test/contract/*.test.ts packages/core/test/fixtures/*.test.ts packages/core/test/members/*.test.ts packages/core/test/world/*.test.ts packages/core/ui/test/*.test.js
npm run -s typecheck
npm run -s build:core
npm run -s gen:ui
npm run -s test:public-terms -- --terms-file /path/to/private/terms
```

The work-focused test includes six real child-process `SIGKILL` points around the start/end commits. The production HTTP test starts the echo entrypoint and verifies that an unimplemented flow does not create a successful run. On the merged gate baseline, the focused work/gate/SDK set passed 44/44, typecheck and core build passed, and the public-term scan found zero findings in 532 files. A complete serial installed-DSH run before the gate merge passed 475 tests: 415 pass, 60 intentional skips, zero failures. One later run overlapped another agent's timing suite and was stopped; its partial output is excluded from results.

The post-merge serial full run naturally exited with **518 tests, 454 pass, 63 skips, and one failure**. The only failure was an existing strict one-second reflex-stop assertion during an installed-DSH turn; all work tests passed. Under the same isolated single-file command, this candidate and the exact merged-v2 baseline both failed at that assertion; an older pre-gate v2 baseline failed there too. This comparison does not satisfy or relax the one-second requirement, and the full run is not reported as green. The complete TAP transcripts remain in a private review directory rather than this public repository. The 63 skips comprise 59 earlier route skeletons, three gate SDK skeletons, and one work SDK skeleton; none are runtime passes.

This is a narrow infrastructure checkpoint. No production memory or opening flow is registered, no real model quality is evaluated here, and the full background-work acceptance gates remain open.
