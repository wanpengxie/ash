# ash architecture

The hub is `packages/core`. It is one Node process that the host starts (`ash-host/1`: a launch description file named by
`ASH_HOST_SPEC`, two secrets in the environment, host events on standard input) and that opens a single port on 127.0.0.1.
Everything that crosses into it becomes a typed word, goes through the router and is written to the ledger.

## Layout of `packages/core/src`

```text
kernel/     ledger, registry, router, gate, redact, vault          (imports only sdk)
edges/      each one turns an outside thing into members:
            link-server (the /link port: human, hands, remote drivers, web page) · tools (MCP for agents) ·
            agents (DSH driver, pi driver, remote driver) · body (the main body) · apps · host · llm
services/   in-process members: clock, semantic, history, blobs, directory, gate, vault, widgets, admin, cost,
            senses, reflex
prompts/    rules (prompts/rules/*.md) and the generated modules built from them
next.ts     startHub: the one place that creates and wires everything
main.ts     the program the host starts: harden the process, call startHub, wait for it to stop
```

The import rules (kernel imports sdk only; edges and services import kernel and sdk, not each other) are checked by
`packages/core/test/arch/imports.test.ts`. Services and edges talk to each other only by sending words through the router.

Other packages: `sdk` (the contracts), `link` (`ash-link/2`; on relay tunnels inside TLS, docs/LINK-E2E.md), `workspace` (file and shell operations), `web` (the page the
hub serves), `device` (the computer program), `ash-skills` (rules, skills, persona templates), `dsh-ash-control` and
`ash-cost` (DSH plugins), `pi-login` (Codex's device-code login for the pi runtime), `apps` (first-party apps), `android-compat` (the Node preload the Android host starts core with).

## Guidance for the main agent: two layers

Every capability domain (widgets, apps, phone operation, media, reminders, senses, the browser, delegating development) is explained in two places and the two are delivered together.

- **Layer 1, an introduction** in the system prompt (`packages/core/src/prompts/rules/<domain>.md`): a short paragraph saying what the capability is, what it can do and when to use it, and naming the skill to read first. No steps, examples or parameter lists.
- **Layer 2, the skill** (`packages/ash-skills/skills/<name>/SKILL.md`, loaded by the skills plugin): when to use it, how, what good looks like (worked examples), common mistakes, how to check the result. Sample cards, templates and example apps sit beside it in the skill folder.

Rules about how the world works (approvals, data versus instructions, voice, the agent's own files) stay in the system prompt as ordinary rules. `packages/ash-skills/test/standard.test.ts` enforces the layout: every skill has valid frontmatter, every introduction is a few sentences that name an existing skill, no skill goes unnamed, and the system prompt does not grow. Adding a capability domain means adding both layers.

## Build and checks

`npm run build:core` bundles `main.ts` into `packages/core/dist/ash-core.mjs`. `npm run build:payload` assembles the payload
(Node and tools, the bundle with `ash-skills/` and the bundled first-party apps `ash-apps/` beside it). The relay is not in it either: the agent
deploys the gateway repository's release with wrangler (skill `relay`). DSH is not in the payload: it runs in the agent container, which `npm run build:container`
builds (an arm64 Ubuntu root with Node, DSH as published and Ash's DSH plugins, pi (the second agent runtime) and v2rayA (the proxy of the container, run by a built-in app), plus proot, into `build/container/`). The Android Gradle build embeds the payload and the container in the APK.

`npm run typecheck` and `npm test` run everything; `npm run test:smoke` runs the unit tests of every package and the hub's
modules; `npm run test:scenarios` starts the whole hub through `startHub` and plays the acceptance scenarios against its port.
