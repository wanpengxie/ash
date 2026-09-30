# ASH-004: two-tool device selection probe

Status: real-model validation passed. The selected DSH default is `deepseek-official/deepseek-flash`; this run used its existing credential and official Anthropic-compatible endpoint. No fake-model score is reported as a substitute.

The runnable probe offers exactly `ash_describe` and `ash_send` for its first pass. It uses 20 instructions: five each for calendar, screen, clipboard, and shell. Every device response comes from an in-memory fixture; `calendar.create`, `screen.tap`, `clipboard.write`, and `shell.run` record simulated results only. The strict oracle requires the exact normalized target member, word, and body values, a normal `end_turn`, and no extra or duplicate effectful call. Discovery and read-only prerequisites may precede the target action. The first device call is a separate diagnostic. A score below 18 automatically runs a second pass with eight direct tools (`calendar.search/create`, `screen.inspect/tap`, `clipboard.read/write`, `shell.inspect/run`). Each case saves visible assistant text, tool calls/results, and stop reasons; hidden reasoning and request headers are excluded. The loop caps at eight model steps.

| Mode | First turn | First device call | Extra effectful calls | Interpretation |
|---|---:|---:|---:|---|
| describe + send, strict rerun | **19/20** | 17/20 | 0 | Meets the 18/20 threshold; select the two-tool design |
| eight direct tools, initial supplement | 20/20 | 17/20 | 0 | Earlier diagnostic; not rerun because the strict two-tool score passed |

In the strict rerun, case 3 called `calendar.search` with the exact `flight` query, but its final answer ended with `max_tokens`, so it failed the completed-turn requirement. Every other case completed with the requested action and parameters. The initial run used a narrower first-device-call metric and had a different failure (case 4 never created its event); its tool-call records and results remain in `initial-transcripts/` and `initial-results.json`. The strict rerun is the acceptance score. The earlier direct case 4 ran read-only `date` before creating the correct event; this was unnecessary but had no effect in the fixture.

Run from the repository root after selecting an authorized model:

```sh
ASH_V4_API_KEY=<provider-key> ASH_V4_MODEL=<model-id> ASH_V4_BASE_URL=<anthropic-compatible-base> node tools/spikes/v4-two-hop.mjs
```

`ASH_V4_BASE_URL` defaults to `https://api.deepseek.com/anthropic`. The script does not print or store the API key. Do not put credentials in the command history when running manually; export them through the normal secret facility. The output is valid evidence only when the endpoint is backed by a real model. `node --test tools/spikes/v4-oracle.test.mjs` covers wrong arguments, extra and duplicate effects, and step caps. The strict score above comes from a new real-model run, not an offline rescore.

Acceptance: **met pending independent reproduction**. The real model exceeded 18/20 with the two-tool design. The three presentation aliases are outside this focused probe and remain part of the later binding implementation.
