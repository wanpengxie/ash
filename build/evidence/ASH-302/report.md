# ASH-302 delivery contract checkpoint

The `service:post/deliver` result now distinguishes `dropped` from `inapp`, `notification`, and `held`. `dropped` means this delivery attempt was suppressed by a dedupe key; it does not remove or alter the original owner-targeted message or its receipt. A host attempt with an unknown outcome must return an error, not a successful `notification` channel.

The SDK test accepts each of the four exact channel values and rejects an unknown channel, extra success assertions, an absent channel, and a non-object result. The word's input and all other result fields are unchanged.

Reproduce: `node --import tsx --test packages/sdk/test/v2-contract.test.ts` (13 pass, zero skip/fail); `npm run -s typecheck` (pass).

Runtime held-queue atomicity, foreground and quiet-window classification, host presentation, and recovery remain pending at this checkpoint.
