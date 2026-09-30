# ASH-006 · Android permission flow spike

Status: implementation evidence complete on an Android API 36 ARM64 emulator; independent reproduction is still pending.

## Fixture

The standalone package is `ai.ash.permissionprobe`. It targets API 33, asks for calendar read access at runtime, and opens the system notification-listener settings. The screen displays both effective grants when resumed. It does not request notification posting; receiving other apps' notifications is a separate special access.

Build from repository root:

    JAVA_HOME=/home/xiewanpeng/ashwork/jdk21 ANDROID_HOME=/home/xiewanpeng/android-sdk android/gradlew -p tools/spikes/android-permissions :app:assembleDebug --offline

APK: `tools/spikes/android-permissions/app/build/outputs/apk/debug/app-debug.apk`. The fixture now opens its own notification-listener detail screen directly; the fallback is the general Settings list when that intent is unavailable.

## Device procedure

Use an isolated emulator. Confirm `adb -s SERIAL shell getprop ro.build.version.sdk` is at least 33. Install the fixture package only:

    adb -s SERIAL install -r tools/spikes/android-permissions/app/build/outputs/apk/debug/app-debug.apk
    adb -s SERIAL shell am start -n ai.ash.permissionprobe/.ProbeActivity
    adb -s SERIAL shell screenrecord --size 480x1066 --bit-rate 1000000 --time-limit 120 /sdcard/permission-probe.mp4

During recording, grant calendar from the fixture dialog, revoke it in the fixture's App info → Permissions, return, and grant again. For listener access, use the fixture's Settings button; enable, disable, then enable the fixture listener, returning to the fixture after each step. Record each status change on screen. Pull the recording:

    adb -s SERIAL pull /sdcard/permission-probe.mp4 build/evidence/ASH-006/permission-probe.mp4

After each change, `tools/spikes/v6-status.sh SERIAL` prints the fixture's grant state without changing it. Save that output alongside the recording.

If system Settings reports restricted access, record that screen and the installer source; do not bypass it silently. Capture the OS version, target SDK, and observed status transitions in this report. Do not toggle any personal app's permissions.

## Target SDK findings to verify on device

The current host target SDK is 28 and it has no READ_CALENDAR or notification-listener service declaration. Calendar read is a dangerous runtime permission, so the host must declare and request it. Notification-listener access is a separate user-controlled Settings grant. Android 13's POST_NOTIFICATIONS controls posting notifications, not reading them. The existing target SDK 28 is also below 33, so posting-permission dialog timing differs from a target-33 app. This fixture tests target 33; a separate host-target-28 check is needed before final host integration. On Android 13+, sideloaded apps may encounter the restricted-settings interstitial; this emulator did not display one for the fixture, so that installer-specific branch remains unverified.

References: [calendar permission](https://developer.android.com/reference/android/Manifest.permission#READ_CALENDAR), [notification listener service](https://developer.android.com/reference/android/service/notification/NotificationListenerService), [Android 13 notification posting permission](https://developer.android.com/develop/ui/compose/notifications/notification-permission), [restricted settings](https://support.google.com/android/answer/12623953).

## Result · 2026-10-01

The fixture built successfully offline and was installed on `emulator-5554`. The emulator reported Android API 36. The first graphical emulator session stalled after the initial calendar grant; after a normal headless restart of the same AVD, adb and system Settings recovered without wiping data.

| Access | Observed fixture / Settings transitions | Video |
|---|---|---|
| Calendar read | `false → true → false → true`; runtime Allow dialog, revocation in fixture App info → Permissions → Calendar, and runtime regrant | `v6-calendar.mp4` (95 s) |
| Notification listener | `true → false → true` in the final clean clip; the initial `false → true` grant was separately observed in Settings and the fixture UI | `v6-listener.mp4` (48 s) |

The listener's system switch and the fixture's displayed status agreed after each transition. No fixture crash occurred when either access was revoked. The two recordings show only the isolated fixture and its system permission screens. The final read-only status script printed API 36, fixture target SDK 33, `READ_CALENDAR: granted=true`, and notification listener `enabled`.

Recording SHA-256:

    v6-calendar.mp4  7ac6670872d1716ee623aba6888e39b7c83a3b059b3e5dc6b01f61a2ba0149a6
    v6-listener.mp4  86e7a33668fe7bc3518859c49aa1380f706198efe9582b95dbf20c757fa15089

The evidence establishes the two UI permission cycles on this emulator and target 33. The current host target 28, other device ROMs, and sideloaded restricted-settings behavior remain integration risks. An independent reviewer must repeat the procedure before this card can be marked Done.
