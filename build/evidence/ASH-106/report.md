# ASH-106 QA foundation evidence

Status: infrastructure ready for independent review; final repository conformity is not yet met.

Reproduce from the repository root:

```sh
npm ci
npm run typecheck
npm test
ASH_ARCH_PRIVATE_TERMS_FILE=/path/to/private-terms.txt npm run test:arch:final
```

`npm test` passed 30/30 with the installed DSH release; the complete run is in `log/ash-qa-test.BsBzEU.log`. Its named tests deliberately inject violations for AR1, AR2, AR3, AR4 and AR12 and assert each detector returns a finding. The empty-tree test proves required source directories cannot silently pass. AR4 also has a runtime monitor test that detects an unauthorized intrinsic-file write.

The strict gate exited 1 with 25 findings against the inherited v1 tree; see `log/ash-qa-gate.T6AHrA.log`. Missing v2 member/UI/worker paths and the v1 API routes account for the findings. This result must not be counted as AR conformity. The private terminology file stays outside the public repository; the gate requires its path in `ASH_ARCH_PRIVATE_TERMS_FILE`.

The route check presently recognizes the switch-based server router. If the v2 router changes form, update the extractor and its negative fixture before treating a green result as accepted. Runtime AR4 must be hooked to a real self-member scenario after that member exists.
