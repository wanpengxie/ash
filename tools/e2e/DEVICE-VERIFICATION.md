# 设备验证怎么做

在模拟器或真机上验证一条链路（审批、虚拟屏、通知、授权……）时，**一律用脚本 agent + 主人命令行，不用真模型**。
真 agent 要靠模型“理解”该调哪个工具，一步几十秒、结果不确定，测出来的是模型的心情，不是我们的代码。

## 原则

1. **确定**：agent 的每一步是脚本里写好的一次工具调用，主人的每一步（点审批、看手机）也是脚本里写好的。同样的脚本，同样的结果。
2. **走真实路径**：脚本 agent 通过和真 agent 完全相同的路径调用（工具通道 → 路由 → 审批 → 宿主），调用方身份就是 agent，
   有 `turn.started` / `agent.tool` / `turn.ended`，前台、后台通道照常，灵动岛、对话、通知都按真实流程走。
3. **等状态，不等时间**：需要等的地方用事件或状态——`until`（轮询一个读调用直到条件成立）、`checkpoint`（agent 停在某处，
   主人这边去看手机，看完放行）、主人对审批卡的反应（`when.approval`）。`sleep_ms` 只是兜底，`delay_ms` 只用来**模拟主人多久后点**
   （比如 3 秒内点、40 秒后点），不是用来等系统。
4. **每个用例都有断言**：没有 `expect` 的脚本不算用例。命令行用退出码说话：0 全部成立，4 有断言不成立，2 等不到 agent 的报告。
5. **设置用完即还**：脚本的 `settings`（例如把审批快路径阈值临时设成 3 秒）在运行前写入、结束后恢复，不留尾巴。

## 前提

- 设备上装的是 **debug 版**内核：内核（debug 构建）在 host.json 里写 `dev.script_agent: true`，中枢于是声明 `agent:script`。
  正式版没有这个字段，没有 `script` 这种 agent 运行时，任何 agent 或应用都声明不出来。
- 命令行连上中枢：`adb shell run-as ai.ash.agent cat files/debug/local-link.json`，`adb forward`，`--link-file`
  （见 README 的 “On a phone or emulator”）。中枢每次重启 token 会变，要重新读。
- `agent:script` 是单个共享的 agent：同一时间只跑一个脚本。

```
export ADB_MDNS=0 ANDROID_SERIAL=emulator-5554
adb shell run-as ai.ash.agent cat files/debug/local-link.json > link.json
adb forward tcp:$(node -p 'require("./link.json").port') tcp:$(node -p 'require("./link.json").port')
node tools/e2e/owner.mjs --link-file link.json script tools/e2e/scripts/approval-fast-approve.json
```

## 脚本文件

```json
{
  "name": "审批快路径：3 秒内批准",
  "settings": { "approval.fast_seconds": 30 },
  "timeout_s": 90,
  "reports": 1,
  "steps":      [ ... agent 要做的 ... ],
  "on_message": [ { "match": "[answers ", "steps": [ ... ] } ],
  "owner":      [ ... 主人这边的反应 ... ],
  "expect":     [ ... 必须成立的 ... ]
}
```

**agent 的步骤**（`steps`，每步按顺序做，结果按顺序报告）

| 步骤 | 做什么 |
|---|---|
| `{"id":"a1","call":{"member","word","body","purpose","wait","approval_ttl_minutes"}}` | 一次 `capability_call`，和真 agent 一样 |
| `{"tool":"human_say","args":{...}}` | 工具通道上的任何一个工具 |
| `{"say":"文字","kind":"reply\|due"}` | 对主人说一句（`human_say`） |
| `{"until":{"call":{...},"path":"data.state","equals":"approved"},"timeout_ms":30000}` | 反复调用，直到结果里的路径成立 |
| `{"checkpoint":"名字"}` | agent 停下，主人这边看完（`owner` 里 `when.checkpoint`）后放行 |
| `{"sleep_ms":N}` | 兜底，尽量不用 |

字符串里可以写 `${a1.data.pending_id}`（前面某步的结果）、`${msg.pending}` / `${msg.option}`（`on_message` 里，主人答复消息
`[answers <审批编号>, option <选择>] 批准：…` 里的编号和选择）、`${run}`。`on_message` 是之后主人的消息到来时 agent 做的事
（比如慢路径里批准之后的 redeem）；每个会触发的处理多等一份报告，在 `reports` 里写总数。

**主人的反应**（`owner`，每条 `when` + `do`）

