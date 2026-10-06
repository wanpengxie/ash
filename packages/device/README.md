# Device endpoint — work in progress

The construction branch provides a standalone Node device endpoint, the shared
gateway transport, workspace tools, and local-agent drivers for Codex, Claude Code
and WorkBuddy. The duplex session protocol is wired through the phone's OwnerLink.
It does **not** yet expose remote agents to the phone's AgentSystem/MCP tools or
provide an installer, device-management UI, or delegated conversation threads.
Do not deploy this branch as a finished device-management feature.

## Development

The integration branch temporarily depends on `file:../ash-gateway-device` (gateway
0.5 development). Keep that sibling checkout available, run `npm ci` there, then
run `npm ci` in this repository. Before merging/releasing, replace this dependency
with an approved, published gateway revision and regenerate the lockfile.

Build with `npm run build:device`. Run:

```sh
node packages/device/dist/ash-device.mjs --config /absolute/path/device.json --pair CODE
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
device's `local_agents` grant before opening/dispatching sessions; that policy
integration is the next stage, not an exposed user-facing tool yet.

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
- CLI discovery happens at startup. Unknown login status is `null`, not logged-in.
  Model-catalog discovery and live refresh still need to be connected to management.

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

Local installed Codex and Claude have passed initialize/open/close smoke checks
without model turns. WorkBuddy is not installed on the Linux build host and still
needs a real Mac smoke test. No Android code changed or APK was installed here.
