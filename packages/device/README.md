# Computer program (`ash-device`)

A Node program that makes a Mac or Linux computer part of Ash. It speaks `ash-link/1` (SPEC-03) with the hub, through the
relay, and has two channels:

- **`device`**: the computer is a hand. It declares `workspace.*` and `body.info` (always; the hub registers them as
  `body:<id>` only while the owner has bound this computer as a body, SPEC-09), the standard `browser.*` while the Kimi
  browser extension is connected, `x.kimi.browser.upload|network`, `x.ego.browser.script` when ego-browser is installed,
  and `x.ash.update` (only the hub's device service may call it). It answers `call`, `cancel` and `assess`.
- **`agent`**: the computer runs Codex, Claude Code and WorkBuddy for the hub (SPEC-08). Only asked for while one of them
  is installed and signed in; the hub grants it per computer ("run local agents").

## Run

```sh
node packages/device/dist/ash-device.mjs run --config /absolute/path/device.json --pair CODE
```

The config has `gateway`, `name`, and absolute `stateDir` and `workdir`; `installRoot` when installed by `install.sh`.
Omit `--pair` on later starts. The owner approves the pairing in Ash and ticks what the computer may do (lend its
abilities, be a body, run local agents, web access); each can be taken back later without pairing again. A revoked
computer stops for good and needs a new pairing. Build with `npm run build:device`, package with `npm run package:device`.

## How it connects

The program signs in to the relay as itself (`ash-gw/1`, unchanged: `src/link.ts`, `GatewayLine`). The hub opens a
tunnelled WebSocket on path `/link`; any other path is refused. The hub speaks first (`challenge`); the handshake, the
channels, reconnecting and the manifest are `packages/link`'s `HandClient`. `TunnelPort` turns the tunnel into the socket
the client wants, and keeps what the hub said before the client asked. The hand id is the hash of the identity key in
`<stateDir>/device.jwk`.

## The device channel

`src/hand.ts` builds the manifest and answers calls. `workspace.*` / `body.info` are the `packages/workspace` package
(`src/workspace.ts`): the OS account is the file system boundary, `workspace.write|edit` are assessed per call (inside the
work directory is harmless; the home folder and the program's own state never count as free), and a picture or large
file is sent as a `stream`. `~/` means the home folder. Browser actions are `src/kimi.ts` (one tab per caller and space;
refs checked against the last page, and the site and name of the control before a click or type) and `src/browser.ts`.

## The agent channel

`src/agents/driver.ts` is the sdk's `AgentDriver` over the session classes (`codex.ts`, `claude.ts`, `workbuddy.ts`).
One runtime process holds one lane (session key) of one agent. `src/agents/channel.ts` carries the frames:

| hub to computer | answer |
|---|---|
| `{t:"agent", id, op, agent, ...}` | `{t:"agent", id, op_result: op, ok:true, result}` or `{..., ok:false, error:{code, message, recovery_hint?}}` |

The operation's fields are the driver method's arguments by name:

| op | fields | result |
|---|---|---|
| `agent.start` | `spec` (`AgentStartSpec`; the runtime is `spec.runtime`) | `{sessions:{<key>:<handle>}, attached}` |
| `agent.stop` | `reason` | `{}` |
| `agent.list` | | `{agents:[{agent, runtime, state, detail?}]}` |
| `session.get` | `key` | `{handle: string\|null}` |
| `session.set` | `key`, `handle` | `{}` |
| `session.new` | `key` | `{handle}` |
| `session.reload` | `key`, `modules:{static:[...]}` | `{handle}` |
| `session.compact` | `key` | `{compacted, detail?}` |
| `send`, `followup` | `key`, `messages:[DriverMessage]` | `{}` |
| `steer` | `key`, `text` | `{accepted}` |
| `inject` | `key`, `modules?`, `text?` | `{}` |
| `interrupt` | `key` | `{}` |
| `restart` | `key?` | `{}` |
| `configure`, `config.get` | `key?`, `config?` (`model`, `effort`) | the current `{model?, effort?}` |
| `plugins` | `action`, `name?` | `unavailable` |

Events go out as `{t:"agent", event, ...}`: the sdk's `AgentEvent`, and `agent.status {agent, state, detail?}`
(`starting`, `running`, `exited`, `failed`). A runtime's call of an Ash tool goes out as
`{t:"agent", id, outbound: <tool>, agent, key, turn, args}` and is answered by
`{t:"agent", id, outbound_result: <tool>, ok, result | error:{message}}`. Only `agent_list`, `agent_ask`, `agent_tell`
are offered (SPEC-08 §2.7). Calls not answered when the turn ends or the connection drops fail.

- The hub's tool address is not reachable from here, so the tool list in the spec is not used; the hub decides on its side
  what each call may do.
- These runtimes take nothing between turns: `inject` is held and goes in front of the next turn. Images are not passed
  (`images:false`); an attachment is named in the message with its ref.
- `session.compact`: Codex `thread/compact/start`; Claude Code is sent `/compact` as a turn that is not reported;
  WorkBuddy cannot. Both are reported as `compact:"unknown"` in `hello` because they have not been run against the
  real programs.
- A runtime that dies ends its turn as `error`, then `ended` (and `agent.status failed`) is reported once, and the whole agent
  is closed; the hub starts it again with its saved handles.
- When the connection drops the agents keep running for ten minutes. Their events are kept (the last 2000) and sent when
  the channel opens again; an `agent.start` for an agent that is still running attaches instead of starting it over: it
  reports each lane's handle and re-sends `turn.started` for a turn still running, so the hub may see `turn.started`
  twice and de-duplicates by turn. After ten minutes without the hub they are stopped.

## The Codex App uses Ash

The Codex App and Ash are two products of one user. `ash-device mcp` is the MCP server (stdio) the Codex App starts: the
tools of the hub's tool surface that matter to an outside app (`capability_list`, `capability_describe`, `capability_call`,
`await_result`, `list_pending`, `cancel`, `agent_list`, `agent_ask`, `agent_tell`). It holds nothing: each call goes through
the unix socket `<state>/mcp.sock` (`src/local.ts`, mode 0600) of the running ash-device and on its agent channel as
`{t:"agent", id, outbound: <tool>, attached: {session?}, args}`, with no `agent` and no `turn`. The hub answers
`outbound_result` (`tools/list` answers the tools and the caller's name). On the hub the caller is `agent:codex-<computer>`
(`edges/agents/attached.ts`): judged by the router as an agent with the default declaration, never started or woken,
recorded in the ledger with the Codex session as its turn. `src/mcp.ts` says plainly when ash-device is not running or not
connected.

`ash-device codex install` registers the MCP server in `$CODEX_HOME/config.toml` (default `~/.codex`; one marked block,
the file is backed up first) and puts the skill `ash` (`skill/SKILL.md`, embedded by `tools/gen-rules.mjs`) in
`<codex home>/skills/ash/`. It can run again; `codex uninstall` takes both out; `codex status` shows what is there.
Codex's plugin format can carry a skill and an MCP server together, but a plugin has to come in through a marketplace and
the app's plugin cache, so the install writes the two places directly.

## Install and update

`install.sh GATEWAY CODE` downloads the release `device-v<version>` for the platform, verifies its SHA-256, installs it
under `~/.ash-device`, pairs, and installs a per-user launchd/systemd service. `ash-device update --version-to V --sha256 H`
and the capability `x.ash.update` take an explicit official version and checksum, check the archive, platform and startup,
and switch `current` atomically. Operational logs are bounded and redacted: `logs/device.log` and three backups.

## Tests

`node --expose-internals --import tsx --test packages/device/test/*.test.ts`. `device.test.ts` runs the program against a
kernel made of the link server, the hand registry and the bodies service, with a fake `codex` script as the runtime;
`driver.test.ts` and `channel.test.ts` cover the agent side with fake sessions and with the fixture runtimes
(`test/fixtures/agent-cli.mjs`). The fixture runtimes do not verify the real programs' behaviour.
`tools/smoke-device-runtimes.ts --execute --only=codex` is an explicit smoke test against a real, signed-in runtime.
