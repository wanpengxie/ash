# ASH-611 × 306：管理命令恢复与竞态增量

范围：本增量只修服务端暂停/恢复命令的持久事实、恢复鉴权与取消竞态，不改变此前的本地设置交互。旧的隔离 Android 页面验证不能替代本次服务端独立复验。

## 可复现检查

在包含本增量的检出中运行：

```sh
node --expose-internals --import tsx --test packages/core/test/members/admin-active-kill.test.ts packages/core/test/members/admin-host.test.ts packages/core/test/members/admin-kill.test.ts packages/core/test/members/admin-stale-kill.test.ts packages/core/test/members/admin-target.test.ts packages/core/test/members/admin.test.ts
npm run -s typecheck
npm test
npm run -s build:core
node --expose-internals --import tsx packages/core/ui/test/admin-browser-probe.mjs
```

定向 26/26、全套 357 pass / 67 skip / 0 fail，类型检查、构建及隔离 Chrome 的本地暂停/恢复、离线与过期屏幕拒绝均通过。生成 UI 后工作树未出现生成文件差异。私有词表扫描 0 命中。

定向测试使用真实子进程：命令事实写入 SQLite 之后、应答之前发送 SIGKILL；重启对已提交的暂停和恢复分别按原请求结算，之后的同 `client_id` 显式重试返回原 id/回复且没有第二次效果。即使旧凭据后来被撤销，已提交事实也不会被误报为未生效；未提交的旧屏幕恢复仍拒绝。另测旧暂停已被更高序号恢复覆盖时不再报告当前暂停。

受控屏障还覆盖：原始所有者授权在反射暂停受理后、执行前撤销时零管理效果；暂停/恢复在最终授权等待期间被取消或超时后零管理效果；两屏交错时旧暂停的迟到回复不得倒挂为当前已暂停。

另一个独立 SIGKILL 探针把进程停在暂停事实已提交、尚未发取消请求的窗口：此前重启把活跃轮记为 `error`，修复后在恢复任何路由、模型前以最新暂停事实对活跃轮写入持久取消意图。探针同时保有一个未完成的合成工具请求与一条待处理消息；首次及再次重启均只有一条 `cancelled` 轮结束、一条工具取消回复、一条未消费停机事实，暂停期间没有模型调用且待处理消息仍在。新屏幕明确恢复后，这条消息只进入一个新轮，新轮收到停机事实并正常完成。若最新管理命令已经是恢复，启动对账不会用旧暂停取消较新的轮。

最后的目标轮约束不改变外部消息格式。暂停事实在同一事务内记录当前活跃轮；服务端内部取消消息用可信调用上下文盖出原目标轮。执行端同步核对原目标轮、当前活跃轮、最新暂停请求与持久状态，任一不符只答 `cancelled:false`，不写取消意图。两种确定性屏障分别覆盖旧取消请求在受理前、受理后迟到，均不影响恢复后的新轮；第三个真实 SIGKILL 探针覆盖已受理旧取消在重启派发时仍不得取消新轮。旧数据库列迁移保持未知目标为空，不猜目标；同 `client_id` 回复仍引用原请求，目标轮不能被重写。

## 边界

测试使用隔离临时状态、合成身份及回声代理，未触碰个人应用或资料。真实设备原有页面链路仅由先前隔离包验证；本次服务端变更仍需非作者按固定 SHA 独立复验。完整设置页的其余功能不属于本增量，不能据此关闭整卡。
