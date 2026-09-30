# ASH-101 ledger evidence

Implementation branch: `v2-ASH-101-ledger`, based on frozen v2 commit `09fa4ae`.

The new `Ledger.open` is deliberately not called by the v1 process. It is the v2 cutover entry point for ASH-102/103: the old process must stop writing `events` before it opens. On migration, a SQLite online backup is taken from a query-only source connection before any schema write; the backup is checked for integrity and kept mode 0600. A single `BEGIN IMMEDIATE` transaction creates `messages` and indexes, converts rows in old-sequence order, locks `events` against further writes, and commits the completion marker. Retries do not duplicate rows; new message sequence numbers follow the old maximum.

The converter preserves each old row's sequence and timestamp. Old conversation text and attachment references become `say` messages. Tool/device starts and ends retain word, target, order, pairing, and known success/failure; unknown argument/result structures are explicitly omitted and reference the old row. Other historical event payloads are likewise minimized. The untouched v1 table remains the full local archive; this avoids newly streaming old device arguments or unknown payloads. No model summarizes historical data.

Validation commands:

- `npm run -s typecheck` — passed.
- `node --expose-internals --import tsx --test packages/core/test/world/ledger.test.ts` — 11 passed, 0 failed.
- `npm test` — 52 passed, 56 deliberately skipped routing gates, 0 failed.
- Fixture regenerated via `node --expose-internals packages/core/test/fixtures/create-v10-fixture.mjs <new-output-path>`; binary SHA-256 matched the checked-in synthetic fixture.

The fixture tests cover ordered conversation and attachment migration, non-disclosure of synthetic secret markers, exact `seq`/`ts`, pre-migration backup integrity, live WAL tail inclusion, a newer backup after a failed attempt plus later v1 events, atomic stable-transport retry claims, single response settlement, process death after commit before acknowledgement, and real `SIGKILL` at six migration stages (before transaction, after schema, first row, halfway, before commit, after commit). Each restart produces one row per old event and a second restart adds none.

Private-device acceptance was conducted only on a mode-0700 local snapshot, never on the live original. An app-private Node online backup included the active WAL and passed `PRAGMA integrity_check`; the temporary device snapshot was removed after the private copy was verified. The snapshot contained 429 old events, producing 429 messages with identical final sequence and 43 ordered conversation entries with equal SHA-256 projections before and after migration. A `SIGKILL` halfway through migration of another isolated private copy recovered 429 rows on restart and zero additional rows on a second restart. No record contents, credentials, database bytes, or raw hashes appear in this report or repository.

Remaining integration gates: ASH-102/103 must switch the v2 edge/router to this ledger and stop the v1 event writer. F-W08's separate requirement that the new UI display complete historical conversation remains for projection/UI QA; this report verifies the migration layer only. Request execution recovery and external-effect uncertainty require router-level tests in ASH-102; ledger idempotence alone does not prove them.
