# AR12 fixture privacy follow-up (2026-10-01)

The legacy architecture detector and its tests no longer embed or encode private terminology. `checkTree` accepts an external list; an absent or empty list produces an AR12 finding. The final repository gate still requires `ASH_ARCH_PRIVATE_TERMS_FILE` and reports nonconformity when it is missing. Fixture tests use clearly synthetic labels while preserving positive, boundary, evidence-walk, and fail-closed cases.

Reproduction at this commit:

- `npm test`: 34/34 passed.
- `npm run typecheck`: passed.
- `node tools/originality.mjs --ci-terms --terms-file <private-term-file>`: 229 tracked text files, 0 findings. The private file is external and is not committed.
- `ASH_ARCH_PRIVATE_TERMS_FILE=<private-term-file> npm run test:arch:final`: 25 known pre-migration AR1/AR2/AR3/AR4 findings, **0 AR12 findings**. This is not a final architecture pass.
