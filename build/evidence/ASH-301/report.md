# ASH-301 clock implementation evidence

The SDK now declares a clock-origin outbound `clock.fired` event. Its closed body carries a timer ID, safe-integer scheduled timestamp, and one of `dispatched`, `skipped`, or `failed`; reason and accepted request ID are optional. `dispatched` means only that the world router accepted the scheduled request, not that any external effect completed. The event has no response schema and is not an inbound callable word.

The contract test checks positive shapes, wrong source, missing and extra fields, non-finite, fractional, negative, and unsafe timestamps, invalid outcome, and empty IDs.

The clock member's narrow allowlist contains scheduled `agent:main/wake`, `agent:main/say`, and `person:owner/say` with `kind:due`. The production agent now has a separate DSH mind for `wake`. It records the server-stamped original delegate, allows owner API/screens and the real local DSH agent principal, and rejects other service/MCP callers and higher-privilege destinations. Each set/cancel command is idempotent by accepted request ID. Side tables carry the new payload, delegate, blocked status, and stable `(timer_id,scheduled_at)` occurrence/outbox state. Pre-product v10 timer migration is not a delivery requirement; the owner's construction rule explicitly excludes it.

At each due occurrence, the timer is atomically advanced or removed with an outbox claim before dispatch. The original delegate's current authority and the current target contract are checked again; a paused occurrence is recorded as `skipped` without a request, and resuming does not backfill it. Request acceptance and `clock.fired` each use a stable client ID, so reopening after the claim, accepted request, or accepted event produces one occurrence, one scheduled request, and one event. The public synthetic spike actually sends `SIGKILL` at all three barriers and reopens the same SQLite file; each yields one request, one event, and no pending occurrence. `dispatched` means router acceptance only. The internal pause fact is one SQLite `kv` JSON boolean at `v2:admin:paused`: missing means false; malformed values fail closed. The production AdminMember writes this fact; the clock has no pause-setting word.

Production `startOwner` registers the member before router recovery, starts the scanner before HTTP readiness, and closes it before the ledger. `HostDeviceLink.scheduleAlarm` waits for the existing Android `/alarm` `{at|null}` acknowledgement. The synthetic production-main HTTP host test verifies set→restart re-arm→cancel and a failed acknowledgement followed by successful restart reconciliation. It also writes the internal pause key in a test-only temporary DB and observes a skipped due occurrence with no later delivery.

Reproduce from the repository root:

```sh
node --import tsx --test packages/sdk/test/v2-contract.test.ts
node --import tsx --test packages/core/test/members/clock.test.ts packages/core/test/members/clock-host.test.ts
node --import tsx tools/spikes/v2-clock-kill.ts
npm run -s typecheck
ASH_TEST_DSH_ROOT="$INSTALLED_DSH_PACKAGE" npm test
npm run -s build:core
```

Current verification (2026-10-02, `b0bf80c`): focused clock suite 13/13, including the same production SQLite pause fact used by AdminMember: owner pause → due `skipped` → local-screen resume → no late delivery. The production host bridge schedules the next alarm through Android `/alarm`; a clean Mac checkout compiled Kotlin and passed `:app:testDebugUnitTest`. On an API 36 emulator, an isolated `ai.ash.agent.probe` package accepted `/alarm`, AlarmManager listed its `WakeReceiver` as an `RTC_WAKEUP` one-shot, and at the scheduled time the system recorded one wake and an `ash:timer` partial wakelock. The probe package and its sole `tcp:14764` forward were removed; the original `ai.ash.agent` PID stayed 3420. The installed-DSH suite reported 605 total, 542 pass, 63 conditional skip, zero fail; typecheck and GitHub CI passed. F-S01–04 are covered. The previously listed migration and compatibility work is out of scope by owner decision; this card is complete. The isolated alarm probe establishes Android wake delivery, not a claim about a full phone UI reminder notification.
