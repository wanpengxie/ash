# ASH-107 fixture evidence

Status: fake services and evidence helper ready for independent review; C7 types remain provisional until contract freeze.

Reproduce from the repository root:

```sh
npm ci
npm run typecheck
npm test
tools/evidence.sh ASH-107 log /path/to/existing-log-file
```

`npm test` passed 30/30 with the installed DSH release; see `log/ash-qa-test.BsBzEU.log`. The host fixture records every HTTP request, requires a bearer token, serves manifest and gateway identity, scripts capability results, and records present/hide/alarm/sign/restart. The model fixture scripts tool calls, text, and JSON for worker decisions, supports streamed and ordinary Anthropic-style responses, captures requests, and rejects unscripted calls. Tests assert call recording, script consumption, and negative authentication/unscripted behavior.

`tools/evidence.sh` copies an existing log, screenshot, or recording to `build/evidence/<card>/<kind>/`, refusing invalid card IDs and overwrite. The evidence directory is ignored by default; reports and selected logs are force-added intentionally. No production host or model code changed.
