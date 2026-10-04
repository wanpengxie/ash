# Ash peripheral decision runtime

Status: implemented, 2026-10-05. This document records the peripheral decision
runtime replacing the stop-specific `service:reflex` implementation, with the
execution-screen extension in section 19. It does not describe an additional Agent.

## 1. Role in the system

Ash has two intelligent paths with different responsibilities:

```text
owner / world events
        |
        +----> Decision plane (`service:reflex`, JEV)
        |        fast, typed, tool-free, peripheral control decisions
        |
        +----> Agent plane (`agent:main`, DSH)
                 conversational, stateful, tool-using task execution
```

The decision plane observes the world around a DSH turn and controls that
turn's lifecycle or the surrounding product state. It does not converse, plan
tasks, browse, or operate arbitrary tools. The Agent plane remains responsible
for understanding and carrying out the owner's task.

`service:reflex` remains the durable member id for compatibility with existing
permissions, ledger records, and control words. Internally it becomes a generic
decision runtime. Conversation interruption is one decision route within that
runtime; it is not the runtime itself.

## 2. Design goals

1. One reusable path for fast semantic decisions outside DSH.
2. Typed inputs, typed questions, and closed-set outcomes for every decision.
3. Hooks before, during, and after a turn without coupling routes to the Agent
   implementation.
4. Deterministic code gathers facts, protects freshness, and executes effects;
   JEV makes the semantic choice.
5. A decision can never turn into an unrestricted tool call.
6. Every judgment and attempted effect is durable, attributable, idempotent,
   and debuggable without storing credentials or unnecessary sensitive text.
7. Adding a route must not require editing a central switch statement.

## 3. Non-goals

- This is not a second conversational Agent or a replacement for DSH.
- It has no session memory, tool loop, autonomous planning, or free-form action
  generation.
- It is not the approval gate. The gate decides whether an Agent request may
  cross a trust boundary; the decision runtime manages peripheral product and
  turn state.
- It is not `worker:*`. Workers perform slower one-off structured reasoning for
  workflows. The decision runtime is event-driven, latency-sensitive, and can
  pre-empt or reconcile a live turn.
- JEV is not trusted to establish facts. Facts come from the ledger and narrow
  device snapshots.

## 4. Module model

```text
world messages / lifecycle hooks
             |
             v
       DecisionRuntime
       - route registry
       - scheduling / supersession
       - JEV transport
       - audit emission
             |
       +-----+------------------+
       |                        |
       v                        v
conversation.control      screen.reconcile       future routes...
- trigger                  - trigger              wake, delivery,
- collect                  - collect              avatar, attention
- questions                - questions
- validate                 - validate
- freshness guard          - freshness guard
- restricted executor      - restricted executor
```

The implemented source layout preserves the existing member dependency boundary:

```text
packages/core/src/world/decision/
  runtime.ts              route registration, scheduling, audit lifecycle
  jev.ts                  generic typed JEV transport
packages/core/src/members/reflex/
  conversation-control.ts route semantics and restricted cancel/pause executor
  screen-execution.ts     pre-run screen choice, scoped runner context and constraint
  screen-reconcile.ts     route semantics and restricted screen executor
android/.../host/
  ScreenDecisionHost.kt   atomic host comparisons and screen effects
  ScreenDecisionState.kt  turn ownership, epochs and host-side deduplication
```

`members/reflex.ts` becomes the small world-member adapter which feeds accepted
ledger messages to `DecisionRuntime`. It should not contain route semantics.

## 5. Generic route contract

The following is conceptual TypeScript, not a final public API:

```ts
interface DecisionRoute<State, Questions, Answers, Outcome, Snapshot> {
  readonly id: string;                 // e.g. "screen.reconcile"
  readonly version: number;            // increments when semantics change

  match(message: Message): Trigger | null;
  key(trigger: Trigger): string;        // concurrency / supersession key

  collect(trigger: Trigger, signal: AbortSignal): Promise<{
    state: State;
    snapshot: Snapshot;
    evidence: string[];                 // ledger message ids, not prose claims
  } | null>;

  questions(input: State): Questions;
  interpret(answers: unknown): Outcome; // strict runtime validation

  stillCurrent(snapshot: Snapshot): Promise<boolean>;
  apply(outcome: Outcome, context: ApplyContext): Promise<ApplyResult>;

  fallback(error: DecisionFailure): Outcome | null;
}
```

