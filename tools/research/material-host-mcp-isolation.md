# H1 native MCP isolation evidence

2026-10-10 Asia/Shanghai. **The bundled App Server can attach a configured stdio MCP tool to the same synthetic existing thread. Its exposed MCP metadata and native-item correlation do not provide a verified model-invocation identity or exclusive response custody. Original desktop H2 remains unproven.**

## Reproduce

```sh
node --test tools/research/material-host-mcp-isolation.test.mjs
node tools/research/material-host-mcp-isolation.mjs \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --case all --output /tmp/ash-h1-mcp-new-disposable-directory
```

The output directory must not exist. The runner imports the read-only H0 `BINARY`, `isolatedEnv`, `profile` and `bounded` exports; none of the H0 files were modified. It copies only its own MCP fixture into the private temporary directory. Native uses a fixed environment, temporary HOME/CODEX_HOME, CFFIXED_USER_HOME and CoreFoundation daemon avoidance. No real config, credentials, API key, login, original rollout, desktop daemon, installation or business operation is used. The model is an HTTP Responses fixture and the MCP tool accepts only one synthetic nonce, returning synthetic text.

The deny-default OS profile is the already tested H0 profile. It permits the allocated model/RPC ports, required system/bundled runtime reads and temporary writes; no Users read rule was added. Before native startup the selftest proves temporary read/write, refusal to read a newly created external HOME sentinel, allowed mock connection and EPERM on another loopback listener and 1.1.1.1:443. Isolation failure stops the experiment, with no bare-process fallback. MCP stdio has no network service. Tests passed before native execution.

## Actual evidence

Authoritative artifacts: `/tmp/ash-h1-mcp-isolation-20261010-b/report.json`, `events.jsonl`, `mcp.jsonl`, `manifest.json`, `sandbox.sb`, `logs/help.txt`, and generated `schema/`. Started 2026-10-09T22:57:18.948Z (Shanghai October 10).

| Evidence | Actual value |
| --- | --- |
| Bundled CLI | `0.162.0-alpha.17.2` |
| Launcher SHA-256 | `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` |
| Actual Mach-O SHA-256 | `0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28` |
| ClientRequest + McpServerToolCallParams schema SHA-256 | `10ba98319d691301e85aa1920b491c5d62f20bca58b507db92799da1a92d6aa3` |
| Original synthetic U | `01a122e2-9e13-7d20-8556-e0afd29b5009` |
| Other synthetic thread V | `01a122e2-9e7c-7a41-bcd4-3106dd44aa4a` |
| Native PID | 45524 |
| MCP generations/PIDs | `stdio_45529`, `stdio_45530` |
| Mock/RPC/denied listener | 60724 / 60725 / 60726 |

Generated schema and help support the exact `config/mcpServer/reload`, `thread/resume` and `mcpServer/tool/call` methods and WebSocket listen flag. All native IDs come from native returns.

## Same existing U tool attachment

A starts persistent U with no dynamic tools and no MCP config. U completes `before_attach`: the model request declares no probe and native emits no MCP item. Only the temporary config is then extended with `[mcp_servers.probe]`, an absolute Node executable and the copied stdio fixture. A invokes supported `config/mcpServer/reload`, then resumes the **same U**.

The next model request declares namespace `mcp__probe` with function `ash_material_probe`. Native calls the fixture through stdio, emits `item/started` and `item/completed` for `attached_model_call` on the same U, and includes `fixture_result_stdio_45529_4` in its next model request. The original history is present in the subsequent real thread/read response. No rollout edit, fork, replacement U or start-time dynamic registration was used.

This establishes synthetic existing-thread MCP attachment through config reload/resume. It does not establish attachment in the original desktop GUI or authenticating that GUI's model invocation; H0's narrower dynamic-tool attachment result remains unchanged.

## Actual native metadata and direct calls

The model-path fixture receives `_meta.callId`, `threadId`, `sessionId`, `windowId`, `itemId`, `progressToken` and `x-codex-turn-metadata` containing native thread/session/turn coordinates and synthetic model/runtime settings. The model `itemId` is `fc_attached_model`, while the native mcpToolCall event's item id is `attached_model_call`.

