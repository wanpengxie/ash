# ASH-005: cancellation during device execution

Tested installed DSH `0.2.0-rc.2` with a scripted model and an in-memory delayed device. Both fixtures use the real DSH agent loop and `agent.cancel()` through the current core API. No real device or outward operation was used.

| Device behavior | Abort signal after cancel | `turn/end` after cancel | Observed outcome |
|---|---:|---:|---|
| Resolves when aborted | 2.97 ms | 24.32 ms | Under 1 s; `turn/end` reason was `error` |
| Ignores abort until released | ~3 ms | Absent at 5 s | DSH waited for tool completion; after release it emitted aborted `tool/result` and `turn/end` reason `error` |
| Ignores abort; spike-only router settles request | promptly | 35.99 ms | `turn/end` while device remains in flight; one `call.ended {ok:false,error:"cancelled"}` |

The delayed operation was still in flight during the five-second timeout in the second case: the ledger had `call.started` without `call.ended`. After release, the current core logged `call.ended {ok:true}` despite cancellation, while DSH converted the tool result to an abort error. This is a pre-router vulnerability: the ledger can record a late success after the user has cancelled. Raw event and timing records: `cooperative.json`, `abort-ignoring.json`.

The third case installs a cancellation-settlement wrapper on this probe's in-memory core instance only. The underlying provider ignores abort and remains unresolved for another 150 ms after `turn/end`. On abort, the wrapper returns a cancelled tool result to DSH and emits one cancelled `call.ended` in the ledger. After the provider is released, its successful result is suppressed; there is no second terminal event or late success. The runnable assertion checks all of these facts in `router-settlement.json`. Production core/router code has not changed.

Recommended router behavior for the next implementation card: track every in-flight request by id and turn; on turn cancellation, atomically settle pending requests with a `cancelled` response, abort the device operation, notify the recipient, and mark the request terminal in the ledger. Ignore any later provider response for that id, including a late success: it must not create a second terminal response or a successful end event. For an uncooperative provider, race its work against the cancellation settlement so the DSH tool promise resolves promptly. Treat the DSH `error` ending after cancellation as a cancelled turn at the core boundary, based on the turn's abort state. This is a contract recommendation; no downstream router was implemented here.

Reproduce from repository root (with `node_modules` available):

```sh
ASH_TEST_DSH_ROOT=/path/to/@deepseek-ai/dsh node --expose-internals --import tsx tools/spikes/v5-cancel.ts --cooperative
ASH_TEST_DSH_ROOT=/path/to/@deepseek-ai/dsh node --expose-internals --import tsx tools/spikes/v5-cancel.ts
ASH_TEST_DSH_ROOT=/path/to/@deepseek-ai/dsh node --expose-internals --import tsx tools/spikes/v5-cancel.ts --router-settlement
```

Acceptance: **spike demonstrated, pending independent reproduction**. The proposed router settlement yields a subsecond `turn/end` even when the device ignores abort, and the delayed success is quarantined. The later production router must implement this behavior; the current core does not.
