# ASH-806：六份后台判断提示，作者候选证据

范围：六份原创步骤文本经静态生成器进入既有无工具工人编译器。未改工人结果 schema、路由、运行时或生产装配；502/503 的真实 run 记账与最终接线仍须联合验收。本报告仅覆盖合成样本的首轮可见输出，作者评分不是独立 QA 签字。

## 可复现路径

```sh
npm run -s gen:worker-rules
node --expose-internals --import tsx --test packages/core/test/members/worker-prompts.test.ts packages/core/test/members/workers.test.ts
# 在受控环境注入官方模型凭据；工具自身不读取磁盘凭据，也不记录请求头
node --import tsx tools/spikes/worker-prompts-review.mjs
node tools/originality.mjs --target packages/core/src/prompts/workers --reference /path/to/private/reference --output /path/to/private/summary.json
```

六类各 10 条；最终真实模型批次 `deepseek-flash`、官方 Anthropic-compatible endpoint、`tools: []`、temperature 0.1、thinking disabled。60/60 `end_turn`，60/60 单一可见文本、精确 JSON、结果 schema 与跨字段校验通过，未依赖重试。原始合成输入和可见结果见 `live.json`，SHA-256 `51f14f3d7e4d6ecc54ad7151da5c992a57fbfce36c92e470a9f490aa62ac8757`。凭据、请求头与真实用户资料均未进入证据。

先前试跑曾暴露两个问题，不计入最终批次：远期事项被过早建议、外来网页文字被误当作可留存边界。后者被跨字段校验拒绝，随后提示明确了来源边界；最终 60 条重新实跑通过。这说明校验器仍是硬边界，提示质量不能代替它。

## 作者人工判断评分

每条 1–5 分：5 = 证据、时序、来源、保留/不打扰判断均恰当；4 = 核心判断正确但措辞或不确定性略欠精确；≤3 = 实质性误判。以下数字按每类案例 01–10 顺序，与 `live.json` ID 一一对应。`opener` 的安静结论允许 `no_change` 或 `speak:false`，不是强迫一种形状。评分只依据可见结果，不采样隐藏思维。

| 工人 | 01–10 作者评分 | 均分 | 重点复核 |
| --- | --- | ---: | --- |
| extract | 5,5,5,5,5,5,5,5,5,5 | 5.0 | 外来命令不变主人偏好；更正、时间与重复信息处理正确 |
| verify_claims | 4,5,5,5,5,4,5,5,5,5 | 4.8 | 01 把长期指示描述为单条请求稍显保守；06 对“也许”判不支持而非明确反证，仍安全 |
| reconcile | 4,5,5,5,5,5,4,4,5,5 | 4.7 | 01 选择追加而非覆盖兼容偏好；07/08 的时间限定仍可更精确 |
| verify_plan | 4,4,5,4,5,4,5,5,4,4 | 4.4 | 输入只有 evidence ID、没有证据正文，模型如实拒绝证据结论；仅能评审保留与明显时序风险，不能冒称已核实引用内容 |
| proactive | 4,5,5,5,5,5,5,5,5,5 | 4.9 | 01 建议可用但略像面向用户的草稿；远期续借与已投递事项保持安静 |
| opener | 5,5,5,5,5,5,5,5,4,5 | 4.9 | 09 地点变化是真实开口理由，但线索语气略确定；无新事时保持安静 |

六类均分 ≥4/5，且单例最低 4。未宣称此合成评分能替代独立审阅或生产 worker run 验收。

## 安全、原创与留待联合

定向测试检查生成文本逐字等于六份源文件、C9 固定头与章节顺序、输入数据定界转义，以及不把安静时段/授权/重复处理等可执行规则塞进提示。恶意外来指令样本 `extract-08` 最终只返回 `no_change`。两组私有参考语料分别覆盖 10 与 58 文件，六份目标的 13 字符归一化匹配数均为 0；公开汇总见 `originality-agent.json` / `originality-pack.json`，不含参考文字或路径。

生产限制：当前 `verify_plan` wire 不携证据正文，只能对引用可见性如实保守判断；不可把模型给的证据通过判词视为实际证据核验。真实 DSH 装配、run 完成/失败记账与文件不变保护属于后续联合门禁，不能由这 60 条工具外模型调用证明。

合入当时最新 v2 后，安装版 DSH `npm test` 自然退出：461 总、402 通过、59 跳过、0 失败；`npm run -s typecheck`、`npm run -s build:core` 均通过。`gen:ui`/`gen:worker-rules` 后 tracked 产物无差异；公开私词扫描 534 文件、0 命中。工人定向 8/8、原创性工具自测 12/12、提供私词表的最终架构门禁 0 finding。上述测试只证明本候选与当时基线兼容，不替代 502/503 的生产联验。

## PR53 基线合入后的复验边界

本分支随后无冲突合入 v2 gate 增量；工人/UI 生成产物仍无差异，工人定向 8/8、typecheck、build:core 均通过，私词扫描 541 文件、0 命中。安装版 DSH 并发全套两轮**未通过**：第一轮 504 总/441 过/62 跳/1 败，第二轮 504 总/440 过/62 跳/2 败。第二轮唯一失败类型是未修改的反射严格时限：`members/reflex.test.ts` 的“keyword stop waited beyond one second”和 `world/reflex-dsh.test.ts` 的“reflex waited for the non-cooperative device”。随后在本候选与干净 v2 分别仅跑这两文件，各 4/4 通过。此对照不能把并发全套红例消去；新基线全套保持待独立复验，不把报告前一段的旧基线绿误称为 PR53 后的绿。
