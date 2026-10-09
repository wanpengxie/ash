# Device endpoint — integration branch

The construction branch provides a standalone Node device endpoint, the shared
gateway transport, workspace tools, and local-agent drivers for Codex, Claude Code
and WorkBuddy. Remote runtimes are wired into the phone's AgentSystem/MCP tools,
including live delegation permissions, owner intent, work threads, @ recipients,
scoped cancellation, and capsule progress. Device management uses one service for
both MCP and settings. An installer and four platform archives are built locally.
Production publication, gateway deployment and replacement of an existing client
are separate owner-approved steps; none has been performed by this branch.

## Development

The integration branch temporarily depends on `file:../ash-gateway-device` (gateway
0.5 development). Keep that sibling checkout available, run `npm ci` there, then
run `npm ci` in this repository. Before merging/releasing, replace this dependency
with an approved, published gateway revision and regenerate the lockfile.

Build with `npm run build:device`. Run:

```sh
node packages/device/dist/ash-device.mjs run --config /absolute/path/device.json --pair CODE
```

The config contains `gateway`, `name`, optional `kind` (`laptop` or `server`), and
absolute `stateDir` and `workdir` paths. Omit `--pair` on later starts. Pairing must
be approved on the owner side. Revocation stops reconnection and retains the local
key; an explicit new pairing is required to reconnect.

`workspace.poll` is read-only. `workspace.signal` is a separate action. Commands
run under the device's OS account; paths are not sandboxed. Output is kept in a
normal file under the state directory, with a bounded preview and path returned.
Common credentials are redacted in returned text, with `redacted:true` where
applicable; this is display hygiene, not a security boundary.

## Local agents

Native runtimes use their own installed login. This endpoint runs them with full
local access, as configured for this feature. The **phone** must enforce the
device's `local_agents` grant before discovering, creating or dispatching sessions.
DSH uses `agent_runtimes`, then `agent_create` with a device runtime. Native actions
on the authorized computer run with that OS account's access; remote Ash tools
retain the declared agent identity and the delegators' intersected permissions.

`agents/host.ts` accepts one `/ash/device/stream` connection. Both ends send
`hello {epoch}`. An `op` includes the device epoch, a stable `id`, `op`, `args`,
and (except `open`) `session` and `generation`. Operations are `open`, `send`,
`steer`, `interrupt`, `select`, `clear`, `close`, `status`, and `result`.
The phone assigns `args.turn` for `send`; progress and outbound calls preserve
that turn, session and generation. `agents/remote.ts` implements the phone half.

- Only one turn runs in a session. Control operations have a 45-second timeout;
  tasks do not have that timeout. An unconfirmed interrupt does not free a session.
- Reconnects in the same process reuse operation IDs. A changed process epoch
  returns `result_unknown` instead of automatically running the action again.
- Session seeds live in `agents/<session>.json`. Reopen by passing
  `open {session, kind}`; changing Claude effort reopens using the same seed.
  Clear opens a fresh generation without the old seed.
- Final results live in `results/<session>/<turn>.json`. Large final replies also
  have a full `.txt` file, with `reply_path` and `truncated:true` in the response.
  Read it through ordinary `workspace.read`. Progress is bounded to 4 KiB.
- Only `agent_list`, `agent_ask`, and `agent_tell` are exposed as Ash tools.
  WorkBuddy's local HTTP MCP endpoint is authenticated and rejects browser origins.
- Installed/login discovery refreshes in the background (at most once a minute).
  Native model catalogs refresh at most every 15 minutes using initialization only,
  never a paid model task. Unknown login status is `null`, not logged-in. Pick an
  advertised model; an old local default may not be valid for the current account.
- Phone reconnection waits up to ten minutes with visible disconnected status.
  An uncertain acceptance/result is reconciled, never silently replayed.

Claude's static SDK MCP declaration is passed as inline JSON (no credentials),
which its CLI supports. This avoids Linux `/dev/fd` reopening of Node socket-pipes.

## Tests

