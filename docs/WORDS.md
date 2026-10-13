# 词清单

> 由 `tools/gen-words.mjs` 从 `packages/sdk/src/words.ts` 和 `namespaces.ts` 生成，不要手改。词契约 v4，ash-api/3，ASH_SDK 4，内容哈希 `2e9400915f6ec823`。
> 机器可读的完整契约（输入输出 JSON Schema）在 `packages/sdk/schema/words.json`。

表头：调用方 = 契约里的 `callers`（owner 主人、agent、app 应用、kernel 中枢自己）；effect / risk 见 SPEC-01 §6.2；输入里 `*` 是必填。`agent:*` 是每个已声明的 agent，`device:*`、`body:*` 是手和身体上的标准能力，`app:*` 是每个应用。

## 目录

- [`service:admin`](#serviceadmin) (12)
- [`service:health`](#servicehealth) (2)
- [`service:gate`](#servicegate) (17)
- [`service:vault`](#servicevault) (5)
- [`service:devices`](#servicedevices) (15)
- [`service:link`](#servicelink) (16)
- [`service:agents`](#serviceagents) (32)
- [`service:apps`](#serviceapps) (17)
- [`service:clock`](#serviceclock) (5)
- [`service:llm`](#servicellm) (4)
- [`service:persona`](#servicepersona) (2)
- [`service:widgets`](#servicewidgets) (13)
- [`service:pulse`](#servicepulse) (7)
- [`service:cost`](#servicecost) (4)
- [`service:reflex`](#servicereflex) (6)
- [`service:senses`](#servicesenses) (12)
- [`service:directory`](#servicedirectory) (2)
- [`service:history`](#servicehistory) (9)
- [`service:blobs`](#serviceblobs) (2)
- [`service:host`](#servicehost) (23)
- [`service:bodies`](#servicebodies) (4)
- [`person:owner`](#personowner) (8)
- [`agent:*`](#agent) (8)
- [`app:*`](#app) (1)
- [`device:*`](#device) (60)
- [`body:*`](#body) (10)

## 错误码

| 码 | 意思 |
|---|---|
| `bad_request` | The input is not in the right form. |
| `unauthorized` | The caller's identity was not proven. |
| `forbidden` | The caller is known but may not do this. |
| `not_found` | There is no such member, word or object. |
| `denied` | The gate or the owner refused. |
| `cancelled` | The request was cancelled. |
| `timeout` | No result by the deadline; it was certainly not done. |
| `offline` | The target is not connected; it was certainly not done. |
| `result_unknown` | The request went out but it is not known whether it was done. |
| `conflict` | The state does not allow it (same client_id with other content, already answered, stale reference). |
| `too_large` | Too large. |
| `unavailable` | The service cannot be used for now (vault locked, bridge busy, extension not connected). |
| `failed` | The target ran and failed. |
| `internal` | The hub itself failed. |

## `service:admin`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `pause` | owner | write / none | local_only | by | 在暂停 | Durably pause all activity (agent turns, timers that would wake an agent). Like resume, only the owner from a channel on this machine: `by` cites the one owner message that said stop. |
| `resume` | owner | write / none | local_only | confirmed* | 在恢复 | Resume after a pause. Only the owner can, from a channel on this machine, after an explicit confirmation. |
| `settings.get` | owner, agent, app | read / none | - | keys | 在看设置 | Read the hub's settings (all of them, or the named keys). Credentials are never part of the result. |
| `settings.set` | owner, agent, app | write / structure | - | - | 在改设置 | Change settings: the body is the keys to change and their new values. Agents asking for this are asked about by the owner. |
| `model.set` | owner, agent, app | write / structure | - | provider*, model* | 在换主模型 | Choose the main model (provider and model name) the hub's own agents run on; restart_required says whether an agent must be restarted for it to apply. |
| `plugins.list` | owner, agent, app | read / none | - | - | 在看插件 | List the plugins of the agent runtime and whether each is enabled. |
| `plugins.op` | owner, agent, app | write / structure | - | op*, name*, id*, enabled* | 在调整插件 | Enable or disable a plugin of the agent runtime. Plugins change what an agent can do, so an agent asking for this is asked about by the owner. |
| `status` | owner, agent, app | read / none | - | - | 在看系统状态 | The hub's state in a few facts: the time and time zone, whether activity is paused, the version, how long it has been up, how many agents and hands are online. |
| `logs` | owner | read / none | local_only | lines, level, since | 在看日志 | The tail of the hub's log file (default 200 lines, newest last; the lines carry no level or time yet, so level and since do not narrow them). Only the owner, from a channel on this machine: logs can hold things nobody else should see. |
| `checkup.changed` | kernel | read / none | event in | todo*, groups* | 在收手机的体检摘要 | A hand reports its checkup in counts: how many things need dealing with, and for each part of the phone its name, the count and a short phrase. No contents. Sent when the summary changes and when the hand connects; not recorded. |
| `checkup` | owner, agent, app | read / none | - | - | 在看手机的体检 | The last checkup summary the phone reported (how many things need dealing with, per part of the phone). known is false until a phone has reported. Use it when asked whether the phone's permissions and keep-alive switches are in order; the details are on the phone. |
| `settings.changed` | kernel | read / none | event out, record | keys*, by | 在记下设置改动 | A setting was changed (the key names, never the values). Goes into the ledger so that what changed, when and by whom can be found again. |

## `service:health`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `status` | owner, agent, app | read / none | - | window_s | 在看自己的运行状况 | How the hub is doing right now: message and ledger rates, the busiest words, process CPU and memory, event loop delay, and which behaviour budgets (idle traffic, ledger growth, reconnect storms, errors) are kept or broken. Use it when asked why Ash is slow, busy or heating the phone. It counts words and callers, never contents. |
| `recent` | owner, agent, app | read / none | - | since, limit, kind | 在翻运行记录 | The health history: budget breaches and starts (kind event, default) or one summary per minute for up to seven days (kind minute), newest first. Use it to find out when something started misbehaving and which word did it. |

## `service:gate`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `rules.list` | owner, agent, app | read / none | - | before, limit | 在看审批规则 | Inspect the current approval rules (who may use which capability without asking, until when) and the approval mode. Do not assume a risky action is already allowed. |
| `rules.set` | owner, agent | write / structure | - | agent*, member*, word*, target, days | 在申请新增审批规则 | Allow one agent to use one outside capability without asking, for up to 30 days, optionally only for one target (site:<host>, a calendar id, a recipient id, browse). The owner is always asked when an agent requests it. |
| `rules.revoke` | owner, agent | write / structure | - | id* | 在申请撤销审批规则 | Remove a known approval rule. It changes future decisions, not past actions. The owner is always asked when an agent requests it. |
| `mode.set` | owner, agent | write / structure | - | mode* | 在申请改审批档位 | Switch the approval mode: auto asks only when an outside action needs it; always asks about every outside action that is not a read. The owner is always asked when an agent requests it. |
| `audit` | owner, agent, app | read / none | - | request_id, requester, word, decision, before, limit | 在查审批记录 | Approval evidence, newest first: what was asked, the facts the reviewer saw and its verdict, the card shown, the owner's answer, and whether the action then ran. |
| `history` | owner, agent, app | read / none | - | before, limit | 在查审批记录 | Review earlier gate decisions (who asked for what and how it was decided). Read only. |
| `pending.list` | agent | read / none | - | - | 在核对待回复的事 | The requests you made that are waiting for the owner or have been answered and not yet acted on. Only the agent that made a request sees it. |
| `pending.get` | agent | read / none | - | id* | 在看原问题与回答 | One pending request of yours: the original request, its state and the owner's answer. Use it before redeeming, to be sure the action is still wanted. |
| `pending.redeem` | agent | act / none | - | id* | 在执行你批准的事 | Carry out a request the owner approved: the original request is sent again and, this time, passes the gate as approved. Works once, only for the agent that made it, in its own turn. |
| `pending.skip` | agent | write / none | - | id*, reason | 在说明为何不再继续 | Say that you will not carry out a request that was answered, for example because it is no longer wanted. The owner is told. |
| `pending.withdraw` | agent | write / none | - | id* | 在撤回问题 | Withdraw a question or approval request you made, while it is still waiting; the owner's card is taken down. |
| `lease.request` | agent | write / none | - | minutes, goal* | 在申请操作屏幕 | Ask the owner to lend you the real phone screen for a while (taps, typing, scrolling, opening an app or a link, keys): the screen words are refused until the owner says yes. Say what for in goal; minutes is how long you need (default 15, the owner may give 'this task' or 1 hour instead). It does not wait: the owner's answer comes as their own message in the conversation. Do not ask again while one is waiting. |
| `lease.status` | agent | read / none | - | - | 在看屏幕授权 | Your screen lease now: when it ends, or null (and whether a request is waiting for the owner). |
| `lease.release` | agent | write / none | - | - | 在交还屏幕 | Hand the screen back when your work on it is done, so the owner's lease ends at once. |
| `lease.revoke` | owner | write / none | - | id | 在收回屏幕授权 | The owner takes the screen lease back (one by id, else every one): the agent is stopped and told. |
| `lease.list` | owner | read / none | - | - | 在看屏幕授权 | The screen leases in force now. |
| `lease.state` | kernel | read / none | event out | leases* | 在转达屏幕授权 | The screen leases changed (or, at most once a second, the agent just operated the screen: last_action_at): the whole list for the owner's screens (the human edge pushes it as present{status/lease}; a channel that just connected gets service:gate/lease.list). |

## `service:vault`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent, app | read / none | - | - | 在看保存的密钥 | Which credentials are saved (names and kinds only, never a value). |
| `describe` | owner, agent, app | read / none | - | ref* | 在看保存的密钥 | Whether one credential is saved, and what it is for. A value is never returned. |
| `set` | owner | write / structure | local_only | ref*, value* (secret), label, kind | 在保存密钥 | Save a credential in the vault. Only the owner, from a channel on this machine; the value is held sealed and never reaches the ledger or an agent. |
| `delete` | owner | write / structure | local_only | ref* | 在删除密钥 | Delete a saved credential. Only the owner, from a channel on this machine. |
| `vault.changed` | kernel | read / none | event out | ref*, action* | 在记下密钥变化 | A credential was saved or removed. Names only; the value is never on the ledger. The agents module listens to configure the runtime's own credentials. |

## `service:devices`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent, app | read / none | - | - | 在看已连接设备 | Every hand the hub knows: name, kind, whether online, what the owner allowed it (lend capabilities, serve as a body, run local agents, web chat) and its tier. |
| `describe` | owner, agent, app | read / none | - | device* | 在看设备详情 | One hand in detail: how it connects, what it was allowed, when it was last seen. |
| `pair_start` | owner, agent, app | act / none | - | kind, name | 在开始设备配对 | Start pairing a new computer or browser. The pairing code is shown only to the owner; you get a pair_id and, as the pairing moves on, a background message. Use pair_status to look. |
| `pair_status` | owner, agent, app | read / none | - | pair_id* | 在看配对进展 | Where a pairing is: waiting for the code, requested (the owner is asked), approved, connected, rejected or expired. |
| `pair_pending` | owner, agent, app | read / none | - | - | 在看配对申请 | The pairing requests that are waiting for the owner's decision. |
| `pair_approve` | owner, agent, app | write / structure | - | pair_id*, name, tier, lend, body, local_agents, web_ui | 在批准设备配对 | Approve a pairing request, with what the new hand may do: lend capabilities, serve as a body, run local agents, web chat; and its tier. An agent asking for this is always asked about by the owner. |
| `pair_reject` | owner, agent, app | write / structure | - | pair_id* | 在拒绝设备配对 | Reject a pairing request. |
| `revoke` | owner, agent, app | write / structure | - | device* | 在断开并撤销设备 | Disconnect a hand and revoke it: it can no longer connect, and its capabilities and body go away. An agent asking for this is always asked about by the owner. |
| `restore` | owner | write / structure | - | device* | 在恢复已撤销的设备 | Let a revoked hand pair again, with the permissions it had. Only the owner. |
| `rename` | owner, agent, app | write / structure | - | device*, name* | 在修改设备名称 | Change the name a hand is shown with. |
| `access_set` | owner, agent, app | write / structure | - | device*, tier, lend, body, local_agents, web_ui | 在调整设备权限 | Change what a hand may do (lend capabilities, serve as a body, run local agents, web chat) and its tier (ask, full). An agent asking for this is always asked about by the owner. |
| `update` | owner, agent, app | write / structure | - | device*, version*, sha256* | 在更新设备程序 | Have a computer update its Ash program to the given version (checked against sha256). Approved here once; the update itself is then run by the hub. An agent asking for this is always asked about by the owner. |
| `pair_code` | owner | read / none | local_only | pair_id* | 在看配对码 | Show the pairing code of a pairing the owner started, with the address to open on the new computer. Only the owner, from a channel on this machine. |
| `pair.changed` | kernel | read / none | event out, record | pair_id*, state*, device | 在记下配对进展 | A pairing moved on (requested, approved, rejected, connected, expired). The one who started it is told by a background message. |
| `config.changed` | kernel | read / none | event in | item*, state* | 在记下手机设置变化 | A hand reports that one of its own permissions or switches changed (config.*). Sent by the hands module; not recorded. |

## `service:link`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent | read / none | - | - | 在看当前连接 | Every live connection: which hand, which channels are open (device, human, agent), local or through the relay, since when, heartbeat delay. |
| `describe` | owner, agent | read / none | - | hand, conn | 在看连接详情 | One connection in detail: each channel's state, calls in flight, the latest disconnect and its reason code. Give hand or conn. |
| `diagnose` | owner, agent | read / none | - | hand | 在检查连接 | A health check: is the relay reachable, the state of each tunnel, the latest handshake failures with what their codes mean, clock difference, whether a capability list was refused. |
| `disconnect` | owner, agent | act / outward | - | conn*, reason | 在断开连接 | Close one connection. The hand may reconnect by itself unless it was revoked. |
| `reconnect` | owner, agent | act / none | - | hand* | 在重连 | Ask the relay to open the tunnel again, or tell a local hand to reconnect. |
| `refresh_manifest` | owner, agent | act / none | - | hand* | 在请手重发能力清单 | Ask a hand to send its capability list again, for example after you changed what it may lend. |
| `gateway.status` | owner, agent | read / none | - | - | 在看中转站 | The relay: whether there is one, its address, whether it is claimed by this hub, whether the hub is connected to it, the latest error, and (setup_unavailable) why building a relay is not possible in this build. |
| `gateway.setup.start` | owner, agent | act / none | - | provider* | 在开始搭中转站 | Start building a relay in the owner's Cloudflare account: a 'sign in to Cloudflare' card goes to the owner. You get a setup_id and a background message at each step. |
| `gateway.setup.status` | owner, agent | read / none | - | setup_id* | 在看中转站搭建进展 | Where a relay setup is: waiting_login, authorized, deploying, claimed, connected, or failed with the reason. Once authorized it lists the Cloudflare accounts the owner's sign-in can build in (id and name). |
| `gateway.setup.deploy` | owner, agent | write / structure | - | setup_id*, name, account | 在部署中转站 | Deploy the relay in the owner's account, claim it and connect. When the sign-in sees more than one Cloudflare account, `account` (an id from gateway.setup.status) is required: Ash never picks one. Ash does not write over a Worker it did not build: a name that is taken is refused; without a name one is made (ash-relay-xxxxxx). An agent asking for this is asked about by the owner. |
| `gateway.setup.cancel` | owner, agent | act / none | - | setup_id* | 在取消搭中转站 | Cancel a relay setup that is not finished. |
| `gateway.use` | owner, agent | write / structure | - | url* | 在改用中转站 | Use an existing relay at this address instead of building one. An agent asking for this is asked about by the owner. |
| `connected` | kernel | read / none | event out, record | hand*, conn*, channels | 在记下设备连上 | A hand finished the handshake and is connected. Goes into the ledger. |
| `disconnected` | kernel | read / none | event out, record | hand*, conn, channel, code, reason | 在记下设备断开 | A hand's connection closed, with the close code and reason. Goes into the ledger. |
| `handshake_failed` | kernel | read / none | event out | hand, conn, channel, code*, reason | 在记下握手失败 | A connection attempt failed the handshake (4001 identity, 4003 revoked, 4008 version, ...). Not recorded; service:link/diagnose reports the recent ones. |
| `env.changed` | kernel | read / none | event in | what*, network*, online*, saver* | 在处理网络变化 | The host reports that the network or the power state changed (what: network with the proxy and whether the device is online, or power with whether it is in power-saving mode); the link layer reconnects the relay. Sent by the host module; not recorded. |

## `service:agents`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent, app | read / none | - | - | 在看有哪些帮手 | Every declared agent: id, name, what it does, whether it is idle, working or stopped, and which one is primary. |
| `runtimes` | owner, agent, app | read / none | - | - | 在查能在哪儿开帮手 | The agent runtimes available (in the main body, and on computers allowed to host agents) with their models. Query before declaring an agent that runs on a computer. |
| `threads` | owner | read / none | - | - | 在看交出去的事 | The delegated work in flight (threads between agents). |
| `thread.stop` | owner | act / none | - | thread* | 在停下交出去的事 | Stop one delegated thread of work. |
| `describe` | owner, agent, app | read / none | - | agent* | 在看帮手 | One agent's declaration (role, tools, lanes, modules, where it lives) and its state. |
| `ask` | owner, agent, app | act / none | timeout 600s | agent*, text* | 在问帮手 | Put a question to another agent; the answer it gives in the turn that takes the question is the result. |
| `tell` | owner, agent, app | act / none | - | agent*, text* | 在告诉帮手 | Deliver news to another agent; what it says back is passed to the sender later as a message. |
| `answer` | agent | act / none | - | in_reply_to*, text* | 在回答 | An agent's words in a turn that answers a question or news delivered to it. Only the agent that was asked, in that turn. |
| `declare` | owner, agent, app | write / none | - | id*, name*, summary*, brief*, runtime, native, tools, words, lanes, modules, primary | 在新建帮手 | Declare a new agent: who it is, its role (brief), its tools and word policy, its lanes, which prompt modules it loads, and where it runs (native). It starts at once in its own session. Delegation rule: when the caller is not the owner, the tools and words you give the agent must be a subset of the tools and words you have yourself; anything beyond that is refused with forbidden. This is not a question to the owner. Delegation goes at most three levels deep. |
| `update` | owner, agent, app | write / none | - | agent*, name, summary, brief, runtime, native, tools, words, lanes, modules, primary | 在调整帮手 | Change an agent's declaration; it applies from its next turn. `primary` can be handed to another agent only through primary.set. The lasting way to choose an agent's model: `runtime` is a patch laid over the declared one: `kind` may be left out, `model` is `provider/model` (see runtime.catalog), `effort` is the thinking effort of that model, and `models` holds settings per model that apply whenever that model is in use (merged model by model; null forgets one). Examples: `runtime: {kind: "pi", model: "deepseek/deepseek-flash"}` switches the agent to the pi runtime; `runtime: {model: "openai-codex/gpt-5.5", models: {"openai-codex/gpt-5.5": {effort: "high"}, "deepseek/deepseek-flash": {effort: "low"}}}` changes the model and gives each model its own effort. A model or effort the runtime does not know is refused with the list to choose from. The result's `notes` say what is still missing for the choice to work (a key, a login). On the pi runtime a change of model or settings is taken from the next turn without a restart; a change of runtime kind restarts the agent. Delegation rule: when the caller is not the owner, the tools and words you give the agent must be a subset of the tools and words you have yourself; anything beyond that is refused with forbidden. This is not a question to the owner. Delegation goes at most three levels deep. |
| `runtime.catalog` | owner, agent, app | read / none | - | agent*, provider, search | 在查能用的模型 | Which providers and models an agent's runtime can use, and whether each is usable now: for every provider its `ready` flag, what it needs (`auth`: a key in the vault, or a login), `how` to make it ready when it is not (including what to ask the owner), and its models with context length, image and reasoning support and the `efforts` each takes. Also `saved` (the lasting settings in the declaration) and `effective` (what is in force now, which a temporary configure or a fallback can make differ), and `catalog`: how new the model lists are (`checked_at`: when upstream was last asked; `upstream_at`: the date of the newest list received; `refreshing`: a refresh is under way). The lists keep up with upstream by themselves, about once a day, and a stale one is refreshed in the background when you read it; when upstream cannot be reached the last lists are used without any error. A provider with many models lists none until you ask for it with `provider`; `search` keeps the models whose id or name contains the text. Read this before choosing a model with update, and again after the owner has logged in or saved a key. |
| `start` | owner, agent, app | act / none | - | agent* | 在启动帮手 | Let a stopped agent take turns again. |
| `stop` | owner, agent, app | act / none | - | agent* | 在停下帮手 | Stop an agent: its current turn is cancelled and it leaves the registry, so words sent to it answer offline until it starts again. Only the owner can stop the primary agent. |
| `restart` | owner, agent, app | act / none | - | agent* | 在重启帮手 | Cancel an agent's current turn and restart its process; its sessions are resumed. |
| `remove` | owner, agent, app | write / none | - | agent* | 在删除帮手 | Remove a declared agent. The primary agent cannot be removed; hand `primary` to another one first. |
| `primary.set` | owner | write / structure | - | agent* | 在换主 agent | Make another agent the primary one: the owner's words, the notification and island replies, and the semantic layer's wake-ups go to it. Only the owner. |
| `spawn` | owner, agent, app | act / none | timeout 600s | task*, template, runtime, model, native, tools, timeout | 在派临时帮手 | Run one task on a temporary agent: declare it, hand it the task, collect the result and delete it, in one step. A quick result is returned, a slow one as a receipt. It can never do more than you can. Delegation rule: when the caller is not the owner, the tools and words you give the agent must be a subset of the tools and words you have yourself; anything beyond that is refused with forbidden. This is not a question to the owner. Delegation goes at most three levels deep. |
| `session.get` | owner, agent, app | read / none | - | agent*, key* | 在看会话 | Which resumable session an agent holds for a lane (the opaque handle the driver gave), or null. |
| `session.set` | owner, agent, app | write / none | - | agent*, key*, handle* | 在指定会话 | Point a lane of an agent at a given session handle so the next turn resumes it; with no handle the lane starts fresh. |
| `session.new` | owner, agent, app | act / none | - | agent*, key* | 在开新会话 | Open a new session for a lane of an agent. The old one is kept in the agent's own history; the ledger still has everything that was said. |
| `session.reload` | owner, agent, app | act / none | - | agent*, key* | 在重新载入会话 | Open a new session with the current static prompt modules (persona, rules). Done only when the agent is idle; skipped if nothing changed. |
| `session.compact` | owner, agent, app | act / none | - | agent*, key* | 在压缩上下文 | Compact the context of a lane's session, when the agent is idle. If it is busy the answer is conflict and the hub tries again after the turn. |
| `session.send` | owner, agent, app | act / none | - | agent*, key*, messages* | 在发起一轮 | Send messages to an idle agent and open a turn on a lane. |
| `session.followup` | owner, agent, app | act / none | - | agent*, key*, messages* | 在排下一轮 | Queue messages for the agent's next turn on a lane, without interrupting the one running. |
| `session.steer` | owner, agent, app | act / none | - | agent*, key*, text* | 在插话 | Say something into the turn that is running on a lane, so the agent takes it into account now. |
| `session.inject` | owner, agent, app | act / none | - | agent*, key*, modules, text | 在注入内容 | Put content into a lane's session without starting a turn: named prompt modules, or plain text. |
| `session.interrupt` | owner, agent, app | act / none | - | agent*, key* | 在打断这一轮 | Stop the turn that is running on a lane. |
| `session.restart` | owner, agent, app | act / none | - | agent*, key | 在重启会话进程 | Restart the agent's process and resume its sessions (one lane, or all when key is left out). |
| `configure` | owner, agent, app | write / none | - | agent*, key, config | 在配置帮手 | Set the runtime's own configuration for an agent (model, effort level, other options the runtime reports it supports), or read it when config is left out. This is the temporary way: it changes what is in force now and is forgotten when the hub restarts; the lasting way is `update` with `runtime`. On the pi runtime: `config: {model: "deepseek/deepseek-flash", effort: "high"}` takes effect from the next turn; `config: {login: "openai-codex"}` starts Codex's browser login (pi's standard one) and returns {url} (the owner opens it in the phone's browser, with the phone's VPN on, and signs in; the browser comes back to the phone itself and you are told when it is done). The read-back gives `effective` (in force now: model, effort, whether it fell back to DeepSeek and why, the route to the model, the login state) and `saved` (the declaration's lasting settings). |
| `plugins` | owner, agent, app | write / structure | - | agent*, key, op*, name | 在调整帮手的插件 | List, enable or disable the plugins of one agent's runtime. Plugins change what the agent can do, so an agent asking for this is asked about by the owner. |
| `env.changed` | kernel | read / none | event in | what*, network*, online*, saver* | 在处理网络变化 | The host reports that the network or the power state changed (what: network with the proxy and whether the device is online, or power with whether it is in power-saving mode); when the proxy is a different one, the agents module restarts at once the agents running on this phone (they are told the turn was cut off; their waiting messages go to the new process). Sent by the host module; not recorded. |
| `usage.recorded` | kernel | read / none | event out | caller*, provider*, model*, input_tokens*, output_tokens*, cache_read_tokens, cost, ok*, at* | 在记下用量 | An agent driver's model usage, passed to service:cost. |

## `service:apps`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `apps.list` | owner, agent, app | read / none | - | - | 在看有哪些应用 | Every app found in the container (/root/apps/<id>/app.json): name, version, whether the owner installed (granted) it and whether it is running. An installed app whose folder is gone is listed too (error says so); apps.remove or apps.revoke clears it. |
| `apps.describe` | owner, agent, app | read / none | - | id* | 在看应用详情 | One app: what it needs from ash (needs), its screens (surfaces), events and tools. |
| `apps.install` | owner, agent, app | execute / structure | - | id* | 在安装应用 | Install an app from /root/apps/<id>/ (ash's own, or one you wrote): it is checked first as apps.validate does, and a failing app is refused with the problems (error.detail.problems) before anyone is asked. Then the owner approves, on one card, everything it needs (needs); an app you wrote is shown as written by you, not published. Then its grants are stored and it starts as member app:<id>. Installing again after editing restarts it with the new files. |
| `apps.enable` | owner, agent, app | execute / structure | - | id* | 在重新启用应用 | Start an installed app that was turned off, within the grants the owner already gave. An agent's request asks the owner. |
| `apps.disable` | owner, agent, app | write / structure | - | id* | 在停用应用 | Stop an app; its grants are kept so it can be turned on again. |
| `apps.revoke` | owner, agent, app | write / structure | - | id*, need | 在收回应用的权限 | Take back one need (need: a member id such as device:<hand_id>, or notify / widgets / card), or every grant when need is left out, which stops the app. Works on an installed app whose folder is gone too. |
| `apps.refresh` | owner, agent, app | read / none | - | - | 在查找新应用 | Read /root/apps again: new apps appear, removed ones stop. |
| `apps.badge` | app | write / none | - | tone* | 在亮应用的小点 | An app says how it is, for the dot on its icon in the app grid: ok (no dot), warn, err or paused. Only about itself; it shows while the app runs and is asked again by the app when it starts. |
| `apps.restart` | owner, agent, app | act / none | - | id* | 在重启应用 | Restart an installed app's server so edits to its files (server.mjs, tools, app.json cards) take effect. It is checked first as apps.validate does: a failing app is not restarted and the problems come back (error.detail.problems). If app.json's needs changed, use apps.install instead (the owner approves them). Pages need no restart. |
| `apps.logs` | owner, agent, app | read / none | - | id*, lines | 在看应用日志 | An app's recent output: what its server wrote to stderr, protocol errors (anything but MCP on stdout), and Ash's notes on starts, exits and restarts (newest last, default 100 lines, at most 400). last_exit says how the server last ended (exit code or signal); error is why it is not running, if Ash knows. |
| `apps.reset` | owner, agent, app | write / none | - | id* | 在清空应用数据 | Empty the app's data folder (app.json data_dir, e.g. /root/apps/<id>/data) and restart it, so it starts over with no data; its cards redraw. Only for an app that declares data_dir. The owner's data is gone afterwards: do it only when the owner wants it, or for an app you are still building. |
| `apps.remove` | owner, agent, app | write / none | - | id*, keep_data | 在卸载应用 | Uninstall an app: stop it, drop everything the owner granted it and its home-screen cards, and delete its folder /root/apps/<id>/. keep_data: true keeps the folder (its data and files) so it can be installed again as it was. Ash's own apps cannot be removed (they come back): disable them instead. An installed app whose folder is already gone is removed from the records (and its timers cleared); there is no folder to delete. |
| `apps.contract` | owner, agent, app | read / none | - | - | 在看应用契约 | The ash-app/1 contract for writing an app, in full (doc, markdown): app.json fields, how ash starts the server and talks to it, pages (ui:// resources), tools, needs, events, listens. Also the app.json JSON Schema and a small runnable example app (hello: a list with one page and four tools, the same skeleton apps.scaffold writes) with its files. The same doc and example are in the container at doc_path and example.path. |
| `apps.scaffold` | owner, agent, app | write / none | - | id*, name*, summary, role, surfaces, tools | 在写应用骨架 | Write a new app's skeleton into /root/apps/<id>/ (app.json, a dependency-free server.mjs, one ui/<page>.html per surface, shared ui/app.css and ui/app.js, an empty data/ folder). It runs as it is: a small working list in data/data.json with tools <id>.list, <id>.add, <id>.done (mark done/undone), <id>.remove, and a first page with the list and done/undone toggles. Change them to what the app is about; tools you name besides those answer with a placeholder until you write them in server.mjs. role (default: summary) says what the app is for and when to use it; you and Ash see it in every conversation. surfaces default to one page home: give the app tools that read and change its data, so you can do through them everything the owner does on its pages. Refuses a folder that already has an app.json. No approval is needed: it only writes files. Then edit, apps.validate, and apps.install (the owner approves what it needs). |
| `apps.validate` | owner, agent, app | read / none | - | id, path | 在检查应用 | Check an app folder the way install will: app.json against the contract (each missing or wrong field by its path), the icon file, then a trial start of its server (it must start and speak MCP over stdio), its tools (names, input schemas) and every page (each surface's ui:// resource must be served as HTML). Give id (the folder /root/apps/<id>) or path (/root/apps/<folder>). ok is true when nothing would stop it from installing and opening; warnings are worth fixing but do not block. Nothing is installed or changed. |
| `apps.surface` | owner, agent, app | read / none | - | id*, surface* | 在取应用页面 | The page resource of one of an app's surfaces (the ui:// resource its app.json lists), for a channel to show; csp lists the domains the page declared it may connect to and load from. Pages talk to the app through the bridge, not through this word. |
| `apps.icon` | owner, agent, app | read / none | - | id* | 在取应用图标 | The icon file of an app (base64 in data), for a channel to show in its list of apps. An app with no icon, or whose icon file is gone, gets Ash's default PNG icon instead of an error. |

## `service:clock`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `set` | owner, agent, app | write / none | - | at, every, to*, word*, body*, label* | 在定提醒 | Set a timer that sends a word to a member at a time (at, Unix ms) or repeatedly (every, seconds, at least 60). Use for a future or repeating message, not for immediate delivery. Keep the returned id to cancel it. |
| `cancel` | owner, agent, app | write / none | - | id* | 在取消提醒 | Cancel a timer by id; check `cancelled` because it may already have fired. `inflight: true` (with `cancelled: true`) means a one-time timer's send was already on its way when you cancelled: that send is not taken back and is delivered if it succeeds; cancelling only stops it from being put back and sent again if it is refused. |
| `cancel.owner` | kernel | write / none | - | member* | 在清理已删成员的提醒 | Internal: take back every timer the given member set, and tell how many there were. The agents module calls it when it deletes an agent, and the apps module when an app is removed or loses all its grants, so their timers do not go on firing as a member that no longer exists. The hub itself calls this; nobody else. |
| `list` | owner, agent, app | read / none | - | - | 在看提醒 | The active timers, to look at before changing them; the result is a snapshot. An agent or an app sees the timers it set; the owner sees all. |
| `wake.fired` | kernel | read / none | event in | at* | 在响应唤醒闹钟 | The host's alarm went off (the device woke); the clock checks which timers are due. Sent by the host module. |

## `service:llm`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `complete` | owner, agent, app | read / none | timeout 60s | model, messages*, max_tokens | 在问小模型 | A short completion from the hub's small model (the model argument is optional). For organs that must judge something in code, e.g. a sensor rule. The usage is counted against the caller and its quota. |
| `keys.status` | owner, agent | read / none | - | - | 在看模型密钥是否可用 | Whether each model key (DeepSeek for the conversation model, OpenRouter for the quick judgement) is saved and whether its provider accepts it: status ok, rejected (the key itself is refused: reason says why, such as expired; ask the owner for a new key), low_balance (accepted, but the account has no balance left, so calls fail; the owner tops up) or unknown (not checked yet or unreachable). Never the key. Use this when the model or quick judgement seems not to work. |
| `keys.check` | owner, agent | read / none | timeout 30s | provider | 在验证模型密钥 | Ask the provider now whether a model key is accepted (one provider, or both when left out) with a free authenticated request that costs nothing, and return the same as keys.status. A key saved in the vault is checked automatically; use this to check again (an agent asking again within 30 seconds gets the last answer). |
| `usage.recorded` | kernel | read / none | event out | caller*, provider*, model*, input_tokens*, output_tokens*, cache_read_tokens, cost, ok*, at* | 在记下用量 | One call of the hub's small model (the approval review, JEV, the progress summary, service:llm/complete), passed to service:cost under the caller's name. |

## `service:persona`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `get` | owner, agent, app | read / none | - | file | 在看人格 | The approved versions of SOUL.md and IDENTITY.md, the only ones sessions load. Editing the files in the body changes nothing until a change is proposed and approved. |
| `propose` | owner, agent | write / structure | - | file*, content*, reason* | 在提议改人格 | Propose a new SOUL.md or IDENTITY.md with the reason. The owner is always asked when an agent proposes; a change the owner makes takes effect at once. It shows in new sessions after the next reload. |

## `service:widgets`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `widget.list` | owner, agent, app | read / none | - | - | 在看桌面小组件 | What is on the owner's phone home screen: each placed widget (the 'ash' widget, or an 'Ash 卡片' card widget with the card it shows), and every card that exists with its owner, size, expiry, event action names and the phone's last problem drawing it (null when it drew fine or has not reported). |
| `widget.card.put` | owner, agent, app | write / none | - | id*, title*, size*, a2ui*, ttl_min | 在更新桌面卡片 | Create or replace (same id) a card the owner can place on the phone home screen with the 'Ash 卡片' widget; widgets already showing it redraw. When the data belongs to an app (a todo list, health numbers…), use that app's own card instead (owner app:<id> in widget.list, drawn from the app's data and kept current; the owner places it on the home screen) — a copy of its data here goes stale. id: lowercase letters, digits, . _ - (at most 64); title: at most 40 characters. The card belongs to whoever created it: only its creator or the owner may replace or remove it. size is the intended widget size (2x2 small, 4x2 wide, 4x4 large). ttl_min: after this many minutes the card shows as expired until updated. Invalid cards are refused with the component, property and reason. The result says whether the phone drew it (phone: drawn), could not (phone: problem, with problem), or did not answer in time (unknown); a later problem (e.g. an image that failed to load) reaches you as widget.problem. When the phone can draw it, the result also carries a preview image of the card as the home screen shows it (at the widget's size, in the phone's current dark or light theme): look at it, and fix cut-off text, overflow and empty lists before telling the owner it is done. widget.card.preview shows it again later. a2ui is A2UI v0.9 (basic catalog) as a flat component list: {components:[{id, component, ...}], root?:'root', data?:{...}, sizes?, theme?:{primaryColor}}. Anything Android widgets can draw is allowed; what they cannot is refused with the reason. No limit on nesting style, number of buttons or text lines except Android's own (about 10 nested levels; a scrolling List's items get their own budget). Components: Text {text, variant: h1..h5\|body\|caption} — text keeps line breaks and emoji, and simple Markdown (**bold**, *italic*, `code`, ~~strike~~, [link](url), # heading, - list) is drawn as formatting, never shown raw. Row/Column {children, justify: start\|center\|end\|spaceBetween\|spaceAround\|spaceEvenly\|stretch, align: start\|center\|end\|stretch}; Stack {children, align} (children overlap; a child's style.place: topStart..bottomEnd); Grid {children, columns}; Card {child}; List {children, columns?} scrolls vertically when longer than the widget (horizontal lists are impossible; at most 16 Lists per layout); Tabs {tabs:[{title, child}], selected?} (switches on the phone); Spacer {size?} (flexible when no size); Divider {axis}; Image {url, fit: contain\|cover\|fill\|none\|scaleDown, variant: icon\|avatar\|smallFeature\|mediumFeature\|largeFeature\|header} with url https://… or data:image/png\|jpeg\|webp\|gif;base64,… (the phone fetches, downsizes and caches; no SVG), 'avatar' / 'avatar:<face>' (Ash), 'icon:<name>'; Icon {name: an A2UI icon name (check, close, star, favorite, home, settings, refresh, add, delete, edit, mail, phone, person, search, share, warning, info, …) or Ash's sun, cloud, rain, snow, wind, moon, heart, steps, weight, sleep, water, fire, calendar, clock, alert, bell, car, money, chart; or {svgPath}}; Button {child: any component id, variant: default\|primary\|borderless, action}; CheckBox / Switch {label, value: bool or {path}}; ChoicePicker {options:[{label, value}], value:[...] or {path}, variant: mutuallyExclusive\|multipleSelection, displayStyle: checkbox\|chips}; ProgressBar {value, max?: 100, label?}; Badge {text}; Clock {format?, timeZone?} (live); Timer {since \| until: epoch ms} (live count up/down); Chart {series:[1-4 of {type: line\|bars, values: 1-240 numbers, color, fill?, width?, dot?, max?, floor?, highlight?: {from, to?, color}, colors?: {"<bar index>": colour}, lastColor?, limit?, limitColor?}], gap?} (at most 600 values; style.height in dp is required; the phone draws it as a bitmap of the size it is given, in the colours of the phone's mode). Not drawable in a widget (refused): Video, AudioPlayer, TextField, DateTimeInput, Slider, Modal, web pages, scripts, animation. Every component may have: weight (share of the free space in a Row/Column), visible (bool or {path}), accessibility {label}, action, and style {background, color (text/icon/tint; inherited by children), cornerRadius, padding, margin, width, height (dp \| 'fill' \| 'wrap'), fontSize (sp), fontWeight (normal\|medium\|bold\|100-900), italic, underline, strikethrough, textAlign, maxLines, ellipsize (end\|start\|middle\|none), lineHeight, letterSpacing, opacity}. Colours: '#RRGGBB', '#RRGGBBAA' (alpha last, e.g. '#000000B3' translucent dark), theme names text, textSecondary, accent, onAccent, background, surface, surfaceVariant, line, transparent, translucentDark, translucentLight, white, black, red, orange, yellow, green, teal, blue, purple, pink, gray (these follow the phone's dark mode), or {light, dark}. A background on the root replaces the widget's own background (and its title). Actions (any element; in a List each item is tappable): {event:{name, context?}} — sent back to you as widget.action with the item key, checked state or chosen values; {openApp:{app, surface?}} or {functionCall:{call:'openUrl', args:{url:'ui://<app>/<surface>'}}} — opens that app's page in 「Ash 应用」; {openAsh:{}}; openUrl with https/mailto/tel/geo. A CheckBox/Switch/ChoicePicker whose value is {path} writes the owner's choice back into the card's data. Values may be literals, {path:'/a/b'} into data (relative paths inside templates), or A2UI functions {call: formatString ('${/a} ${b}') \| formatNumber \| formatCurrency \| formatDate \| pluralize \| and \| or \| not, args}. children may be a template {componentId, path:'/items'}: one copy per array element, with paths relative to the element (its id or key field is the item key in widget.action). sizes: [{width, height (dp), root}] gives other layouts for other widget sizes. Example: {components:[{id:'root',component:'Column',style:{background:'translucentDark',color:'white',padding:14},children:['t','l']},{id:'t',component:'Text',text:'**待办**',variant:'h3'},{id:'l',component:'List',children:{componentId:'row',path:'/todo'}},{id:'row',component:'CheckBox',label:{path:'title'},value:{path:'done'},action:{event:{name:'toggle'}}}],data:{todo:[{id:'a',title:'买菜',done:false}]}} |
| `widget.card.preview` | owner, agent, app | read / none | - | id* | 在看桌面卡片的样子 | Look at a card again: the phone draws it as the home-screen widget would (its size on this phone, in the current dark or light theme) and returns the picture as an image you can see, or says why it cannot. Use it after the owner changes theme, after an app's card refreshed, or to check a card you did not just put. fresh: false means the phone did not answer in time and the image is the last one it drew. |
| `widget.card.get` | owner, agent, app | read / none | - | id* | 在看桌面卡片的内容 | Read one card back: what it says (its a2ui as it was put), size, owner, last update, the owner's answers recorded on it (feedback: what a feedback button said and when; card_updated_at tells which version of the card was answered), and the picture of how the home screen shows it now (the same image as widget.card.preview; preview_problem says why there is none). Use it to see what you showed before and how it was received; widget.list only gives titles. |
| `widget.card.validate` | owner, agent, app | read / none | - | a2ui* | 在检查桌面卡片 | Check a card's a2ui exactly as widget.card.put would, without saving or showing anything: valid, or the problem (which component, which property, why). levels is how deep it nests against Android's limit. Same format as widget.card.put. |
| `widget.card.remove` | owner, agent, app | write / none | - | id* | 在移除桌面卡片 | Remove a card you created (the owner may remove any). Widgets that showed it ask the owner to pick another card. |
| `widget.tap` | owner | write / none | - | card*, action, component, checked, value | 在转达小组件上的点击 | The owner tapped, toggled or chose something on a card (sent from the phone as the owner). Owner only; the card's creator is then told by widget.action. |
| `widget.placed` | kernel | read / none | event in | widgets* | 在记下放好的小组件 | The phone reports which Ash widgets are on its home screen. Sent by the hands module from the hand's event; not recorded. |
| `widget.bind` | kernel | read / none | event in | widget*, card* | 在记下小组件选的卡片 | The owner picked which card one placed 'Ash 卡片' widget shows. Sent by the hands module from the hand's event; not recorded. |
| `widget.rendered` | kernel | read / none | event in | widgets, rendered* | 在记下卡片画出来没有 | What a channel reports after being asked to show widget state: which widgets are placed and which cards it drew, with the problem or a preview picture. Turned from the channel's present result by the human module; not recorded. |
| `widget.action` | kernel | read / none | event out | card*, action*, owner*, title, component, item, checked, value, context | 在转达小组件上的点击 | The owner tapped, toggled or chose something on a home-screen card. owner is the card's creator, who decides what it means; component is the element, item the list item's key, checked / value the new state. On an app's card (owner app:<id>) the tap goes to the app's own action tool, which changes the app's data; otherwise the tap itself does nothing else. |
| `widget.state` | kernel | read / none | event out | - | 在更新桌面卡片 | The home-screen cards changed: the whole state for the channels that show widgets (the human edge pushes it as present{widget}). A channel that just connected gets the current state from service:widgets/widget.list. |
| `widget.problem` | kernel | read / none | event out | card*, owner*, title, problem* | 在转达卡片画不出来 | The phone could not fully draw a home-screen card (problem says what and why); the card's creator should fix it. |

## `service:pulse`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `pulse.get` | owner, agent, app | read / none | - | - | 在看主动更新的安排 | Your pulse: whether it is active (it exists only while an 'Ash 卡片' widget is on the home screen; otherwise active:false, reason:'no widget'), whether the owner has it switched on, your wake schedule, today's wake count against the daily budget, the next scheduled wakes, the latest history entries and gaps you noted. |
| `pulse.set` | owner, agent, app | write / none | - | schedule, reason* | 在改主动更新的安排 | Change your own pulse and say why (reason is required and is kept in the history). Schedule (list of {time:'HH:MM' local, days:'daily'\|'weekdays'\|'weekends'\|[0..6 with 0 = Sunday]} or {time:{at: epoch ms}} for one moment; replaces the whole list; the next 48 hours become real timers). Other fields are refused. PULSE.md, the file that tells you how to use each wake, is in your home folder: edit it there yourself. |
| `pulse.history` | owner, agent, app | read / none | - | limit, before | 在看主动更新的记录 | Page through your pulse history, newest first: wakes (why, when), what you did (pulse.note), the owner's feedback on your cards, changes to the schedule with their reasons, skipped wakes and why. limit (default 20), before: an entry id from next_before to read older ones. |
| `pulse.note` | owner, agent, app | write / none | - | did*, why, kind, data_used | 在记下这次做了什么 | Record what you did on this wake and why (did, why, data_used: what you looked at). kind: pulse (default) for an ordinary wake, gap for something you wanted to know or do but could not get; gaps are collected so the missing source can be added. Nothing here ever reaches the owner. |
| `pulse.fire` | owner, agent, app | write / none | - | - | 在试一次主动更新 | Wake yourself now as a pulse to try your schedule and cards; it does not use the daily budget. Needs the pulse to be active and switched on. |
| `pulse.switch` | owner | write / none | - | enabled* | 在开关主动更新 | Owner only: switch the whole pulse on or off. Off keeps PULSE.md, history and feedback. |
| `pulse.due` | kernel | write / none | - | kind*, at* | 在响应到点的主动更新 | Internal: the clock reports one of the semantic layer's own timers: wake (an hourly pulse), daily (the evening look back at the day) or reload (the daily new session). The hub itself calls this; nobody else. |

## `service:cost`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `usage.get` | owner, app | read / none | - | days | 在看用量 | What the models used and cost: today, 7 and 30 days, by part of Ash, by day, and the latest calls. |
| `balance.get` | owner | read / none | - | - | 在看余额 | The provider account balance for the configured API key; fails rather than reporting zero when it cannot be read. |
| `quota.check` | kernel | read / none | - | agent* | 在查额度 | Whether an agent may open another turn under its daily quota, by the latest usage numbers. A soft limit: the numbers are only as fresh as the last poll. |
| `usage.recorded` | kernel | read / none | event in | caller*, provider*, model*, input_tokens*, output_tokens*, cache_read_tokens, cost, ok*, at* | 在记下用量 | One model call, as the llm edge reports it for the hub's small models or an agent driver reports it for an agent: who called, which model, tokens in and out (cache_read_tokens: the cached part of the input, priced apart), the cost in US dollars when a price is known (the cost service prices the models it has rates for when none is given) (the field is left out otherwise, never zero), whether it worked. Not recorded: usage has its own table. |

## `service:reflex`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `conversation.control` | kernel | act / none | timeout 8s | message_id*, agent*, lane | 在判断要不要打断 | The owner spoke while an agent was busy: judge what to do with it (stop it, pause, say it into the running turn, or wait for the next turn). Keywords first, the small model when unclear; a failed judgment means followup. |
| `task.outcome` | kernel | act / none | timeout 8s | turn* | 在判断结果 | After a turn ended normally, label how it ended from the owner's point of view, for the island and the capsule: delivered, needs a reply, needs action in Ash, or incomplete. |
| `task.stop` | owner | act / none | timeout 3s | turn* | 在停下任务 | Stop only the task the owner selected, never a newer turn. |
| `task.end` | owner | act / none | timeout 5s | turn*, pending_ids* | 在结束任务 | End the selected capsule interaction: stop its current turn and withdraw only the pending requests that are displayed. Never stops a newer turn. |
| `screen.plan` | kernel | act / none | timeout 15s | agent*, lane*, ids | 在判断在哪块屏幕上做 | Before a turn that the owner started opens: decide whether the turn's phone-screen work belongs on the real screen or on a background virtual screen, and give the text to put into that turn. The agent names the lane because the turn does not have an id yet. Whatever cannot be judged (no phone, no judge, unsure) is mode none with no text: the turn goes on untouched. |
| `screen.reconcile` | kernel | act / none | timeout 30s | turn*, agent*, lane*, outcome | 在收拾后台屏幕 | After a turn ended: close the virtual screen this turn opened when its work is done, if the screen state the decision saw is still current. The real screen is never touched; the owner chooses when to go back to Ash. |

## `service:senses`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `query` | owner, agent, app | read / none | - | kind*, from, to, limit | 在翻感知记录 | Archived sensor readings of one kind in a time range (Unix ms; default the last day), oldest first. Also what an organ uses to look back. |
| `daily` | owner, agent, app | read / none | - | date | 在看每日统计 | The day's statistics, computed from the archive when asked (places, activity minutes, steps, health numbers) for a date (default yesterday). steps is null when the day has no step readings; counts are the readings archived for the day (all 0 = nothing recorded). |
| `now` | owner, agent, app | read / none | - | - | 在看最近读数 | The newest reading of each kind (location, activity, battery, ...) and how old each is. No phone call is made; it is what the archive holds. |
| `sense.calendar` | kernel | read / none | event in | kind*, event* | 在收日程变化 | A calendar event is about to start or changed, from the hand. Archived only; not recorded in the ledger. |
| `sense.battery` | kernel | read / none | event in | level* | 在收电量 | The battery level, from the hand. Archived only; not recorded in the ledger. |
| `sense.screen` | kernel | read / none | event in | state*, away_ms* | 在收屏幕状态 | The screen came on or the app was opened, with how long the owner was away. Archived only; not recorded in the ledger. |
| `sense.notification` | kernel | read / none | event in | app*, title*, text* | 在收通知 | A notification arrived on the hand (app, title, text). Archived only; not recorded in the ledger. |
| `sense.location` | kernel | read / none | event in | batch_id*, items* | 在收位置 | A batch of location points from the hand; a batch_id makes a re-delivered batch idempotent. Archived only; not recorded in the ledger. |
| `sense.activity` | kernel | read / none | event in | batch_id*, items* | 在收运动状态 | A batch of activity segments from the hand. Archived only; not recorded in the ledger. |
| `sense.health` | kernel | read / none | event in | batch_id*, items* | 在收健康数据 | A batch of health readings from the hand. Archived only; not recorded in the ledger. |
| `sense.geofence` | kernel | read / none | event in | name*, transition*, ts* | 在收围栏进出 | The owner entered or left a named place. Archived only; an organ that listens decides whether to wake an agent. |
| `sense.source` | kernel | read / none | event in | source*, state*, ts*, stale_hours*, summary*, last_data_ts | 在收数据源状态 | A health source stopped bringing new readings for stale_hours (sent once), or came back. last_data_ts is its newest reading; summary is plain Chinese for the owner. |

## `service:directory`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent, app | read / none | - | member | 在查能做什么 | The members you can reach and the words of each that you may call, with the label and whether a call needs the owner's approval (true, or per_call when it is judged per call). Pass a member id to see just that one. |
| `describe` | owner, agent, app | read / none | - | member*, word | 在查怎么做 | The full contract of a member's words you may call (description, input and result schemas, effect, risk), or of one word. |

## `service:history`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `query` | owner, agent, app | read / none | - | text, speaker, lane, thread, before, after, limit | 在翻聊天记录 | Search the ledger: messages by text, speaker, lane or thread, newest first. Long bodies are summaries with an attachment reference; read them with service:blobs/read. |
| `read` | owner, agent, app | read / none | - | from_seq*, to_seq* | 在读历史原文 | Read ledger messages by sequence range, as recorded (secret and sensitive fields masked). |
| `turn` | owner, agent, app | read / none | - | turn* | 在看某一轮做了什么 | What happened in one turn of an agent: the messages it was given, its tool calls and results (summaries), and what it said. |
| `activity` | owner, agent, app | read / none | - | id*, offset | 在看活动详情 | The detail of one activity entry (a turn's tool calls), paged by offset. |
| `window` | owner | read / none | - | before, after, limit, snapshot_seq, around_id | 在翻聊天记录 | A bounded window of display items with complete answer, delivery and reaction state at snapshot_seq. Before, after and around_id are mutually exclusive. Long text is a preview and blob reference. Oversized marks one legitimate item returned alone. |
| `current` | owner | read / none | - | before, after, limit, snapshot_seq, agent | 在看现在的事 | Authoritative current presence and bounded progress, with independently paginated pending questions and complete total count. Optional agent scopes turns and question publishers; gate approvals remain in the unfiltered owner view. Read without snapshot_seq for current state; old conversation windows do not determine current presence. |
| `activity.page` | owner | read / none | - | before, after, limit, snapshot_seq, turn, since_ts, until_ts, agent | 在看她做过的事 | Bidirectional bounded turn summaries with an authoritative total count, optionally filtered by inclusive since_ts, exclusive until_ts and agent. With turn, read its safe display steps and complete step count instead; time/agent filters then do not apply. Step details remain on demand through history.activity. |
| `activity.count` | owner, app | read / none | - | since_ts, until_ts, agent | 在数她做过的事 | How many things she did (turns) in a time range, optionally for one agent: the same count as the total of activity.page, without any of the turns. since_ts inclusive, until_ts exclusive. For a status page that only needs the number. |
| `confirm` | owner | read / none | - | ids*, snapshot_seq | 在确认消息已送达 | Confirm at most 24 owner's outgoing message ids against the authoritative ledger, independently of retained history pages. Does not send or execute anything. |

## `service:blobs`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `read` | owner, agent, app | read / none | - | hash*, offset, limit | 在读附件 | Read a text attachment of a ledger message in pieces. You can read an attachment only when you may read the message that holds it. |
| `get` | owner, agent, app | read / none | - | hash* | 在取附件 | Get a binary attachment (an image, a file) of a ledger message as a stream reference. You can get an attachment only when you may read the message that holds it. |

## `service:host`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `wake.at` | kernel | act / none | - | at* | 在设唤醒闹钟 | Ask the host to wake the device at a time (Unix ms); only the earliest one is kept. |
| `wake.clear` | kernel | act / none | - | - | 在取消唤醒闹钟 | Cancel the host alarm. |
| `power.hold` | kernel | act / none | - | ms*, reason* | 在保持唤醒 | Keep the device awake for a while (at most 10 minutes) for a stated reason; released by itself when the time is up. |
| `power.release` | kernel | act / none | - | - | 在放开唤醒锁 | Release the wake lock before its time is up. |
| `wake.fired` | kernel | read / none | event out | at* | 在转达唤醒闹钟 | The host's alarm went off (the device woke): the host module passes it on to service:clock. |
| `vscreen.state` | kernel | read / none | event out | open* | 在转达虚拟屏开关 | The virtual screen was made or closed: the host module passes it on to person:owner, whose screens show or hide the live preview (the human edge pushes it as present{status/vscreen}). |
| `env.changed` | kernel | read / none | event out | what*, network*, online*, saver* | 在转达环境变化 | The network or the power state changed: the host module passes it on to service:agents and service:link (which reconnects the relay). |
| `restart` | owner, app | act / none | - | reason | 在重启大脑 | Have the host restart the kernel: it is away for about ten seconds and what it was doing is cut off. The caller has asked the owner first (an app puts the question on its own screen); an agent cannot call it. |
| `hands.handoff` | kernel | act / none | - | port*, token* (secret) | 在交接本机的手 | Hand the local link port and token to the hands on this device (the phone app) so they connect. The token is held in memory and never written down. |
| `update.install` | owner | execute / structure | - | version*, url*, sha256* | 在安装大脑更新 | Have the host download and install a new kernel package (checked against sha256). Only the owner. |
| `input.key` | owner, agent, app | act / outward | foreground | key*, long_press | 在按手机按键 | Press a key on the phone: media keys (play_pause, next, previous ...), volume keys, and other keys (back, home, recents, power ... or an Android keycode number). Keys other than media and volume need the phone's debug identity (「后台也能动手」), which the owner connects. |
| `vscreen.create` | owner, agent, app | act / structure | - | orientation, short_edge, dpi | 在创建虚拟屏 | Create (or reuse) the virtual screen: a separate phone-shaped display, invisible to the owner, where apps can be launched, seen and operated without disturbing the real screen. Only one exists; calling again with another size recreates it. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.close` | owner, agent, app | act / structure | - | - | 在关闭虚拟屏 | Destroy the virtual screen (apps running on it are closed or moved) and stop its server. Call it when the task is done. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.status` | owner, agent, app | read / none | - | - | 在看虚拟屏状态 | Report whether the virtual screen exists, its display id, size and dpi, and whether it has rendered a frame. |
| `vscreen.see` | owner, agent, app | read / none | - | max_side, quality | 在看虚拟屏 | Screenshot of the virtual screen (JPEG, long side at most 1280 px); the caption gives the factor from image pixels to the screen coordinates vscreen.tap uses. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.record.start` | owner, agent, app | act / structure | - | max_seconds | 在录虚拟屏 | Start recording the virtual screen to a video (mp4). Call it when the owner asks you to record ("录下来"); do the work on the virtual screen as usual, then vscreen.record.stop. It stops by itself at max_seconds (default 120, at most 600) or when the virtual screen closes. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.record.stop` | owner, agent, app | act / structure | - | - | 在停止录虚拟屏 | Stop the recording and save it in your workspace (/root/work/recordings/vscreen-<time>.mp4); the reply gives the path, length and size. Show it to the owner with human_show as a file card (workspace body:main, mime video/mp4). Also hands over a recording that stopped by itself. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.launch` | owner, agent, app | act / outward | - | app* | 在虚拟屏里打开应用 | Launch an app onto the virtual screen for delegated work (use apps.open to show an app to the owner). Wait a moment, then vscreen.see. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.tap` | owner, agent, app | act / outward | - | x*, y* | 在点虚拟屏 | Tap on the virtual screen at (x, y) in virtual-screen pixels (see vscreen.see for the scale). Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.swipe` | owner, agent, app | act / outward | - | x1*, y1*, x2*, y2*, duration_ms | 在滑动虚拟屏 | Swipe on the virtual screen from (x1, y1) to (x2, y2) in virtual-screen pixels, e.g. to scroll (drag upwards to scroll down). Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.key` | owner, agent, app | act / outward | - | key*, long_press | 在虚拟屏按键 | Send a key press to the virtual screen: a name (back, home, enter, menu, app_switch, tab, escape, delete ...) or an Android keycode number. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `vscreen.type` | owner, agent, app | act / outward | - | text* | 在虚拟屏输入 | Type text into the focused field of the virtual screen (tap the field first). Text with non-ASCII characters is pasted through the clipboard, replacing the owner's clipboard content. Needs the phone's debug identity (「后台也能动手」), which the owner connects (Android 10+). |
| `apps.open` | owner, agent, app | act / outward | foreground | app* | 在打开应用 | Open (launch or bring to front) an app on the real foreground screen, by package name or launcher label, for the owner to use. With the phone's debug identity connected (「后台也能动手」) the host opens it; without, Ash opens it itself, which Android allows only while Ash is in front or its accessibility service or overlay permission is on (the error says what to turn on). |

## `service:bodies`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `list` | owner, agent, app | read / none | - | - | 在看有哪些身体 | The bodies the hub has bound: its own (body:main) and any computer the owner lent, with whether each is Ash's own or borrowed, and whether it is online. |
| `describe` | owner, agent, app | read / none | - | body* | 在看身体详情 | One body in detail: its body.info (system, resources, work directory, ownership), disk use, and the latest error. |
| `bind` | owner, agent, app | write / structure | - | hand* | 在把电脑当作身体 | Bind a paired computer as a body: its workspace.* capabilities become available as body:<hand>. An agent asking for this goes through the gate. |
| `unbind` | owner, agent, app | write / structure | - | body* | 在解绑身体 | Unbind a body: workspace.* goes offline at once; the computer stays as a hand and as a host for local agents. body:main cannot be unbound. |

## `person:owner`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `say` | agent, app | act / none | - | text*, kind, facts, dedupe_key | 在回你消息 | Send the owner a short message; it is acknowledged when recorded and does not wait for a reply or replace ask. kind (default reply): reply, due (a reminder), offer or heads_up (unprompted; an opaque stable dedupe_key keeps a repeat from showing twice). facts are source message or fact ids. |
| `react` | agent, app | act / none | - | message_id*, emoji* | 在给消息加表情 | React to one existing message with an emoji; an unknown message id fails. Not for a new explanation: use say for that. |
| `show` | agent, app | act / none | - | card* | 在给你看卡片 | Show the owner a file, image, link, a permission page to switch on, or choices. Showing choices does not itself authorize anything. A permission card only names an Android setting the owner must switch on; calling a capability asks the owner by itself. |
| `ask` | agent | act / none | timeout 604800s | title*, detail, human_kind, allow_custom, options, expires_at, source | 在问你 | A durable question to the owner, who must choose before something continues. Only title is required; a question (the default human_kind) also needs options, while a confirmation without options gets yes and no from the owner's side. detail, source and expires_at are optional: the gate fills them for an approval, the tools fill expires_at from approval_ttl_minutes, and the owner's side ends the question at expires_at (at most seven days). The tools human_ask and human_confirm are this word under two names and take exactly this input. The answer (or the expiry) comes back as the response; an approval does not execute anything by itself. The hub's gate uses this for approval cards. |
| `open` | agent, app | act / none | - | target*, id, mode, client | 在打开页面 | Open or suggest a page on one of the owner's channels: settings, the activity of a turn, a file (id says which). `client` picks the channel; leave it out for the one the owner is on. Check `opened`: a suggestion may be declined. |
| `typing` | kernel | read / none | event out | - | 在等你说完 | The human module tells an agent the owner is composing a message to it. |
| `widget.rendered` | kernel | read / none | event out | widgets, rendered* | 在记下卡片画出来没有 | The human module passes on what a channel reported after showing widget state, for service:widgets. |
| `widget.preview` | kernel | read / none | - | card*, size | 在画卡片预览 | Ask a channel that shows widgets to draw a card and return the picture (an image part), for service:widgets. |

## `agent:*`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `say` | owner | act / none | - | text*, attachments*, in_reply_to*, option_id* | 在读你的消息 | The owner speaks to the agent, or answers an option card (in_reply_to and option_id together). Acknowledged at once and queued on the front lane; the agent's answer arrives later as a message. |
| `tell` | owner, agent, app | act / none | - | text*, attachments | 在告诉帮手 | Tell the agent something. It joins the agent's back lane and the agent decides what to do with it; there is no direct answer to the sender. |
| `ask` | owner, agent, app | act / none | timeout 600s | text* | 在问帮手 | Put a question to the agent; what it says in the turn that takes the question is the answer. A quick answer is returned directly, a slow one as a receipt. |
| `wake` | agent, app | act / none | - | lane, reason*, context | 在叫醒帮手 | Wake the agent for a reason, on a lane (default back), with the facts it needs in context. Its own turn runs; nothing is said to the owner by this. Harmless by itself, so organs (apps) may use it to alert an agent. |
| `typing` | kernel | read / none | event in | - | 在等你说完 | The owner is composing a message to this agent in some channel; the inbox waits for them to finish before opening a turn. Sent by the human module. |
| `turn.started` | kernel | read / none | event out, record | turn*, lane*, ids | 在记下一轮开始 | A turn of the agent began (the lane and the ids of the messages it was given). Goes into the ledger. |
| `turn.ended` | kernel | read / none | event out, record | turn*, lane*, outcome*, error | 在记下一轮结束 | A turn of the agent ended, with how it ended. Goes into the ledger. |
| `agent.tool` | kernel | read / none | event out, record | turn*, name*, phase*, summary, ok | 在记下工具摘要 | One tool call of an agent's turn, as a one-line summary for the activity page. Goes into the ledger; the full result stays where the call was made. |

## `app:*`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `ash.on_event` | kernel | act / none | - | word*, body, from*, at* | 在把事件交给应用 | Deliver an event the app listens to (app.json `listens`). The hub calls this reserved tool; an app never sees it in its own list of tools. |

## `device:*`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `screen.read` | owner, agent, app | read / none | - | - | 在读屏幕内容 | Read the phone's current screen as a list of UI elements (foreground app, screen size, and each visible element with its centre point, size and flags). Use it to see what is on screen and where to tap. |
| `screen.see` | owner, agent, app | read / none | - | grid, elements, display | 在看屏幕 | Take a screenshot of the phone's screen and look at it (the image is the image part of the result, long side at most 1280 px). Use it when the element list is not enough: pictures, layout, games. Secure screens cannot be captured. |
| `screen.screenshot` | owner, agent, app | read / none | - | path, display | 在截屏 | Save a full-resolution PNG screenshot of the phone's screen to a file and return its path (the picture itself is not shown; use screen.see to look at the screen). |
| `screen.touch_status` | owner, agent, app | read / none | - | - | 在看触控状态 | Show which virtual fingers are held down by screen.touch or screen.gesture: finger, position, how long, plus the screen size and limits. |
| `screen.tap` | owner, agent, app | act / outward | foreground | text, desc, id, fx, fy, x, y, long | 在点屏幕 | Tap an element on the phone's screen: by text or content description, by view id, or by coordinates (fractions preferred). With text or id it clicks through accessibility; long: true long-presses. |
| `screen.type` | owner, agent, app | act / outward | foreground | text*, mode, field | 在屏幕上输入 | Type text into an input field on the phone's screen through accessibility (any language). mode set replaces the field's content, paste pastes at the cursor (use it for web pages). It does not press Enter. |
| `screen.scroll` | owner, agent, app | act / outward | foreground | direction* | 在滚动屏幕 | Scroll the scrollable area of the phone's screen by one page. direction is where you want to see more content (down = further down the list). |
| `screen.swipe` | owner, agent, app | act / outward | foreground | fx1, fy1, x1, y1, fx2, fy2, x2, y2, durationMs, finger | 在滑动屏幕 | Swipe one finger from a start point to an end point on the phone's screen (press, move, lift). Give each end as fractions (preferred) or pixels. |
| `screen.hold` | owner, agent, app | act / outward | foreground | fx, fy, x, y, durationMs, finger | 在长按屏幕 | Press and hold one point on the phone's screen for durationMs (default 500), then lift: long-press an icon, charge a game action. |
| `screen.touch` | owner, agent, app | act / outward | foreground | action*, finger, fx, fy, x, y | 在操作触屏 | A stateful virtual touchscreen for multi-finger control: action down presses finger N and keeps it pressed after the call, move slides a held finger, up lifts it, release_all lifts every finger. |
| `screen.gesture` | owner, agent, app | act / outward | foreground | strokes* | 在做屏幕手势 | Perform a multi-finger gesture on the phone's screen: strokes run one after another on one timeline and are injected together as one real multi-touch gesture (total at most 60 s). |
| `screen.global_action` | owner, agent, app | act / outward | foreground | action* | 在操作手机系统键 | Press a system button on the phone: back, home, recents, notifications (pull down the shade), quick_settings, power_dialog, split_screen, lock_screen. |
| `apps.list` | owner, agent, app | read / none | - | query, include_system | 在看装了哪些应用 | List the apps on the phone that have a launcher icon: label and package name, sorted by label. Optionally filter by a substring of the label or package. |
| `apps.info` | owner, agent, app | read / none | - | app*, permissions | 在查看应用信息 | Details of an installed package: label, version, install and update time, system or disabled, SDK levels, installer, launcher activity, APK path, and the permissions it requests with their grant state. |
| `apps.usage` | owner, agent, app | read / none | - | days, limit, app | 在看应用使用情况 | How long each app was used in the foreground (screen time), most used first, with the last time it was used. Needs the Usage access permission. |
| `apps.open_direct` | kernel | act / outward | foreground | app* | 在直接打开应用 | Open an app on the real foreground screen from the hand app itself, which needs Ash in front or its accessibility service or overlay permission. For the hub's `service:host/apps.open`, which uses it when the host cannot open apps; an agent calls apps.open. |
| `apps.open_url` | owner, agent, app | act / outward | foreground | uri*, package | 在打开链接 | Open a URL or deep link on the phone's screen with the app that handles it (https in the browser or a matching app, geo:, tel: opens the dialer without calling, mailto:, app schemes). |
| `settings.get` | owner, agent, app | read / none | - | namespace*, key* | 在读系统设置 | Read an Android system setting from system, secure or global (e.g. screen_brightness, screen_off_timeout, airplane_mode_on). A few protected keys cannot be read by an app. |
| `settings.put` | owner, agent, app | write / structure | - | namespace*, key*, value* | 在改系统设置 | Change an Android system setting in the system namespace (brightness, screen timeout, rotation, font scale ...); needs the owner's Modify system settings grant. Secure and global settings are the owner's to change in Settings. volume_music, volume_ring and the other volume_* keys set that volume. Returns the previous and the new value. |
| `settings.open` | owner, agent, app | act / outward | foreground | page, action, package | 在打开设置页 | Open a system settings page on the phone's screen for the owner: a named page, an app's details or notification settings (give package), or any raw android.settings.* action. |
| `clipboard.get` | owner, agent, app | read / none | - | - | 在读剪贴板 | Read the text on the phone's clipboard. Android 10 and later only let the app in the foreground read it, so this can fail while Ash is in the background. |
| `clipboard.set` | owner, agent, app | act / structure | - | text* | 在改剪贴板 | Put text on the phone's clipboard, replacing what is there, so the owner can paste it anywhere. |
| `device.status` | owner, agent, app | read / none | - | - | 在看手机状态 | The device's current status: battery and charging, network (type, online, metered), free storage, memory, screen on or locked, ringer mode and volumes, time, time zone, locale, model and OS version. |
| `browser.open` | owner, agent, app | read / none | - | url*, space | 在打开网页 | Open a web page (http or https) in a browser space and return it as text with numbered controls; scripts run like in a real browser. |
| `browser.read` | owner, agent, app | read / none | - | space | 在读网页 | Read the page open in a space now: its text and the numbered controls (links, buttons, fields). Call again after the page changes. |
| `browser.click` | owner, agent, app | act / outward | - | ref*, site*, label*, space | 在网页上点击 | Click a control from the latest page of that space; refused if the page or the control is no longer what site and label say. Returns the page afterwards. |
| `browser.type` | owner, agent, app | act / outward | - | ref*, site*, label*, text*, submit, space | 在网页上输入 | Type text into a field from the latest page of that space, replacing its content, optionally submitting its form. Password and file fields are refused. Returns the page afterwards. |
| `browser.scroll` | owner, agent, app | read / none | - | direction, space | 在滚动网页 | Scroll the page about one screen down or up and return it. |
| `browser.back` | owner, agent, app | read / none | - | space | 在回上一页 | Go to the previous page in that space and return it. |
| `browser.screenshot` | owner, agent, app | read / none | - | space | 在给网页截图 | A picture of the page in a space as it looks now, for things text does not show (charts, layout). The picture is the image part of the result. |
| `browser.evaluate` | owner, agent, app | execute / structure | - | code*, space | 在网页里运行脚本 | Run JavaScript in the page of a space and return its JSON-serializable result. Runs with the page's own authority, logged in as the owner. |
| `browser.close` | owner, agent, app | act / none | - | space | 在关网页 | Close a browser space and forget its page (logins stay). space "*" closes every space of the caller. |
| `browser.spaces` | owner, agent, app | read / none | - | - | 在看打开了哪些网页 | List the open browser spaces of the caller: address, title and when each was last used (most recent first). |
| `calendar.search` | owner, agent, app | read / none | - | start_ms, end_ms, query, limit | 在看日历 | Find events in the owner's phone calendar within a time window: titles, times, locations and provider ids. Needs calendar read permission; changes nothing. |
| `calendar.list` | owner, agent, app | read / none | - | - | 在看有哪些日历 | List the owner's phone calendars: id, name, account, writable, shown, primary. Use an id from here as calendar.create's calendar_id. Needs calendar read permission. |
| `calendar.create` | owner, agent, app | write / outward | - | calendar_id*, title*, start_ms*, end_ms*, description, location, time_zone | 在添加日历事件 | Add one event to a writable phone calendar. This changes the owner's calendar. Needs calendar write permission. |
| `media.list` | owner, agent, app | read / none | - | type, since_ms, until_ms, album, name, order, limit, offset, with_location | 在看你的照片和视频 | List the owner's photos, videos and audio on the phone, newest first. Filter by type, time, album and file name; page with limit and offset. Each item has an id for media.read. Needs the photos permission. |
| `media.albums` | owner, agent, app | read / none | - | type | 在看你的相册 | The albums (folders) the owner's media is in, with how many items each holds and the newest item's time, largest first. Use a name with media.list album. |
| `media.read` | owner, agent, app | read / none | - | id*, max_size, copy | 在看你的照片 | Open one item from media.list by id. A photo comes back as an image you can look at (scaled to max_size) with its details; a video comes back with one frame; video and audio come with a path to process. |
| `media.save` | owner, agent, app | write / none | - | path, data, name, mime_type, album | 在存图片到相册 | Save a photo or video into the owner's gallery (Pictures/<album> or Movies/<album>, default album Ash) so it shows up in the Photos app. Give a path or the file as base64 (about 10 MB at most). |
| `camera.capture` | owner, agent, app | act / none | - | reason, timeout_s, max_size | 在等你拍照 | Ask the owner to take a photo: the phone's own camera opens and the owner presses the shutter. Returns the photo as an image and its path; fails with cancelled when the owner closes the camera without a photo. |
| `location.get` | owner, agent, app | read / none | - | accuracy, timeout_s | 在看手机位置 | The phone's location now: the fused, GPS and network providers are asked together and the first fix good enough for the accuracy wins. The result says which provider answered, its accuracy and the fix's age. |
| `location.history` | owner, agent, app | read / none | - | from, to, max_points | 在看位置记录 | Recorded location points in a time range (default the last 24 hours), thinned evenly to max_points. |
| `location.track` | owner, agent, app | write / none | - | on*, interval_min | 在开关位置记录 | Turn location and motion recording on or off. While on, the app keeps a notification with a stop button, takes a point when movement starts or stops and every interval_min minutes, and reports new points to Ash. |
| `activity.current` | owner, agent, app | read / none | - | - | 在看运动状态 | What the owner is doing now (still, walking, running, cycling, in_vehicle) and since when, from step cadence and location speed. Needs recording on. |
| `activity.history` | owner, agent, app | read / none | - | from, to | 在看运动记录 | Recorded activity segments (still, walking, running, cycling, in_vehicle) in a time range (default the last 24 hours), with minutes per state. |
| `health.sources` | owner, agent, app | read / none | - | - | 在看健康数据来源 | Health data sources and their state: Health Connect, Gadgetbridge, a Xiaomi scale; for each set-up source the time of its newest reading, whether it is stale, and a plain-language summary for the owner. |
| `health.read` | owner, agent, app | read / none | - | metrics, from, to, sources, max_rows | 在读健康数据 | Health readings in a time range (default the last 7 days) as rows {ts, metric, value, unit, source}. Read only. |
| `health.summary` | owner, agent, app | read / none | - | period, date | 在看健康汇总 | A day's or a week's health in a few numbers (steps, heart rate, sleep, weight ...), computed by rule from health.read, with the sources that have gone stale. |
| `health.sync` | owner, agent, app | act / none | - | - | 在让手表同步健康数据 | Ask Gadgetbridge to fetch new data from the watch and export its database now, and wait up to 90 s for the export. Needs Gadgetbridge's Intent API enabled. |
| `sensors.steps` | owner, agent, app | read / none | - | - | 在看今日步数 | Steps today from the phone's step counter. A complete count needs recording on since midnight; otherwise complete is false and since says from when it counts. |
| `sense.status` | owner, agent, app | read / none | - | - | 在看感知记录状态 | The sensing app's state: recording on or off and its settings, permissions, each location provider, the last location attempt, batches waiting for Ash, stored rows per kind. |
| `sense.configure` | owner, agent, app | write / none | - | recording, interval_min, accuracy, retention_days, geofences, stale_hours | 在改感知记录设置 | Change what is recorded: recording on or off, interval_min, accuracy, retention_days, geofences (named circles; crossing one is reported to Ash), stale_hours per health source. Only the given keys change. |
| `sense.delete` | owner, agent, app | write / structure | - | kind*, from, to | 在删除感知记录 | Delete recorded rows of a kind (location, activity, steps, health, all) in a time range (default everything), including rows not yet delivered to Ash. |
| `config.status` | owner, agent, app | read / none | - | - | 在看手机App的权限和开关 | The state of every permission and switch the hand app needs: accessibility, notification listener, notifications, exact alarms, battery optimization (app and kernel), location, activity recognition, health, overlay, modify system settings, the phone's debug identity (host_shell, 「后台也能动手」), usage access, storage. These are host services the owner grants; the app reads them and never switches one itself. |
| `config.permission.request` | owner, agent, app | act / none | foreground | name* | 在请求权限 | Show the system permission prompt, or open the matching settings page, for one permission or switch the owner has to grant by hand. |
| `config.keepalive.status` | owner, agent, app | read / none | - | - | 在看保活状态 | The vendor's auto-start and background-limit switches for Ash's apps, and whether each is on. |
| `decision.surface` | kernel | read / none | - | - | 在看界面是否在前台 | Whether the hand app's home page is visible and live, with an epoch that changes when visibility changes. For the hub's reflex only. |
| `decision.screen` | kernel | read / none | - | - | 在看前台应用 | The foreground app and a state epoch. For the hub's reflex only (the virtual screen is the host's, see service:host). |
| `decision.return` | kernel | act / none | - | expected_package*, expected_state_epoch*, decision_id* | 在回到原来的应用 | Return to the app that was in front, when the state epoch still matches. For the hub's reflex only. |

## `body:*`

| 词 | 调用方 | effect / risk | 标记 | 输入 | 进行时 | 说明 |
|---|---|---|---|---|---|---|
| `workspace.ls` | owner, agent, app | read / none | - | workdir, path, limit | 在看目录 | List a directory on the body: name, type (file, directory, symlink) and size. |
| `workspace.read` | owner, agent, app | read / none | - | workdir, path*, offset, limit | 在读文件 | Read a text file by lines (offset is the first line, from 1), or an image. A binary or large file comes back as a stream reference in the result's content, for download. |
| `workspace.find` | owner, agent, app | read / none | - | workdir, path, pattern*, limit | 在找文件 | Find files by a glob pattern under a directory. |
| `workspace.grep` | owner, agent, app | read / none | - | workdir, path, pattern*, glob, literal, ignoreCase, context, limit | 在搜文件内容 | Search file contents for a pattern (regular expression, or literal text), with optional context lines. |
| `workspace.write` | owner, agent, app | write / structure | per_call_risk | workdir, path*, content* | 在写文件 | Write a whole file (creating folders), replacing what is there; at most 4 MiB. The risk is assessed per call: a write inside the work directory is harmless, anywhere else it is a lasting change. |
| `workspace.edit` | owner, agent, app | write / structure | per_call_risk | workdir, path*, edits* | 在改文件 | Edit a file by exact text replacement: each oldText must match exactly once or nothing is saved. The risk is assessed per call like workspace.write. |
| `workspace.bash` | owner, agent, app | execute / structure | - | workdir, command*, timeout, yield_ms | 在执行命令 | Run a shell command on the body. It returns what it printed within yield_ms; if it is still running, use workspace.poll with the process id for more, and workspace.signal to stop it. |
| `workspace.poll` | owner, agent, app | read / none | - | process*, yield_ms | 在读命令输出 | Read the new output of a command started with workspace.bash, waiting up to yield_ms for more. |
| `workspace.signal` | owner, agent, app | act / structure | - | process*, signal* | 在停止命令 | Send INT or TERM to a command started with workspace.bash. |
| `body.info` | owner, agent, app | read / none | - | - | 在看身体信息 | What this body is: system and architecture, whether it is a full Linux, the package manager, resources (CPU, memory, disk), the work directory, and whether it is Ash's own or borrowed from the owner. |

