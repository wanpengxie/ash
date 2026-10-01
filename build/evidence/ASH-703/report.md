# ASH-703 notification sensor — author evidence

Status: implementation candidate for independent review, not a completed card.

The existing `sense.notification{app,title,text}` event contract is sufficient; no SDK wire change was made. The Android listener is a separate system-bound service. Both a local owner opt-in (default `false`) and the Android notification-listener special access are required. The diagnostic screen offers an explicit opt-in, opt-out and the system access page, and reflects the effective state after returning. Only newly posted callbacks are considered; the service does not query active notifications or persist notification content for later retry. It skips its own package and copies only bounded app/title/text fields. Delivery failure is logged without message content and does not crash the listener. A callback queued before opt-out or revocation rechecks both gates before reading extras and before sending. A network request already started cannot be rolled back; this test does not claim instantaneous cancellation of an in-flight HTTP send.

## Reproduce without personal data

The isolated build has package `ai.ash.agent.sensesprobe`, target SDK 28, and sense port 4870. It intentionally excludes the application payload in this probe; the home screen may show a missing-payload diagnostic, but the notification listener and diagnostic controls still run. Build and run JVM tests from the repository root:

```sh
JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk android/gradlew -p android :app:testDebugUnitTest -x :app:copyPayload --offline
JAVA_HOME=/path/to/jdk21 ANDROID_HOME=/path/to/android-sdk android/gradlew -p android :app:assembleSensesProbe -x :app:copyPayload --offline
node tools/spikes/v703-fake-host.mjs
```

The fake host listens only on `127.0.0.1:4870`, accepts only authenticated-shaped `sense.notification` events whose title and text begin `ASH703_SYNTHETIC_`, and exposes counts at `GET /state`. It never prints credentials or notification contents. If adb's server is on a different computer, establish a dedicated loopback relay from that computer's port 4870 to this fake host before running `adb reverse tcp:4870 tcp:4870`; verify the relay and remove only this reverse mapping afterwards. Do not point the probe at a personal core.

On an isolated emulator (substitute its serial), install only the probe APK, open its app, skip onboarding and enter Diagnostics. The local notification-reading control starts off. Use its button to opt in and open the component-specific Android access page; grant or revoke there, then return to Diagnostics to inspect the state. Post only these synthetic shell notifications, one at each state transition:

```sh
adb -s emulator-5554 install -r android/app/build/outputs/apk/sensesProbe/app-sensesProbe.apk
adb -s emulator-5554 reverse tcp:4870 tcp:4870
adb -s emulator-5554 shell cmd notification post -t ASH703_SYNTHETIC_OFF ash703-off ASH703_SYNTHETIC_OFF
adb -s emulator-5554 shell cmd notification post -t ASH703_SYNTHETIC_ON1 ash703-on1 ASH703_SYNTHETIC_ON1
adb -s emulator-5554 shell cmd notification post -t ASH703_SYNTHETIC_LOCAL_OFF ash703-local-off ASH703_SYNTHETIC_LOCAL_OFF
adb -s emulator-5554 shell cmd notification post -t ASH703_SYNTHETIC_REVOKED ash703-revoked ASH703_SYNTHETIC_REVOKED
adb -s emulator-5554 shell cmd notification post -t ASH703_SYNTHETIC_REGRANTED ash703-regranted ASH703_SYNTHETIC_REGRANTED
curl -fsS http://127.0.0.1:4870/state
```

Each `post` line is a separate step, not a batch: the intended order is initial off; both gates on; local switch off while system access stays on; local switch back on then system access revoked; system access regranted. Inspect fake-host counts after each step. Check the isolated component's grant without printing other apps' notification contents:

```sh
adb -s emulator-5554 shell settings get secure enabled_notification_listeners | grep -o 'ai.ash.agent.sensesprobe/[^:]*'
adb -s emulator-5554 shell cmd notification list | grep 'ash703-'
```

Clean up only this fixture: turn its local switch off, revoke its special access, dismiss only the five `ash703-*` shell notifications (the emulator grouped them; one precise group swipe removed the five), confirm the five tags no longer occur in `cmd notification list`, then run `adb -s emulator-5554 uninstall ai.ash.agent.sensesprobe` and `adb -s emulator-5554 reverse --remove tcp:4870`. Stop the fake host and its dedicated relay. Do not use notification “clear all”, alter the original app, or change another app's permission. If the five tags cannot be removed precisely on another ROM, leave them and report the residue rather than clearing unrelated notifications.

## Observed on isolated API 36 ARM64 emulator

| State when new synthetic notification was posted | Fake-host accepted count |
|---|---:|
| Local off; system special access absent | 0 |
| Local on; system access granted | 1 |
| Local off; system access still granted | 1 |
| Local on; system access revoked | 1 |
| Local on; system access regranted | 2 |

The target component appeared in the system's connected-listener record while enabled, and both accepted events came from newly posted synthetic notifications. Previously posted synthetic notifications were not replayed on grant or regrant. Returning from Settings showed “both on” after grant and “waiting for system access” after revocation; final local-off/revoked state was also verified. No crash occurred. The five synthetic tags, isolated APK, reverse mapping and temporary device capture files were removed; the dedicated Mac relay was separately closed and its port verified free. The original `ai.ash.agent` package was neither modified nor launched for this test.

All 34 Android JVM tests and the isolated APK build passed. The repository private-term CI scan reported 434 files and zero findings. This evidence is API 36 emulator + target-28 probe only; other ROMs, restricted-settings interstitials, physical phones and a production core `service:senses` integration remain independent gates. An independent reviewer must repeat the negative transitions before F-D05 can be signed.
