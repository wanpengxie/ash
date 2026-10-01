# ASH-610 F-U18/F-U19: isolated editor verification

Scope: tests only, based on `v2` at `f83ac6352c1a756bd27e2caecb76ee59e2b2d04a`. No production editor, shell, SDK or wire change. The tests create a temporary owner state/home and an isolated Chrome profile; synthetic file contents are removed on exit. They never address a personal workspace.

Run from the repository root with the project's dependencies installed:

```sh
node --import tsx packages/core/ui/test/managed-editor-browser-probe.mjs
node --import tsx packages/core/ui/test/agent-sheet-browser-probe.mjs
node --import tsx --test packages/core/ui/test/editor.test.js packages/core/ui/test/sheets.test.js packages/core/test/members/self.test.ts packages/core/test/world/self-ui-http.test.ts
npm run -s typecheck
```

Observed locally: both real Chrome probes passed; focused Node tests passed 26/26; typecheck passed. No installed-DSH full suite was run during the shared heavy-test window.

The new probe checks:

- USER is edited twice through the registered local browser screen. A denied Gate ask leaves the current bytes, snapshots and `self.changed` count unchanged. A separate `once` answer restores the earlier snapshot and the UI reads the canonical USER version 3 back from the service.
- An unanswered rollback is expired by invoking the real router deadline callback under a test-only controlled clock set to the persisted Gate expiry. The Gate records `timeout`; a late approval is rejected; file, snapshots and events stay unchanged. This accelerates the deadline path, not ten minutes of elapsed wall-clock time.
- While a later USER rollback awaits approval, a second registered browser tab writes the file. Approving the earlier request returns `bad_request/stale`; it cannot undo the second tab's bytes or add a snapshot/event.
- MEMORY is edited twice and approved rollback restores the earlier bytes. Its UI shows actual snapshot timestamp/hash history without inventing USER-style numeric version metadata.
- A first tab holds an unsaved SOUL draft; a second tab explicitly refreshes and saves a newer SOUL. The first tab's stale save keeps its draft visible, while the newer file, snapshots and `self.changed` count remain unchanged. The rejected request remains in the audit ledger.

The older AgentSheet browser probe previously expected `gate unavailable`, which was only true before the durable Gate service existed. It now answers the real ask with `deny` and checks that USER remains unchanged. Its remaining shell/remote/clock checks passed unchanged, apart from an approval-panel copy assertion updated to the current explicit not-connected message.

F-U17 is not covered here: a successful SOUL write still does not prove that the next real DSH turn consumed it. That requires a separate installed-DSH prompt-ingestion test. This report is author evidence only, not independent QA acceptance or an ASH-610 whole-card completion claim.
