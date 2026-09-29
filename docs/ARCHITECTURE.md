# ash architecture

## Two worlds

| | Android ↔ an app | ash ↔ DSH |
|---|---|---|
| system | Android: lifecycle, permissions, system services, IPC | **ash** (the personal-agent world): agents' lifecycle and identity, devices and communication, grants, confirmations, timers, notifications, the event log, the UI |
| app | the app's own logic in its runtime | **DSH agents and plugins** (the agent-harness world): thinking, tools, the loop and the context |
| system drives app | start/stop, delivery, permission checks | ash creates, resumes, feeds, steers and cancels agents; gates every model step and every sensitive tool call; owns part of the context; projects tools |
| app uses system | the Android SDK | agents and plugins call ash: messages, devices, timers, notifications, grants, the log |
| evolution | API levels | **`ash-api/1`**, versioned, guarded by contract tests on both sides |

ash is not a DSH plugin and does not move into DSH. It hosts DSH's *core* — profile `ash` =
`@deepseek-ai/dsh-base`, no web app, no DSH UI — inside ash core's process, through DSH's public
host entry (`@deepseek-ai/dsh/profile-boot`, the same one DSH's desktop app uses). The bridge goes
deep (loop, context, tools, approvals) but only through DSH's published extension points; DSH's
files are never modified.

## Concepts (packages/sdk/src/api.ts)

- **space** — one person's ash world: the owner, their agents and devices.
- **member** — anything that acts: `person:owner`, `agent:<name>`, `device:<id>`, `service:ash`.
- **device** — a member with a self-described **capability manifest** (name, description, JSON
  schema, `confirm`). The phone (`device:phone`, via the Android host), paired laptops (via the
  gateway, their MCP servers), browsers (no capabilities).
- **call** — one capability invocation on a device on behalf of a member; logged.
- **grant** — the owner lets a member use `*`, `device:<id>/*` or `device:<id>/<capability>`.
- **confirmation** — a yes/no question to the owner (UI card, Android notification with ✓/✗,
  any paired browser); anything marked `confirm`, and sensitive actions requested from untrusted
  origins, wait for it.
- **origin** — who is speaking in a message (owner, one of the owner's devices, another agent, a
  timer). Trust follows the origin, not the channel.
- **timer** — a member's own alarm; when it fires ash delivers its text back as a message.
- **event log** — append-only, per workspace; the UI and remote browsers follow it (SSE).

## The two handles

```
            ① ash → runtime (AgentRuntime, packages/core/src/runtime.ts)
ash core ───────────────────────────────────────────────────────────▶ DSH world
   ▲         start/resume · runTurn(msg) · steer · cancel               │
   │                                                                   │
   └──────────────────────────────────────────────────────────────────┘
            ② runtime → ash (AgentPort, one per agent)
```

- **① control plane** — `DshRuntime` (packages/dsh-binding): `ctx.agents.create/resume`,
  `agent.followup / steer / inject / cancel`, the `session/event` feed.
- **② system services** — `AgentPort`: whoami, members, devices, call, send, timers, notify,
  log, grants, request_grant, confirm; plus the policy hooks ash evaluates for the runtime
  (gateStep, gateTool) and the context it owns (contextSections).

The DSH binding's **door** plugin connects ② to DSH's extension points:

| DSH extension point | ash |
|---|---|
| `ctx.provide("ash")` | `ctx.ash.portOf(agent)` for any DSH plugin |
| `ctx.tools.register` | `ash_*` system tools; device capabilities as `<device>__<capability>` tools, re-projected live as devices come and go and grants change |
| `agent/pre-step` | loop gate: step budget per turn / per day |
| `tools/pre-execute` | tool gate: sensitive DSH tools (bash, write …) from untrusted origins ask the owner |
| `approval/request` | DSH's own approval questions go to the owner |
| `systemPrompt.section` / `.context` | who the agent is in ash; live devices and timers |
| `agent/request` | the model chosen in ash's settings applies to running agents |
| `credentials`, `agentDefaultModel`, `llm` | ash's settings page |

Out-of-process runtimes (Codex, Claude Code, Pi …) get the same services as an MCP server per
agent (`/mcp/<agent>`); `RuntimeCapabilities` says what each runtime supports — DSH supports all.

## Processes on the phone

```
App process (Kotlin)                                     node ash-core (one process)
  CoreService (foreground)                                 ash core + DSH core + door
    ├─ PayloadInstaller  assets/payload.zip → files/payload
    ├─ HostServer        127.0.0.1:4710  ◀── manifest/call/notify/confirm/alarm/key/sign
    └─ supervisor        exactly one ash core (/proc), restart with backoff, stop flag
  HomeActivity           WebView → 127.0.0.1:4700 (ash UI)
  A11yService            screen.* capabilities
```

The gateway identity lives in the Android Keystore; ash core asks the host to sign. The
core's next timer is mirrored into an exact AlarmManager alarm so doze and kills cannot eat it.

## The payload

`payload/manifest.json` locks every input with a version and a SHA-256:

- `@deepseek-ai/dsh` from npm, installed for android-arm64 **as published**;
- Termux aarch64 packages (node, python, git, rg, bash, curl, pnpm …) made relocatable at build
  time (RUNPATH `$ORIGIN/../lib`, the Termux prefix in shebangs replaced by a placeholder);
- `packages/android-compat`, installed *next to* DSH (never inside `@deepseek-ai/`):
  - `node-addon-require-builtin-android-arm64` — the platform package DSH's loader looks for,
    backed by `--expose-internals`;
  - `@vscode/ripgrep-android-arm64` — points at the runtime's rg;
  - `android-node-compat` — a `--require` preload: hard links (refused by SELinux/FUSE) fall back
    to exclusive copies, unopenable ancestor directories skip fsync, `flock` works in-process;
- `@img/sharp-wasm32` — sharp's official fallback;
- ash core and a host patch layer for DSH (`profile/cordis.patch.yml`, passed as a patch file).

Upgrading DSH is a one-line change plus the group-2 contract tests.

## Remote

`ash-gateway` is the user's own Worker + Durable Object. The phone keeps one outbound WSS.
Paired browsers holding `web_ui` reach the ash UI and `/api/*` through the tunnel; ash serves
them as that device (chat, log, confirmations — not pairing, grants or credentials). Laptops
holding `expose_capability` answer `/ash/manifest` and `/ash/call`. Pairing and revocation are
signed by the phone's Keystore key.
