# ASH-004: two-tool device selection probe

Status: real-model validation passed. The selected DSH default is `deepseek-official/deepseek-flash`; this run used its existing credential and official Anthropic-compatible endpoint. No fake-model score is reported as a substitute.

The runnable probe offers exactly `ash_describe` and `ash_send` for its first pass. It uses 20 instructions: five each for calendar, screen, clipboard, and shell. Every device response comes from an in-memory fixture; `calendar.create`, `screen.tap`, `clipboard.write`, and `shell.run` record simulated results only. Each case is scored on whether the requested target member, word, and required body fields were reached during the first complete turn, with no extra effectful call. Discovery and read-only prerequisites may precede the target action. The first device call is a separate diagnostic. A score below 18 automatically runs a second pass with eight direct tools (`calendar.search/create`, `screen.inspect/tap`, `clipboard.read/write`, `shell.inspect/run`). The script saves per-case tool-call transcripts and aggregate `results.json` here.

| Mode | First turn | First device call | Extra effectful calls | Interpretation |
|---|---:|---:|---:|---|
| describe + send | **19/20** | 16/20 | 0 | Meets the 18/20 threshold; select the two-tool design |
| eight direct tools | 20/20 | 17/20 | 0 | Supplemental diagnostic from the original, stricter scoring run; no fallback needed |

Two-tool case 4 failed: it inspected the screen, searched the calendar, and read the clipboard, but never called `calendar.create`. Two-tool case 5 searched before creating the correct event. Screen cases 9 and 10 inspected before tapping the correct label. These three are successful first turns, while their first device calls differ from the final target. The supplemental direct case 4 also ran read-only `date` before creating the correct event. Its extra steps are unnecessary but did not cause effects in the fixture. All expected parameters are visible in `transcripts/`; the oracle is implemented in the script.

Run from the repository root after selecting an authorized model:

```sh
ASH_V4_API_KEY=<provider-key> ASH_V4_MODEL=<model-id> ASH_V4_BASE_URL=<anthropic-compatible-base> node tools/spikes/v4-two-hop.mjs
```

`ASH_V4_BASE_URL` defaults to `https://api.deepseek.com/anthropic`. The script does not print or store the API key. Do not put credentials in the command history when running manually; export them through the normal secret facility. The output is valid evidence only when the endpoint is backed by a real model. `node tools/spikes/v4-two-hop.mjs --rescore` reapplies the documented oracle to the saved tool-call records without using a model or changing the calls; the score above was obtained this way after the first run's overly narrow first-device-call diagnostic was corrected.

Acceptance: **met pending independent reproduction**. The real model exceeded 18/20 with the two-tool design. The three presentation aliases are outside this focused probe and remain part of the later binding implementation.
