# Agent sheet and managed-file shell: author checkpoint

This increment connects the avatar to a separate five-tab agent sheet. Identity and memory tabs use the already registered screen's `service:self` API; activity, upcoming, and approvals explicitly say they are not connected. They show no fabricated records, decisions, or empty-list conclusions. Settings keeps its separate drawer, including the existing pause/resume and preference editor.

Managed-file requests are checked against the current screen token, screen ID, authentication scope, registration generation, and local-management flag. The sender accepts only a response paired to the exact request ID, member, recipient, and word, then checks the screen binding again after parsing the JSON. Remote screens may read permitted files but cannot write or roll back. A scope change or offline event closes the sheet and clears drafts, pending request state, and visible text; a delayed old-screen read cannot repopulate it. User-requested closing with a dirty or uncertain edit requires confirmation. Rollback has a second explicit confirmation before sending.

The first production-browser run exposed a real editor mismatch: `USER.md` writes are canonicalized by the server with a new version header, but the editor previously compared the readback byte-for-byte to the submitted draft and falsely reported a conflict. A deterministic unit negative was red before the fix. The editor now verifies the returned hash, version, and unchanged body and adopts the server's canonical readback as its next baseline. It still rejects a stale hash without replacing the draft. In the present owner configuration a rollback is denied because the approval service is unavailable; the UI reports that limitation and the synthetic file remains unchanged. This is not evidence that end-to-end rollback works.

Focused reproduction:

```sh
node --import tsx --test packages/core/ui/test/editor.test.js packages/core/ui/test/sheet-agent.test.js packages/core/ui/test/presence.test.js packages/core/ui/test/settings.test.js
node --expose-internals --import tsx packages/core/ui/test/agent-sheet-browser-probe.mjs
```

The browser probe starts two production owner services with separate temporary homes, uses an ephemeral loopback proxy and isolated Chrome profile, and verifies: avatar opens five tabs; local `SOUL.md` and `USER.md` save/readback and version listing; stale SOUL draft cannot overwrite an authorized concurrent edit; rollback rejection leaves USER unchanged; remote identity is read-only and direct remote write returns 403 with zero ledger change; a dispatched browser offline event and an authentication-scope change clear the page; an intentionally delayed old-screen file response does not repopulate it. CDP also emulates network offline, but the test explicitly dispatches the browser event rather than claiming that CDP itself raised it. It never reads or modifies a personal workspace or device.

Pending: independent review; a real approval service for rollback; agent next-turn behavior after a SOUL edit; and complete activity/upcoming/approval pages. Neither related card is marked complete by this checkpoint.

## Integrated author verification

The source was merged with the latest `v2` containing the conversation/browser integration before verification. There was no source conflict; the generated UI was rebuilt from the combined source and a second generation produced the same SHA-256 (`f0a7eaa2eac435b9d5a461a64805d4cfa09ac23684ea6fc61fc35bf08006420b`).

```sh
ASH_TEST_DSH_ROOT=<installed runtime> npm test
npm run -s typecheck
npm run -s build:core
node --expose-internals --import tsx packages/core/ui/test/browser-probe.mjs
node --expose-internals --import tsx packages/core/ui/test/admin-browser-probe.mjs
node --expose-internals --import tsx packages/core/ui/test/preferences-browser-probe.mjs
node --expose-internals --import tsx packages/core/ui/test/conversation-browser-probe.mjs
```

Installed-runtime full suite: 387 pass / 59 intentional skip / 0 fail (446 tests); typecheck and core build passed. The new agent-sheet browser probe passed. Existing browser regressions passed: latest 200 records first rendered in 260 ms with two tabs synchronized; local pause/resume and remote 403; preference ACK-loss stable-ID retry; grouped conversation, delivery/read status, reaction placement, offline accepted exactly once, and isolated attachment compression/preservation. Public-term scan: 511 files, 0 findings. Browser profiles, homes, and loopback listeners were temporary and removed by each probe.
