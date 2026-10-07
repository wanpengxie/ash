# ash architecture

## Two worlds

ash owns the personal-agent world: message ledger, members, routing, permissions, timers, notifications, devices, and UI. DSH owns the agent runtime: model turns, sessions, native tools, and skills. The production boundary is `ash-api/2`; DSH is installed as published and hosted in the same Node process through its extension points.

The Android app supplies lifecycle, foreground service, system permissions, sensors, notifications, AlarmManager, Keystore, and device actions. It runs one ash core child process. The WebView loads static UI assets from the APK through `WebViewAssetLoader`; a native bridge relays the UI's local Core requests. A paired remote browser reaches the Core through the gateway tunnel.

## Message path

```text
owner screen / Android host / timer / device
        │
        ▼
ash-api/2 edge → router → append-only SQLite ledger → addressed member
                       │                         └→ screen stream / activity projection
                       ├→ gate for sensitive effects
                       └→ agent:main → DSH turn → ash tool → router
```

Members exchange typed words using `request`, `response`, and `event` messages. Requests and replies are joined by `reply_to`. The owner, agent, clock, delivery, gate, managed files, sensors, reflex, background work, and administration are members of the same world. The UI projects the ledger; it is not the source of truth for a turn or an approval.

The DSH door presents five ash-owned tools: `ash_describe`, `ash_send`, `ash_say`, `ash_react`, and `ash_show`. Device capabilities are discovered through `ash_describe` and invoked through `ash_send`, not registered as an individual model tool per capability. An audited set of DSH-native file and web tools remains available. Sensitive operations pass through the existing gate, and managed identity/memory files use the `service:self` words.

## Asynchronous owner interaction (container runtime)

The container's `AgentMcpServer` carries approval metadata separately from capability arguments:
`purpose` and `approval_ttl_minutes` (default 10, range 1–10080). Reads and rule/reviewer passes still execute
normally. When the router creates an owner card, the tool immediately returns `waiting_owner`, `pending_id`,
`expires_at` and the card title. It does not spend the 15-second fast path waiting for a human. Ending or
cancelling that agent turn does not withdraw the card. `await_result` remains for actual long execution,
not owner decisions. The older in-process DSH Door retains its separate synchronous compatibility bridge.

`human_pending` and `human_outbox` share the message ledger's SQLite database. Gate creation records the
frozen original request and its owner ask atomically. An answer changes no external state: a durable outbox
delivers the original question, purpose, answer, times, original owner context and frozen action to the
originating agent's inbox. The normal inbox steers an active session or starts another turn. Stable delivery
client IDs prevent duplicate inbox messages, including a crash after intake but before delivery acknowledgement.
Recovery also reconciles an owner response committed just before the pending-state update.

`human_pending_redeem(pending_id)` is the only container-tool path that dispatches an approved frozen action.
It accepts no replacement arguments. Current tool/word policy, caller authority, contract fingerprint, TTL
and the redeeming turn are checked again; the ledger atomically claims the approval with the dispatch phase.
The request runs under the new turn for screen constraints and cancellation. Repeated redemption is rejected;
the pending record or execution receipt exposes the result without another execution. A crash after the claim reports an
unknown outcome rather than replaying a potentially committed external effect. The agent must re-read an
affected screen and reassess current intent before redemption; Ash does not freeze an external screen.

`human_ask` and `human_confirm` create the same durable pending record without an attached action.
`human_pending` / `human_pending_get` inspect it; `human_withdraw` only withdraws an unanswered request;
`human_pending_skip` records why an approved action will not continue. Main may inspect all records, but
only the originating identity may mutate or redeem; helpers' pending, approval-audit and rule queries are
filtered server-side. Agent removal retires that identity's pending work and receipt namespace.

The `human.pending` ledger event distinguishes waiting, answered, redeemed, denied, expired, withdrawn and
skipped. Chat cards and the approvals page distinguish approval from execution and retain the full original.
Android question notifications validate the original offered choices and route custom text back to the
original ask, rather than turning it into an unrelated main-agent message. Approval notifications retain
their fixed approval choices. Host socket disconnects are contained within a client worker.

Both main and helper prompts include `prompts/rules/approvals.md`. Regression coverage lives in
`world/human-pending.test.ts`, the Chromium `human-pending.spec.js`, and Android notification-route tests.

