# H3 controlled native proxy evidence

2026-10-10 Asia/Shanghai. **The fixed bundled native CLI supports authenticated WS behind two role-specific Unix WS proxy endpoints, preserving the synthetic original thread and blocking the previously demonstrated Ash MCP direct path. H3 observations completed; original desktop H2, production installation and full GUI compatibility remain unproven.**

## Reproduce

```sh
node --test tools/research/material-host-proxy.test.mjs
node tools/research/material-host-proxy-isolation.mjs \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --case all --output /tmp/ash-h3-new-disposable-directory
```

The output directory must be new. This research package imports only read-only H0/H1 helpers. It does not modify their files, existing transport/setup/link, real Codex configuration, real daemon or GUI. There is no login, account API, real model key, real rollout or business action.

The native child has the already verified fixed temporary HOME/CODEX_HOME/CFFIXED_USER_HOME and CoreFoundation daemon avoidance environment. The deny-default OS profile permits only allocated native/mock loopback ports, temporary writes and required bundled/system runtime reads. Its selftest precedes native startup and checks temporary read/write, denied external synthetic HOME sentinel, allowed mock and EPERM for another loopback listener and external 1.1.1.1:443. No Users content rule is added. Failure stops the run, without a bare native fallback.

## Authoritative native run

Artifacts: `/tmp/ash-h3-proxy-isolation-20261010-d/report.json`, `events.jsonl`, `mcp.jsonl`, `schema/`, `logs/help.txt`, `sandbox.sb`. Started 2026-10-09T23:54:13.095Z (Shanghai October 10).

| Evidence | Value |
| --- | --- |
| Version | `codex-cli 0.162.0-alpha.17.2` |
| Actual Mach-O SHA-256 | `0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28` |
| ClientRequest schema SHA-256 | `29df6f372314d84d00436b23a3f6f0bfbcb81e646379464344f140ba18dd7019` |
| Original synthetic U | `01a12316-b719-7180-96ab-1888f6407aba` |
| Other synthetic V | `01a12316-b83b-7c73-87d0-596ef5fa62d4` |
| Native PIDs | 50612, then 50703 after controlled restart |
| Mock / native ports | 49253 / 49254 |
| First proxy instance/epochs | `9a5c647c-43de-4bf5-ac43-4c98a925c5a7:1`, `:2` after reload, `:3` after invalidation |

The exact native invocation is:

```text
app-server --listen ws://127.0.0.1:<owned port>
  --ws-auth capability-token --ws-token-file <temp>/native.capability
```

The supervisor generates a random 256-bit capability and writes only a 0600 file in the 0700 temporary directory. The token is not an argv value or environment variable, is never given to model/MCP/downstream clients, and is checked for absence from report/events. The tested successful upgrade uses `Authorization: Bearer <private capability>` solely inside the proxy's upstream connection factory. Native missing-token and wrong-token controls both return **HTTP401**. After native restart with a rotated token, the old token also returns **HTTP401**. Real proxy initialize ACKs prove the correct credential path worked; mock boundary tests alone are not counted as this evidence.

Owned-PID lsof inventory before proxy startup shows precisely one native TCP LISTEN at `127.0.0.1:49254`. Unix entries are unnamed inherited/internal socketpairs, not path-addressed control listeners. The temporary state tree contains no native Unix socket. An early inventory revision mistakenly AND-combined TCP/Unix selectors and was not accepted as evidence. A later revision rejected all unnamed socketpairs; the final check distinguishes those from path-addressed/listening controls. No real daemon inventory or stop was performed.

## Live cases and response custody

A GUI fixture connects through `<temp>/gui.sock`, B device fixture through `<temp>/device.sock`, both mode0600. Each has its own authenticated native WS; connections are never multiplexed. The role comes from the listener authority, not body/query/clientInfo; B's pretend GUI clientInfo does not change its role.

