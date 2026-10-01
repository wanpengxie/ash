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
cd android
ANDROID_HOME=<local Android SDK> JAVA_HOME=<JDK 21> ./gradlew --offline -Pandroid.useAndroidX=true :app:testDebugUnitTest --tests ai.ash.ui.transport.FixedCoreClientTest
```

At the integrated base, the UI tests passed 120/120, typecheck and core build passed, and the focused Android JVM suite passed 7/7. Deterministic negatives cover pre-ready network/database/flush, unknown routes, oversized file reads, invalid native bootstrap URLs, redirects, invalid responses, a bearer echoed by the upstream body or split across stream chunks, and replies arriving after page invalidation. The generated test-only UI was 124775 bytes with SHA-256 `347648a04ccfeea98dd42d5c69b0d5220da77ffc642515fa4ef8e06de5ad1a28`.

An initial full repository test run before the integration merge reported 431 pass, 75 intentional skips and one failure among 507 tests. Its failing test name was not captured, and it overlapped another full test process; it is not reported as a clean regression or a pass. A second overlapping run was stopped. A clean full run is pending an exclusive test slot.

## Gates not satisfied

The native client has no verified WebView main-frame caller or message-port binding; `beginPage` accepts a value that a future caller must prove. It is therefore not an authorization boundary in the running app. Live stream delivery, real same-package pending-store export/import, crash checkpoints, current authentication-scope matching, selective old-cookie removal, and zero credential egress across all WebView network paths remain unverified. The current app continues to use its original UI entry. No queue may be automatically retried after a credential change or unknown acknowledgement without separate recovery approval. ASH-604's embedded-origin safety gate remains open.
