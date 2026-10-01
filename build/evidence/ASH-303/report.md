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

The complete installed-DSH suite, run once serially and once at the repository's default concurrency after the fixes, naturally exited with 494 tests, 432 pass, 0 fail, and 62 existing intentional skips in each run. Typecheck and the core build passed; the public-term scan found 0 findings across 520 files. Earlier full runs were red: first, synthetic-device fixtures lacked grants; then a late terminal was published twice. Both failures and their focused reproductions informed the fixes above. The serial and default-concurrency final TAP transcripts are kept outside the repository for independent review.

## Scope still awaiting independent verification

The author did not exercise a real paired remote gateway in this candidate. An isolated trusted remote-owner route is covered: device use enters the ask rather than bypassing it, while remote device-access administration is rejected before ledger acceptance. Invalid owner HTTP credentials and public attempts to send `internal.approval` are also rejected before acceptance. Gateway pairing/revocation, a non-author cross-layer DSH crash replay, and independent review of permission changes at the effect boundary remain acceptance gates. No production user device, credential, or external message service was called.
