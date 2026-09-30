# ASH-106 QA foundation evidence

Status: infrastructure ready for independent review; final repository conformity is not yet met.

Reproduce from the repository root:

```sh
npm ci
npm run typecheck
npm test
ASH_ARCH_PRIVATE_TERMS_FILE=/path/to/private-terms.txt npm run test:arch:final
```

`npm test` passed 33/33 with the installed DSH release; the latest complete run is in `log/ash-qa-test.lcq061.log`. Its named tests deliberately inject violations for AR1, AR2, AR3, AR4 and AR12 and assert each detector returns a finding. The empty-tree test proves required source directories cannot silently pass. AR4 also has a runtime monitor test that detects an unauthorized intrinsic-file write.

Review follow-up: AR1 now allows standard-library imports and helpers grouped with their member, while still rejecting peer imports. AR12 detects prohibited words adjacent to Chinese prose, excludes substrings of encoded alphanumeric data, and includes text logs under `build/evidence` in the repository scan. Positive and negative fixtures cover each of these cases. A scan of the committed evidence found no private terms or absolute channel paths.

The strict gate exited 1 with 25 findings against the inherited v1 tree; see `log/ash-qa-gate.T6AHrA.log`. Missing v2 member/UI/worker paths and the v1 API routes account for the findings. This result must not be counted as AR conformity. The private terminology file stays outside the public repository; the gate requires its path in `ASH_ARCH_PRIVATE_TERMS_FILE`.

The route check presently recognizes the switch-based server router. If the v2 router changes form, update the extractor and its negative fixture before treating a green result as accepted. The AR4 snapshot helper is not live runtime enforcement: it only compares filesystem states before and after a scenario and needs to be hooked to a real self-member scenario after that member exists. It does not count as final AR4 acceptance.
