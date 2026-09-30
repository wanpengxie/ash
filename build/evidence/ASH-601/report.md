# ASH-601 projection evidence

Status: implementation ready for independent review; not self-verified or marked Done.

Reproduce from this checkout with dependencies installed:

```sh
node --test packages/core/ui/test/project.test.js
npm run -s typecheck
npm test
npm run -s test:arch:final
```

Observed: 26 JSON fixture segments and 6 boundary test groups pass (32 test cases). Full suite: 74 passed, 57 intentionally skipped runtime word-routing skeletons, 0 failed. The final architecture gate remains not yet conformant with 26 findings in later member/router/worker work and the required private terminology input; this card does not claim that gate.

The pure reducer consumes only numbered ledger messages. It normalizes display-safe fields and sorts them by sequence, making duplicate live delivery and older history pagination deterministic. Unnumbered screen registration frames, unknown words, and raw tool data do not enter the view. The seven public view fields match C11; non-enumerable internal records support replay without leaking into serialized snapshots.

Projection facts covered: presence and avatars from explicit status; owner/agent say; received/read; reaction attachment; option-card locking from an accepted owner reply; five card variants; ask pending/answer/timeout; turn/run grouping and generic gate steps; timer snapshots only from clock.list; self.changed; and held only from trusted owner-directed post.changed snapshots. Negative tests cover old/repeated/forged/invalid held updates, control frames, unknown words, out-of-order history, and timer set/cancel without a list snapshot.

Scope boundary: this module does not open streams, send visible/typing, use wall-clock expiry guesses, or render the UI. The later client must send visible immediately after stream registration to obtain an authoritative initial held snapshot, then continue its heartbeat. Initial held=0 is a display default until that snapshot arrives, not a claim that the queue was queried.