| `when` | 触发 |
|---|---|
| `{"start":true}` | 发出脚本之前（例如先让手机回桌面） |
| `{"approval":{"word":"mode.set"}}` | 出现一张审批卡（可按它要做的词筛），`repeat` 每张都处理 |
| `{"checkpoint":"名字"}` | agent 到了这个检查点；`do` 做完自动放行（`hold` 则不放） |
| `{"message":{"from","to","word","text"}}` | 出现一条符合的账本消息 |

`do` 里：`{"answer":"once\|always\|deny"}`（授权卡的选项是 `task`/`m15`/`h1`/`deny`）、
`{"exec":["adb","-s","${env.ANDROID_SERIAL}","shell","dumpsys",...],"expect":{"stdout":"正则","not_stdout":"正则","exit":0},"within_ms":8000}`
（在本机跑一个程序并断言输出，看手机用；`within_ms` 内每半秒重跑一次，等通知这类要一会儿才出现的东西；参数里 `${env.NAME}` 是环境变量，`${run}` 是这次运行的编号）、
`{"say":"..."}`、`{"call":{"member","word","body"},"expect":{"ok":true,"data":{子集}}}`（以主人身份调一个词并断言结果）、`{"sleep_ms":N}`。`delay_ms` 是先等多久。
顶层 `cleanup` 是一串同样的动作，不管成败最后都做（把手机上改过的设置放回去）。
一条不是 `optional` 的反应如果从没触发，整个用例失败。

**断言**（`expect`）

- `{"step":"a1" 或 序号,"ok":true,"error":"denied","error_message":"子串","status":"waiting_owner","data":{子集},"min_ms":N,"max_ms":N,"min_images":N}`
- `{"messages":{"from","to","word","text"},"count":0 或 {"min":1}}`：运行期间账本里符合条件的消息有几条
  （“没有发过『批准：』消息”“没有 `pending.redeem`”“同一轮：`turn.started` 只有 1 条”都这样写）。

## 输出和退出码

每行一个带时间的事件：`event`（账本消息）、`answered`、`report`、`step`、`check`、`expect pass=true|false`，最后一行
`script … result=PASS|FAIL total_ms=…`。`--json` 每行一个 JSON。退出码：0 全部成立；4 有断言不成立；2 等不到报告；
3 中枢拒绝（非 debug 版没有 `agent:script`）；1 连不上。

## 样例（`tools/e2e/scripts/`）

| 脚本 | 验什么 |
|---|---|
| `approval-fast-approve.json` | 快路径：3 秒内批准，同一调用同一轮拿到结果，没有“批准：”消息，没有 redeem |
| `approval-fast-deny.json` | 快路径：2 秒内拒绝，同一调用被拒绝 |
| `approval-slow.json` | 阈值临时设 3 秒，7 秒后批准：调用拿到回执，批准以主人消息到来，agent 在新一轮 redeem |
| `vscreen.json` | 虚拟屏：create → launch 设置 → see → close |
| `vscreen-record.json` | 虚拟屏录像：边操作边录，agent 停一次、主人停一次（主人那次对话里出现文件卡），录好的 mp4 在工作区 recordings 里 |
| `pi-models.json` | 模型目录（含清单自己从上游更新：读目录后等到 `catalog.checked_at` 出现）：agent 读 `runtime.catalog`、被拒绝写错的模型和强度、保存「当前模型 + 每个模型各自的强度」、读回现在生效的和长期保存的、临时试一个强度（不跑真模型） |
| `notifications.json` | 普通通知（普通通道）和强通知（重要通道），读 `dumpsys notification` 断言所在通道，以及两个通道的响铃/振动配置。验之前先让灵动岛不在屏上（关无障碍和悬浮窗权限），否则中枢认为主人正看着、不发通知；脚本里做并在 `cleanup` 里放回 |
| `screen-lease.json` | 屏幕限时授权：没有授权被拒；主人借 15 分钟；agent 操作；主人收回，agent 被拦下并收到通知（到期那一支要等授权时长可以调短再补） |

## 写新用例时

1. 先想清楚要证明什么，写成 `expect`；再写 `steps` 和 `owner`。
2. 用现成的词（`capability_list` 看得到的），不要为了测试加只在测试里存在的词。
3. 要读设备状态就用 `exec` + `checkpoint`，别在脚本里 `sleep` 碰运气。
4. 先在模拟器上跑通，再上真机；真机一次只跑一个脚本，别和别人的验证抢同一个 agent。
