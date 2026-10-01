# Conversation completion candidate (ASH-604)

Base: `3fd0a72a21f27565a118ee9ee04a74f97d67d96c`. This increment adds an isolated Chrome probe across the real inbox member, HTTP edge, SQLite ledger and SSE projection, plus bounded static-image compression in the existing upload path. It changes no shell layout or public wire schema.

## Reproduction

```sh
node --import tsx --test packages/core/ui/test/attachments.test.js packages/core/ui/test/conversation.test.js
npm run -s gen:ui
node --expose-internals --import tsx packages/core/ui/test/conversation-browser-probe.mjs
npm run -s typecheck
ASH_TEST_DSH_ROOT="$DSH_INSTALL" npm test
npm run -s build:core
```

The browser probe uses a disposable Chrome profile, temporary ledger and synthetic messages. It deliberately holds the first HTTP send before acceptance and the real inbox `read` event after `received`, then verifies the page's sending → delivered → read stages. The real runner produces two same-turn replies and a reaction to the owner's message; Chrome shows a first/last group and the reaction only on that owner bubble. CDP network-offline mode then verifies a visible unsent placeholder, zero ledger sends while offline, and exactly one accepted owner request, one inbox dispatch and one bubble after reconnection. This is local real HTTP/SSE/Chrome with a deterministic runner, not a device or model-provider test.

The same Chrome probe uploads a generated 4096×1024 static PNG and a text document through the page. The ledger stores a 550,192-byte JPEG in place of the 14,430,737-byte PNG; authorized on-demand opening yields a 2048×512 preview. The document's bytes and MIME remain original. Deterministic canvas tests cover static PNG conversion, GIF/document byte preservation, an unsupported HEIF decoder, and output larger than input. Supported static formats are attempted only when the browser can decode them; unsupported codecs remain original and the existing 20 MiB post-selection limit still applies. This does not claim every browser can decode HEIC/HEIF.

Author results: focused 9/9; real Chrome probe passed; the existing 2/19 MiB Chrome probe passed; full suite 394 total, 335 passed, 59 intentional skips, 0 failures; typecheck, core build and public-term scan passed. The first image probe run against an unregenerated UI bundle still uploaded PNG; regenerating the bundle exposed and verified the new source behavior. The generated bundle is deliberately held for final integration with concurrent shell changes; the reproduction command generates it locally. Independent QA remains required.

## Remaining boundary

F-U03/04/05/25 are not self-signed here. The real browser chain covers synthetic local transport and an actual inbox, but not a production Android WebView, remote gateway, physical device, or external model. Existing multi-tab/ACK-loss, large binary and scope-switch probes remain separate regressions. QA must independently reproduce the fixed SHA and decide which acceptance checks can be signed; no unsupported device or backend behavior is inferred from this fixture.
