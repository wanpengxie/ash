# ASH-302 delivery contract checkpoint

The `service:post/deliver` result now distinguishes `dropped` from `inapp`, `notification`, and `held`. `dropped` means this delivery attempt was suppressed by a dedupe key; it does not remove or alter the original owner-targeted message or its receipt. A host attempt with an unknown outcome must return an error, not a successful `notification` channel.

The SDK test accepts each of the four exact channel values and rejects an unknown channel, extra success assertions, an absent channel, and a non-object result. The word's input and all other result fields are unchanged.

The subsequent bounded-visibility SDK checkpoint adds a service-only `post.delivery` event and an unnumbered `post.delivery.snapshot` stream control frame. The snapshot contract rejects more than 1000 entries, duplicate message IDs, invalid states, and versions beyond its ledger watermark. It never advances a ledger cursor or acts as a screen credential.

The proactive-message contract also permits a bounded opaque dedupe key only on offer/headsup at initial `say` acceptance. Replies and due messages reject it, and explicit delivery uses the same key format. Reproduce: `node --import tsx --test packages/sdk/test/v2-contract.test.ts` (16 pass, zero skip/fail); `npm run -s typecheck` (pass).

Runtime held-queue atomicity, foreground and quiet-window classification, host presentation, and recovery remain pending at this checkpoint.

## Runtime candidate (not independently accepted)

The single production post member reuses the authenticated screen registry. A visible heartbeat updates that registry and publishes a fresh authoritative held-count snapshot. Foreground messages stay in the existing owner ledger stream; background reply, due, and valid approval requests use the authenticated host `/present` endpoint. Approval presentations preserve the original options, expiry, request ID, and initiating member as `reply_target`; no-deny options fail closed before host I/O. At startup the scanner baselines preexisting history, then derives one internal delivery request per newly accepted owner say/ask and scans for a crash gap. It does not re-notify migrated or other historical owner messages.

The post journal and `post.changed` count event use one SQLite connection and one transaction. Dedupe decisions are persisted by key and a half-open configured window; a suppressed attempt returns `dropped` while the original owner message remains intact. Quiet evaluation uses the running host's local timezone, with an injectable zone for exact cross-midnight boundary tests; no urgency field exists and no bypass is inferred. A notification attempt enters durable `dispatching` before `/present`; a restart turns an unsettled attempt into diagnosable `unknown` and does not replay external I/O. A lost host acknowledgement yields an error, never a claimed `notification` success. The synthetic spike actually kills the core child after host entry and confirms one delivery request and zero new host effects after reopen.

Held offer/headsup remains in the audit ledger and releases to in-app only at the quiet boundary; it never upgrades to a host notification. Its held/released/dropped event and journal transition share the same SQLite transaction as the held-count update. A finite history page and its per-ID latest-state snapshot share one SQLite read transaction, avoiding an unbounded ledger scan. The live stream sends its first snapshot before replaying from the original cursor, so a transition in the registration gap is replayed as a numbered ledger event. A synthetic day-one offer released on day two appears in its old-page state snapshot; a synthetic release between snapshot and subscription is also replayed. UI projection and a two-tab browser were separately exercised in an isolated joint checkout; that integration is not yet part of this branch.

For proactive dedupe, the router refuses keyed owner messages from owner API/web, device, remote, or unrelated services before the first ledger write. Only trusted local main-agent and work-service contexts may submit one. Recovery rejects a keyed message whose stored source fails the same narrow identity check and still calls the current authority hook. The automatic scanner passes the immutable key from the original owner message into its stable `post:<message.id>` delivery request. An explicit delivery cannot add, omit, or replace a proactive key after the owner message was accepted. With the production scanner enabled, two distinct keyed messages yield one in-app classification and one dropped classification; retrying the first client ID yields the same message and no second classification. A synthetic production-entrypoint child is actually killed after the first classification: on reopen it neither resubmits that message nor revives a stranded work-service request that current production authorization rejects, and a later matching offer is dropped.

Reproduce candidate checks:

```sh
node --import tsx --test packages/core/test/members/post.test.ts packages/core/test/members/post-host.test.ts packages/core/test/members/post-key-kill.test.ts
node --import tsx tools/spikes/v2-post-kill.ts
ASH_TEST_DSH_ROOT="$INSTALLED_DSH_PACKAGE" npm test
npm run -s typecheck
```

The focused post suites currently pass 18/18 with zero skips/fails. The concurrent post-plus-SDK test combination also passes 34/34; its host test waits for both the observed `/present` call and the durable paired response, avoiding an assertion before settlement. After merging current v2, the full suite with the installed DSH runtime exits naturally with 340 total, 281 pass, 59 intentional skips, and zero failures. Typecheck and core build pass, and the public-content scan reports zero findings across 434 files. The synthetic SIGKILL unknown-recovery probe and keyed production-restart child test pass. Bounded summary streaming and final UI/browser integration are separate pending work; this card is not marked complete.
