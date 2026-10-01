# ASH-206 continuation: cancellation barrier and root-session recovery

Scope: the production root retains the strict five-tool profile. This change adds no native tool, wire field, new world member, or OS sandbox.

## Recovery boundary

- A private state journal is atomically published and synced before the first DSH session is created. Its session ID is reused on restart; a different or missing ID is never silently substituted once a core turn exists.
- Startup reconciles core cancellation and pending requests before DSH is resumed. A read-only check of the persisted DSH log rejects a foreign application prompt, duplicate prompt, or queued DSH input that could auto-run on publication. Every core-completed turn must map to a unique DSH prompt inside a `turn/start` and a matching `turn/end` whose reason is `completed`; an incomplete historical turn remains eligible only when core did not mark it completed. DSH's own context snapshot is accepted only in its expected structured form.
- The resumed agent receives the guarded tool scope and turn adapter during unpublished setup. An interrupted DSH turn receives the runtime's synthetic interrupted tool result; the core inbox does not submit its already-read batch again. Unknown external effects are not replayed or reported as success.
- Missing, malformed, or wrong journal and absent, truncated, or corrupt history fail before the agent is started or the HTTP edge opens. Existing deployments with core turns but no new journal require an explicit migration decision; they do not silently start with empty model history.

## Evidence

- Real DSH with a script provider and held device request: cancellation reached the sole cancelled terminal in under one second while the external handler remained pending. Once DSH itself became idle, the next batch ran before the handler was released; its actual model request carried both the stop reason and the pending device action. The old turn made no later tool or say request. A further trusted cancellation while the next DSH turn was idle returned `{cancelled:false}` and drove no model call or extra terminal, even though the old external handler was still pending.
- Real child-process SIGKILL after `ash_send` was accepted and the device call entered: on restart the external call count and model request count stayed at one; the core request settled once as unknown/failed, and DSH history contained an interrupted unknown tool result. No old prompt was automatically replayed.
- Clean restart retained the earlier user and assistant messages in the next model request. Revoking the old API token before restart made that token return 401 while the newly authenticated sender could start the next turn.
- Synthetic persisted-history negatives covered a queued DSH prompt; a complete-frame truncation that keeps the second completed turn's prompt but removes its assistant/tool/end tail; a truncation leaving only the physical header; a damaged frame; deleted history; and missing, malformed, or wrong session journal. All refused startup.

Reproduce with `ASH_TEST_DSH_ROOT=<installed-runtime-root> node --expose-internals --import tsx --test packages/core/test/world/dsh-cancel-barrier.test.ts packages/core/test/world/dsh-runtime.test.ts packages/dsh-binding/test/resume-v2.test.ts`, then `ASH_TEST_DSH_ROOT=<installed-runtime-root> npm test`, `npm run -s typecheck`, and `npm run -s build:core`.

On the merged baseline used for this report: full suite 312 total, 254 passed, 58 intentional skips, 0 failures; typecheck and core build passed. The public-source term scan checked 421 files with 0 findings.

Remaining gates: production native tools and arbitrary shell remain disabled. Managed-file physical isolation and native pre-request/result accounting are not supplied by this change. A legacy root session without the new journal is intentionally blocked; it needs a separately reviewed migration path.
