# ASH-004: two-tool device selection probe

Status: real-model validation blocked. The installed DSH package is available, but this checkout has no selected model or provider credential in the expected local configuration or environment. No fake-model score is reported as a substitute.

The runnable probe offers exactly `ash_describe` and `ash_send` for its first pass. It uses 20 instructions: five each for calendar, screen, clipboard, and shell. Every device response comes from an in-memory fixture; `calendar.create`, `screen.tap`, `clipboard.write`, and `shell.run` record simulated results only. Each case is scored on the first device call's member, word, and required body fields. Discovery calls may precede it. A score below 18 automatically runs a second pass with eight direct tools (`calendar.search/create`, `screen.inspect/tap`, `clipboard.read/write`, `shell.inspect/run`). The script saves per-case transcripts and aggregate `results.json` here.

Run from the repository root after selecting an authorized model:

```sh
ASH_V4_API_KEY=<provider-key> ASH_V4_MODEL=<model-id> ASH_V4_BASE_URL=<anthropic-compatible-base> node tools/spikes/v4-two-hop.mjs
```

`ASH_V4_BASE_URL` defaults to `https://api.deepseek.com/anthropic`. The script does not print or store the API key. Do not put credentials in the command history when running manually; export them through the normal secret facility. The output is valid evidence only when the endpoint is backed by a real model. The exact model and provider must be recorded alongside the final score.

Acceptance: **unmet** until a real-model run yields at least 18/20, or the direct-tool fallback is measured and selected.
