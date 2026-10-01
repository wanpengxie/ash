# Approval sheet component (ASH-609, partial)

Base: `db1e783f43cdea33a9fe9f8ff312a479d2d74789`. This commit adds a standalone, read-only approval sheet and deterministic tests. It does not add a gate member, alter the HTTP contract, or wire a new page into the shell.

`View.asks.from` is now copied from the trusted message envelope. The sheet shows only `service:gate` asks with a valid pending state and a future expiry. It displays only offered choice labels, never creates approval actions, and never interprets a body-supplied sender. A missing source fails closed. Non-gate asks, answered/expired asks, malformed option sets, duplicated IDs and raw markup do not become actionable approvals. The sheet renders through `textContent` and has no decision or revoke button.

The production gate member is not available yet. `rules.list` and `history` item schemas are not stable, so the page labels both as unavailable instead of claiming empty data or inventing rule rows. F-U16 is therefore **not complete**: full history, rule enumeration, revocation effect, page navigation and live owner/remote behavior still need the gate service and a reviewed UI send path. The separately submitted L-029 proposal records the minimum candidate data shape; no proposed fields were added to public wire contracts here.

Reproduce from this worktree:

```sh
node --import tsx --test packages/core/ui/test/sheet-approvals.test.js packages/core/ui/test/project.test.js
npm run -s typecheck
ASH_TEST_DSH_ROOT="$DSH_INSTALL" npm test
npm run -s build:core
```

With an installed runtime in `DSH_INSTALL`, author results: focused 48/48; full suite 381 total, 322 passed, 59 intentional skips, no failures; typecheck and core build passed. The generated UI bundle was rebuilt from source because it imports the updated projection. No production route or SDK schema changed. Independent review remains required.
