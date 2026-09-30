# ASH-901 architecture acceptance matrix — baseline

Base revision: `09fa4aebfc4b1457909c14cfa6abc8aa32227c50` (2026-10-01). This is a plan and measured baseline, **not** final sign-off. `npm run test:arch:final` with an external private term file reports **25 findings** in AR1–AR4; no AR12 finding. The separate public term scan examined 272 tracked text files and found 0. Neither detector self-tests nor legacy v1 tests certify the v2 architecture.

| Rule | Required evidence and independent test | Current status |
|---|---|---|
| AR1 | Static import boundary on all `members/*`, with positive same-member/standard-library and negative peer-import fixtures | **Fail:** member sources absent; detector fixtures pass |
| AR2 | Inspect every UI network call and reject URLs outside the permitted edge API; negative dynamic/bypass fixtures | **Fail:** split UI JavaScript target absent |
| AR3 | Snapshot actual edge route table against the C4 allowlist, including removed legacy routes | **Fail:** legacy routes still present, required v2 routes absent |
| AR4 | Static worker/flow filesystem boundary plus runtime intrinsic-directory monitor exercised by unauthorized-write fixture | **Fail:** workers/flows sources absent; monitor is only a one-interval fixture, not runtime enforcement |
| AR5 | Enumerate real model-facing DSH tools with and without device online; require five named tools and no per-device projection unless a documented exception is accepted | **Detector ready, final pending:** four positive/negative fixture tests pass; legacy binding still projects device tools |
| AR6 | Execute scenario matrix and independently capture device calls, notifications, intrinsic writes, and gate releases; match each effect to exact ledger request/event and terminal response, reject omissions/duplicates | **Detector ready, final pending:** five positive/negative fixture tests pass; v2 ledger and externally observed product scenario not yet present |
| AR7 | Compare installed DSH fingerprint to same-version published package; verify payload/device install and absence of repository patches | **Partial:** verifier exists; final payload/device fingerprint pending |
| AR8 | Headless browser assert chat region has no stop/interject/edit/retract controls; test action paths through edge messages | **Pending UI migration** |
| AR9 | Non-author review every persona/rule/worker prompt for code-enforced policy; machine scan is supplemental | **Partial:** five rule modules reviewed; future worker prompts and full prompt set pending |
| AR10 | Run each background flow with tagged output; assert main DSH event stream excludes it unless delivered via a `say` message | **Pending background implementation** |
| AR11 | Capture each light-worker LLM request and assert `tools: []`; review tool-bearing steps for placement in DSH | **Pending worker implementation** |
| AR12 | Scan all tracked readable text with external private term list; fail if list missing or empty | **Pass at baseline only:** 272 files/0 findings; rerun on every revision |
| AR13 | Click options, approval, and notification replies; assert resulting ledger `say`/response with origin and no dedicated bypass | **Pending UI/host/ledger integration** |
| AR14 | Drive state sequence and compare code-derived status to expected; review model-facing tools to ensure no report-status tool. For delivery, verify authoritative `post.changed{held}` snapshots, never infer held count from send replies | **Pending state implementation** |
| AR15 | Through a remote gateway screen, attempt admin word and require 403; separately prove allowed chat/ask response still works | **Pending v2 gateway path:** legacy remote test is not enough |

The final gate stays nonconformant until every automated rule has direct evidence and the review rules have non-author sign-off. In particular, the synthetic AR6 verifier tests are only detector validation: acceptance requires a live product scenario with independently captured effects and its persisted ledger. The future adapter must not derive `ObservedEffect` records from those ledger rows. Private terminology and private reference material remain outside public git.

Cross-card watch: ASH-101 migration replay needs a read-only WAL-consistent private snapshot and a separate public synthetic database; ASH-601 projection needs duplicate/old-sequence/forged-origin/negative-held fixtures under the frozen `post.changed` contract. ASH-302 must prove queue update plus event are atomic and recovery/visible produces a snapshot; ASH-602 must prove state refresh after messages have fallen outside the most recent 200. None of these future checks is counted as passed here.