| Case | Actual evidence |
| --- | --- |
| Same U before/after MCP attachment | No-tool initial turn, temporary configured MCP reload/resume, same U ID and original history retained; native's next mock request consumes the actual MCP result |
| Device scope | B reads approved U; V read is rejected; B has no generic config/direct MCP access |
| Ash direct, alias, unknown server | A/B direct denied; `PLUGIN:ASH` canonical alias and unresolved identity denied; blocked nonce count at fixture is zero |
| Protected config override | thread/resume config override rejected; device reload rejected |
| Native same-pending direct | A/B copied `_meta` and identical args rejected before upstream; fixture receives precisely one `pending_model` call; only original model consumes `fixture_result_stdio_50665_5` |
| Normal non-Ash GUI direct | `zzzordinary` MCP succeeds for A; B direct remains denied |
| Registry failure | Ash turn admission unavailable; non-Ash GUI direct still succeeds |
| Live max frame | Above 1MiB closes the test connection with `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`; ordinary connections continue |
| Generation/restarts | Old connections invalidated; new proxy instance gets a fresh UUID; native restarts on the same temporary state with rotated credential, U/history retained |

The fixture's non-Ash server is named `zzzordinary` so the fixed Responses fixture selects namespace `mcp__probe` for the model Ash call. It never emits shell/file/network operations. The MCP tool's argument schema contains only the fixed synthetic nonce. Tool completion is proved from the native's actual `function_call_output` in the next mock input.

A separate fixed dynamic-tool thread exercises a real server RPC. Native id0 becomes `sr:9a5c647c-43de-4bf5-ac43-4c98a925c5a7:1:9` on its sole GUI owner connection. B sends both guessed native and downstream IDs and a forged item notification; neither enters native or settles the call. A's answer produces **only `correct_dynamic_owner`** in the next native mock input. A duplicate answer is rejected. Device does not receive the server request. Reconnected B cannot reuse the old response ID.

## Proxy boundary and bounded tests

The proxy distinguishes request/response/notification frames, rejects mixed method/result and unknown client notifications, and uses schema method sets for both directions. Client IDs retain string/number distinction and receive unique upstream IDs per connection. Server requests are deduplicated by native generation/id/method/coordinates, assigned to one GUI, and retired after response/disconnect so another GUI cannot acquire a delayed duplicate. No GUI owner means native waits; there is no automatic approval.

All eleven generated server-request families are routed in controlled WS fixture tests, including token refresh, attestation, current time, MCP elicitation, user input and legacy/new approval requests. These are fixed inert payloads, **not real login, attestation or approval compatibility tests**.

Bounds: 1MiB maxPayload, compression disabled, JSON depth24, per-connection client inflight32, global server pending32, startup queue2, queue-byte budget2MiB, retired server-request capacity128 per proxy instance. Queue budget overflow closes the connection; a controlled WS test proves an oversized queued notification is not forwarded. This is a deterministic budget test, not a sustained slow-GUI throughput certification. Outstanding state is dropped on close/generation change. Client/server IDs include a UUID instance, avoiding proxy-restart reuse. Native responses from an earlier request generation fail closed. Registry reload advances generation before dispatch and cannot proceed while server responses are pending.

Four initial boundary test groups passed before the d native run; the post-review baseline below has eight: strict framing/depth, policy/aliases/scopes/config overrides, independent upstream and all server-request families/duplicate answers/max frame/generation, and queue-byte overflow cleanup. Native token and model routing evidence comes from the live run above.

## Cleanup and deployment limits

The runner has a 120-second stop timer, bounded native startup/RPC/case waits, TERM/KILL cleanup for its own native, and closes owned proxy sockets/mock/stdio fixture children. Independent final checks confirm both native PIDs and all six stdio fixture PIDs stopped, no `.sock` entries remain, and mock/native ports return ECONNREFUSED. No process or tool session remains.

This establishes the **temporary R2 entry-point restriction**, changing the H1 experiment's direct result path from accepted to rejected before MCP receives it. It does not make metadata intrinsically signed. A production verifier must still bind actual native generation/registry, model MCP request/native item/tool/args/current WorkRef, and enforce grant/current fences and custody.

