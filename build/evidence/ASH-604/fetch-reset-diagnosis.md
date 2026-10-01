# Intermittent second POST reset in the runtime integration test

Base commit: `36db56ed23b5e6cedc19d81e66b5ba0d70373d11`. This change modifies only the test fixture; it does not change the HTTP server or production client.

## Observed failure

The second `/api/send` POST in `packages/core/test/world/dsh-runtime.test.ts` intermittently failed before returning a `Response`. Independent instrumentation on the unchanged base captured `TypeError: fetch failed`, cause `ECONNRESET` / `read ECONNRESET`, in 6–9 ms. The first POST had been idle for approximately 6.7–6.9 seconds; the Node 22 server's measured keep-alive timeout was 5 seconds. In the captured failed attempt, the second POST had not entered the edge handler, ledger sequence and client-id acceptance were unchanged, and an immediate health GET returned HTTP 200. Retrying the exact same POST and client ID succeeded with one arrival and one accepted message. These observations locate the failure in the HTTP transport before application acceptance and are consistent with reuse of a closing idle connection. The failed attempt's exact socket identity was not captured, so the keep-alive mechanism is a supported explanation, not a directly witnessed socket-level proof.

Separately, the original test did not consume the first POST response body. The fixture now consumes it. This is correct cleanup, but it is not claimed as the proven cause of the reset.

## Narrow fixture correction

The attachment-only POST retries at most once, only when `fetch` throws a `TypeError` whose cause code is `ECONNRESET`. It reuses byte-identical JSON, authorization and a nonempty stable `client_id`. HTTP error responses and other thrown errors are not retried. A recovered reset is reported in test diagnostics; if the retry also fails, an aggregate error retains both failures. The test checks the accepted message against the durable client-id lookup and checks that only one request row exists. A deterministic ACK-loss test lets the real HTTP endpoint accept a request, discards that acknowledgement, then confirms the retry returns the same ID with only one inbox request and one agent response. Another test rejects unrelated failures and a second reset without further retry.

## Verification

Commands, with `DSH_INSTALL` set to an installed runtime directory:

```sh
npm run -s typecheck
ASH_TEST_DSH_ROOT="$DSH_INSTALL" node --expose-internals --import tsx --test packages/core/test/world/dsh-runtime.test.ts
ASH_TEST_DSH_ROOT="$DSH_INSTALL" npm test
npm run -s build:core
node --import tsx packages/core/ui/test/pending-browser-probe.mjs
```

Author run after the fixture change: focused 4/4; full suite 372 total, 313 pass, 59 intentional skips, zero failures; typecheck and build passed; eight concurrent focused runs passed 4/4 each. The isolated real-browser pending-send probe passed attachment-only input, same-client-ID ACK-loss retry, one ledger acceptance, credential-scope isolation, two-tab lease and crashed-tab recovery (44.9 seconds). The browser probe uses synthetic data and a temporary profile.

This is test stability and idempotency coverage, not a fix to a production network stack. Independent review of the final commit remains required.