## Processes and transport

```text
Android App process                         Node ash core process
  CoreService (foreground) ──────────────── process supervisor
  HostServer 127.0.0.1:4710 ◀────────────── host device link
  HomeActivity + APK UI assets ─ native ──▶ edge 127.0.0.1:4700
  sensors / notification actions ─────────▶ world members
                                            DSH host + main / mind sessions
                                            outbound gateway link
```

The phone makes the outbound gateway connection. Paired browsers are additional screens; a paired laptop running the client role can expose its MCP capabilities as a device. Pairing, owner-only administration, and device grants remain distinct from an Agent's ordinary tool call.

`service:devices` owns device management and persists local policy in `devices.json`. The settings UI and `device_*` / `gateway_*` MCP tools call the same words. Only the local owner and main Agent can manage devices. Agent requests to pair, widen permissions, or update require an owner card; approval leaves the action frozen until the originating Agent explicitly redeems it. Restrictive changes do not require a card. The legacy administration gateway operations delegate to this service.

Computers default to `approval`: reads pass, writes/edits without an owner rule ask, and commands can be reviewed. Global `always` takes precedence over ordinary rules. An explicitly `full` computer bypasses action approval, recording `device_full`; this never changes the phone's policy. Local Agent use and browser UI access are separate grants, disabled by default on computers. Browser pairing grants only chat and UI access. Withdrawing local Agent access closes its channel and prevents reopening it. The remote AgentSystem runtime adapter is a separate integration step.

The development device process and local-gateway round trip are testable with `tools/e2e-device.ts`. Pairing follows the key rule: agents may list devices and start pairing, but the pairing code is never in a result or the ledger. `pair_start` only reports that a code was issued; the code, its countdown and the one-line installer command (`install.sh GATEWAY CODE` from the `device-v0.1.0` release) are read by the local owner's devices page from an owner-only route, and approving a device stays the owner's. A pairing request is announced to the owner with the device name and fingerprint. A gateway that refuses the claim or cannot be reached never stops ash; `gateway_status` reports why.

## Build and checks

### Activity presentation

The web activity sheet and native task capsule share `sdk/activity.ts`: a concrete purpose, actual tool name,
selected non-secret target, request identity and lifecycle. Transport status pulses are not work steps.
An unambiguous identical capability wrapper and dispatch share one step; concurrent ambiguous calls stay separate.
Accepted receipts are pending, not successful execution. Device failure cannot be overwritten by wrapper success.

`GET /api/activity/detail?id=<request-id>&offset=<character-offset>` is an owner-only, read-only projection of an
existing agent request and its reply. It returns redacted JSON text in 16,000-character pages with `next_offset`;
it does not dispatch, approve or retry anything. Raw inputs/results never enter the native capsule. The detail
view labels stored previews; runtime result capture is bounded to 64,000 characters and marks truncation.

DSH's committed thought updates may produce an optional, short user-facing progress summary using the existing
DeepSeek credential. This runs asynchronously with a four-second timeout and separate `progress` usage accounting.
Raw reasoning is not stored in Ash's activity ledger. Summaries are labelled as such, never execution evidence;
late summaries cannot override current tool progress, and turn completion/cancellation discards unfinished summaries.
No model text means an honest waiting state, not a fabricated work phase.

The native capsule always exposes a direct conversation input button, including collapsed, waiting and completed
states. Input uses the authenticated phone-owner `say` path with a persisted client id for uncertain retries;
it does not bring Ash to the foreground. The editor acquires keyboard focus only on an explicit tap. Screen
gestures and captures defer while the owner is typing. A successful completed turn is green and remains visible
outside Ash until dismissed, returned to Ash, or replaced by a new task. Its controls are Return to Ash, Close
notification and Continue input. Returning to Ash consumes completion; leaving Ash again never resurrects it.

`payload/manifest.json` locks the published DSH package and Android runtime inputs. `npm run build:payload` assembles the payload without editing DSH's package files. The Android Gradle build embeds that payload in the APK. The test suite includes world/service tests, installed-DSH integration tests when `ASH_TEST_DSH_ROOT` is set, and real Chromium UI scenarios (`npm run test:ui:e2e`). A successful build or test run is not a substitute for Android device, online gateway, JEV latency, or final experience validation.