Important constraints:

- `match` may perform only deterministic relevance checks. It must not encode
  the semantic answer that JEV is intended to decide.
- `collect` reads immutable ledger evidence and narrow current-state snapshots.
- `questions` and accepted answer shapes belong to the route, not to the JEV
  HTTP client.
- `interpret` accepts only known fields, valid enums, bounded scores, and finite
  numbers. Free-form text is evidence for diagnostics only and never an action.
- `apply` is implemented by the route and exposes only its closed set of
  effects. A model answer cannot choose an actor id, word, command, package, or
  arbitrary request body.
- `stillCurrent` runs immediately before the effect. A stale judgment is
  recorded and discarded.

## 6. Generic JEV transport

The existing `JevReflexClient.judge()` hard-codes the stop questions and answer
parser. Replace it with a transport shaped like:

```ts
interface DecisionModel {
  evaluate(input: {
    route: string;
    version: number;
    state: JsonValue;
    questions: JsonValue;
  }, signal: AbortSignal): Promise<unknown>;
}
```

The transport owns only:

- endpoint, model id, credential lookup, timeout, and cancellation;
- serialization and HTTP errors;
- response size limits and basic JSON-object validation.

It does not know what `stop`, `return_to_ash`, or `urgent` means. Each route
strictly validates its own answers. The credential remains in the vault and is
read for each evaluation, as it is today; no key enters the ledger.

One evaluation may contain several atomic typed questions. Questions that must
describe one consistent moment should be asked in one request, rather than in
separate calls which could disagree or observe different state.

## 7. Hook lifecycle

The runtime uses three lifecycle hook classes:

| Hook | Typical trigger | Purpose |
|---|---|---|
| `before_turn` | internal request immediately after durable `turn.start` | capture origin state, choose execution screen and initialize route-local observation |
| `during_turn` | owner `say`, device request/result, approval result | pre-empt or accumulate facts while the Agent is active |
| `after_turn` | `turn.end` | reconcile product state created by the completed turn |

`during_turn` and `after_turn` are observed from the ledger. A route may opt
into a narrow `before_turn` ordering barrier: after the Agent has durably
emitted `turn.start`, but before it invokes the DSH runner, it sends a local
internal `before_turn {turn}` request to `service:reflex` and
waits for bounded local state capture and eligible execution-screen judgment. Without this barrier an asynchronous
subscriber can lose the race to the Agent's first effect, making the supposed
baseline state false. A timeout or failed snapshot returns `captured:false`
and the turn continues; peripheral observation must never strand the Agent
path.

This is an Ash lifecycle hook, not a callback inside or modification of DSH.
The fast capture reads the Android bridge directly within the `before_turn`
handler, avoiding a second ledger request on the critical path. Non-sensitive
route captures are persisted in the hook response (`captures[{route,state}]`),
and that hook request id is included in the later decision's evidence.

The durable `turn.start` event remains the source of turn identity and evidence.
A route may keep a bounded in-memory cache for speed, but all evidence needed to
recover or explain a decision must be reconstructible from the ledger plus a
current device snapshot. A process restart after `turn.start` may lose the true
pre-action screen snapshot; in that case the screen route records `baseline
unavailable` and cannot choose `return_to_ash` for that turn. In the implementation,
unarmed turns never create a screen decision; pending decision records are instead
closed as `interrupted` on restart. Old host requests are cancelled before router
recovery, and are never replayed.

For an `after_turn` route, `turn.end` means that collection may begin; it does
not make a previously captured screen state authoritative. The route takes a
fresh post-turn snapshot and later rechecks it before applying an effect.

## 8. Route 1: conversation control

