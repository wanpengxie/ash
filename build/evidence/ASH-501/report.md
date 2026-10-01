# ASH-501 worker runtime — author evidence

## Scope

Six worker members use the frozen request/result word contracts. Each call compiles a deterministic prompt, makes a session-free model request, parses one complete JSON value, and checks the declared schema plus cross-field evidence rules. Invalid output gets one fresh model attempt; a second invalid output returns a failed response. Workers do not receive tools or file access.

The DSH adapter reads the selected provider/model for every call and passes `tools: []` to `llm.stream`. It accepts only a normal stop, rejecting truncation and tool output. The startup registration function is deliberately not called by the current owner bootstrap: the production DSH runner/bootstrap dependency is not yet available there. It must be registered before router recovery when that dependency lands; a fake or echo model must not stand in for it.

## Acceptance evidence

| ID | Author result | Reproduction |
|---|---|---|
| F-B03 | Pass at worker boundary: missing or invented owner quote is rejected; cited wording must occur in a cited owner message. | `node --import tsx --test packages/core/test/members/workers.test.ts` |
| F-B04 | Pass at worker boundary: unknown evidence ids fail, including a two-attempt real DSH-service fixture. | same test; `tools/spikes/v2-worker-service.ts` |
| F-B09 | Partial: malformed/invalid/incomplete output is retried once and returns `failed`; the durable `run.end{failed}` plus unchanged-file integration remains with ASH-502/503. | same tests; later integration required |
| F-B16 / AR11 | Pass at adapter boundary: three actual DSH `llm.stream` calls capture the configured model and `tools: []`; no agent session is created. Production owner startup remains pending. | `tools/spikes/v2-worker-service.ts` |
| F-B19 | Pass for the runtime prompt compiler: section ordering, escaped source-marked data, exact prompt capture, and a fixed SHA-256 snapshot. The six quality-tuned worker prompt files belong to ASH-806. | same tests |
| AR9 | Pass for this runtime's six minimal step instructions: automated forbidden-rule scan; ASH-806 content is out of scope. | worker unit test |

## Commands

From the repository root with Node 22 and dependencies installed:

```sh
npm run -s typecheck
npm test
npm run -s build:core
ASH_TEST_DSH_ROOT=/path/to/installed/@deepseek-ai/dsh node --expose-internals --import tsx tools/spikes/v2-worker-service.ts
```

Local author run: typecheck/build pass; full suite 163 pass, 57 skip, 0 fail; DSH service fixture prints PASS with three captured calls. The fixture uses a loopback scripted provider and synthetic messages, no user files or live credentials.

## Still pending

- Production owner bootstrap registration after the DSH runner is available; the present core startup must not silently install a fake worker.
- ASH-502/503 joint test for `run.end{failed}` and unchanged managed files after two invalid responses.
- ASH-806's six final prompt files and quality samples; this card supplies only minimal runtime instructions.
