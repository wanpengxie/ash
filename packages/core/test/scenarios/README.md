# Scenario tests (T20)

Black-box acceptance of the new hub, written from outside in. Each test starts the hub with `startHub` (`packages/core/src/next.ts`)
and touches it only through what the outside world can touch:

| What the test plays | How | Where |
|---|---|---|
| the owner | `packages/link` client on the human channel of the local connection (`Authorization: Bearer <local token>`, signed challenge); `sync` gives the conversation, `present` frames are what the channel is shown | `Human` in `harness.ts` |
| a hand (phone, computer) | `packages/link` client on the device channel: signed identity, manifest, answers `call`/`assess`, sends events | `Hand` |
| an agent | `scriptedDriver()`, a fake `AgentDriver`; its tools are called on `/mcp` with the token the hub gave it in `start()` | `ScriptedDriver` |
| the host | the T15 `FakeHost` (the hub reports to it; the harness plays `wake.fired`) | `startScenario` |

The local token is read from the host's `hands.handoff` call, the way the phone app gets it. Nothing here imports a hub module,
opens the database, or reaches into the hub's internals: everything goes through `startHub` and the one port it opens.

Run: `npm run -s test:scenarios` (`npm test` runs them too; the smoke glob does not).

## How the modules map to the tests

Every test needs the hub to **start, take the owner on a human channel, run an agent and serve `/mcp`**. Call that BASE:
T2 (words), T3 (ledger), T4 (router, gate, registry), T5 (link-server, hands), T6 (human), T7 (tool surface), T15 (host),
T17 (agents + a driver). The "also needs" column lists only what a test needs on top of BASE.

## The tests

