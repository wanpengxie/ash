# ASH-901 · SSE response lifecycle cleanup

The HTTP adapter now registers SSE cleanup on the response's `close` event, not on the request. If a client disconnects before asynchronous routing finishes, the already-closed response triggers cleanup immediately when stream setup completes. The callback is one-shot. This releases the stream's subscription and keepalive timer after a client disconnect or `server.closeAllConnections()` during shutdown.

The focused regression uses a small stream fixture and covers ordinary disconnect, server shutdown, and disconnect-before-route-completion. It asserts one cleanup callback and zero remaining fixture intervals. It does not alter test runner flags or close unrelated sockets.

Reproduce from the repository root with dependencies installed:

```sh
npm run -s typecheck
node --expose-internals --import tsx --test packages/core/test/sdk-contract.test.ts packages/core/test/sse-cleanup.test.ts
node --expose-internals --import tsx --test packages/*/test/*.test.ts packages/core/test/arch/*.test.ts packages/core/test/contract/*.test.ts packages/core/test/fixtures/*.test.ts packages/core/test/world/*.test.ts packages/core/ui/test/*.test.js
```

Observed without `--test-force-exit`: typecheck passed; SDK plus focused tests 15/15 passed and exited naturally in about 10 seconds; full suite 171 total, 114 passed, 57 explicitly skipped, 0 failed, and exited naturally in about 10 seconds. Independent reproduction is still required before the architecture card is signed.