This route preserves current behavior while moving it behind the generic
contract.

### Trigger

A new owner `say` accepted while `agent:main` has an active turn. An explicit
global pause may also trigger while idle.

### State

- active turn id and original owner request;
- latest owner message;
- the last small number of owner/Agent utterances;
- current Agent phase and currently pending effect, if any.

### Questions and outcome

JEV answers the existing atomic questions: control intent, whether it targets
the current task, urgency, and confidence. The route maps strictly to:

```text
cancel_current | pause_ash | no_control
```

### Fast path and fallback

Exact, short commands may retain the local keyword fast path. This is an
explicit deterministic owner command parser, not a second semantic classifier.
Ambiguous language goes to JEV.

If JEV is unavailable, only the existing safe exact-command behavior applies;
ambiguous text remains normal inbox input. A failed model call must never gain
authority to cancel a task.

### Freshness

Before cancellation, the active turn must still equal the captured turn. Pause
must continue to prove the original owner-message provenance through the
router, as it does today.

## 9. Route 2: screen reconciliation

This route decides what to do with screen state after a conversational turn.
It is deliberately armed only when the owner starts the turn from the visible
Android Ash conversation. Ash then has a clear product responsibility: the
owner was looking at Ash before delegating the task, so the completed turn may
need to bring them back. Background and remote work carries no such implied
responsibility.

The semantic answer belongs entirely to JEV; deterministic code only proves
that the route is eligible, determines whether there is anything to reconcile,
and protects result freshness.

### Eligibility

All of these must be true before the DSH runner starts:

- the turn batch contains an explicit `person:owner -> agent:main/say`;
- that message came through the Android HomeActivity's authenticated native UI
  transport, not a remote browser or replay;
- `AppState.homeVisible` is still true when the turn is about to start;
- the Ash conversation page is live, rather than onboarding, diagnostics, or
  the embedded browser.

Proactive wakes, timers, background Agent work, agent-to-agent turns, Mac/web
messages, and owner messages sent after switching away from Ash do not arm
screen reconciliation. They may use the phone, but completion will not pull
the real screen into Ash.

This check is intentionally blocking: the task runner starts only after the
local visibility snapshot returns. It does not inspect a screenshot or walk an
accessibility tree. Android already maintains `AppState.homeVisible` from
`HomeActivity.onResume/onPause`; add a monotonic `visibility_epoch` beside it
and return both through the local host bridge. The operation is an in-process
memory read plus localhost IPC and should normally complete in milliseconds.
Use a short bounded timeout; failure simply leaves the route unarmed and starts
the task.

The original capture-only hook deadline was 2 seconds; with section 19's
execution-screen judgment it is now 10 seconds, with an 800 ms host-read deadline
and a maximum 6-second execution judgment. The local state capture budget
allows for durable ledger writes and scheduling on a loaded phone, while the
visibility read itself remains an in-memory operation. The emulator measured an
11 ms direct bridge round trip; complete audited hook responses in successful
probes took 232–496 ms. These are observations, not a device-independent latency
guarantee.

### Observation window

At `turn.start`, capture:

- `homeVisible` and `visibility_epoch` from Android `AppState`;
- triggering owner message ids and origin screen.

This capture uses the bounded `before_turn` barrier described above. The
reconcile route itself only captures; section 19's execution route may also ask
JEV before dispatch. No screen effect is applied before the DSH turn begins.
It also means no full general-purpose pre-turn
screen snapshot is necessary: eligibility itself establishes that the real
screen originated in Ash.

During the turn, record successful screen-affecting requests associated with
the turn. This is evidence collection only. Examples include foreground app
launches, screen gestures, virtual-screen creation/use, and authentication
handoff signals.

At `turn.end`, capture:

- turn reason and final Agent reply;
- real-screen foreground package/activity and state epoch;
- successful real- and virtual-screen effects;
- open virtual-screen ids created or used by this turn;
- whether an approval, login, QR scan, CAPTCHA, OTP, or owner action is still
  pending;