| File | Test (starts with the REGRESSION codes) | Also needs |
|---|---|---|
| conversation | S057 owner speaks, front turn, answer | – |
| | S001, S011 same `client_id` is one message | T3 (`client_id`) |
| | S002, S003 message while busy is queued (followup), running turn goes on | `service:reflex/conversation.control` (T17 asks it), falls back to followup without a model |
| | S004 "停下" interrupts the turn (keyword path) | reflex keywords |
| | S005–S009 failure notice + retry card, retry is a plain reply | T17 (failure notice) |
| | S016 option card and the pick | T6 (`show`) |
| | S017 reaction | T6 (`react`) |
| | 人场景 4 list agents, primary marked | T17 (`service:agents/list`, seeded `main`) |
| | 人场景 5 typing: inbox waits | T6 (`presence{typing, agent}`), T17 (inbox) |
| | S015, S019, S025 new channel sees history, scrolling up pages | T6 (`sync`), T3 (`page`) |
| | S114–S118 `task.stop` interrupts that turn | reflex words (`task.stop`) |
| approval | S032, S039, S033 wait → answer → background message → `pending.redeem`, once | T4 gate + `service:gate` words, T7 `human_pending_redeem`, T5 (hand) |
| | S032 refusal | same |
| | S032 "always" makes a rule; S034–S038 rules and audit are listed | `service:gate/rules.list`, `audit` |
| | S039 expiry (fake clock) | every module honoring `HubOptions.now` |
| | S040 restart with a waiting card | T3/T4 `recover()`, T17 restart |
| | S044, 设备 20 per-call `assess` (none = no card, else ask) | T5 (`assess` frame), T4 |
| | S044 `full` tier is trusted | T5 `service:devices/access_set`, T4 decide step 6 |
| | `human_ask` answered by the owner | T7 `human_ask`, `await_result` |
| | persona proposal always asks (SPEC-00 §6.4) | T19 `service:persona` |
| | agent only sees words its contract allows (SPEC-02 §3.2) | T6 `service:directory`, T7 filtering, T6 `service:vault` |
| hands | agent 7, 设备 19 manifest, one bad capability rejected alone | T5, T6 directory |
| | S085, 设备 20 agent calls a hand | T5, T7 |
| | 设备 8 revoke → 4003, cannot return | T5 `service:devices/revoke`, `hands` table |
| | S141–S146 offline | T5, T4 |
| | S141–S146 hand drops mid-action → `result_unknown` | T5 |
| | S056 receipt + cancel reaches the hand | T7 `cancel`, T4 cancel, T5 `cancel` frame |
| | agent 7 phone and computer are the same | T5 |
| | 设备 8 rename / access_set | T5 |
| | 设备 15 update computer (`x.ash.update`, kernel only) | T5, `service:devices/update` (T5/T16) |
| | 设备 27 `decision.*` kernel only | T4 `callers` |
| link | SPEC-03 §11.2 wrong token / no token / wrong signature → 4001 (3 tests) | T5, T15 (token handoff) |
| | SPEC-03 §11.2, 3a second device connection → 4009; two chat tabs coexist | T5, T6 |
| | SPEC-03 §2.3 local human channel `local:true` | T5, T6 |
| timers | S082 reminder to the owner | `service:clock` (T21) |
| | S083, agent 9 timer wakes an agent on `back` | clock, T7 `timer_set`, T17 (`wake` → back lane) |
| | S084 list and cancel | clock |
| | S084, 设备 host alarm: `wake.at`, then `wake.fired` fires it | clock, T15 `service:host/wake.at`, host events, `HubOptions.now` + `stdin` |
| | timer ids | clock |
| senses | S097 geofence → wake | T5 (event routing), T19 `service:senses`, the organ `app:sense-rules` (T4 `listens`, T7 apps bridge) |
| | S100 stale source → wake; S098 calendar → wake | same |
| | S102, S103 uninteresting reading wakes nobody, is archived | same |
| | SPEC-03 §11.4a, SPEC-00 §6.12 `sense.*` not in the ledger | T4 `shouldRecord` |
| longflow | SPEC-03 §9.5.4, SPEC-00 §6.9 pairing code never reaches agent or ledger | T16, T4 redact |
| ledger | SPEC-00 §6.12 what is recorded and what is not | T4 `shouldRecord`, T6 `service:history` |
| | SPEC-00 §6.9, S159 vault secret not in the ledger | T6 `service:vault`, T4 redact |
| | S011–S014 long text → summary + attachment, read back | T3 blobs, T6 `service:blobs` |
| | S020–S023 `service:history/turn` | T6 `service:history` |
| health | the busy loop of reading one word without end becomes an event naming the word (fake clock); an idle hub polled now and then does not | `service:health`, `HubOptions.healthTickMs` |
| agents | S046–S051 declare / start / ask a sub-agent | T17 |
| | SPEC-08 §5.7 delegation only narrows (forbidden, no card) | T17 + T4 authorization |
| | SPEC-08 §5.7 spawn: temporary agent, gone afterwards | T17 |
| | SPEC-08 §5.8 front and back lanes run at once | T17 |
| | S170, S171, SPEC-00 §6.5 restart mid-turn: no replay, "interrupted" note | T3/T4 `recover()`, T17 |
| | S172 hub restart, runtime still starting: the owner's words are taken and delivered once it is up | T17 (member stays in the registry while starting) |
| | S168 runtime killed again and again: restarted each time, words answered, never given up | T17 (failure count clears after a finished round) |
| | S164, S165 pause interrupts all, resume is the owner's | `service:admin` (T6), T17 `session.interrupt` |
| | S028 first meeting wake; no key then key saved: wake again until the agent has spoken | T19, T24 |
| | SPEC-08 §5.7 `primary.set` | T17 |
| | S046 owner talks to a sub-agent directly | T17, T4 structural rule |
| surfaces | S075, 设备 23 notification only to channels that declared it | T6 delivery |
| | S114–S118 status frames | T6 `status.ts` |
| | 人场景 28 `open` on one channel | T6 |
| | S107, S108 card put → `present{widget}` | T6 `service:widgets` |
| | 人场景 6 visible = no buzz | T6 delivery rules, `presence{visible}` |
| | S111 card tap reaches the creator | T6 `service:widgets` |
| body | S026 owner uses `body:main` files | T18 |
| | SPEC-00 §6.4 agent writes inside the work directory without a card, outside asks | T18, T4 per-call assess |

## REGRESSION-0.3, row by row

