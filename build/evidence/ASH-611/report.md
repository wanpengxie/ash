# ASH-611 — 设置、远程限制与首次见面

## 2026-10-02 JEV Key / F-U20 主线验收

本地 Android 设置页现有暂停、免打扰和主动偏好之外，加入 JEV Key 输入。输入只经已存在、限制为 appassets 主帧的 `AshNative` 通道送到 Android 私有 `Secrets`；查询只返回布尔“已设置”，不回显 Key，不经 `/api/send` 或事件账本。保存或移除后调用已有 `CoreService.ACTION_RESTART`，`CoreProcess` 在有 Key 时为反射层写入官方 `https://api.typesafe.ai/v1/systemone` URL 与 `jev` 凭据引用，并把 Key 仅放入 Core 进程环境；无 Key 时保持关键词退回。JEV `score` 问题补齐官方协议必填的四档 `criteria`，避免真实请求 422。

已在 API36 隔离 `ai.ash.agent.probe` 包复现：界面首次状态“未设置”；输入合成占位 Key 并保存后，Core 重启、私有配置出现 URL 与凭据引用、界面状态“已设置”；空值保存移除后，私有偏好不再有 `jev_api_key` 且配置不再有 JEV 段。原 `ai.ash.agent` 包未安装/覆盖，原进程未停止。合成 Key 已从测试包移除。前端原生桥+设置单测 10/10，Android `compileDebugKotlin` 与隔离 `assembleDebug` 通过；安装 DSH 全套 618 项 555 过/63 预期跳/0 败，typecheck 和架构门禁 0 发现。真实 JEV Key 未提供，故这只签 F-U20 的设置接线，不签 ASH-007/402 的外部 API、p95 或准确率。

F-U23 已有真实未认领 Worker/DO→OwnerLink→Chrome 的远程对话/审批/管理隐藏与伪造 403 证据；F-U26 已有真实注册屏首聊 3 气泡及重复 visible 不重复证据。按任务卡三条 F-U20/23/26 均已满足，611 完成；下文是以前的局部阶段记录。

本提交只交付本地设置抽屉的暂停/恢复入口。`screen.registered.local_management` 由服务端按当前调用身份铸造；旧帧缺字段仍可聊天但不显示管理项，畸形字段拒绝。恢复需二次点击、当前屏幕令牌、`wait:true` 和配对的 `paused:false` 回复才显示成功。管理命令不进离线队列，不自动重试；同一认证域、屏幕、令牌和授权上下文内，用户再次显式点击才可复用未知结果的 `client_id`。换域、换屏、换令牌、断线与停止均清掉旧意图，明确 403 也不复用。

## 复现

在本分支运行 `npm test`、`npm run -s typecheck`、`npm run -s build:core`。本次全套 320 pass、67 skip、0 fail，类型检查与构建通过。`shell.test.js` 覆盖旧/远程/畸形注册、配对回复、403、同屏重试及跨域/屏/令牌重试身份隔离；`settings.test.js` 覆盖隐藏管理项和二次确认。服务端 `screens.test.ts` 覆盖本地与远程可信标记。

真实浏览器与管理运行时联合复现：在独立检出中合入本分支与实现 `service:admin` 的运行时分支，运行 `node --import tsx packages/core/ui/test/admin-browser-probe.mjs`。探针仅启动临时本机账本、隔离 Chrome profile 与测试回声代理；结束时精确关闭和删除。联合候选 `218085f` 本次全套 328 pass、67 skip、0 fail，类型检查与构建通过。Chrome 经真实 HTTP/SSE 注册后，本地暂停与二次确认恢复各有一条管理请求及配对回复；首次“恢复”点击没有外部效果。浏览器离线和屏幕令牌过期均不显示成功、无新管理请求。远程同 bundle 不显示管理项；在测试代理伪造显示标记后，服务端仍返回 403 且管理请求数不增。上述浏览器探针在仅本分支而尚无管理运行时的检出中不能运行，联合检出才是其执行条件。

## 尚待联合验收

这是 611 的安全关键部分，不等于完整设置页：免打扰、偏好、模型密钥与首次见面流程尚未实现；真实远程连接、更多浏览器及完整生产配置须由独立验收复测。展示标记仅控制界面可见性，最终鉴权始终在服务端。卡片不由作者自行标为 Done。
