# ASH-610: managed Markdown editor and L030 guard

This increment provides standalone identity and memory sheets and a managed Markdown editor. The production UI shell is not connected by this increment; the caller supplies a live registered-screen sender (`createSelfScreenSender`) and an explicit rollback confirmation callback. No file PUT or direct filesystem write is used by UI code.

## Contract change (L030)

`service:self/rollback` now requires `expected_hash` of the **current complete file bytes** in addition to `path` and `to_ts`. The service compares it in the same serialized member queue used by write and apply_plan, before creating a durable write intent. A stale baseline returns `bad_request` / `stale`; no file, snapshot or `self.changed` effect is produced. Calls using the old two-field rollback body are rejected by SDK schema, so this is an intentional compatibility break. The snapshot target still comes from the existing version directory; a successful rollback is reread before the editor reports current content.

## Evidence

Synthetic fixtures only:

- `node --expose-internals --import tsx --test packages/core/test/members/self.test.ts packages/sdk/test/self-ui-contract.test.ts` — 17 pass / 0 fail. Includes missing/stale hash, concurrent write versus rollback (one effect), and child SIGKILL after intent, rename and event with single-effect recovery.
- `node --import tsx --test packages/core/ui/test/editor.test.js` — 5 pass / 0 fail. Includes draft retention on stale write, exact `client_id` retry after uncertain ACK, explicit rollback confirmation and L030 guard, file-tab restrictions, and screen scope switch.
- `node --expose-internals --import tsx --test packages/core/test/world/self-ui-http.test.ts` — 1 pass / 0 fail. A production `startOwner` on a synthetic home, live SSE screen registration, read, background update, and stale editor write through real HTTP; background content remains intact and one `self.changed` is recorded.
- `ASH_TEST_DSH_ROOT=<installed DSH root> npm test` — final integrated aggregate 375 pass / 59 intentional skip / 0 fail, natural exit (434 tests). Two earlier concurrent-load runs hit the pre-existing reflex strict one-second timing assertion. A subsequent standard full run on the unmodified `origin/v2` baseline also failed that same `reflex-dsh` timing assertion (424 tests, 364 pass / 59 skip / 1 fail); neither the threshold nor reflex implementation was changed. The final 610 full run was 0 fail.
- `npm run -s typecheck`, `npm run -s build:core`, `npm run -s test:public-terms -- --terms-file <private terms path>` — pass; public scan 498 files / 0 findings. The terms file is private and not part of this source commit.
- `node --expose-internals --import tsx packages/core/ui/test/admin-browser-probe.mjs` and `node --expose-internals --import tsx packages/core/ui/test/browser-probe.mjs` — isolated Chrome PASS. These protect the integrated PR43 admin controls and existing browser shell; they do not claim the standalone 610 identity/memory modules are mounted in the shell.

## Latest v2 integration

Merged `origin/v2=8e117f88c892b042a6f82fcb1a8c1525dbc56209` (PR43 admin settings/security and PR42 echo) into the 610 branch. The sole textual merge conflict was generated `packages/core/src/ui.ts`; it was resolved by running `npm run -s gen:ui` from the combined source, not by choosing one side's bundle. `packages/sdk/src/words.ts` merged without conflict and retains both L030 rollback `expected_hash` and the strict admin pause/resume contracts. After the full suite/typecheck/build generated assets, tracked files remained clean; only the pre-existing local `node_modules` symlink was untracked. No product changes from PR43 or PR42 were removed.

## Remaining acceptance boundaries

- The 611-owned app shell/setting UI is deliberately untouched. These modules are not yet linked from the actual identity/memory navigation, so F-U17/18/19 are **not** claimed complete.
- A real DSH next-turn personality/memory observation after an identity edit remains to be verified jointly. The current HTTP test proves persisted self writes, not model ingestion.
- A browser-level test of visible version/snapshot/rollback and a user-confirmed rollback against a concurrent background write remains for independent QA after shell integration.
- Uncertain operation ACKs retain the exact `client_id` and body for retry; a new screen principal may not be able to resume that id. The editor will not silently clear the pending operation or overwrite the file.
