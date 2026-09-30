# ASH-102 router evidence

This card supplies an isolated world router and durable request-phase table. It does not switch the running v1 server, implement the member registry/describe endpoint, or implement the later gate and agent inbox.

## Reproduction

From the repository root:

```sh
npm ci --ignore-scripts
npm run -s typecheck
node --expose-internals --import tsx --test packages/core/test/world/router.test.ts
npm test
```

The focused tests use temporary synthetic SQLite databases and fake members/devices; they make no real device calls or outward writes.

On the current v2 base, `npm run -s typecheck` passed. The focused router file is run without `--test-force-exit`; the full suite's pass/skip count should be taken from the command's current output because unrelated tests change on the shared integration branch. The skipped word-route skeletons are not runtime evidence.

After merging v2's natural-exit test runner, the full `npm test` process exited normally with 136 pass, 57 intentional skips, 0 failures (193 total). `npm run -s build:core` completed. The public-term scan against the private out-of-repository term list scanned 310 tracked public files and found 0 matches; the term list itself is neither printed nor committed.

CI exposed a test-only race in the old timeout fixture: a 25 ms deadline could pass during SQLite setup before the fake handler entered, leaving its late-result release function unset. The timeout fixture now waits for explicit handler-entry evidence and asserts that entry precedes the terminal timeout, while keeping a genuine late success after timeout to verify one durable response. The cancellation fixture likewise asserts its fake device is in flight before cancellation. These changes do not relax the router's timeout behavior.

## Claims covered by the focused tests

- Request acceptance, `client_id` retry identity, matching `reply_to`, one response, and a matching external response (F-W01).
- Timeout records one error response; cancellation settles the waiting promise immediately and invokes the recipient cancellation hook. A deliberately non-cooperative fake device releases a late success, which is ignored (F-W02, F-W06).
- Unknown recipient word and invalid body reject before acceptance/dispatch (F-W03, F-W04). External device schemas are compiled with Ajv (draft 7, 2019-09, or 2020-12); unknown dialects and unresolved remote references reject at registration. No remote schema is fetched.
- Broadcast reaches multiple subscribers, replay resumes from a sequence cursor, and one broken subscriber cannot strand an accepted request (F-W05).
- Every risky request, including one from the owner, persists before gate inspection. A gate decision event is recorded before device dispatch; denial never dispatches. This is a test hook, not the later gate implementation.
- Recovery distinguishes accepted, gate-waiting, dispatching, and settled. Current authorization is rechecked. Uncertain dispatching effects and orphaned gate waits are not blindly replayed. Explicitly marked durable-inbox endpoints can redeliver the same message ID to a fake deduplicating inbox; the real inbox remains a later card.
- Untrusted request fields cannot choose sender, origin, or turn. Outbound events bind to their declared source member and schema; remote screens cannot invoke local-only writes. The persisted caller snapshot contains only selected identity/permission facts and excludes synthetic transport tokens/cookies.
- Each subscriber, gate hook, and handler receives a detached copy of the accepted message, so mutating an observer's copy cannot change the checked body or device effect. Recovery checks the currently registered request kind, direction, and input schema again before any effect; an incompatible accepted request settles with `bad_request`.
- `service:work/run` is owner-only. Trusted local `service:work` may use only `service:self/append` and `apply_plan` as itself, matching the background-flow contract; other services, remote work, and its `write`/`rollback` attempts are denied before ledger acceptance.
- Web-screen and paired-phone notification answers persist their server-stamped origin on the response row. Valid phone sense broadcasts use only the four declared service:senses word schemas and keep `from=device:phone`; unknown words, invalid bodies, and non-phone attempts are rejected before acceptance.
- An external `ask` reply must come from a verified web screen or paired-phone notification proxy, name an option offered by that exact request, and arrive before the earlier of its `expires_at` and endpoint timeout. Ordinary owner API calls and invalid choices leave the first-answer slot open. At expiry the router records one automatic `choice:deny` without owner-screen origin; a shorter generic endpoint timeout remains `timeout`. Restarted expired asks are denied without redispatch.
- Stream replay captures each page's cursor before invoking listeners and provides detached message copies, so a listener cannot force duplicate or looping history by changing `seq`.

## Boundaries and follow-up

The production startup cutover and HTTP authentication/stream framing belong to later cards. `RecoveryAuthorizer` receives detached request/context copies and must be wired to current grants/permissions by that integration; its test double is not an authorization service. The fake durable inbox is an interface test, not a claim that the agent's actual inbox is implemented. The real gate, device adapters, and integrated turn cancellation also remain future work.
