#!/bin/sh
set -eu

serial=${1:?usage: v6-status.sh ADB_SERIAL}
adb -s "$serial" get-state >/dev/null
api=$(adb -s "$serial" shell getprop ro.build.version.sdk | tr -d '\r')
case "$api" in
    ''|*[!0-9]*) echo "Invalid Android API level" >&2; exit 1 ;;
esac
if [ "$api" -lt 33 ]; then
    echo "Android 13 or newer required" >&2
    exit 1
fi
echo "Android API: $api"
echo "Fixture target SDK:"
adb -s "$serial" shell dumpsys package ai.ash.permissionprobe |
    sed -n 's/.*targetSdk=\([0-9][0-9]*\).*/\1/p' | head -1
echo "Calendar permission:"
adb -s "$serial" shell dumpsys package ai.ash.permissionprobe |
    sed -n '/android.permission.READ_CALENDAR: granted=/p' | head -1
echo "Notification listener:"
listeners=$(adb -s "$serial" shell settings get secure enabled_notification_listeners)
case "$listeners" in
    *ai.ash.permissionprobe*) echo "enabled" ;;
    *) echo "disabled" ;;
esac
