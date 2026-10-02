# Android sensor recovery probe (2026-10-02)

## 2026-10-02 remote regression helper update (not yet device-signed)

The helper now uses the existing v2 `service:admin/gateway.state|op`, `/api/send`, `/api/stream` and live `screen.registered` proof. It accepts a short-lived `GATEWAY_TICKET` supplied by the test environment; it does not add a ticket/bootstrap-secret word or public route. R9 holds its temporary pairing key in a mode-0600 `mktemp` file and removes the exact file afterward. R11 now queries installed DSH bundles through `plugins.list` after a restart and targets the running `ash-v2` profile. The standalone 20KB gateway helper bundle is generated from `regress-remote.mjs` using the repository's esbuild, so device-host Node does not need the TypeScript dependency tree.

`node --check` (source and bundle), `bash -n`, bundled helper's no-ticket rejection and `git diff --check` passed. No live gateway/ticket or model was available in the isolated Android probe. R7/R9/R11/R17/R18 therefore remain **unsigned**, and the R1–R21 gate is not claimed.

## 2026-10-02 v2 regression-script increment

`tools/regress.sh` now defaults to the isolated `.probe` package and points its Core checks, session identity, message delivery, finite ledger stream and installed-plugin switch at the current v2 API. The old global PID search initially counted the original app's Core as well as the probe's, producing false R4/R5 failures; it was narrowed to the selected package's exact Core bundle path before rerun. No original-app PID was killed (original PID 3420 remained). With a freshly rebuilt payload and API36 isolated APK, R4 kill/restart, R5 stop/start, R12 published DSH byte hash, and R16 installed-plugin `false→true→false` all passed. R12 phone/build fingerprints both read `dsh 0.2.0-rc.2 @deepseek-ai files=4685 sha256=481b23de035ed5480ea42b30421ea6b17a5713553f2bc212e4f75b36bdc1bc49`. The R16 test restored its original plugin state. The temporary verifier script was removed from `/data/local/tmp` after use.

These four tests are only a subset. R1–R3, R6–R11, R13–R15 and R17–R21 were not signed by this run; at this historical checkpoint the remote helper still used retired gateway routes. Tests requiring a live model or configured gateway remain outstanding. ASH-707 stays In Progress.

ASH-707 remains in progress. This record covers only F-D16 after a process kill, not the regression script or any legacy-data migration.

On an API 36 emulator, an isolated `ai.ash.agent.probe` APK used its own Core and state. Toggling the screen off/on produced one persisted `sense.screen{state:"on"}` event. The probe host process was then killed with SIGKILL. Android restarted its sticky foreground service under a new host PID and started a new isolated Core process. A second off/on cycle produced a second `sense.screen{state:"on"}` event in the same Core ledger, alongside a fresh `app_open` event. The original host package stayed running throughout.

The observed recovery is the screen receiver. `CoreService.onCreate` also starts the calendar and device sensor objects, but this probe did not trigger a calendar event or notification callback after restart. The probe package and its dedicated adb forward were removed; the original package was neither overwritten nor restarted.
