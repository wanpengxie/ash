# ASH-604 implementation evidence (partial)

This checkpoint covers conversation rendering, persisted outbound retries, attachment-only messages, bounded attachment summaries, and authentication-scope isolation. It is not a whole-card sign-off. Independent QA and the final service integration remain pending.

## Boundaries

- `message.summary` is a separate read-only projection, not an original message or a sendable wire object. The database selects an explicit metadata allowlist and computes inline attachment sizes without loading their base64 data into summary pages.
- Summary pages are continuous prefixes under the page byte limit, with an explicit `stream.page_end`. Status snapshots for the same page are read in one database transaction. Raw pages are preflighted before HTTP headers and fetched one row at a time; an authorized original is requested only on attachment click.
- `auth.scope` precedes finite page content. A changed scope discards old cursor/page/DOM/outbox state and refetches the latest page for the new scope. Scope is a partition hint, not authorization; the server still binds the current screen credential.
- The renderer accepts safe raster previews only after validating the fetched original's message identity and attachment metadata. It does not expose private filesystem paths or create another download route.
- Outbound attachment bytes use the app's IndexedDB queue, scoped to the authenticated transport domain, with stable client IDs and a single-tab lease. A lost ACK retains bytes for retry; only a durable matching ACK clears them. Cold-start input before a scope is authenticated is not auto-enqueued into a guessed account.

## Reproduction

From the repository root with dependencies installed:

```sh
npm run -s typecheck
npm test
npm run -s build:core
ASH_PROBE_LARGE=1 node --expose-internals --import tsx packages/core/ui/test/browser-probe.mjs
ASH_PROBE_SWITCH=1 node --expose-internals --import tsx packages/core/ui/test/browser-probe.mjs
```

The browser probe creates isolated synthetic ledgers, server credentials and a disposable Chrome profile. It does not use a personal browser profile or user data. Its large-file mode sends 2 MiB and 19 MiB attachment-only messages through the UI, receives bounded summaries through history/SSE, and fetches each original through the existing authenticated route on click. Its switch mode changes credentials on the same origin from an A ledger with higher sequence numbers to a B ledger with lower ones; the old page is discarded and B's latest page is fetched.

At this checkpoint: full test suite **293 passed, 66 skipped, 0 failed**; typecheck and core build passed. Chrome large-file mode passed with `latestRecords=200`, `firstRenderMs=250`, `authorizedRawReads=2`; switch mode passed with `firstRenderMs=241`, `oldSeqAboveNew=true`, and `staleCursorPageDiscarded=true`. Timings are from one isolated local run, not a device performance claim. Tests also cover UTF-8 byte accounting, multi-row 4 MiB summary paging, raw over-budget HTTP 413 before headers, live oversize error without a false cursor, status snapshot folding, and malformed summary rejection.

After merging the latest runtime baseline and post delivery implementation, typecheck and core build still pass. Both Chrome modes pass again: 2/19 MiB with two authorized raw reads and 243 ms first render; same-origin credential switch with stale cursor discard and 259 ms first render. The full suite passed once with **303 passed, 66 skipped, 0 failed**, but failed on two other runs with **302 passed, 66 skipped, 1 failed**. The identified failure is the preexisting clock-host lifecycle test (`production echo bootstrap confirms host alarm on set, restart, and cancel`, `host alarm acknowledgement unavailable`); its owning lane is repairing that integration race. This merged SHA is therefore a functional checkpoint, not a final green integrated baseline.

The owning lane supplied a clock lifecycle fix, merged without a product-code conflict. On that exact integrated source, full suite **304 passed, 66 skipped, 0 failed**; typecheck and core build passed; the private-term CI scan reported 445 files and zero findings. Both Chrome modes passed once more: large-file mode first render 243 ms with two authorized raw reads; credential-switch mode first render 208 ms with stale cursor page discarded. The earlier red runs remain documented above rather than silently discarded. Independent QA still needs to sign the integrated source.

## Still pending

- Non-author QA must independently replay the browser and security negatives against the fixed integrated SHA.
- Final service integration must preserve the current per-message delivery-state snapshot and new outbound authorization behavior. The test server is isolated; it is not evidence of a complete production device deployment.
- Approval/choice UI belongs to a separate card. No assertion here marks the entire conversation card Done.
