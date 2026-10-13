# T-C2 GUI 发起 / 单次追加观测

本次修改未连接真实 daemon。fake 验收：`node --test tools/research/codex-gui-steer-probe.test.mjs`，42 项通过。测试只使用内存 fake RPC 及一次临时 Unix socket 身份 fixture，不连接 Codex。

固定测试 chat：`01a11f8f-7ff8-7ab2-9ad7-0607832213a9`。正式运行前由协调者确认该 chat 是隔离测试且 idle，用户手动打开该 GUI chat。本脚本硬限制目标、只连接显式 Unix socket，不创建会话/轮次、不 interrupt、不启动停止 daemon、不自动处理审批。经本任务根协调者明确授权，idle 基线检查后允许该固定测试 chat 的 `thread/resume({excludeTurns:true})` 作为订阅；不带配置覆盖。协议 schema 没有 `thread/subscribe`，故不虚构此方法。

协调者可按下列参数模板执行，先替换占位值：

```sh
node tools/research/codex-gui-steer-probe.mjs \
  --socket /absolute/path/to/app-server-control.sock \
  --pid VERIFIED_DAEMON_PID \
  --executable /absolute/path/to/CodexCLI.app/Contents/MacOS/codex \
  --out-dir /absolute/path/to/unique-evidence-dir \
  --observe-ms 600000
```

`--executable` 是 lsof txt 指向的实际 native CLI，不是 bin/codex 包装脚本。socket 可为 symlink；每次验证其 canonical 路径、inode、PID 和 native executable 归属。只运行该 CLI 的 `--version`，与 initialize 的服务版本核对，不索要凭据。每个 lsof/RPC 最长 5 秒；输出独立 UUID `.jsonl` 以 `wx` 预留、权限 0600，不覆盖。输出仅 ID、版本、时间、退出码、状态；stdout ARMED 包含本次 GUI 输入模板，不记录聊天内容。

看到 ARMED 后，用户在固定测试 chat 发送 stdout 的完整 input 字段。不要提前发送、不要沿用旧 run_id。精确模板：

> 这是 Ash GUI 发起对照 `<run_id>`。初始标记 GUI-BASE-`<run_id>`。只执行一次 sleep 25，不要读写项目文件或调用其他工具，不要启动子 Agent。等待结束后仅回复 GUI-BASE-`<run_id>`；若收到本轮补充标记，将它附在同一条最终回复。

每次 run 的用户发送窗口为 ARMED 后 180 秒；新 turn 后默认最多观察 600 秒，以覆盖 GUI 模型思考等待，整个控制有效窗口最多 13 分钟（布防 3 分钟 + 观察 10 分钟）。可用 `--observe-ms` 显式设置 1000..600000 的整数毫秒；省略时为 600000，超界或格式错误在连接前拒绝。ARMED 输出实际预算。过期即关闭布防，旧模板失效；用户不能在看到过期后补发。必要历史核对另限定最多四页、每页 25 轮；仅该目标。协调者随后核对 GUI 显示本次初始输入、追加及最终回复。

证据文件另保存最多 2000 条固定目标事件摘要（相对 ARMED 的 ms、method、thread/turn/item ID、item type 和 status），以及丢弃计数；不保存事件 text、content、command 或完整 params。历史只能证明历史状态，不能替代实时等待 started 且未 completed 的事件门槛。

运行中工具来自同原生订阅连接的唯一 commandExecution started 事件，必须仍为 inProgress 且没有 completed；历史不制造这个门槛。该 daemon 的运行中 full 历史正常可有 commandCount=0，故这时仅核唯一新 turn、inProgress、唯一 base 标记及允许 item 类型，不再等待工具写入存档；已有存档 command 则必须唯一且 ID、命令、状态无冲突。每次发送前仍核 native thread/read 当前 active/无等待标志、同 daemon epoch，最终以 expectedTurnId 发送。初始标记或新 turn 暂缺时仍最多重查 8 次、间隔至少 500ms；冲突、历史已结束、多个新 turn/命令或未知工具立即停止。`preflightChecks` 最多保存 32 条细项：新 turn/command 数、ID/command 匹配布尔值、状态、base 标记计数、item 类型集合、toolSource=native_live_event 和 ready/retry/stop 判定；不保存 command 或用户正文。

第三次 GUI 观测 `bbdf161c-0189-47f8-b715-a56ceff8310f` 确认等待 live started 在 ARMED 后 20.288s，随后旧复合历史检查失败、steerCalls=0。协调者后续获授权的自动诊断 turn `01a12050-4652-70b3-8b3f-2ce9ceb5ab43` 在 4.776s 收到 live started；5.046..10.647s 的 12 次快照均有 baseCount=1、turn inProgress、thread active/空 waiting flags，却始终 commandCount=0。这直接证明当前接口的存档快照不含该运行中工具；原先要求存档工具已存在的门槛与实际 API 不匹配，反复等存档不解决问题。自动诊断仅验证 API 映射，不计 GUI C2 通过。下一步由协调者先安排自动 sender+本 probe 的单次追加验证，再决定 GUI 发起验收；本次代码修补未真实发送。

唯一新 turn、唯一初始标记、live active 无 waiting flags、唯一 commandExecution started 且尚未完成、历史再次核验全部成立，才 fsync 本地调用意图并发送一次 steer(expectedTurnId)。等待命令白名单只有裸 `sleep 25` 或 `/bin/zsh`、`/bin/bash` 的 `-lc "sleep 25"` / `-lc 'sleep 25'` 精确包装；其它命令、shell 拼接或工具均停止控制。ack 必须同 turn；同一 command item 必须正常结束 exitCode=0；final_answer 必须两标记俱全；history 必须唯一 clientId→native item.id 同 turn，并复核唯一等待命令与最终标记。partial_answer 不算 final。

出现多个新 turn、审批/等待输入、其他工具、epoch 改变或 deadline，停止自动控制。断线或 ack 丢失输出 unknown，绝不重放；本实现不自动重连，后续仅可由协调者安排同实例固定目标的有界只读核查。没有唯一 history clientId 始终保留 unknown。所有路径最后清理 pending RPC timers 和本脚本 socket；不得用 pass 代替用户 GUI 确认。
