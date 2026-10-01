# ASH-206 staged runtime evidence

This candidate connects the production owner entrypoint to one real DSH main session after ledger, authorization, and cancellation-intent recovery. The session exposes exactly five owned tools; native file, search, shell, and derived-agent tools are disabled in this stage. The worker's non-session model service remains available.

The turn runner passes only the bounded rendered batch plus bounded attachment source references to one `followup`. It does not call `steer` or stringify control-plane messages into the model request. Images become actual DSH image blocks after MIME/byte validation. Other new attachments are atomically materialized in a private inbox under the state directory using message ID, attachment index, and SHA-256; existing different content is rejected. A path reference is provenance, not a claim that the model can read that file in five-only mode. Source labels and text remain separate, and assistant text events—not tool results—produce split `say` requests with fenced code intact.

The runner waits for `whenIdle()` outside the session event listener before releasing its door turn or allowing another batch. Abort cancels the DSH session and invalidates late tool and text output, but cannot undo an already executed external effect. A rejected idle receipt does not unblock another turn. Durable cancelled/read/turn facts remain owned by the inbox and router.

Reproduce from the repository root with an installed, unmodified DSH package:

```sh
npm run -s typecheck
npm run -s build:core
ASH_TEST_DSH_ROOT=/path/to/installed/dsh node --expose-internals --import tsx --test packages/dsh-binding/test/runtime-v2.test.ts packages/core/test/world/dsh-runtime.test.ts
ASH_TEST_DSH_ROOT=/path/to/installed/dsh npm test
```

Author run on the fixed source: targeted runtime tests 5/5; full suite 236 pass, 57 intentional skip, 0 fail; typecheck and core build pass. The scripted provider demonstrated a production main tool request/response, accepted and rejected `react` to real/missing message IDs, exactly five presented tools, one bounded user followup, and three text bubbles with a fenced block intact. A real child process was killed during an in-flight provider request; startup recovery recorded an interrupted read turn and did not replay that model request. Fake-agent tests held `whenIdle` unresolved after `turn/end`, rejected a concurrent turn, and suppressed a post-abort assistant event. Attachment tests cover malformed base64/MIME, malicious display names, symlink roots, changed-content retries, and batch overflow before disk writes. Follow-up boundary tests cover four-marker fences containing shorter markers, tilde fences, nonempty closing-line tails, indentation, and 32 repeated path-image references exceeding the aggregate byte cap before image storage or inbox writes.

This is a staged candidate, not full card completion. Native DSH tools have no pre-call world request/response binding yet; physical isolation of managed files and full native effect accounting remain pending. A file path in the model input does not make file contents readable while native reads are disabled. Reopening the durable world inbox does not restore the full prior DSH session history; that history-resume path is not implemented. Independent review and the final native-tool gate are not claimed here.