- whether a newer turn has started.

If the turn caused no relevant screen state or virtual-screen change, the route
does not call JEV.

### One coherent JEV decision

The route asks both questions in one evaluation:

```text
real_screen:    return_to_ash | stay | leave_unchanged
virtual_screen: close | keep | none
```

JEV receives the owner request, final reply, completion reason, origin and
current screen facts, successful screen actions, and pending-human-action
facts. It decides semantics such as:

- a delegated "check/handle this" task normally returns to Ash when complete;
- "open WeChat" or "take me to Settings" normally stays at the destination;
- a screen waiting for login, scanning, confirmation, or OTP normally stays;
- a turn which only used a virtual screen should not steal real-screen focus;
- a virtual screen which has finished its delegated task can be closed.

These examples belong in the route's JEV question criteria and tests, not as a
hard-coded `if` ladder in the executor.

### Device contract required

Add narrow, non-Agent-facing device primitives:

```text
service:reflex/surface.get -> {
  home_visible,
  visibility_epoch,
  page_live
}

service:reflex/screen.get -> {
  foreground_package,
  state_epoch,
  virtual_generation,
  virtual_owner_turn,
  virtual_open
}

service:reflex/screen.return { expected_state_epoch, expected_package, decision_id }
service:reflex/virtual.close { expected_generation, owner_turn, decision_id }
```

They are available only to the local authenticated `service:reflex` path, not
as general model tools. The Android host performs compare-and-act atomically
where possible. `return_to_ash` launches the existing Ash activity; it does not
simulate Back, because Back has app-specific and stack-specific consequences.

`surface.get` reads Android lifecycle state without requiring Shizuku
or the accessibility service. It now also reports a cheap Shizuku readiness
boolean (`virtual_available`), but does not start Shizuku or create a display.
`screen.get` is only needed after the
turn and for the final freshness check; it is not on the normal task-start
critical path.

Virtual screens must carry ownership metadata (`created_by_turn`, last-used
turn) so the reconciler cannot close a screen created by the owner or another
concurrent turn.

### Freshness and user precedence

The decision is discarded if, after collection and before effect:

- a newer conversational turn started;
- the foreground package or state epoch changed;
- user interaction changed the combined monotonic `state_epoch`;
- the virtual screen no longer exists or is no longer owned by the turn;
- Ash is shutting down or paused in a way which invalidates the action.

The owner always wins a race with JEV. If the owner touches or switches the
screen while judgment is pending, Ash leaves the screen alone.

If JEV times out, is unavailable, or returns an invalid answer, the fallback is
`leave_unchanged + keep/none`. Returning focus is a convenience, not an effect
worth guessing about.

## 10. Scheduling and concurrency

Each route supplies a decision key. The runtime permits at most one active
evaluation for a key:

```text
conversation.control:<owner-message-id>
screen.reconcile:<turn-id>
```

Routes also define a supersession group. A new turn supersedes an unfinished
screen reconciliation for the previous turn. A newer screen snapshot
supersedes an older snapshot for the same turn. Supersession aborts the HTTP
request when possible and records the old decision as `superseded`; it does not
apply its fallback.

Routes may run concurrently when their keys and effects cannot conflict. Effect
executors still serialize on a resource key such as `agent:main`,
`real-screen:device:phone`, or `vscreen:<id>`.

Runtime shutdown aborts outstanding evaluations, waits for executors which have
already crossed their compare-and-act boundary, and writes no new effect after
closure.

## 11. Durable decision record

Use generic events rather than adding a new event name per route:

```text
decision.started {
  decision_id, route, route_version, trigger_id, turn?, evidence_ids,
  state_fingerprint
}

decision.judged {
  decision_id, route, route_version, outcome, confidence?, latency_ms,
  stage, fallback?
}

decision.applied {
  decision_id, route, route_version, trigger_id, outcome?, acted, effects?,
  skipped?: stale | superseded | unavailable | invalid | timeout | closed | interrupted
}
```

