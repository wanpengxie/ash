# ASH-007 · Model judgment latency spike

Status: pending real key. The isolated client and offline contract probe are ready. No p95 claim is made.

The existing local prototype uses POST https://api.typesafe.ai/v1/systemone with a bearer token, model jev-latest, a state object, and typed questions. The probe uses the same request shape with three control questions. It records only timing and model name; it never prints the key, prompt response, or conversation content.

Run from the repository root:

    node tools/spikes/v7-jev-latency.mjs --stub --count=3
    TYPESAFE_API_KEY=… node tools/spikes/v7-jev-latency.mjs --count=30

The stub checks invocation and response shape only. The real run is required to decide whether p95 is below 300 ms. A 300 ms production deadline and keyword fallback remain required regardless of this spike's result.

On 2026-10-01, `node tools/spikes/v7-jev-latency.mjs --stub --count=3` completed with three validated stub responses. Their measured 0 ms is local function overhead and is not model latency. Neither `TYPESAFE_API_KEY` nor `JEV_API_KEY` was present in the process environment, so no real request was sent.