`node --import tsx --test packages/device/test/*.test.ts` covers workspace behavior,
three fake-CLI protocols, private MCP, session recovery, stale turn filtering and
process-group shutdown. Fake-CLI tests do not verify provider model behavior.
`tools/e2e-device.ts` exercises the actual phone core, pairing, gateway and workspace
and duplex fake-CLI turns against a **fresh local** gateway only. Set `GATEWAY_URL` and a local fixture
`BOOTSTRAP_SECRET`; no model key is needed. The gateway repository also has a
`tunnel-e2e` script covering browser and duplex device traffic.

`tools/smoke-device-runtimes.ts --execute --only=codex --lifecycle` is an explicit
real-provider smoke test using existing desktop logins. It sends only fixed text,
forbids tools, and checks an advertised model, stopping and reopening a session.
It must not be counted as passing merely because a CLI was found or initialized.

## Browser tools

`browser.script` uses an installed `ego-browser`, a private task space per caller
and task, and `finish:true` to close that space. Native scripts have the computer
account's authority and are actions, never advertised as read-only.

The optional Kimi extension bridge listens on loopback (`/ws`, port 10086 or
10089–10091). It advertises capabilities only while connected. The installed
extension protocol supports navigation, snapshots, clicks, fill, evaluation,
screenshots, upload and network inspection. It does not support the draft's
tab-close/PDF operations, so those are not fabricated. Caller/task-owned tabs and
snapshot references cannot be reused by another caller. An existing extension
connection is not changed automatically. Long output and screenshots are ordinary
files readable through workspace tools.

## Installation and upgrades

`npm run package:device -- --all` creates Linux/macOS x64/arm64 archives with a
pinned, checksum-verified Node runtime, `install.sh`, and `SHA256SUMS` in
`build/device`. No publishing occurs. The owner's devices page shows the pairing
code together with the one-line install command for the `device-v0.1.1` release
(`curl -fsSL …/install.sh | sh -s -- GATEWAY CODE`); the code is never returned to
an agent or written to the ledger.

`ash-device setup --gateway URL --pair CODE` pairs, waits for owner approval, then
installs a per-user launchd/systemd service. `--no-service` pairs without replacing
a service. `status` reveals no credentials. `uninstall` stops the service and
preserves keys, work and installations. Do not run setup/uninstall against a real
existing device merely to test installation.

Updates accept an explicit official version plus approved SHA-256, reject unsafe
archive entries, check platform and startup, then atomically switch `current`.
An active task prevents updates; a failed check leaves the old version running.
Previous versions remain available. Bounded, redacted operational logs are in
`logs/device.log` plus three rotated backups; command/runtime output is not logged.

## Verification snapshot — 2026-10-07

- Full repository suite: 765 tests, 764 passed, one live-API test skipped; no failures.
- Device tests: 28 passed. Chromium device settings and @/work-card tests: two passed.
- Real local gateway: owner approval followed by explicit agent redemption, workspace
  operations, native protocol callbacks, remote AgentSystem/MCP delegation, full
  results, grant removal and device revocation all passed. Provider turns in this
  gateway test use a deterministic fake CLI, not a real paid model.
- Mac Codex and WorkBuddy: real model reply and session reopening passed using their
  advertised models. Stop requests settled with a known completed outcome: these
  very short tasks finished before cancellation, so this is not a long-running
  provider interruption test. Deterministic CLI interruption tests passed.
- Mac Claude: initialization works; the provider reports an expired OAuth session
  that could not refresh. Credentials were not changed. Model execution remains
  unverified until the owner logs in again.
- Real Mac browser script: create task space, navigate, read, click and close passed.
  Kimi uses a protocol-level mock extension test, not the owner's live connection.
- Android unit tests and debug assembly passed. A matching-signed APK was installed
  over the existing emulator app; no uninstall or data clearing. The @ picker and
  settings screen were inspected. No real phone or production gateway was changed.

Production pairing/reboot/old-client replacement and the public installer URL/QR
remain release-acceptance work. A locally built archive or emulator screenshot is
not evidence that those production steps have been completed.
