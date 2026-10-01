# ASH-604 bounded transport slice

This is a no-device implementation of a transport boundary, not an embedded UI rollout. It adds no production Android Activity hookup, public route, credential deletion, queue migration, or automatic embedded-queue flush.

## Implemented

- The browser keeps its existing same-origin behavior. A future packaged page can inject an explicit transport with a fixed logical core endpoint and a one-way `READY` latch. Before `READY`, it neither opens the new-origin pending database nor starts the stream, sends, or flushes queued messages. Embedded queue flushing remains disabled even after `READY` in this slice.
- The UI transport admits only bounded stream, send, and validated workspace-file reads. Historical workspace references become an explicit Blob read in embedded mode rather than a direct core-origin link. The ordinary browser still uses its existing download link.
- The independent native client fixes the destination to loopback plus a constructor-provided port, uses `Proxy.NO_PROXY`, refuses redirects and unknown routes, bounds responses and stream frames, and drops replies after page invalidation. The private bootstrap URL parser accepts only the expected local root and one token parameter. Neither this parser nor the client is connected to an Activity.
- A test-only static artifact is generated from the same UI bytes as the core-served page and checked against a length and SHA-256 manifest. It is not installed or loaded by the production app.

## Reproduction

```sh
node --expose-internals --import tsx --test packages/core/ui/test/*.test.js
npm run -s typecheck
npm run -s build:core
node tools/spikes/v2-604-ui-asset.mjs
ASH_TEST_DSH_ROOT=<installed runtime> node --expose-internals --import tsx --test --test-concurrency=1 packages/*/test/*.test.ts packages/core/test/arch/*.test.ts packages/core/test/contract/*.test.ts packages/core/test/fixtures/*.test.ts packages/core/test/members/*.test.ts packages/core/test/world/*.test.ts packages/core/ui/test/*.test.js
cd android
ANDROID_HOME=<local Android SDK> JAVA_HOME=<JDK 21> ./gradlew --offline -Pandroid.useAndroidX=true :app:testDebugUnitTest --tests ai.ash.ui.transport.FixedCoreClientTest
```

At the integrated base, the UI tests passed 120/120, typecheck and core build passed, and the focused Android JVM suite passed 7/7. Deterministic negatives cover pre-ready network/database/flush, unknown routes, oversized file reads, invalid native bootstrap URLs, redirects, invalid responses, a bearer echoed by the upstream body or split across stream chunks, and replies arriving after page invalidation. The generated test-only UI was 124775 bytes with SHA-256 `347648a04ccfeea98dd42d5c69b0d5220da77ffc642515fa4ef8e06de5ad1a28`.

An initial full repository test run before the integration merge reported 431 pass, 75 intentional skips and one failure among 507 tests. Its failing test name was not captured, and it overlapped another full test process; it is not reported as a clean regression or a pass. A second overlapping run was stopped. The final integrated source was then tested alone with the installed runtime and `--test-concurrency=1`: **527 total, 464 pass, 63 intentional skips, 0 fail**, exit 0. The complete private TAP was recorded from 2026-10-01T13:03:21Z to 13:07:27Z, SHA-256 `072336f36231356be2bc031c0b33497cc7c72c92caa89356322f845eed4f55d7`. This clean result does not remove the embedded-origin safety gates below.

## Gates not satisfied

The native client has no verified WebView main-frame caller or message-port binding; `beginPage` accepts a value that a future caller must prove. Likewise, `authorizeReady()` is an internal latch release, **not** an authorization proof that JavaScript may grant itself. A future native integration must verify the page source, current principal and completed queue migration before releasing it. This slice is therefore not an authorization boundary in the running app. Live stream delivery, real same-package pending-store export/import, crash checkpoints, current authentication-scope matching, selective old-cookie removal, and zero credential egress across all WebView network paths remain unverified. The current app continues to use its original UI entry. No queue may be automatically retried after a credential change or unknown acknowledgement without separate recovery approval. ASH-604's embedded-origin safety gate remains open.

## Integration with later UI baseline

This candidate semantically merges `origin/v2` at `f83ac6352c1a756bd27e2caecb76ee59e2b2d04a`. The only conflict was generated `packages/core/src/ui.ts`; it was regenerated from the merged UI sources. The merged shell retains the newer approval-sheet wiring while the explicit transport and boot latch remain unchanged. There is still no `HomeActivity` hookup, cookie removal, queue migration, or automatic embedded flush.

On this merged source, focused UI tests passed **125/125**, `npm run -s typecheck` and `npm run -s build:core` passed, and the generated test-only asset matched the core UI bytes (**132163 bytes**, SHA-256 `30658e8217ba742d90d1abe3a65eb446b3f8fde08356e2b5714f0ee24d901de6`). The older full-suite and Android JVM results above apply to the pre-merge candidate only; they are **not** presented as results for this merged candidate. Android JVM and installed-runtime full tests were deferred while another team test occupied the shared runtime slot. Independent verification is still required before integration.
