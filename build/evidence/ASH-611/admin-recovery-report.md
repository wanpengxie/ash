# ASH-611 × 306：管理命令恢复与竞态增量

范围：本增量只修服务端暂停/恢复命令的持久事实、恢复鉴权与取消竞态，不改变此前的本地设置交互。旧的隔离 Android 页面验证不能替代本次服务端独立复验。

## 可复现检查

在包含本增量的检出中运行：

```sh
node --expose-internals --import tsx --test packages/core/test/members/admin-host.test.ts packages/core/test/members/admin-kill.test.ts packages/core/test/members/admin.test.ts
npm run -s typecheck
npm test
npm run -s build:core
node --expose-internals --import tsx packages/core/ui/test/admin-browser-probe.mjs
```

定向 20/20、全套 351 pass / 67 skip / 0 fail，类型检查、构建及隔离 Chrome 的本地暂停/恢复、离线与过期屏幕拒绝均通过。生成 UI 后工作树未出现生成文件差异。私有词表扫描 485 文件、0 命中。

定向测试使用真实子进程：命令事实写入 SQLite 之后、应答之前发送 SIGKILL；重启对已提交的暂停和恢复分别按原请求结算，之后的同 `client_id` 显式重试返回原 id/回复且没有第二次效果。即使旧凭据后来被撤销，已提交事实也不会被误报为未生效；未提交的旧屏幕恢复仍拒绝。另测旧暂停已被更高序号恢复覆盖时不再报告当前暂停。

受控屏障还覆盖：原始所有者授权在反射暂停受理后、执行前撤销时零管理效果；暂停/恢复在最终授权等待期间被取消或超时后零管理效果；两屏交错时旧暂停的迟到回复不得倒挂为当前已暂停。

## 边界

测试使用隔离临时状态、合成身份及回声代理，未触碰个人应用或资料。真实设备原有页面链路仅由先前隔离包验证；本次服务端变更仍需非作者按固定 SHA 独立复验。完整设置页的其余功能不属于本增量，不能据此关闭整卡。
