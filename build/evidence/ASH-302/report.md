# ASH-302 delivery contract checkpoint

The `service:post/deliver` result now distinguishes `dropped` from `inapp`, `notification`, and `held`. `dropped` means this delivery attempt was suppressed by a dedupe key; it does not remove or alter the original owner-targeted message or its receipt. A host attempt with an unknown outcome must return an error, not a successful `notification` channel.

The SDK test accepts each of the four exact channel values and rejects an unknown channel, extra success assertions, an absent channel, and a non-object result. The word's input and all other result fields are unchanged.

Reproduce: `node --import tsx --test packages/sdk/test/v2-contract.test.ts` (13 pass, zero skip/fail); `npm run -s typecheck` (pass).

Runtime held-queue atomicity, foreground and quiet-window classification, host presentation, and recovery remain pending at this checkpoint.

## Runtime candidate (not independently accepted)

The single production post member reuses the authenticated screen registry. A visible heartbeat updates that registry and publishes a fresh authoritative held-count snapshot. Foreground messages stay in the existing owner ledger stream; background reply, due, and valid approval requests use the authenticated host `/present` endpoint. Approval presentations preserve the original options, expiry, request ID, and initiating member as `reply_target`; no-deny options fail closed before host I/O. At startup the scanner baselines preexisting history, then derives one internal delivery request per newly accepted owner say/ask and scans for a crash gap. It does not re-notify migrated or other historical owner messages.

The post journal and `post.changed` count event use one SQLite connection and one transaction. Dedupe decisions are persisted by key and a half-open configured window; a suppressed attempt returns `dropped` while the original owner message remains intact. Quiet evaluation uses the running host's local timezone, with an injectable zone for exact cross-midnight boundary tests; no urgency field exists and no bypass is inferred. A notification attempt enters durable `dispatching` before `/present`; a restart turns an unsettled attempt into diagnosable `unknown` and does not replay external I/O. A lost host acknowledgement yields an error, never a claimed `notification` success. The synthetic spike actually kills the core child after host entry and confirms one delivery request and zero new host effects after reopen.

Held offer/headsup remains in the audit ledger and releases to in-app only at the quiet boundary; it never upgrades to a host notification. Current UI projection does not yet hide the chat bubble until release. F-S07/S13 and user-visible quiet-hour behavior remain pending a per-message delivery-state contract and projection integration; a held-count event alone is insufficient.

Reproduce candidate checks:

```sh
node --import tsx --test packages/core/test/members/post.test.ts packages/core/test/members/post-host.test.ts
node --import tsx tools/spikes/v2-post-kill.ts
ASH_TEST_DSH_ROOT="$INSTALLED_DSH_PACKAGE" npm test
npm run -s typecheck
```

The focused post suites currently pass 9/9 with zero skips/fails; the real DSH full suite exits naturally with 317 total, 259 pass, 58 intentional skips, and zero failures. The synthetic SIGKILL unknown-recovery probe passes. Independent QA and the quiet-release decision remain pending, so the card is not marked complete.
