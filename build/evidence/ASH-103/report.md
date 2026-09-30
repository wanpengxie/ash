# ASH-103 member directory evidence

Implementation boundary: this change registers validated member words with the router and describes the same snapshots. It does not switch the running edge server to the new directory; that belongs to the later edge integration.

The directory publishes a member only after the router validates and commits its complete batch. Static schemas use the fail-closed internal schema preflight. Device manifests use Ajv compilation in the router; unknown dialects and unresolved remote references fail at registration without network loading. Existing route keys and duplicate keys reject the complete new batch. Returned descriptions and registration specifications are detached copies.

`describe("owner" | "agent", member?)` filters by exact audience before returning names or schemas. A hidden-only member is indistinguishable from an unknown member on a specified query. Audience is presentation metadata, not route authorization.

The device adapter wraps an injected executor and live online flag. It retains an offline device's validated words for describe; a send while offline is accepted and settled with a paired `offline` response without invoking the executor. Restoring online does not reregister the capability. Discovery and host execution are not implemented here.

Reproduce from the repository root with dependencies installed:

```sh
npm run -s typecheck
node --expose-internals --import tsx --test packages/core/test/world/describe.test.ts packages/core/test/world/router.test.ts
npm test
npm run -s build:core
```

Observed: focused describe/router 27/27; full suite 141 passed, 57 intentionally skipped, zero failures; typecheck and core bundle passed. Architecture test scans actual `members/device.ts` and deliberately injects a forbidden cross-member import. The repository's public-terms scan also returned zero findings with an external private term list; the list and its location are not part of this evidence.

Not claimed: production edge cutover, host device discovery, member-specific business logic, or the full architecture acceptance matrix.
