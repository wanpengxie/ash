# ASH-303 gate candidate

This candidate adds a durable approval case beside each protected request, an owner ask, exact-object approval rules for one isolated synthetic capability, owner-only rule/history and device-access inspection, and a root-scoped bridge to the installed DSH approval waterfall. It does not create a public `internal.approval` word. Fresh agent/device access requires an owner-issued exact capability grant; owner device calls still require the current trusted route, device permission, and risk decision. Legacy access records migrate as expiring access only, never as approval rules.

## Verification

- Installed DSH 0.2.0-rc.2 with a local synthetic model and controlled device: once, deny, cancel, a policy change before approval, and a policy change after the ask all yielded the expected zero-or-one tool effect. A spoofed call ID did not create a core parent.
- Five real `SIGKILL` points in a child process (accepted, asked, answered, dispatching, handed off) were reopened through `WorldRouter.recover()`. Unfinished DSH approvals failed closed; the old ask and parent each had at most one terminal response and were not replayed.
- A controlled clock reproduced a 1 ms deadline mismatch in the first DSH bridge implementation. Using the accepted request's persisted deadline for its ask fixed it. Separate clock tests cover default 600 s, explicit 90 s, and explicit 900 s total deadlines; an approval at 599 s may dispatch at 601 s under a 900 s parent deadline.
- A committed device-access revocation between authorization and dispatch is rechecked within the dispatch SQLite transaction. Changing DSH approval policy from ask to never and back invalidates the prior policy-event identity before handoff. External credential/device policy remains subject to an immediate in-process recheck; this is not a claim that an external effect can be undone.
- Regressions that wait on synthetic agent device calls now obtain exact device access through the authenticated local owner route first. The old fixtures had assumed implicit access and could hang after the new deny-by-default rule. The retired baseline's three corresponding installed-DSH tests passed without those grants; the updated fixtures pass with them.
- A late non-cooperative handler originally caused a committed cancellation response to be published twice (one ledger response). The handler continuation now returns before observing a precommitted response when its pending call is already settled; the pre-existing late-result regression passed four consecutive focused runs.

Commands from the repository root:

```sh
ASH_TEST_DSH_ROOT=/path/to/installed/dsh node --expose-internals --import tsx --test packages/core/test/world/gate-dsh.test.ts packages/core/test/world/gate-http.test.ts packages/core/test/world/gate-ledger.test.ts packages/core/test/world/gate-router.test.ts
ASH_TEST_DSH_ROOT=/path/to/installed/dsh npm test
npm run -s typecheck
npm run -s build:core
npm run -s test:public-terms -- --terms-file /path/to/private/terms
```

Before integration with the newer v2 UI, the complete installed-DSH suite naturally exited with 494 tests, 432 pass, 0 fail, and 62 skips in both a serial and default-concurrency run (59 pre-existing skips plus 3 new SDK route skeleton skips; these are not runtime passes). Earlier full runs were red: first, synthetic-device fixtures lacked grants; then a late terminal was published twice. Both failures and their focused reproductions informed the fixes above.

After merging v2 through PR51, the four gate-focused files passed 35/35. The installed-DSH serial full suite naturally exited with 499 tests, 437 pass, 0 fail, and 62 skips. Typecheck and the core build passed; the public-term scan found 0 findings across 524 files. Default-concurrency full suite was **not green**: two existing strict one-second reflex-stop timing tests failed under load (499 tests, 435 pass, 2 fail, 62 skips). The same two tests also failed in a clean origin/v2 baseline under the identical default-concurrency command (456 tests, 395 pass, 2 fail, 59 skips), while the two reflex test files passed 4/4 when run together alone on both trees. The timing requirement was not weakened. Complete TAP transcripts for the merged and baseline runs are kept privately outside the repository.

After PR52, the only merge conflict was the generated UI bundle; regenerating it from the merged source retained the clock-cancel sheet and the gate changes. The gate-plus-clock-cancel focused set passed 47/47. The installed-DSH serial full suite naturally exited with 504 tests, 442 pass, 0 fail, and 62 skips. Typecheck, core build and repeat UI generation passed without tracked changes; the public-term scan found 0 findings across 526 files. The earlier default-concurrency reflex timing failure remains documented above and is not presented as a green full-suite result.

## Scope still awaiting independent verification

The author exercised a fresh local Worker/DO gateway with synthetic pairing credentials, production OwnerLink, and a synthetic device: trusted remote-owner device use entered an ask before one effect, remote access administration returned 403 with zero acceptance, credential mismatch returned 401 with zero acceptance, and revocation blocked a later call. This is not production gateway or real-device validation. Public attempts to send `internal.approval` are rejected before acceptance. Independent cross-layer DSH crash replay, real-device permission changes at the effect boundary, and owner-facing presentation remain acceptance gates. No production user device, credential, or external message service was called.