The registry and role authorities here are controlled fixtures; production needs protected manifest parsing, actual config watcher/ABA fencing, supervisor identity/state locks and transport integration, all separately reviewed. GUI config/plugin modifications are deliberately rejected wholesale in this first proxy rather than forwarded without a validated protected-registry transition; unregistered dynamic-tool overrides are rejected. Broader ordinary GUI configuration workflows must be added through a reviewed transition policy. Real GUI auth storage, account refresh, attestation, apps/plugins, launcher/reopen and upgrade behavior remain H2/switch-package work. There is no production advertising, installation, real shared-engine switch or user action in H3.

## Independent-review corrections (2026-10-10)

Three P2 findings were corrected in the same four owner files. These findings came from static/fixture review; no native exploitation of the previously reachable methods is claimed.

1. **Schema presence is no longer authorization.** `clientMethodPolicy` has an explicit small allowed map and defaults to deny, including future schema methods. The final actual 173-method schema report classifies 155 denied, 1 initialize, 4 control, 8 read, 1 registry refresh and 4 non-Ash-only MCP direct methods. Fork, settings updates, extra roots, config import, plugin reconciliation, filesystem writes, command/process execution and unreviewed lifecycle methods are denied. Parameters of admitted start/resume/read/turn methods have explicit allowed fields; toolOutput/config/path/modelProvider/runtime roots and arbitrary dynamic tools cannot pass. This narrows the study's GUI surface further; it does not claim full real GUI compatibility.
2. **Retirement capacity fails closed with guaranteed cleanup.** Retirement does not throw after marking a peer dead. Capacity exhaustion advances generation, terminates every upstream/downstream, drops pending/queued/request maps, keeps the existing bounded tombstones and permanently poisons the proxy instance against new upgrades. Tombstones are preserved across internal generation changes. There is no capacity-eviction path that allows old responses to be reused. The fixture exercises a lowered capacity of two, a third pending request and owner disconnect, verifying both peers closed, maps/queue empty, two tombstones retained and future upgrades rejected. Production recovery from this poisoned state requires explicit supervisor/native-generation policy, not recycling the same admission state.
3. **Queued and returned operations retain private leases.** Registry and role authorities must expose monotonic epoch ports. A queued request captures registry epoch, role epoch, connection generation and exact parameters/work; actual forward repeats authorization/current scope and checks the captured lease. Each native response repeats these checks, with another fence after serialization immediately before socket send. Registry/role revoke→restore cannot revive the old operation. Independent non-Ash GUI calls may begin while Ash registry readiness is false, but cannot revive an older epoch. Tests exercise queued registry ABA, role ABA, exact work removal, and a native response after registry ABA; zero stale payloads reach native/downstream.

All **eight** boundary tests pass. The same bounded native scenario was rerun once after the fixes without adding new probes. Final post-review evidence is `/tmp/ash-h3-proxy-isolation-20261010-reviewfix/report.json`, `events.jsonl`, `mcp.jsonl`; the earlier d report remains untouched as its historical baseline.

Post-review run started 2026-10-10T00:10:29.176Z. Same synthetic U before/after reload/restart: `01a12325-9bbb-7a21-91b0-d2986928d818`; mock/native ports 51180/51181; native PIDs54985/55051. It completed the same native authentication, owner-only server response, MCP/direct rejection, same-pending exclusive result, non-Ash compatibility, registry/generation and frame cases. Independent cleanup confirms both native PIDs and all six fixture PIDs stopped, no Unix sockets remain, and both ports return ECONNREFUSED. No real environment was used.

### Server-response lease completion

The remaining P2 on the GUI-to-native server-answer path is also closed. Each native server request now captures registry epoch and role epoch when its sole GUI owner is registered. Answer handling checks those epochs, current registry readiness, current role and connection/native-proxy generation; the send helper repeats the private `serverResponseFence` after serialization immediately before writing upstream. The ordinary fixture regression performs registry and role revoke→restore after a real fixture server request and verifies the old GUI answer never reaches native. **Nine boundary tests pass.** No additional native probes were run for this correction; the post-review native report above remains the historical scenario evidence.
