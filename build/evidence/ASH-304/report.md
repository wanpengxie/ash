# ASH-304 implementation evidence (pending independent review)

This branch adds a real `service:self` member when a canonical home workspace is configured. It implements the six existing SDK words without changing wire schemas. The member owns managed-file bytes; a separate SQLite journal records an authenticated request's stable operation id, caller, path, baseline and intended content hashes before any file mutation. The normal router still owns the request and terminal response ledger messages.

Writes, edits, append and rollback construct a complete UTF-8 replacement. Existing files are snapshotted first; snapshots and temporary replacements are `fsync`ed before atomic rename, and the parent directory is synced after rename. The member then emits `self.changed` with a stable `client_id` and the actual ledger caller, before the paired response. Replayed requests reuse their intent and cannot append a second time. `USER.md` receives a generated ISO timestamp and incremented version. Its read hash and all baseline comparisons use the exact UTF-8 bytes; invalid byte sequences fail closed. Snapshot history retains the latest 50 per file.

`prepareRecovery()` runs after member registration and before `WorldRouter.recover()`. A target matching the authorized new hash **and the prepared temporary file's durable device/inode identity** completes the missing event/response without writing again; a target matching the old hash is left for the router's current-authorization check and idempotent handler; anything else is a conflict and is never overwritten. This rejects an external writer that happens to produce the same bytes. A previously settled request with no effect is aborted and its own temp/snapshot discarded. Five actual child-process `SIGKILL` boundaries (intent, snapshot, temp, rename, event) each recover one file effect, one event, and one response. Separate tests cover a killed append, revoked recovery authority, external tampering including same-byte writes, local cancellation before rename, hard/symbolic aliases, stale hash/guard, exact caller attribution, production echo bootstrap, and snapshot pruning.

Reproduce from the repository root:

```sh
npm run -s typecheck
npm run -s build
node --import tsx --test packages/core/test/members/self.test.ts packages/core/test/world/bootstrap.test.ts
npm test
npm run -s test:public-terms -- --terms-file "$PRIVATE_TERMS_FILE"
```

At the current source SHA, typecheck/build and the complete suite exit naturally: 183 passed, 57 intentionally skipped, 0 failed. The external private-term scanner reports 0 findings across 367 files. The synthetic tests do not touch user data.

The current implementation provides cooperative-call authorization and crash recovery, **not a physical AR4 boundary**. DSH's native shell can bypass the `write/edit` hook in the ASH-003 negative control; the 204/304 joint gate must either deny every arbitrary execution/write interface in the DSH scope or provide a separately verified OS filesystem boundary. Node path checks do not eliminate cross-process symlink races, and a process with the same UID and direct filesystem access can bypass this member. No post-execute observation is treated as authorization. No real user files or external services were mutated for these tests.
