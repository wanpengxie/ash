# ASH-301 clock implementation evidence (joint gates pending)

The SDK now declares a clock-origin outbound `clock.fired` event. Its closed body carries a timer ID, safe-integer scheduled timestamp, and one of `dispatched`, `skipped`, or `failed`; reason and accepted request ID are optional. `dispatched` means only that the world router accepted the scheduled request, not that any external effect completed. The event has no response schema and is not an inbound callable word.

The contract test checks positive shapes, wrong source, missing and extra fields, non-finite, fractional, negative, and unsafe timestamps, invalid outcome, and empty IDs.

The clock member's narrow allowlist contains scheduled `agent:main/wake`, `agent:main/say`, and `person:owner/say` with `kind:due`. This is an upper bound, not a claim that all three are live: the current production agent has no `wake` endpoint, so production `set` for wake returns an error and creates no timer until ASH-207 installs a real two-session wake handler. It records the server-stamped original delegate, allows owner API/screens and the real local DSH agent principal, and rejects other service/MCP callers and higher-privilege destinations. Each set/cancel command is idempotent by accepted request ID. The v10 `timers` table and original columns remain intact; side tables carry the new payload, delegate, blocked status, and stable `(timer_id,scheduled_at)` occurrence/outbox state. An old timer must match its original `timer.set` event and old caller/owner relationship to fire as a low-privilege message; unverified old rows remain intact and blocked. The private WAL-consistent v10 snapshot has zero active timers (only aggregate counts were inspected), so legacy-live behavior is verified with synthetic positive/negative fixtures, not claimed as observed on a real active old timer.

At each due occurrence, the timer is atomically advanced or removed with an outbox claim before dispatch. The original delegate's current authority and the current target contract are checked again; a paused occurrence is recorded as `skipped` without a request, and resuming does not backfill it. Request acceptance and `clock.fired` each use a stable client ID, so reopening after the claim, accepted request, or accepted event produces one occurrence, one scheduled request, and one event. The public synthetic spike actually sends `SIGKILL` at all three barriers and reopens the same SQLite file; each yields one request, one event, and no pending occurrence. `dispatched` means router acceptance only. The internal pause fact is one SQLite `kv` JSON boolean at `v2:admin:paused`: missing means false; malformed values fail closed. ASH-306 owns its future production writes; this card has no pause setting word.

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

The focused SDK suite exits with 12 pass, and the focused clock suites with 12 pass, all with zero failures/skips. The host fixture additionally confirms production wake fails closed with zero timer rows. With the installed DSH test package, the complete suite previously exited naturally with 244 pass, 58 intentional skips, and zero failures; this will be rerun after merging the new DSH baseline. Typecheck and core build pass; the private-term scanner previously reported zero findings across 398 public files. The additional skip over the prior merged baseline was the newly declared outbound clock word's existing architecture placeholder, not a missing real-DSH test. Actual Android AlarmManager wake-from-kill, ASH-306's authenticated pause/resume path, and the ASH-207 real DSH secondary-session wake remain joint acceptance gates. No full-card completion is claimed.
