# H0 isolated bundled App Server evidence

2026-10-10 Asia/Shanghai. **Protocol observations completed; trusted connection ownership is disproven for the tested transport. Original desktop H2 and existing-thread tool attachment remain unproven.** This is a temporary synthetic process, not an Ash runner replacement for a desktop conversation.

## Reproduce

No install, login, real credentials, daemon connection, rollout copying, business tool execution or real configuration change is used.

```sh
node tools/research/material-host-isolation.mjs \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --case all --output /tmp/ash-h0-new-disposable-directory
node --test tools/research/material-host-isolation.test.mjs
```

Output must be a nonexistent directory. The runner creates mode-0700 state/home/config/project/cache/log directories. Its child environment is constructed from fixed constants, with temporary HOME/CODEX_HOME/XDG/TMPDIR and no inherited tokens, proxies or session variables. The macOS deny-default profile grants temporary state writes, required bundled/system runtime reads and only the allocated mock/RPC loopback ports. An OS-enforced selftest must pass before native startup; failure terminates the experiment. Responses emits only the fixed synthetic function call and fixed completion text, validates the fixture model/schema, and allows at most three requests per case. No model call to real shell/files/network tools is emitted.

Every RPC is on the test process's WebSockets with connection generations A1/B1, A2 and A3/B2. The raw events are synthetic and host name/installation identifiers are redacted. IDs returned by native are retained, never fabricated.

## Actual run

Authoritative output: `/tmp/ash-h0-isolation-20261010-g/report.json`, `/tmp/ash-h0-isolation-20261010-g/events.jsonl`, `manifest.json`, generated `schema/`, `logs/help.txt` and `sandbox.sb` in that directory. Start: 2026-10-09T22:27:34.438Z (Shanghai October 10).

| Evidence | Value |
| --- | --- |
| Bundled version | `codex-cli 0.162.0-alpha.17.2` |
| Launcher SHA-256 | `50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8` |
| Actual Mach-O SHA-256 | `0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28` |
| Sorted schema path/content SHA-256 | `8822b2ac74b727709098d0c32551cc07835207c31dbfe70a1ac5d002a3a03cff` |
| Native PIDs | 39611, then 39618 after controlled restart |
| Owned ports | Mock 56846, RPC 56847 |
| Native T | `01a122c7-638e-76f3-8f18-7bd42c789777` |
| Native U without tools | `01a122c7-6394-7f61-9356-0e55f526c921` |

The bundled `codex` path is a shell launcher for sibling `CodexCLI.app/Contents/MacOS/codex`; both hashes are recorded. Help confirms `--listen ws://IP:PORT`. Generated ThreadStartParams contains dynamicTools; ThreadResumeParams and ThreadSettingsUpdateParams do not.

Selftest proved temporary read/write and denial of the newly created external HOME sentinel with EPERM/EACCES. Allowed mock loopback connected. Another loopback listener (56848) and external 1.1.1.1:443 returned **EPERM**, rather than merely timing out. No real home contents were read. Sentinel was removed.

| Case | Tool request recipients | Actual observation |
| --- | --- | --- |
| Correct response | A1 | `correct_answer_call` returned `fixture result` into native's next model request; completed |
| Creator | A1 only | B1, never sent the request, answered RPC id 1; mock received `creator_call` / `wrong_connection_creator` |
| B read T | A1 only | B1 answered RPC id 3; mock consumed `wrong_connection_after_read` |
| B resume T | B1 and A1 | Broadcast request; first response from either connection consumed |
| Starter B | A1 and B1 | Broadcast, independent of turn starter |
| Pending disconnect | A1 closed; B1 live | Closed A1 output never consumed; B1 answered pending call and native continued |
| Reconnect | A2 and B1 | Both received; response from other connection consumed |
| Process restart | A3 only | Same native T resumed with persisted tool; B2 answered its request id 0 without receiving it |
| U before/after restart | No dynamic call | Same native U stayed tool-free; no new T/fork substituted for U |

Additional synthetic response metadata with wrong U/turn/call strings was ignored while the correct RPC id was accepted. The response schema does not require these metadata fields; this does not establish a metadata authentication facility. Unissued RPC ids did not settle the pending call. Duplicate replies after completion did not replace the recorded output. A closed WebSocket's Node `send` silently discarded rather than throwing; the evidence is `staleOutputConsumed:false`, not a claimed explicit server-side stale-auth rejection.

The decisive evidence is the **actual function_call_output included in the native request to the mock**, recorded by call_id and fixed output nonce. Seeing a client send or a turn complete alone is insufficient. The report retains model outputs from thread history, so earlier outputs can appear alongside the current case output.

These facts concern a same-localhost test App Server transport. They do not claim a public-network exploit. An A3 provider cannot treat receipt of item/tool/call, knowledge of RPC/native IDs, or read/resume as proof of exclusive authenticated invocation ownership.

## Isolation repairs and limits

Early selftest revisions failed closed. A precise read of root directory `(literal "/")` was necessary for dyld; it grants no user directory contents. Sandbox network filter syntax accepts `localhost:PORT`, not a numeric host in the profile. Native managed-preferences synchronization initially rejected thread/start even though both clients initialized; those runs contain zero ownership cases.

The final environment uses `CFFIXED_USER_HOME=<temporary home>` and `__CFPREFERENCES_AVOID_DAEMON=1`. This keeps CoreFoundation preference resolution in temporary state and avoids its user-preference daemon; no real user preference read/write rule was added. The [official macOS loader source](https://raw.githubusercontent.com/openai/codex/main/codex-rs/config/src/loader/macos.rs) identifies the synchronization error as CFPreferencesAppSynchronize; source inspection alone was not counted as a successful workaround. The final native run supplies the actual successful evidence.

Existing-thread attachment is **attachment_unproven**. Schema MCP/plugin lifecycle methods exist, but this experiment does not install a plugin or demonstrate a safe dynamic-tool registration mutation for U. Client-supplied MCP threadId does not prove trusted per-invocation metadata delivered to an MCP server. Formal host connector/bridge support and the original GUI/native-thread H2 remain required.

All cases have bounded RPC waits, native startups and shutdowns, with a 60-second overall stop timer. Cleanup stopped both owned PIDs and closed sockets/mock. Independent post-run checks saw ESRCH for both PIDs and ECONNREFUSED for mock/RPC ports. No listener or native process remains. Six independent runner/mock boundary tests pass. Exit 0 means observations completed, **not** secure ownership or H2 success; exit 1 is a fixture/native case failure, exit 2 is an isolation environment refusal.
