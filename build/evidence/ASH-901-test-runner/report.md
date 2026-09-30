# ASH-901 · Complete Node test reporting

The repository test script no longer uses `--test-force-exit`. The SSE response-lifecycle repair in this branch lets the SDK contract test release its keepalive timer and exit naturally. This is a test infrastructure repair, not acceptance of the still-pending AR1–AR15 production architecture gate.

## Reproduction

With the installed DSH tree selected via `ASH_TEST_DSH_ROOT`, run `npm run -s typecheck` and `npm test` from the repository root. Five consecutive independent `npm test` runs on the merged candidate each exited 0 and reported exactly 171 tests: 114 passed, 57 explicitly skipped, 0 failed. No fixed count is enforced in the runner, so new tests can be added without updating a magic constant.

The formerly hanging `packages/core/test/sdk-contract.test.ts` was also run alone three consecutive times without force-exit; each naturally exited 0 with 12/12 passed. The three new SSE cleanup tests passed independently on a detached checkout of their source commit.

As a negative control, the same full test command was run with an additional private fixture registering 200 skips and one deliberate assertion failure. It naturally exited 1 and reported 372 tests: 114 passed, 257 skipped, 1 failed. The private fixture and raw TAP logs are not published.

The previous forced-exit runner could produce incomplete TAP summaries with exit 0 under concurrent or serial execution. This change removes the abrupt termination rather than treating a passing exit code alone as complete evidence. These repetitions support the runner fix; they do not prove every future test or production AR requirement passes.
