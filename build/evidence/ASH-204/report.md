# ASH-204 — controlled DSH door

Status: implementation candidate for independent review. Production turn/session wiring and the full native-tool audit remain gated by later integration; this report does not certify complete filesystem isolation or tool-effect accounting.

## Implemented

- The production DSH profile uses only the audited base bundle. An existing profile with extra dependencies or nonempty patch configuration fails startup. A worker may obtain the non-session `llm` service without creating a model agent.
- `startMain` requires an injected turn adapter before session creation. DSH's unpublished agent `setup` registers exactly five scoped `ash_*` tools and checks their actual definition object identities at publication. The binding freezes its own tool definitions, rechecks identity at execution, and rejects a same-scope duplicate registration. The old tool door and runtime live under test-only legacy files; production source imports none of them.
- The five tools are `ash_describe`, `ash_send`, `ash_say`, `ash_react`, and `ash_show`. They read the validated member directory or use the world router with a server-bound `agent:main` identity, active turn, stable call ID, and combined cancellation signal. Model arguments cannot set sender, origin, turn, or transport context. A missing or ended turn cannot dispatch a tool request.
- The native model-facing surface is limited to reviewed read/search tools and native `write`/`edit`. Shell, process/job controls, PTC `run_code`, subagents, and unreviewed tools are unavailable. A monotonic execution guard checks source identity after pre-execute policies, so an allow decision cannot re-authorize a disallowed call. A derived agent does not inherit the root's scoped five tools in the installed DSH version, and a direct attempt returns an error.
- Native `write`/`edit` may target ordinary files inside the canonical workspace. They reject managed files, the managed memory and snapshot trees, self staging names, protected core-state roots, hard-link targets, symlink aliases, and paths resolving outside the workspace. Denials direct the model to use `ash_send` for the managed file service. This is a path-level safety measure, not a race-free OS boundary.

## Reproduce

With repository dependencies installed and `ASH_TEST_DSH_ROOT` pointing to the installed DSH package:

```sh
npm run -s typecheck
node --expose-internals --import tsx --test packages/dsh-binding/test/door-v2.test.ts
npm test
npm run -s build:core
```

The scripted provider and temporary workspace use no real model key or user files. The installed DSH runtime was 0.2.0-rc.2. Direct production-host startup was tested: missing turn adapter failed before session creation; with an adapter, the model saw exactly five owned tools, called `ash_say`, and a real world request/response was recorded. The separate door test covered two consecutive `ash_say` calls, device `ash_send` success and offline response, `ash_describe`, `ash_react` missing-message response, a permission `ash_show` card, ordinary native write, denied managed writes/edits and shell, child-agent denial, and definition mutation/duplicate-registration negatives. A synthetic path test covered dated-log hard links, snapshots/staging, core-state files, and cross-workspace aliases.

Observed locally with real DSH enabled: focused door tests 3/3; full suite 186 passed, 57 intentional skips, 0 failed; typecheck and core build passed. The configured public-term scan is run after the moved legacy files are staged because its tracked-file walker requires every indexed path to exist.

## Boundaries

The production core entrypoint still fails closed for DSH until the turn adapter is implemented and assembled. The adapter must bind each actual turn and abort signal, end the binding only after session quiescence, and suppress late calls. Native `read`/`write`/`edit` have not yet been routed through pre-execution world requests and terminal responses; observing results afterward is not enough to claim complete tool-effect accounting. The path guard is vulnerable to same-UID filesystem races and cannot safely enable arbitrary shell execution against managed files. Same-process malicious plugin JavaScript is outside this guard's isolation model. Full filesystem isolation and native-tool accounting remain separate acceptance gates.
