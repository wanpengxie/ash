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

After local integration of the fixed ASH-201 factory SHA, typecheck, core build, and the complete test suite passed: 166 passed, 57 intentionally skipped, 0 failed (before later incremental safety cases). The production bootstrap test verifies explicit DSH fail-before-database and real echo/inbox wiring. A recovery test verifies that a persisted high-entropy token digest is matched against current credentials and that a revoked token causes a paired forbidden response without agent dispatch. The architecture gate currently reports only the separately scheduled worker/flow sources as missing.

The rewritten `tools/e2e-gateway.ts` was run through an isolated local Wrangler Worker and Durable Object, using a separate local persistence directory and a synthetic bootstrap secret. Its ten checks passed: owner claim/connection, browser pairing, old-route absence, screen registration, unregistered-send denial, registered-send acceptance, describe, trusted origin and exact stream replay. This is a real gateway implementation running locally, **not** a public Cloudflare deployment test. No production gateway, phone, user record, or user MCP tool was touched. The screen proof header is `Ash-Screen`, because the gateway intentionally strips its reserved `x-ash-*` request headers.

The host integration with the updated Android manifest, remote paired-device capability routes, dynamic manifest replacement, and production DSH runner are still pending. The retired v1 UI remains unavailable until the separately scheduled v2 UI is installed. These dependencies are not represented as passed checks.