`decision_id` is deterministic for the route and trigger. Event `client_id`s
derive from it, making retries idempotent. Full credentials are never recorded.
The full JEV state is not copied into the ledger: immutable evidence message ids
plus a canonical state fingerprint provide traceability without duplicating
owner content. Small non-sensitive facts needed by the activity UI may be
included explicitly.

During migration, conversation control may additionally emit the legacy
`reflex.judged` projection so existing UI/tests continue to work. New code uses
the generic events; the compatibility event can be removed after readers move.

## 12. Authority and safety

`service:reflex` is powerful because it can act outside normal Agent approval.
Its authority must therefore be narrower than an Agent's:

- route registration is compile-time code, not configuration supplied by a
  model or remote screen;
- every route declares its exact effect enum and executor;
- the router accepts only explicit `(service:reflex, target, word)` pairs;
- each effect rechecks source evidence or snapshot tokens immediately before
  acting;
- JEV output never supplies message addresses or raw effect parameters;
- device reads are narrow snapshots, not general screen or filesystem access;
- the decision plane cannot call `shell.run`, browser actions, arbitrary device
  capabilities, or owner-facing `say`;
- an outcome that would cross a trust boundary still goes through the gate or
  is not offered as a decision-plane effect at all.

## 13. Configuration

Move model transport settings under a decision section while accepting the old
configuration during one migration window:

```json
{
  "decision": {
    "jev": {
      "url": "...",
      "key_credential": "jev",
      "model": "typesafe/jev-1.13",
      "timeout_ms": 6000
    },
    "routes": {
      "conversation.control": { "enabled": true, "threshold": 0.6 },
      "screen.reconcile": { "enabled": true },
      "screen.execution": { "enabled": true }
    }
  }
}
```

Routes may expose thresholds only when the numeric threshold has meaningful,
tested semantics. Product policy should not be hidden in global generic
settings.

## 14. Extension pattern

A future feature is appropriate for this runtime when all of the following are
true:

1. it is triggered by world or lifecycle state;
2. it requires a small semantic choice, not a multi-step plan;
3. its answers can be a closed typed set;
4. its possible effects can be narrowly allowlisted;
5. stale results can be detected before effect;
6. failure has a safe, explicit fallback.

Likely routes include:

- `wake.attention`: wake now, defer, or ignore;
- `delivery.urgency`: in-app, notify, or hold;
- `presence.expression`: choose a bounded avatar state;
- `conversation.direction`: future redirect/wait behavior;
- `screen.reconcile`: post-turn real and virtual screen state.

Anything requiring browsing, tool selection, iterative reasoning, composing a
message, or deciding an unbounded action remains in DSH or `worker:*`.

## 15. Implementation sequence

1. Extract the generic `DecisionModel` transport while keeping current stop
   tests green.
2. Add `DecisionRuntime`, generic audit events, scheduling, cancellation, and
   strict route contracts.
3. Move existing stop/pause behavior into `conversation.control`; retain its
   legacy event projection temporarily.
4. Add the bounded `before_turn` capture hook and prove it precedes DSH runner
   dispatch without making snapshot failure block a turn.
5. Add Android screen snapshot, epoch, compare-and-return, and virtual-screen
   ownership primitives.
6. Implement `screen.reconcile` with no-op-on-failure and stale-result guards.
7. Add activity projection for generic decisions only after the ledger contract
   is stable.
8. Migrate configuration names and remove the stop-specific JEV client.

## 16. Acceptance criteria

- Existing explicit and JEV-assisted stop/pause behavior remains unchanged.
- The recorded pre-turn screen snapshot is taken after durable `turn.start` and
  before DSH runner dispatch; snapshot failure does not prevent the turn.
- Screen reconciliation is armed only by an explicit owner message sent from a
  live, visible Android Ash conversation; remote and background turns never
  return the phone to Ash.
- A route cannot make a JEV answer invoke an undeclared effect.
- A completed foreground delegated task can return to Ash when JEV selects it.
- A task which intentionally opens an app, or waits for owner action, can stay.
- A virtual-only task never changes the real-screen foreground app.
- User interaction or a new turn while JEV is pending prevents the old screen
  decision from acting.
