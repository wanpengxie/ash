# ASH-507 · 工人模型与花费（未整卡验收）

工人模型可独立于主会话选择；每次模型尝试把 provider/model、输入/输出/cache token 写入 `worker.usage`。本次接入安装版 DSH 随包模型目录的价格，按该次调用的确切 provider/model 与分档费率估算美元成本，写入 `cost_usd` 和 `cost_source=dsh-bundled-model-catalog`。目录缺该模型时保留 `cost_usd:null`，不把未知费用记成零。未引入第二份手写价格表或更改冻结的 C13 配置。

验收记录：安装版 DSH 价目目录实测 `anthropic/claude-haiku-4-5` 有价格，未知路由返回 null；定向 13/13，新目录实测 5/5；`npm run typecheck`；安装 DSH 全套 620 项中 557 过、63 预期跳、0 失败；最终架构门禁 0 finding。当前隔离 Android DSH 未配模型，真实供应商账单对照和 §8.4 三天统计未完成，整卡保持 In Progress。
