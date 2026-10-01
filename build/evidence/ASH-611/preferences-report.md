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

The integration checkpoint merges the latest `v2` containing the local admin controls, managed-file editor modules, and attachment source. The generated UI bundle was rebuilt from that combined source; two successive generation runs produced the same SHA-256 (`9251b06df920ed260919c1de951ff5455bd22e7b909de390c535782cd057ef47`). The managed-file editor modules remain independent modules; this increment does not wire their unfinished pages into the settings panel.

Real-browser reproduction:

```sh
node --expose-internals --import tsx packages/core/ui/test/preferences-browser-probe.mjs
```

The probe uses a temporary production owner/home, ephemeral loopback HTTP proxy, and isolated headless Chrome profile. It verifies missing-file creation and readback, an authorized concurrent edit causing stale-hash rejection without overwrite, then a write accepted by the owner while the proxy replaces that single HTTP acknowledgement with 503. Explicit retry from Chrome uses the identical `client_id` and leaves exactly one accepted write. It then switches the same browser origin to a second isolated owner's authentication scope and checks that old text is absent. A synthetic remote web UI registration hides the editor; a remote browser's direct write receives 403 with no ledger change.

Author integration run: Chrome probe PASS; `npm run -s typecheck` PASS; `npm run -s build:core` PASS; `ASH_TEST_DSH_ROOT=<installed runtime> npm test` 383 pass / 59 skip / 0 fail (442 tests); generated bundle stable across two runs; public-term scan 504 files / 0 findings. The installed-runtime test uses scripted, isolated fixtures, not a personal model account. No real user workspace or device was accessed. Independent QA remains pending, and the complete settings card remains open.
