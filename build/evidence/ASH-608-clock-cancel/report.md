# ASH-608 plan cancellation — author evidence

This increment connects the existing AgentSheet plan page to `service:clock/cancel`. It introduces no new SDK word or route. A cancel is sent with the current registered screen token and a stable `client_id` for that timer within that screen/scope session. The page retains the timer until a strictly paired successful response is followed by an authoritative `clock.list` that no longer contains it. A missing acknowledgement, `cancelled:false`, malformed response, HTTP denial, or failed list never optimistically removes the row. An uncertain request is retried only after another explicit click, with the same `client_id`; disconnect or changed screen/scope clears the intent rather than reusing it under another identity.

The current edge is the authorization boundary. In the isolated remote browser check, `clock.list` was unavailable and no delete control appeared. A direct remote clock cancel was accepted into the audit ledger with HTTP 200 but replied `ok:false, forbidden`; the timer remained. Thus HTTP success is not treated as an effect. An unrelated remote managed-file write was rejected at HTTP 403 with no new ledger row.

Reproduce from the repository root:

```sh
node --expose-internals --import tsx --test packages/core/ui/test/sheet-agent.test.js packages/core/ui/test/clock-cancel-restart.test.ts
node --import tsx packages/core/ui/test/agent-sheet-browser-probe.mjs
ASH_TEST_DSH_ROOT=/path/to/installed/dsh node --expose-internals --import tsx --test --test-concurrency=1 packages/*/test/*.test.ts packages/core/test/arch/*.test.ts packages/core/test/contract/*.test.ts packages/core/test/fixtures/*.test.ts packages/core/test/members/*.test.ts packages/core/test/world/*.test.ts packages/core/ui/test/*.test.js packages/core/ui/test/*.test.ts
npm run -s typecheck
npm run -s build:core
npm run -s gen:ui
git diff --exit-code -- packages/core/src/ui.ts
```

Author checks: focused 12/12; installed-DSH serial full suite 461 tests, 402 pass, 59 skip, 0 fail; typecheck, core build and generated UI consistency passed; public term scan 518 files, 0 findings. The production `startOwner` plus isolated Chrome probe used temporary homes and a browser profile, then removed them. It observed a durable cancel whose HTTP acknowledgement was replaced by a synthetic 502: the timer remained on screen, there was no automatic retry, the next click reused the same identity and the ledger held one cancel request; the ensuing authoritative list removed the row. A timer cancelled elsewhere returned `cancelled:false` and remained visible until a fresh list. A separate real-core restart test replayed an uncertain `client_id` to the same request id/seq and found one durable cancel command, with an empty list afterward.

The existing activity page still lacks a production `service:work` source and F-U14 remains open. Independent QA must reproduce this candidate before F-U15 or the whole ASH-608 card is signed complete.
