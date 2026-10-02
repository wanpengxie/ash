# Android sensor recovery probe (2026-10-02)

ASH-707 remains in progress. This record covers only F-D16 after a process kill, not the regression script or any legacy-data migration.

On an API 36 emulator, an isolated `ai.ash.agent.probe` APK used its own Core and state. Toggling the screen off/on produced one persisted `sense.screen{state:"on"}` event. The probe host process was then killed with SIGKILL. Android restarted its sticky foreground service under a new host PID and started a new isolated Core process. A second off/on cycle produced a second `sense.screen{state:"on"}` event in the same Core ledger, alongside a fresh `app_open` event. The original host package stayed running throughout.

The observed recovery is the screen receiver. `CoreService.onCreate` also starts the calendar and device sensor objects, but this probe did not trigger a calendar event or notification callback after restart. The probe package and its dedicated adb forward were removed; the original package was neither overwritten nor restarted.
