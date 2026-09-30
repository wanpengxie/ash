# ASH-006 · Android permission flow spike

Status: fixture built; device flow and video pending an Android 13+ emulator or isolated device.

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

No device was attached to local adb when this report was written. Build success proves only that the fixture compiles. Authorization, revocation, reauthorization, and video acceptance remain unverified.