- JEV timeout, malformed output, missing key, restart, and shutdown leave the
  screen unchanged and produce an intelligible durable record.
- Duplicate delivery or recovery of the same trigger cannot apply an effect
  twice.
- Adding a synthetic third route requires a new route module and registration,
  but no changes to the JEV transport or runtime scheduler.

## 17. Implementation boundaries

The generic interface above is conceptual: the shipped `DecisionRoute` creates a
job with `judge/current/apply` callbacks, optional `beforeTurn/observe/close`, and
a deterministic route/version/trigger key. This keeps the generic engine small.
Conversation control still publishes `reflex.judged` and accepts legacy `reflex`
configuration; both adapters remain intentionally for compatibility.

The host currently exposes one virtual display, so ownership is one generation
and one turn, not a general display pool. Reusing another turn's display never
transfers cleanup ownership. User interaction is detected through accessibility
events and Android activity lifecycle epochs; without accessibility and a known
foreground package, return-to-Ash is a no-op. Failed/cancelled turns, pending
requests, pause, shutdown and missing JEV credentials leave focus unchanged.
Login/OTP intent is inferred by JEV from owner text, final replies and action
evidence, not a new deterministic login classifier. No generic decision UI was
added; the existing conversation projection remains unchanged.

## 18. Verification (2026-10-05)

- Core/SDK/UI regression: 662 passed, 1 skipped, including installed DSH tests.
- After restricting all hook entrypoints to the internal decision service and
  hiding them from Agent discovery, 98 interface/decision regression tests passed.
- Architecture gate: zero findings, with the existing dependency rules unchanged.
- All 80 Android unit tests, including native transport proof injection, new-turn
  invalidation, display generation/ownership and deduplication, passed.
- Real Android simulator + native WebView UI + real DSH: return-to-Ash, intentional
  stay, owner switching to launcher during JEV judgment, and non-native API input
  all passed. The JEV endpoint was a local scripted server, not online OpenRouter.
- Virtual-only cleanup was verified with the core integration fixture and Android
  ownership tests. An actual Shizuku display was not exercised in this run.
- Exact stop/pause and JEV-assisted stop behavior keep their existing tests and
  legacy audit projection. Missing key, invalid JEV output, failed turn, capture
  timeout, stale state and supersession are covered by the new route tests.

The signed production-package APK is `build/delivery/ash-decision.apk` (SHA-256
`a5ea679feb2998bd4b426ce26e12808402e04758ec1acda23e17b16a20be85a2`). Its payload
core and the simulator's latest core both have SHA-256
`e70ea48de01c3752ed471cfb7bdf9e0e7490b8ba9220733a3df2017ddd9cb0fe`.
The four successful simulator scenarios were run before the final entrypoint
restriction. The subsequent final-version rerun reached an apps.open approval
card, then the mac-mini device went offline; that rerun was not completed. No
online JEV model or physical Shizuku display success is claimed.

The isolated simulator probe is `tools/decision-simulator.mjs` (`serve`, `keys`,
`probe`) with `tools/decision-simulator.config.json`. It targets only
`ai.ash.agent.probe`; the owner's installed package is never overwritten. Start
the isolated APK once, copy the override with app-owned permissions, restart its
core, then configure its test credentials. The script reads the existing
temporary DeepSeek test key, does not print it, and does not delete it. JEV's
synthetic credential is used only with the local endpoint. Do not reuse this
configuration as a production JEV setup.

## 19. Execution-screen selection and visible app delivery

An app opened *for the owner to use* is a different deliverable from work done
*inside an app on the owner's behalf*. A virtual launch does not satisfy the
first request. The `screen.execution` route now shares one pre-run capture and
preparation promise with `screen.reconcile`; it does not launch an app itself.

```text
native owner message -> local visible-page check -> JEV execution-screen choice
  -> trusted per-turn runner context + device execution constraint
  -> DSH performs the task -> JEV completion cleanup + freshness guard
```

