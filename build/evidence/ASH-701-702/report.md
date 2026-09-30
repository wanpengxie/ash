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

A subsequent code review found three boundaries. The scanner now keeps a six-hour rolling rescan alarm even when no occurrence/reminder is present. Shutdown serializes queued callbacks behind cleanup and refuses callbacks after close. Accepted changes retain an acknowledgement and last-delivered occurrence state until the snapshot advances; an ambiguous send is first replayed with its reserved client ID before comparing the provider's latest state. Version generations distinguish repeated A→B→A→B transitions before a batch commit. JVM tests exercise partial success, lost acknowledgement, reversal, deletion/reappearance and repeated versions.

### Follow-up real alarm probe

An isolated API 36 `sensesProbe` build kept the production six-hour interval in the release BuildConfig and used a fixed 90-second interval **only** in the disposable test build (not remotely configurable). Before launch, a synthetic event was placed 24 hours plus 30 seconds ahead. Its first snapshot was `{}`. With no calendar mutation, the system's exact 90-second `CalendarAlarmReceiver` alarm fired; the same occurrence then appeared in the snapshot, and `dumpsys alarm` showed one package wakeup. This accelerates the rolling-window mechanism; it is not evidence of a literal six-hour wait.

A second synthetic event was placed about 31 minutes ahead. Before its scheduled lead time, its occurrence was in the snapshot but had no `reminded` marker. `dumpsys alarm` showed an exact `RTC_WAKEUP` at `start − 30 minutes`; after that wall-clock time the fake receiver saw one additional request, the marker for that occurrence appeared, and package alarm wakeups advanced from one to two. Force-stopping and relaunching the isolated test package retained the marker. The first fake receiver logged only request lines, so its post-restart request count cannot alone prove the absence of a duplicate calendar send; the revised receiver emits only safe word/kind classifications for independent replay. No clock adjustment or direct refresh call was used to simulate either alarm.

Reproduction uses only a uniquely named new local calendar and the isolated package. Push `tools/spikes/senses-fake-core.sh` to an exact temporary path, run `adb -s emulator-5554 shell sh /data/local/tmp/senses-fake-core-701.sh` in a foreground terminal, build/install `app-sensesProbe.apk`, and grant `android.permission.READ_CALENDAR` to `ai.ash.agent.sensesprobe` before first launch. Create a local calendar with account name `ash_sense_701_probe` and record the returned/queryable `_id`; create events with `calendar_id` equal to that ID, `dtstart` at device-now + 24h + 30s (rolling) and device-now + 31min (reminder), each with `dtend > dtstart` and `eventTimezone=UTC`. Query only this account/IDs before deletion. This run used calendar ID 1 and event IDs 2/3; those IDs are observations, **not** reusable delete targets. Cleanup used `content delete --uri content://com.android.calendar/events/<verified-id>` for each verified synthetic event, then the verified synthetic calendar URI with `caller_is_syncadapter=true` and its account parameters; queries for the exact account and event IDs returned no results. The isolated package was uninstalled and its temporary fake script removed. The existing application package was untouched.

Before the direct-loopback fix, the isolated host's `HttpURLConnection` received HTTP 503 from the emulator's configured system proxy while a direct shell request reached the fake core. After `Proxy.NO_PROXY`, the actual host requests reached the fake core. No credential value or calendar body was logged or committed.

After the run, the synthetic event and its calendar were deleted by their verified IDs and a provider query returned no rows. Both disposable APKs and the temporary fake-core script/log were removed; the fake port was closed. The original application's loopback ports remained open. The original app package and its private data were not touched.

## Independent scope and integrated checks

An independent reviewer replayed the fixed host revision on a separate API 36 isolated package and fake receiver. All 15 JVM tests and the isolated APK assembly passed. The reviewer observed a real provider-change callback, the exact lead-time `RTC_WAKEUP` and reminder marker, a 90-second test-only rolling rescan, and no repeat `upcoming` after force-stop/relaunch. Calendar permission revocation held the snapshot unchanged and regrant resumed it. Battery 15→16→14 did not resend while latched; 17→14 sent once. Screen off/on and app-open events reached the receiver. The reviewer verified exact synthetic calendar/event IDs before deleting them, then confirmed empty provider queries, uninstalled the isolated package, stopped the fake receiver, removed both temporary scripts, restored AC-powered battery level 100 and Awake screen state, and left the existing package untouched. This is independent **host/fake-receiver** evidence, not a genuine core-ledger or permission-card integration result; the separate detailed device log is private and is not copied into this public repository.

After merging the current shared branch into this work branch, `npm run typecheck`, the complete `npm test` (139 pass, 57 intentional skips, zero failures, natural exit), and Android's 15 JVM tests plus isolated Kotlin compile passed. The private-term scanner checked 325 tracked public files with zero findings; only its aggregate counts are reported here. The merge did not alter sensor implementation files. The production release BuildConfig remains six hours; only the disposable probe build is accelerated to 90 seconds.

## Open integration checks

- The isolated host and independent reviewer validated the sensor/receiver behaviors above. Reboot restoration and genuine core ledger receipt/wake rules remain unverified; F-D01/F-D03/F-D04 still require integration sign-off rather than treating a fake receiver as the final target.
- No-permission safety is covered by a local grant guard, `SecurityException` handling and the isolated revocation/regrant run; the in-conversation permission card belongs to the later core/UI integration. F-D02 remains open until that card is exercised with the host.
- Browser `screen.registered`/token and visible heartbeats are server/Web UI responsibilities; the Android activity reports native foreground entry/exit only. F-D13 remains open until the browser implementation is joined and background heartbeat cessation is observed.
- This emulator run does not establish behavior on other ROMs, a physical device, or sideloaded restricted-settings branches.
