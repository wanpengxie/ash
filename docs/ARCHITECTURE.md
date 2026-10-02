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

## Build and checks

`payload/manifest.json` locks the published DSH package and Android runtime inputs. `npm run build:payload` assembles the payload without editing DSH's package files. The Android Gradle build embeds that payload in the APK. The test suite includes world/service tests, installed-DSH integration tests when `ASH_TEST_DSH_ROOT` is set, and real Chromium UI scenarios (`npm run test:ui:e2e`). A successful build or test run is not a substitute for Android device, online gateway, JEV latency, or final experience validation.
