# ASH-008 contract implementation evidence

Status: implementation ready for independent review; protocol freeze is not claimed.

Implementation commit: `d1110f06a7bfeee2c66e18327370b2da216e78a6` on `v2-ASH-008-contracts`; PR #7 targets `v2`.

Reproduce from the branch checkout with dependencies installed:

```sh
npm run -s typecheck
node --import tsx --test packages/sdk/test/v2-contract.test.ts
npm test
npm run -s test:arch:final
```

Observed: typecheck passed; focused contract tests 7/7 passed; full suite 40 passed, 56 intentionally skipped route implementation skeletons, 0 failed. The final architecture gate reported 26 not-yet-conformant findings from unimplemented future member/UI/route/worker work and its required private term-list environment input. This card does not change production routes or claim that gate passed.

The SDK now contains additive v2 message/member/card/worker/screen/auth types, word schemas, host types, config defaults/validation, and a selected runtime contract. Existing v1 API remains active. V1 maps two separate runtime instances to one public member; V2 workers use a non-session tool-free call; V3 native managed writes must be denied and directed to self while result hooks only observe; V4 exposes five world tools; V5 route cancellation settles immediately and drops late results. These are declared contracts, not runtime enforcement.

Important implementation boundaries for following cards:

- Internal schema validation supports a deliberately small subset and throws on unsupported keywords/types. Do not use it to validate arbitrary device manifests; registration/router needs a standards-compliant JSON Schema validator.
- Screen registration is an unnumbered SSE control frame, not a ledger message. A future stream parser must handle it separately without advancing the ledger cursor. The screen token is never a body/URL/ledger field. The authenticated transport identity, not owner stamp or screen token, scopes persistent client-id deduplication.
- Static card/option-reply checks exist; pending/expiry/first-answer checks need an atomic router transaction.
- Static self write schemas require expected_hash, but hash comparison, path containment including symlinks, atomic append, guarded edits, and physical managed-file isolation remain implementation duties. A shell can bypass a native write hook; full isolation is not proved here.
- Worker schema and hard-rule checks exist, but model invocation, one retry, and failed run settlement are future runtime work.
- Read permissions for authenticated remote owner remain the existing authorized ledger/workspace scope. Server context must separately retain remote/local restrictions for admin and local-only writes.

No private design documents, machine-specific paths, credentials, or copied private prose are included in committed source.
