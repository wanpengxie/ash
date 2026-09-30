# ASH-807 detector evidence (2026-10-01)

Status: detector implemented; final content conformity **not yet assessed**. The intended v2 content target directories were absent at this revision. Missing inputs make the local command exit 2, not pass.

Counting rule: normalize each blank-line-delimited paragraph with Unicode NFKC and lowercasing; count each remaining Unicode letter or number as one code point (one Han character = one; one Latin letter = one). Ignore punctuation and whitespace. A match of exactly 12 counted characters passes; 13 or more is reported. Matches never cross paragraph boundaries. This is a deliberately conservative normalized-overlap detector; human review remains required for meaning and originality.

Checks:

- `npm run test:originality`: 12/12 pass, covering boundary, paragraph, CLI fail-closed, redaction, and private sidecar behavior.
- `npm run test:public-terms` with `ASH_PRIVATE_TERMS` supplied from a protected CI secret (or direct CLI `--terms-file` locally): 217 tracked text files scanned, 0 findings. Missing terms exit 2 rather than pass. CI never reads the private reference corpus. Fork PRs without the secret require trusted maintainer rerun and cannot claim a passing term gate.
- Local private-reference smoke: 1 synthetic target against 465 readable reference files / 8,706 eligible paragraphs; 11 candidate matches, maximum normalized length 14. Exit 1 correctly signals candidates. This is a detector smoke test, **not** a F-C10 pass/fail result for production content.

Local content acceptance command, to run once content exists (replace placeholders with repository-local content directories and an external private reference directory):

`node tools/originality.mjs --target <content-dir> --reference <private-reference-dir> --output <private-evidence-json>`

The summary output contains only counts, randomly salted truncated path digests, paragraph indices, and match lengths. Add `--private-map <private-sidecar-json>` to resolve those IDs to paths and paragraph start lines locally; this file is created with owner-only permissions and must remain outside public git. Neither file contains matched passages. Do not publish the reference, matching passages, or original paths.
