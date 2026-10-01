# ASH-611 proactive preference editor: author evidence

This increment adds a local-screen editor for the managed `PROACTIVE.md` file. It does not implement quiet hours, model-key settings, remote approval actions, or first-meeting behavior. The full settings card remains open.

The editor uses only the registered screen's existing `/api/send` route to `service:self/read` and `service:self/write`. It requires the current server-issued local-management flag, screen token, screen ID, and authentication scope. A write carries the last read hash (or `null` only after a verified not-found read). It reports success only after a paired write response and a second paired read matching both hash and content. A stale response retains the draft without overwriting the file. Ambiguous delivery keeps the same in-memory `client_id` and exact body for an explicit retry; it never retries automatically. Draft and uncertain bytes are not put in browser storage. Disconnect, scope change, token rotation, or remote registration invalidates the editor and clears its in-memory draft.

## Reproduction

From the repository root, with dependencies installed:

```sh
node --expose-internals --import tsx --test packages/core/test/members/proactive-preferences-host.test.ts
node --import tsx --test packages/core/ui/test/settings.test.js packages/core/ui/test/settings-preferences.test.js
```

The first test starts the production owner service on an ephemeral loopback port with a temporary home, registers a real local screen over SSE, then checks not-found, create, read/hash, stale rejection with unchanged bytes, exact-hash update, and a synthetic remote screen's HTTP 403 with no ledger/file mutation. The UI tests check missing-file creation, conflict, unknown-ACK same-ID retry, unpaired reply, HTTP denial, late reply after screen change, and remote/scope fail-closed behavior. Author run: host 1/1; UI 7/7.

No real user workspace or device was accessed. Generated `packages/core/src/ui.ts` is intentionally not part of this checkpoint while other UI modules integrate; a clean generated bundle, full suite, and real-browser end-to-end review remain pending before integration.
