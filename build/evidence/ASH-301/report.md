# ASH-301 contract checkpoint (implementation pending)

The SDK now declares a clock-origin outbound `clock.fired` event. Its closed body carries a timer ID, safe-integer scheduled timestamp, and one of `dispatched`, `skipped`, or `failed`; reason and accepted request ID are optional. `dispatched` means only that the world router accepted the scheduled request, not that any external effect completed. The event has no response schema and is not an inbound callable word.

The contract test checks positive shapes, wrong source, missing and extra fields, non-finite, fractional, negative, and unsafe timestamps, invalid outcome, and empty IDs. No clock runtime, old-timer conversion, host alarm scheduling, pause integration, or delivery behavior is claimed at this checkpoint.

Reproduce from the repository root:

```sh
node --import tsx --test packages/sdk/test/v2-contract.test.ts
npm run -s typecheck
```

The focused SDK suite exits with 11 pass, 0 failures, 0 skips; typecheck passes.
