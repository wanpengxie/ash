# ASH-307 implementation evidence (pending independent and UI joint review)

The production owner member now handles the declared `say`, `react`, and `show` receipt words and leaves `ask` pending under the existing durable router. Router recovery can redispatch an unanswered ask because the owner handler has no external effect; options, expiry, first answer, automatic denial, and retry identity remain in the router/ledger, without a second terminal-state table.

The existing authenticated `ScreenRegistry` is the sole source of screen IDs, labels, registration expiry, connection state, and visible heartbeats. A single validated `screen:*/ui.open` route accepts target IDs, and the member directory projects that same route for registered screens. Following SSE streams deliver `ui.open` requests only to the target screen; finite owner history remains complete for auditing but creates no screen or registration control frame. Disconnected live registrations remain valid for their 24-hour token window and are swept after expiry; an expired active stream is closed on its bounded keepalive check before its registration is reclaimed. Pending commands settle false before reclamation. A stream delivery does not imply success: only the registered target tab can reply through the existing send response, which the router stamps as that screen. Missing, disconnected, and expired screens settle with `opened:false` before the general request timeout; cancellation retains the router's existing semantics. The narrow `service:post/visible` member records real authenticated screen heartbeats only; delivery itself remains for ASH-302.

The SDK adds a type for the existing `ui.open` response envelope, not a new HTTP field or route. Schema tests reject extra identity fields and malformed results. A real local HTTP/SSE two-tab test, plus router-level tests, verify target-only live delivery, complete finite history, other-tab/owner-API/forged identity rejection, exact response pairing and stable retry, disconnection and expiry, 60-second visible window, cross-screen ask first answer, and ask recovery. The separate ASH-602 UI implementation provides the actual per-tab render/navigation ACK and requires joint review; no UI success is claimed by SSE delivery alone.

Reproduce from the repository root:

```sh
node --import tsx --test packages/sdk/test/v2-contract.test.ts packages/core/test/world/screens.test.ts
npm run -s typecheck
npm run -s build:core
npm test
npm run -s test:public-terms -- --terms-file "$PRIVATE_TERMS_FILE"
node --import tsx tools/spikes/v2-screen-presence.ts  # real 60-second foreground expiry
```

At this source candidate, the focused screen suite passes 12/12 and the complete test suite exits naturally with 219 pass, 57 intentional skips, and 0 failures. Typecheck and core build pass; the external private-term scanner finds 0 issues in 387 public files. The lifecycle regression covers 100 finite history pages with zero registrations, disconnected-token validity until expiry, expired-token reclamation, and an active expired stream closing while its pending command settles false. The real-time probe used production `startOwner` with explicit echo, a live local HTTP/SSE connection, two authenticated visible heartbeats, then stopped heartbeats: after 60,251 ms without a new heartbeat, foreground state was false, with exactly two ledger heartbeat events. All tests use synthetic local identities and records. ASH-302 delivery behavior and ASH-602 live UI ACK remain separate joint acceptance gates.
