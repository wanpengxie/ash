# ASH-602 app shell evidence

## Scope

The UI now bundles `app.js`, `net.js`, and the existing pure projection into one served HTML document. The app uses only the documented send and stream routes. It waits for a server-issued screen registration before sending queued owner messages or foreground presence, preserves a stable `client_id` for retries, batches the latest 200 ledger records, pages backward with `before`, and resumes from `Last-Event-ID`. Older pages are sorted/deduplicated and discarded after a session reset. User text and source labels are rendered with DOM text nodes; historical records show their source and read-only status.

The shell displays `ui.open` suggestions only for its own registered screen and replies `opened:false` after rendering. Its destination pages are not yet implemented, so perform requests also reply `opened:false`; receiving a stream request is never treated as successful navigation. Historical replay does not trigger a page action. Core-side target validation and response settlement await the separate screen service integration.

## Reproduction

From the repository root:

```sh
npm run typecheck
npm test
npm run build:core
node --import tsx packages/core/ui/test/browser-probe.mjs
```

For the final architecture gate, provide the repository's separately managed private term-list path through `ASH_ARCH_PRIVATE_TERMS_FILE` and run `npm run test:arch:final`; the private list is not part of this repository.

Observed on isolated Google Chrome 145 with a temporary profile and the real HTTP edge/router over a temporary ledger: latest 200 ledger records appeared in 206, 228, 230, and 215 ms from Navigation Timing `fetchStart` to the first DOM observation, each under the 1 s target. The 200 records contain 100 owner-message bubbles and 100 responses, not 200 bubbles. Scroll-up loaded the remaining 20 earlier owner messages. Two tabs simultaneously received a new message exactly once; the persisted `origin.screen` and `origin.label` matched the sending tab and differed from the other screen. A forced TCP disconnect followed by a new message showed a numeric `Last-Event-ID` on reconnect and one displayed copy of the new message. The focused shell suite passed 9/9; full suite passed 201 with 57 skipped and 0 failed; typecheck, build, and architecture gate passed.

The browser fixture registers a fake `service:post` solely to verify the screen heartbeat transport and lifecycle. A separate real-edge negative check without that service gets HTTP 404; the UI treats 404 as failure, not presence success. This is **not** proof of production post-service registration or delivery policy.

## Still pending

- F-U21 production presence requires the real post service and its foreground/background integration; only shell transport and browser lifecycle are proven here.
- Target-screen `ui.open` settlement and navigation require the screen service and future destination pages. No perform success is claimed.
- Later conversation, cards, attachment, and settings features remain separate cards. The current shell deliberately leaves those controls inert or unavailable.
- Independent non-author review is still required before the card can be marked Done.
