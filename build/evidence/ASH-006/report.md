# ASH-006 · Android permission flow spike

Status: blocked during device flow. Fixture built and installed on an Android API 36 ARM64 emulator. Full grant → revoke → regrant evidence and video are still pending.

## Fixture

The standalone package is `ai.ash.permissionprobe`. It targets API 33, asks for calendar read access at runtime, and opens the system notification-listener settings. The screen displays both effective grants when resumed. It does not request notification posting; receiving other apps' notifications is a separate special access.

Build from repository root:

    JAVA_HOME=/home/xiewanpeng/ashwork/jdk21 ANDROID_HOME=/home/xiewanpeng/android-sdk android/gradlew -p tools/spikes/android-permissions :app:assembleDebug --offline

APK: `tools/spikes/android-permissions/app/build/outputs/apk/debug/app-debug.apk`.

## Device procedure

Use an isolated emulator. Confirm `adb -s SERIAL shell getprop ro.build.version.sdk` is at least 33. Install the fixture package only:

    adb -s SERIAL install -r tools/spikes/android-permissions/app/build/outputs/apk/debug/app-debug.apk
    adb -s SERIAL shell am start -n ai.ash.permissionprobe/.ProbeActivity
    adb -s SERIAL shell screenrecord --time-limit 180 /sdcard/permission-probe.mp4

During recording, grant calendar from the fixture dialog, revoke it in the fixture's App info → Permissions, return, and grant again. For listener access, use the fixture's Settings button; enable, disable, then enable the fixture listener, returning to the fixture after each step. Record each status change on screen. Pull the recording:

    adb -s SERIAL pull /sdcard/permission-probe.mp4 build/evidence/ASH-006/permission-probe.mp4

After each change, `tools/spikes/v6-status.sh SERIAL` prints the fixture's grant state without changing it. Save that output alongside the recording.

If system Settings reports restricted access, record that screen and the installer source; do not bypass it silently. Capture the OS version, target SDK, and observed status transitions in this report. Do not toggle any personal app's permissions.

## Target SDK findings to verify on device

The current host target SDK is 28 and it has no READ_CALENDAR or notification-listener service declaration. Calendar read is a dangerous runtime permission, so the host must declare and request it. Notification-listener access is a separate user-controlled Settings grant. Android 13's POST_NOTIFICATIONS controls posting notifications, not reading them. The existing target SDK 28 is also below 33, so posting-permission dialog timing differs from a target-33 app. This fixture tests target 33; a separate host-target-28 check is needed before final host integration.

References: [calendar permission](https://developer.android.com/reference/android/Manifest.permission#READ_CALENDAR), [notification listener service](https://developer.android.com/reference/android/service/notification/NotificationListenerService), [Android 13 notification posting permission](https://developer.android.com/develop/ui/compose/notifications/notification-permission), [restricted settings](https://support.google.com/android/answer/12623953).

## Result

The fixture built successfully offline and was installed on `emulator-5554`. On 2026-10-01 the emulator reported API 36 and displayed the calendar permission prompt for the fixture. The Allow control was tapped. A subsequent `appops get ai.ash.permissionprobe READ_CALENDAR` returned `Default mode: allow`, but this alone does not prove the permission state shown by the app.

Opening the fixture's App info screen stalled at a Settings splash screen. The emulator remained listed as `device` by adb, while `dumpsys package` timed out after 10 seconds, then basic `adb shell uptime`, screenshots, and pulling the partial recording timed out. The recording process was stopped to reduce load. No calendar revocation or regrant, and no notification-listener toggle, was observed. A partial Android-only recording remains at `/sdcard/v2-permission-probe.mp4` on the emulator but could not yet be retrieved or inspected. Therefore V6 has not passed and the fallback decision is deferred.

The host app still targets API 28. This fixture targets API 33, so it cannot by itself settle every host-specific behavior; integration must check the target-28 flow separately. The emulator or an isolated device must become responsive before the remaining transitions can be recorded.
