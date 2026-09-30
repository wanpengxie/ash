# ASH-701 / ASH-702 · phone sensor implementation evidence

## Scope

The resident service owns a calendar observer and a next-reminder alarm, plus battery and screen receivers. Calendar reads are guarded by the runtime grant; an unavailable or revoked grant cancels its alarm and does not crash the service. A successful scan compares future-day occurrences with the last accepted snapshot and sends `sense.calendar` `changed` events; the next occurrence beginning in 30 minutes gets an `upcoming` event. Delivery failure retains the comparison baseline and schedules a retry. Battery sends below 15%, rearms only at 17%, and retains a pending ID until acknowledgement. Screen-on and app-resume events report a non-negative elapsed-away value. The host sends only the three declared sensor words, with `to:null`, `kind:event` and an authenticated bearer header; it never places `from` or origin claims in the body. Sensor HTTP explicitly bypasses the system proxy for loopback.

This is host-side implementation, not a claim that the still-unimplemented receiver, wake rules, browser screen registration, or permission card are integrated. The present core payload does not yet implement this `/api/send` route. The service's existing target SDK remains 28; no target bump or workaround for Android's app-private executable limitation is included.

## Reproduction

Use JDK 21 and Android SDK 35. From the repository root:

```sh
cd android
./gradlew :app:testDebugUnitTest --offline --console=plain
./gradlew :app:compileDebugKotlin --offline --console=plain
```

Eleven JVM tests passed: decision tests cover battery 14–16% non-repeat/rearm, elapsed-away non-negativity, calendar day/reminder boundaries, and rolling-window rediscovery after an initially empty scan. Three tests drive the exact HTTP envelope against a loopback fake server, including rejected status and invalid word/ID negatives. Three outbox tests cover partial batch success followed by process-style reconstruction, lost acknowledgement storage with stable client ID, and reminder marker retry. Two lifecycle tests cover queued observer work during stop and idempotent close. Kotlin compilation passed. These do not prove that the not-yet-implemented core receiver accepts events.

To repeat the Android target-28 permission boundary on a disposable API 36 emulator, build the existing isolated permission fixture with an independent package name:

```sh
android/gradlew -p tools/spikes/android-permissions :app:assembleDebug --offline \
  -PprobeApplicationId=ai.ash.sensesprobe -PprobeTargetSdk=28 -PprobeMinSdk=24
adb -s emulator-5554 install -r tools/spikes/android-permissions/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 shell am start -n ai.ash.sensesprobe/ai.ash.permissionprobe.ProbeActivity
```

The fixture displayed calendar read `false`, a tap on its request button opened the Android permission dialog, Allow changed the effective grant to `true`; `pm revoke ai.ash.sensesprobe android.permission.READ_CALENDAR` changed it to `false`, and a fresh in-app request/Allow returned it to `true`. Package inspection showed `minSdk=24 targetSdk=28`; all observations were on API 36. The test used no calendar entries. The disposable package was then removed with `adb -s emulator-5554 uninstall ai.ash.sensesprobe` (success). No pre-existing app package, calendar, or user data was changed. This reuses the ASH-006 fixture to check the actual host target level; it is not a second validation of every OEM/restricted-settings path.

## Isolated host on API 36

The `sensesProbe` build type uses an independent application ID and a separate loopback test port. `./gradlew :app:assembleSensesProbe --offline` built the actual host sensing code. Only that disposable package was installed; the in-use application was neither updated nor stopped. `tools/spikes/senses-fake-core.sh`, run on the emulator, consumed complete HTTP bodies without logging them and returned an acknowledgement; JVM fake-server tests above assert the request body and header schema. The test build deliberately omitted the production payload, so its supervisor reported `payload-index.json` missing. That expected isolated-build error did not stop sensor receivers; it is not a successful end-to-end core run.

Observed with one synthetic local calendar and event, initially more than 30 minutes away:

| Stimulus | Observation |
|---|---|
| Initial grant and scan | A private snapshot contained the synthetic occurrence; no invented `changed` event on first baseline. |
| Update synthetic title | The actual `ContentObserver` caused one fake-core request, and the accepted snapshot changed to the new title. |
| Move occurrence into the 30-minute reminder window | The fake core saw three requests: old occurrence change, new occurrence change, and due `upcoming`; private state recorded the new occurrence as reminded. This tests an already-due reminder, not the exact alarm firing after 30 minutes. |
| Revoke calendar grant, change title, reopen app | The process stayed alive/restarted safely and its calendar snapshot did not change. Regrant and reopen advanced that snapshot to the new synthetic title. |
| Battery 100→14→15→16→14 | One request at 14, none during oscillation. 17→14 produced a second request; battery test mode was reset to the original AC-powered 100%. |
| Power off/on, app foreground | The fake core received two requests in that sequence; the screen was restored to Awake. Per-event body identity/elapsed time was covered by JVM policy and transport tests, not captured in this device run. |

A subsequent code review found three boundaries after this device run. The scanner now keeps a six-hour rolling rescan alarm even when no occurrence/reminder is present; this prevents an unchanged event beyond the initial 24-hour horizon from being invisible when it later enters the window. Independently accepted `changed` deliveries now retain durable acknowledgement records until the whole snapshot advances, so retry after one event fails does not resend already accepted siblings with a new ID. Shutdown serializes queued callbacks behind cleanup and refuses callbacks after close, preventing an already-dispatched observer callback from re-registering after service stop. The new tests verify these mechanics offline; they have not yet been replayed on the emulator after this patch.

Before the direct-loopback fix, the isolated host's `HttpURLConnection` received HTTP 503 from the emulator's configured system proxy while a direct shell request reached the fake core. After `Proxy.NO_PROXY`, the actual host requests reached the fake core. No credential value or calendar body was logged or committed.

After the run, the synthetic event and its calendar were deleted by their verified IDs and a provider query returned no rows. Both disposable APKs and the temporary fake-core script/log were removed; the fake port was closed. The original application's loopback ports remained open. The original app package and its private data were not touched.

## Open integration checks

- The isolated host validated its `ContentObserver`, already-due reminder, battery hysteresis and screen-on/foreground request activity through a fake core. A future real-time alarm fire, process-kill/reboot restoration, the new rolling scan/outbox/lifecycle changes on-device, and genuine core ledger receipt/wake rules remain unverified; independent review is still required before F-D01/F-D03/F-D04 are signed.
- No-permission safety is covered by a local grant guard, `SecurityException` handling and the isolated revocation/regrant run; the in-conversation permission card belongs to the later core/UI integration. F-D02 remains open until that card is exercised with the host.
- Browser `screen.registered`/token and visible heartbeats are server/Web UI responsibilities; the Android activity reports native foreground entry/exit only. F-D13 remains open until the browser implementation is joined and background heartbeat cessation is observed.
- This emulator run does not establish behavior on other ROMs, a physical device, or sideloaded restricted-settings branches.
