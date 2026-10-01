# ASH-603 — PresenceBar 增量证据

范围：只消费 `agent:main` 的 `status` 账本事件，显示 C6 的头像、名字与人话状态。连接、发送和分页故障另列提示，不改写人物状态。人物页尚未接入；点击在场条只明确提示这一点，不声称已打开页面。

## 可重复运行

从本提交检出，安装项目依赖后运行：

```sh
npm run -s typecheck
npm run -s build:core
npm test
ASH_PROBE_PRESENCE=1 node --import tsx packages/core/ui/test/browser-probe.mjs
```

浏览器探针自建临时账本、临时 Chrome profile 和本机服务，结束时精确清理；不用个人浏览器资料或真实用户账本。它经真实 HTTP/SSE 投递 `status`，检验七态、头像、文案、暂停/恢复以及断线后的状态更新。计时从发状态前开始，到浏览器 DOM 可见为止，逐项断言不超过 500ms。2026-10-01 的一次运行：listening 113ms、thinking 19ms、working 27ms、waiting_you 13ms、done 12ms、idle 17ms、pause 18ms、resume 15ms；最近 200 条首屏 129ms。探针在实施前的基线首先因 `live presence listening` 超时而失败，此时连接文案占据状态位置。

单测覆盖未知状态不显示伪造文本、working 无标签退回“在忙”、离线提示不覆盖人物状态、人物页缺失提示。全套本次 308 pass、66 skip、0 fail；类型检查与 core 构建通过。

## 边界

- 暂停/恢复由真实 `AgentStatus.refresh()` 产生状态事件，但当前 UI 未提供用户可操作的暂停/恢复入口；该入口留给设置页与运行时联验。
- 本增量不把头像点击伪装成 AgentSheet。AgentSheet 完成后须独立验收点击到达目标页。
- 计时是隔离 Linux Chrome 与本地 SSE 的 E 级证据；不同设备和完整生产装配仍需独立复测。F-U02 不由作者自行签 Done。