JEV receives the triggering native owner messages, bounded recent conversation,
and real host readiness. Its closed outcomes are:

| Outcome | Execution intent |
|---|---|
| `foreground_handoff` | “帮我打开闲鱼”: open visibly on the real screen and leave the app for the owner |
| `virtual_task` | “在闲鱼帮我查一下价格”: prefer a usable virtual display, then report the result |
| `foreground_task` | Real-screen work or owner login/OTP is needed, or virtual capabilities are unavailable |
| `no_preference` | Chat, headless information lookup or another task needing no native app screen |

These examples are model criteria, not a deterministic phrase classifier. The
selection is independent of stop/pause and completion reconciliation; its route
can be disabled separately without disabling either. Old configs enable it by
default. Its plan, confidence, fallback and origin are durable in the internal
`before_turn` response under `captures[].state.execution`.

The Agent member passes only a trusted instruction string into the container
runner's pre-prompt injection and the legacy DSH runner's managed context.
Every turn explicitly supersedes older screen preferences, including turns with
no armed plan. Current app capability descriptions distinguish real foreground
delivery from virtual delegated work. The owner's task text is not rewritten.

The router checks the plan before asking for approval and again immediately
before device dispatch. Foreground plans reject `vscreen.create`, `launch` and
virtual input rather than silently rewriting them; read/status and cleanup
remain available. This constraint is scoped to `agent:main`, this turn and
`device:phone`, and does not override the owner's direct actions or bypass the
approval gate. It constrains declared virtual capabilities, not arbitrary shell
programs. The completion executor will not return to Ash when that would undo a
`foreground_handoff`, even if the cleanup model incorrectly selects return.

Missing/invalid/low-confidence/timed-out JEV uses a disclosed conservative
foreground-task fallback, never an unverified virtual plan. Selecting virtual
requires true readiness both at capture and immediately before runner dispatch.
User focus changes, turn cancellation or shutdown during judgment discard the
plan. The fast eligibility check remains local; model choice is a network call,
not a millisecond operation. The whole hook is bounded at 10 seconds so task
intake cannot be stranded by an uncooperative model.

`virtual_task` is a preference, not a guarantee that every Android app supports
a virtual display. Android may reuse an existing real-screen window. The runner
instruction requires checking `vscreen.see` after launch and explaining failures
or owner-login needs before switching to visible work. This extension does not
change the low-level virtual-display implementation or auto-start Shizuku.

Validation includes pre-run ordering, persisted plans, deliberately incorrect
virtual launch rejection, erroneous cleanup rejection, virtual-task cleanup,
unavailable Shizuku, malformed/low-confidence/missing/timed-out JEV, stale user
focus, cancellation during the pre-run judgment, remote/hidden input and both runner context adapters. These are automated
fixtures; no new live JEV or physical Xianyu/Shizuku success is claimed.

Final verification: 674 Core/SDK/runner/UI tests, 673 passed, 1 skipped, 0 failed
(installed DSH included); all 80 Android unit tests passed. Typechecking,
architecture gate (zero findings), APK signature and alignment checks passed.
The first full run had one loopback HTTP `fetch failed` in the existing DSH
approval-policy test; its five-test file passed separately and the final full
rerun passed without weakening assertions. The final focused screen/runner
regression passed all 27 tests, including pre-run stop and late-model handling.

The updated production-package APK is `build/delivery/ash-screen-execution.apk`,
SHA-256 `14facbf29840c2cc91fa38bd1909837cadc9d9d6f110b1f1f8ea90074fa1daf0`.
Its payload Core SHA-256 is
`1a65072a8ab20cce1b0f8d4457d62c158e87d9f5550e3750b540f663307e43c3`, verified
against both the build bundle and APK-embedded payload. The older
`ash-decision.apk` is preserved as the prior delivery, not the latest build.
The mac-mini remained offline during this extension, so this new APK was not
installed there and no additional live simulator/physical-phone result is claimed.
