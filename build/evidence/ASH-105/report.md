# ASH-105 v2 SDK client and echo runner

The public `AshClient` now calls only the v2 send, describe and stream routes. Its stream yields typed control frames separately from numbered messages. A delivered message advances the resume cursor; controls and incomplete frames do not. Reconnection uses `Last-Event-ID` after a numbered row, or explicit `after=0` before the first row so a large gap cannot collapse to a recent-only window. Duplicate replay rows are suppressed. Authentication-scope changes, invalid frames and 401/403 fail closed. The same caller-provided `client_id` is preserved on send retries.

The retired v1 client and echo runtime remain under test-only legacy files for their existing contract suite. The production echo runner now implements the same turn interface as the DSH adapter and is instantiated behind the durable agent inbox. It does not implement a second inbox or write lifecycle events directly.

Reproduce:

```sh
node --expose-internals --import tsx --test packages/sdk/test/client-v2.test.ts packages/core/test/world/client-v2.test.ts
npm run -s typecheck
npm test
npm run -s build:core
```

The SDK tests use a controlled HTTP server with fragmented CRLF SSE, disconnects, incomplete frames, 205-row initial-gap replay, duplicate replay, scope change, 401, finite summary controls, send and describe. The production test starts the real owner entrypoint in a temporary state directory and checks authenticated describe/send/SSE, screen origin, durable inbox receipts and turn boundaries, echo output, disconnect resume, same-`client_id` acceptance, not-found and invalid-schema rejection. No model, user device or outward action is used.

Observed: focused 6 pass/0 fail; full suite 321 pass/67 existing skips/0 fail; typecheck and core build pass; public-term scan 464 files/0 findings. Independent review and any real-device/browser integration remain separate acceptance gates.
