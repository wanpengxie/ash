# ASH-608 AgentSheet connection — author evidence

Scope: the five-tab sheet now shows ledger-derived conversation activity and a live, read-only `service:clock/list` page. This is an incremental delivery, not completion of F-U14 or F-U15.

The activity shell removes routing-derived step labels and untrusted background flow names before display. It shows a separate notice that the production background-work source is not connected. No raw `to`/`word`, request body, or tool result is used as user-facing prose. No activity action or timer cancellation is offered by this increment.

The clock request uses the current registered `Ash-Screen` token. It displays timers only after a successful, paired `service:clock/list` response and rejects malformed timers. A failed service, mismatched reply, disconnect, changed auth scope/screen, or late response never becomes “暂无计划”. A genuinely successful empty list may show that text.

Reproduction from the repository root:

```sh
node --import tsx --test packages/core/ui/test/sheet-agent.test.js packages/core/ui/test/sheets.test.js
node --import tsx packages/core/ui/test/agent-sheet-browser-probe.mjs
ASH_TEST_DSH_ROOT=/path/to/installed/dsh npm test
npm run -s typecheck
npm run -s build:core
npm run -s gen:ui
git diff --exit-code -- packages/core/src/ui.ts
```

Author results: focused 9/9; full 449 total, 390 passed, 59 skipped, 0 failed; typecheck and build passed. Isolated production `startOwner` plus headless Chrome showed a real owner turn in activity, a synthetic timer read from the real clock service on a registered local screen, and no cancel control. The separate gateway screen remained able to chat/read identity but its clock request was unavailable; the UI displayed unavailable rather than an empty list. Offline, changed-scope, and delayed file reply checks passed. The probe creates and removes temporary homes, browser profile, and servers; it does not access personal files.

Pending: real `service:work` run/step source and background grouping end-to-end; contextual prefill; `clock.cancel` through the sheet with authoritative refresh; independent QA reproduction. Neither F-U14 nor F-U15 is marked complete.