| Direct B call | Actual fixture observation | Result recipient |
| --- | --- | --- |
| No metadata, before B read/resume | Native supplies outer threadId U and a progressToken | B's RPC response, result ordinal 5 |
| Caller-provided metadata | Native rewrites outer threadId to U; supplied sessionId/callId/turnId/turn metadata survive | B, ordinal 6 |
| Copy prior model metadata | All model coordinate fields survive; progressToken is replaced | B, ordinal 7 |
| After B read/resume | Same copied coordinate fields survive | B, ordinal 8 |
| Caller chooses V with copied U metadata | Outer threadId becomes V; copied sessionId and nested thread/session/turn metadata remain U; V's own fixture is called | B, `stdio_45530` ordinal 4 |

No direct case emitted a native `mcpToolCall` item. In contrast, the model path emitted started/completed items with actual U/turn/call and args. This distinction is observable but is insufficient on its own for confidential tool-result custody.

`progressToken` is native-reallocated (model 1, later direct calls 2–5; pending model 6, pending direct 7). It is not shown as a signed model-only source-kind or as a verified relationship to the native item in the observed API. The experiment does not declare that field forgeable; it establishes that it appears on both paths and provides no verified item-to-stdio-request linkage here. No signature, protected credential or mandatory model-only provenance field was observed.

## Same-pending native-item correlation and response custody

The fixture deliberately holds the first `pending_model` call. Native emits an actual in-progress item on U/turn, tool `probe/ash_material_probe`, call `pending_model_call`, args `{nonce:"pending_model"}`. While that item is pending, B sends a regular direct MCP RPC with exactly the same arguments and copied original metadata.

The fixture receives both requests on **the same stdio generation**. Their coordinate fields and argument hash match; the progress tokens differ. The direct RPC produces no new native item but reaches the fixture while the original matching native item is still pending.

The direct request receives `fixture_result_stdio_45529_10` in **B's RPC response**. After release, the original request receives `fixture_result_stdio_45529_9` in native's model `function_call_output`, and the original native item completes. Events, fixture request IDs, response records and actual mock inputs retain this sequence.

Thus observing a real pending native item plus matching coordinates/tool/args hash cannot by itself establish that a particular MCP request is the original call. There are two distinct result destinations. A deduplicating implementation that returns cached confidential get_result/bytes to every request matching that item would also return them to B. This fixture uses distinct harmless markers and does not implement or leak a real result cache. The required exclusive response path remains **unproven**.

These are local synthetic protocol observations, not a public-network vulnerability claim. They justify keeping A3 MCP-only identity disabled until a host-controlled proof or request-to-item association excludes direct RPCs and preserves result custody.

## Bounds, cleanup, and remaining dependency

Each case has an independent nonce and bounded RPC/model waits; the model fixture permits at most three requests per armed case. MCP has an 80-message overall ceiling, bounded pending wait and fixed allowlisted methods. The runner has a 60-second stop timer and only terminates its owned native and logged stdio fixture PIDs. Stdout is reserved for MCP JSON-RPC; evidence uses private temporary files. Host name/installation metadata is redacted.

Final status is `observations_complete`; `hostProof` and `originalDesktopH2` are `unproven`. Five independent boundary tests pass. Cleanup reports stopped native, closed client sockets/mock and fixture PIDs. Independent post-run checks confirm PID45524/45529/45530 gone and mock/RPC ECONNREFUSED. No active process/session remains.

No candidate model-only provenance survived this ordinary direct-call comparison, so further restart/replay testing of a hypothetical signer is not warranted by this result. The concrete missing facility is a host-authenticated model invocation-to-MCP-request binding plus an original-call-only result destination, excluding generic direct RPC issuance. A platform host bridge/signer can supply it; config reload alone does not. A4/A5 ledger, relay, bytes and UI work can continue, while H2 still requires the original GUI/native thread and both directions of synthetic material delivery.
