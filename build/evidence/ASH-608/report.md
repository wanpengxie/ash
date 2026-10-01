# ASH-608 activity and upcoming sheets

This increment adds DOM-renderable activity and upcoming modules without changing the shared application shell. The activity projection groups ledger facts by turn, derives a deterministic title from the owner's batch, separates background runs, and retains only routing/status metadata for tool steps. Tool arguments and results are not retained for display. The upcoming controller reads the actual clock list response shape and removes a timer only after an accepted cancel and a fresh authoritative list.

Reproduce from this commit:

```sh
node --expose-internals --import tsx --test packages/core/ui/test/sheets.test.js packages/core/ui/test/project.test.js packages/core/test/members/upcoming-sheet.test.ts
npm run -s typecheck
npm test
npm run -s build:core
```

The production-entrypoint test uses a temporary echo-agent owner, authenticates through the real HTTP API, verifies empty/set/list/restart/cancel, and rejects an unauthenticated list. It does not call any real device or external host. The UI tests cover grouped turns, background separation, inert tool bodies, clock list schema, failed cancel, empty state, and refresh after cancel.

Observed on this branch: focused 49/49; full suite 315 pass, 67 conditional skips, 0 fail; typecheck and build pass. The optional external-environment suites account for the skips. Public-term scan: 459 files, 0 findings.

Remaining integration: the shared drawer shell still needs to mount these modules with an authenticated registered-screen `send` callback and composer-prefill hook. A production `service:work` source is not present, so the background-run fixture is a projection test, not an end-to-end background-activity claim. Final page-level acceptance and browser reconnect checks await shell integration. No acceptance checkbox is marked here.
