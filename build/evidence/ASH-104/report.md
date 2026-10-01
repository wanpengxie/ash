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

After local integration of the signal-fenced ASH-201 factory and current v2, typecheck and build pass. The complete test suite exited naturally with 174 passed, 57 intentionally skipped, 0 failed. The production bootstrap test verifies explicit DSH fail-before-database and real echo/inbox wiring. A recovery test verifies that a persisted high-entropy token digest is matched against current credentials and that a revoked token causes a paired forbidden response without agent dispatch. Public-term scanning found zero findings across 363 files. The architecture gate currently reports only the separately scheduled worker/flow sources as missing.

The rewritten `tools/e2e-gateway.ts` was run through an isolated local Wrangler Worker and Durable Object, using a separate local persistence directory and a synthetic bootstrap secret. Fourteen checks passed: owner claim/connection, browser pairing, old-route absence, screen registration, unregistered-send denial, registered-send acceptance, describe, trusted origin and exact stream replay, conservative remote MCP classification, one test-gated synthetic remote call, and revoked-route removal. The gate hook is test-only and permits exactly one controlled call; production does not treat an unapproved structure-risk call as safe. This is a real gateway implementation running locally, **not** a public Cloudflare deployment test. No production gateway, phone, user record, or user MCP tool was touched. The screen proof header is `Ash-Screen`, because the gateway intentionally strips its reserved `x-ash-*` request headers.

Remote paired-device manifest/call routing is restored with v2 metadata. The owner overrides any client risk downgrade to `structure`; it never trusts MCP read-only hints. The directory and router replace a fully validated device manifest synchronously, cancel already accepted old calls, and suppress late success. An invalid new manifest leaves the previous metadata offline rather than running under stale authority. Device revocation removes routes. A dispatched external effect may already have occurred despite cancellation; no success is claimed for such uncertain effects.

Host dynamic manifest replacement is covered by controlled fake-host tests (missing metadata makes the device offline; valid new words replace old routes). Deterministic barriers prove a failed old `/call` cannot mark its replacement offline and a pending refresh cannot restore a closed host. Gateway barriers prove stale remote manifest results cannot resurrect a device after disconnect, and same-connection presence revocation queues behind an active sync rather than being lost. Independent QA reproduction scripts for these cases, plus the three canonical-home workspace alias writes, were replayed against this branch: both remote revocation modes leave the member absent, the replacement host remains online, and all protected writes return 403 without changing bytes. This is controlled synthetic evidence, not use of real devices. Joint testing against the updated Android host remains pending. The production DSH runner and durable turn cancellation preparation are separate later dependencies. The retired v1 UI remains unavailable until the separately scheduled v2 UI is installed. These dependencies are not represented as passed checks.
