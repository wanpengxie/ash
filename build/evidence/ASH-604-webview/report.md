# Isolated Android WebView conversation probe

An isolated test application rendered the production conversation UI against a disposable loopback owner server. The existing application, its ports, and its data were not changed. The test application accepts only the fixed loopback test page. Its WebView debugging socket was bound to its own process; the test script checks the page origin before running JavaScript.

## Reproduction boundary

Use one dedicated emulator and confirm the test package is absent, its debug socket is not forwarded, and the test ports are free. Build the test APK with `packages/core/ui/test/android-webview/build.mjs`. Start `tools/spikes/v2-cross-device-server.mjs` with an isolated runtime state. The Android Debug Bridge server and the Linux test server need a loopback-only relay for port 14762. Install only `ai.ash.v2screenprobe`, reverse only `tcp:14762`, and launch it with the server's private synthetic URL file. For DOM testing, forward a second loopback-only port 14765 to `localabstract:webview_devtools_remote_<test-package-pid>`, then relay that port to Linux. Verify both forwarded endpoints and the exact test PID before running:

```sh
node tools/spikes/v2-604-webview-cdp.mjs 14765 <disposable-server-state-directory>
```

The script reads only that disposable database, posts synthetic files through the WebView UI, and does not print its URL or bearer value. It refuses a CDP port other than 14765, a state directory outside the test prefix, multiple debugging targets, or a page outside the fixed test origin. After the run, remove only the two test port mappings, uninstall only the test package, stop the disposable server, and remove its test state. The loopback relays are owned and closed separately by the test coordinator.

## Observed

- A generated PNG of 14,378,314 bytes was uploaded by Android WebView as a 550,246-byte JPEG. Its rendered preview decoded at 2048×512. A separate text file's stored bytes exactly matched its synthetic input.
- With `/api/stream` explicitly blocked and the page reloaded, the connection indicator became offline. Unblocking allowed automatic reconnect, and the owner attachment bubble appeared once after replay; the database contained one copy of that message id.
- The test package, its process, its CDP forward, its 14762 reverse, the local server, the temporary database, and the generated APK were removed. The existing app process and its 4700/4710 listeners remained in place.

Independent replay of the first candidate found that a live SQLite writer could make the script's read-only database query fail immediately with `SQLITE_BUSY` (errcode 5). This was a probe read race, not a demonstrated delivery failure. The probe now sets a 250 ms SQLite busy timeout and retries only busy/locked reads within a 45-second deadline; other SQL errors still fail immediately. The corrected candidate requires another independent device replay before acceptance.

## Limits

The test creates `File` objects in page JavaScript; the isolated APK has no native file chooser implementation. Blocking a new stream request and reloading does not prove immediate detection of a silent failure on an already-open SSE connection. The loopback relay presents a local owner context, not a paired remote principal. None of these untested cases is counted as complete card acceptance.
