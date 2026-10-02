# Android presentations and calendar manifest: author and lead evidence

Scope: phone host `/present` and `/present/hide`, notification actions, durable action outbox, explicit capability risk/label mapping, and calendar search/create. The original author probe below is retained; current lead acceptance is recorded separately.

## Reproduce local checks

From the repository root:

```sh
npm run check:manifest
npm run -s typecheck
```

From `android/` with JDK 21 and Android SDK configured:

```sh
./gradlew --offline :app:testDebugUnitTest :app:compileDebugKotlin -x copyPayload
./gradlew --offline -PashIsolatedProbe=true :app:assembleDebug -x copyPayload
```

The isolated APK must have application ID `ai.ash.agent.probe`; do not install the ordinary debug APK over an existing app. Grant `POST_NOTIFICATIONS` to the probe package before checking visible notices on Android 13+. All calendar permission toggles must target only the probe package. The probe must be removed after testing. No test needs an existing personal calendar event or writes to a user's calendar.

The JVM checks cover approval choice/routing/expiry, stable queued payload across retries, untrusted action extras excluded from URI identity, RemoteInput mutable flags on API 24–30 and 31+, retired presentation IDs, no restart resurrection after dismissal, deterministic render/hide interleavings, and malformed calendar arguments rejected before a provider callback. The manifest checker covers every module named by the actual registry, rejects an unclassified newly registered module, and rejects dynamic capability construction.

## Observed author probe

An isolated emulator package accepted all five synthetic presentation kinds; its notification manager showed five records. The host rejected unauthenticated requests, approval without deny, external callback targets, invalid expiry and option fields, and conflicting reuse of one ID. Legacy `/notify` and `/confirm` returned 404. The calendar capabilities disappeared from the manifest without permission, appeared with explicit `none`/`outward` risks when the probe package had calendar read/write permission, and disappeared again after revocation and process restart. No successful calendar-create request was sent. Synthetic notifications and the probe package were removed afterward.

## Lead verification of ASH-704 (2026-10-02)

On an API 36 emulator, the isolated `ai.ash.agent.probe` notification buttons generated four distinct queued responses for the original ask: `once`, `always`, `deny`, and swipe-to-dismiss `deny`. A notice with only `once` and `deny` displayed only those two buttons; an approval lacking `deny` was rejected with HTTP 400; expiry removed the notice. Reply via Android RemoteInput reached the isolated Core owner inbox once. With that Core stopped, another reply remained in the host action queue and arrived once after Core restart. The retired `/notify` and `/confirm` routes returned 404.

The production Core gate HTTP tests independently verify that `deny` has zero device effect, `once` has one effect, and `always` creates an exact-object rule while another object still asks. `PresentRouteTest` covers each choice's original-ask route, invalid options, and expiry. The notification-button and gate-effect evidence is a **composed verification**, not a claim that one physical button press was observed through a real device effect. The isolated package and dedicated adb forwards were removed; the original `ai.ash.agent` app remained running.

## Pending at original author handoff (historical)

- Independent Android UI tests must exercise reply input, each offered approval button, swipe-to-deny, non-approval swipe dismissal, hide/re-delivery rejection, reboot recovery, and offline queue delivery. The author probe does not establish these.
- Calendar search/create need isolated provider fixtures and the real owner approval gate. The argument unit tests establish only that malformed input does not reach a provider callback.
- If the core accepts an approval answer but its HTTP acknowledgement is lost, a retry must return the original result for the same authenticated `client_id` and content after restart. Core response deduplication and a joint host/core ACK-loss test are pending; the host must not infer success from arbitrary HTTP 4xx.
