# ASH-104 implementation evidence (pending integration)

This branch replaces the production HTTP entrypoint with the v2 edge. The retired v1 server, owner bootstrap, and gateway link are test-only fixtures; the production main/server/link dependency graph does not import them. No production device or deployed service was changed.

Implemented: authenticated `/api/send`, `/api/stream`, `/api/describe`, local-only workspace PUT, workspace GET, static assets, and the two MCP tools; trusted screen registration and gateway web UI principal binding; request/response pairing and bounded HTTP wait; cursor/Last-Event-ID replay; response ACK-loss deduplication in the same SQLite transaction as response settlement; host device metadata preflight and online/offline state; explicit echo-only production bootstrap. DSH configurations fail before database opening until the real turn runner is delivered by a later card. There is no business-success fallback for unregistered members.

The existing ledger migration atomically installs triggers that reject future writes to the retired `events` table. Production bootstrap does not construct the retired Store/Core writer. The v1 UI is intentionally not compatible with this edge until the separately scheduled v2 UI is installed.

Reproduction from the repository root:

```sh
npm test
npm run -s typecheck
npm run -s build:core
npm run -s test:public-terms -- --terms-file "$PRIVATE_TERMS_FILE"
```

Current completed run before agent factory integration: `npm test` exited naturally with 155 passed, 57 intentionally skipped, 0 failed. Focused v2 edge tests and L011 ledger/router tests are included. `typecheck` and `build:core` currently await the committed ASH-201 `createAgentMember` factory; they are not claimed to pass. The architecture gate currently reports only the separately scheduled worker/flow sources as missing.

The rewritten `tools/e2e-gateway.ts` requires a controlled gateway and an explicit bootstrap secret. It has not yet been executed through a real tunnel. Host integration with the updated Android v2 manifest and the production DSH runner remain separate dependencies; no approval, outward write, or device action was used as a substitute for these checks.