Rows are numbered in the order of the file (§1 = R1–R15, §2 = R16–R27, §3 = R28–R51, §4 = R52–R75, §5 = R76–R80).
"✗" = no black-box scenario, with the reason; "~" = partly.

| # | Row | Covered by |
|---|---|---|
| R1 | open, history, scroll up (S015, S019, S025) | conversation: S015 |
| R2 | send, attachments, offline resend (S001, S011–S014) | conversation: S001/S011; ledger: S011–S014. ~ images (`blobs/get` over `stream`) not done |
| R3 | busy: queue, steer, stop (S002–S004) | conversation: S002/S003, S004. ~ the "related → steer" branch needs the small model (gap 1) |
| R4 | failure notice + retry (S005–S009) | conversation: S005–S009 |
| R5 | choose an agent (人场景 4) | conversation: 人场景 4 |
| R6 | typing (人场景 5) | conversation: 人场景 5 |
| R7 | visible / away (人场景 6) | surfaces: 人场景 6 |
| R8 | option cards, reactions (S016, S017) | conversation: S016, S017 |
| R9 | activity page, detail, ask this step (S020–S023) | ledger: S020–S023 (`history/turn`). ~ `history/activity` paging not done |
| R10 | task island: status, steps, cards, stop/end, reply (人场景 9, 12, S114–S118) | surfaces: S114–S118; conversation: S114–S118 (stop). ~ end, steps |
| R11 | files, download, HTML preview (S026, 人场景 27) | body: S026. ~ binary download over `stream` not done |
| R12 | open a page on the owner's screen (人场景 28) | surfaces: 人场景 28 |
| R13 | first meeting (S028) | agents: S028 |
| R14 | tour, opener (S029, S030) | ✂ deleted |
| R15 | external text is data (S031) | ✗ lives in the envelope the driver builds (T17/T14 tests); no field in the minimal driver contract |
| R16 | approval card, once, expiry (S032, S039) | approval: S032/S039/S033, refusal, expiry |
| R17 | answer on notification/island (S033, 人场景 8) | approval: same words from the same human channel; surfaces: S075 for the notification side. ~ |
| R18 | card shows full text, rules, review model, audit, mode (S034–S038) | approval: rules + audit asserted. ✗ review model and mode need the small model (gap 1) |
| R19 | crash after answer (S040) | approval: S040 |
| R20 | precheck (S041) | ✗ needs an app fixture (`Member.precheck` is an app/organ feature) |
| R21 | remote web can chat, not manage (S042) | ✗ needs a non-local human channel (gap 8) |
| R22 | computer: commands via review model, writes in the work dir (S044) | approval: S044 assess; body: inside/outside. ✗ `workspace.bash` via review model (gap 1) |
| R23 | app calls a word that needs approval (S045) | ✗ app fixture (gap 9) |
| R24 | ACP permission request | ✗ internal to the DSH driver (T17's own tests) |
| R25 | `human_ask` / `human_confirm` | approval: `human_ask` |
| R26 | approval result back to the agent | approval: S032 |
| R27 | borrowed MCP tools / client role (S043) | ✂ deleted |
| R28 | owner speaks → main agent → answer (S057, agent 1) | conversation: S057 |
| R29 | turn summary (S021) | ledger: S020–S023 (what, not the model summary). ✗ summary text needs the small model (gap 1) |
| R30 | sub-agents (S046–S051) | agents: S046–S051, delegation, spawn |
| R31 | sub-agent timed wake (agent 9) | timers: S083 (the target is any agent) |
| R32 | owner talks to a sub-agent (S046) | agents: S046 direct |
| R33 | Codex / Claude on a computer (S052–S055) | ✗ the `agent` channel is "not applicable" on the local connection (SPEC-03 §2.2.1); needs a gateway (gap 8) |
| R34 | slow tool receipt, `await_result`, across restart (S056) | hands: S056 (receipt, cancel); human_ask uses `await_result`. ~ across restart not done |
| R35 | skills, rules, context order (S058–S060) | ✗ prompt modules are driver-side; T14/T17 tests (gap 6) |
| R36 | background wake (agent 13) | timers: S083, agents: lanes, senses. ~ persistence of a wake across restart not done |
| R37 | wake: geofence, riding, health source (S097, S100) | senses: S097, S100 |
| R38 | wake: calendar (S098) | senses: S098 |
| R39 | wake: app events | ✗ app fixture (gap 9) |
| R40 | timers (S082–S084) | timers (5 tests) |
| R41 | pulse and cards (S066–S073, S107–S113) | surfaces: S107, S108, S111. ✗ pulse needs a placed widget + schedule (gap 10) |
| R42 | card could not be drawn (S108–S109) | surfaces: S107 (the frame). ~ `widget.rendered` is an unrecorded event, only visible in `card.put`'s `phone` field |
| R43 | card buttons (S111) | surfaces: S111 |
| R44 | memory pipeline, keeper, … | ✂ deleted |
| R45 | memory page history/rollback | ✂ deleted |
| R46 | change persona (S079) | approval: persona proposal |
| R47 | outcome label | ✗ small model (gap 1) |
| R48 | compaction | ✗ `AgentDriver` here has no `session.*`/`compact` yet (gap 6, T17) |
| R49 | model choice, plugins (S157, S158, S162, S163) | ✗ same as R48 (`configure`, `plugins`) |
| R50 | usage and balance (S161) | ✗ `service:cost` needs driver usage reports (gap 6); the quota check before a turn is asserted as "not recorded" in ledger |
| R51 | restart: no blind replay (S170, S171) | agents: S170, S171; approval: S040 |
| R52 | gateway address, claim, reconnect (S148–S150) | ✗ gateway (gap 8) |
| R53 | pair a computer, code only to the owner (S135–S140) | longflow: pairing code. ✗ the hand's side of pairing (gap 7) |
| R54 | browser after pairing (S151–S156) | ✗ gateway (gap 8) |
| R55 | device online, manifest (agent 7) | hands: agent 7 (declared risk drives asking: approval S044) |
| R56 | revoke, rename, access (设备 8) | hands: revoke, rename/access_set |
| R57 | agent calls computer capability (S141–S146) | hands: S141–S146 |
| R58 | app calls a computer capability (设备 13) | ✗ app fixture |
| R59 | update the computer program (设备 15) | hands: 设备 15 |
| R60 | old client role (设备 17) | ✂ deleted |
| R61 | phone startup and keep-alive (S168–S174) | ✗ real phone / Kotlin tests (T10, T11d); link: token and identity rules |
| R62 | phone registers as a device (设备 19) | hands: agent 7, 设备 19 |
| R63 | agent calls the phone (S085–S094, 设备 20) | hands: S085; approval: assess |
| R64 | screen decision (设备 27) | hands: 设备 27 (kernel only). ✗ the reflex calling it needs the small model |
| R65 | notification, island, reminders (S075, 设备 23) | surfaces: S075; timers: S082 |
| R66 | reply on a notification, pause (设备 24, 25) | conversation: S016 (reply words), agents: S164 |
| R67 | native chat page, app shell (设备 31, 32) | ✗ Android/web (T8, T11b); conversation tests are the human-channel half |
| R68 | 后台也能动手：调试身份上的虚拟屏 (设备 33) | ✗ real phone |
| R69 | keep-alive switches | ✗ real phone (`config.*`) |
| R70 | install, grant, start/stop apps (S119–S134) | ✗ app fixture (gap 9) |
| R71 | app calls Ash; health fallback (设备 37) | ✗ app fixture; `registry.findByWord` is a T4 unit test |
| R72 | app pages, icons (设备 39) | ✗ app fixture |
| R73 | app events, notifications, entry cards (设备 40) | ✗ app fixture |
| R74 | app desktop cards (设备 41) | ✗ app fixture |
| R75 | sense helper, scale (S102, S103) | senses: S102, S103 (`sense.*` → archive) |
| R76 | pause, resume (S164, S165) | agents: S164, S165 |
| R77 | quiet hours, approval mode (S166) | ✗ settings keys not in the words (gap 12); mode needs the small model to tell apart |
| R78 | keys (S159, S160) | ledger: S159 |
| R79 | clear browser logins, permission page (人场景 21) | ✗ real phone (`config.*`) |
| R80 | DSH matches release, community plugins (S163, S167) | ✗ real DSH |

## Gaps in the specs found while writing the scenarios

Decisions of the coordinator (BUILD-PROGRESS §7, "T20 发现的规格缺口和总控的决定") closed gaps 1–6 and 11; the harness follows them.

1. **Small model: decided (1).** `HubOptions.llm?: { baseUrl }` overrides the providers' addresses so a scenario can run a fake model.
   The scenarios that need one (R3 steer, R18, R22 bash review, R29, R47, R64, R77) wait for a fake model server in the harness.
2. **Seal key: decided (2).** The seal key comes as the first line on the hub's private pipe to its host (SPEC-07), never in the
   environment. The harness passes `env` (what `FakeHost.writeLaunch()` gives: the spec path only) and the pipe of one run
   (`FakeHost.connect()`: `stdin` brings the boot line, answers and the events `FakeHost.sendEvent()` plays; `stdout` takes the calls);
   the hub reads host.json itself. No field for the key.
3. **Approval answer: decided (3).** Card options are exactly `once`, `always` (only when offered) and `deny`; the answer is the response
   to the `person:owner/ask` request, `{ok:true, result:{data:{choice}}}`; expiry is a deny. The harness answers by option id and asserts the ids.
4. **Background message: decided (4).** The initiator (only when it is an agent) gets `agent:<x>/tell` on its back lane, one sentence naming
   the request, the result and the next step. Tests assert `word === "tell"`, the receiving agent, and the `pending_id` / `setup_id` in it.
5. **Tool result envelope: decided (5).** Success = `{content, structuredContent: data}`, failure = `isError` + `structuredContent: {error}`;
   a receipt's id is `request_id` (long call) or `pending_id` (approval). `ToolResult` is `{isError, data, text}`, `errorCode` reads `data.error.code`.
6. **Driver contract: decided (6).** Full `DriverMessage`, `session.*`/`compact`/`configure`/`plugins` on `AgentDriver`, `start(spec)` with
   `tools:{mcp_url, tokens: {<lane>: token}}`, seeded `main` on runtime `dsh`. The harness registers only `dsh`; a scenario that declares another runtime lists it
   in `startScenario(t, { runtimes })`. The minimal types in `next.ts` are replaced by T17a's `sdk/driver.ts`.
7. **A computer cannot pair through the local connection.** `hello` has no field for a pairing code; pairing (`waiting → requested →
   approved → connected`) can only be driven through the gateway, so the "initiator is told at each step" rule is not tested here.
8. **No way to make a non-local channel or an `agent` channel.** Everything local is `local: true`, and the `agent` channel is "not
   applicable" locally (SPEC-03 §2.2.1). `local_only`, pairing through the relay, and the remote drivers (Codex/Claude) need either
   a fake gateway in `HubOptions` (the gateway client lives in `packages/link`) or a test hook for the origin of a connection.
9. **Apps have no fixture.** Installing a test app (a directory with `app.json` + a stdio MCP server) is possible via `service:apps`, but
   nothing in SPEC-06 owns a shared fixture. R20, R23, R39, R58, R70–R74 wait for one (T7 is the natural owner).
10. **Pulse only exists with a placed widget.** SPEC-10 §3 makes pulse depend on `widget.placed` events and the schedule, so an hourly-pulse
    scenario needs the widget schema, the time zone of the host spec and the fake clock; not written yet.
11. **Unowned services: decided (11).** `service:clock` and `service:senses` are the new T21; the organ `app:sense-rules` is T19; `service:admin`
    (including the quiet-hours setting keys, gap 12) is T6. The timers, pause and senses scenarios depend on them.
12. **Quiet hours and other `admin` settings have no keys in `words.ts`** (`settings.set` is a free object), so they cannot be scripted.
13. **`sync` defaults.** SPEC-03 §5.2 does not say what a `sync` with neither `after` nor `before` returns, nor which way `before` pages. The
    harness always opens `after: 0` and pages with `before` + `limit` (the messages immediately before).
14. **Fixed waits.** Negative checks ("nothing woke the agent", "no card") use `quiet()` (300 ms); nothing that should arrive is waited for with a fixed time.
