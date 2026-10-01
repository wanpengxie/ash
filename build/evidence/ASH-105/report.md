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

For the installed-runtime run, set `ASH_TEST_DSH_ROOT` to an installed DSH package directory containing `package.json` when invoking `npm test`. No provider credentials or real model are used by these tests.

The SDK tests use a controlled HTTP server with fragmented CRLF SSE, disconnects, incomplete frames, 205-row initial-gap replay, duplicate replay, scope change, 401, finite summary controls, send and describe. The production test starts the real owner entrypoint in a temporary state directory and checks authenticated describe/send/SSE, screen origin, durable inbox receipts and turn boundaries, echo output, disconnect resume, same-`client_id` acceptance, not-found and invalid-schema rejection. No model, user device or outward action is used.

After merging the current v2 baseline (which includes the activity/upcoming and approval projections), the combined focused run with an installed DSH package passed 66/66. The full suite with `ASH_TEST_DSH_ROOT` set to an installed package exited naturally with 333 pass/59 intentional skips/0 fail. Typecheck and core build passed; public-term scan: 472 files/0 findings. The merge had no overlapping source conflict; generated UI and approval files were retained unchanged. Independent review and any real-device/browser integration remain separate acceptance gates.
