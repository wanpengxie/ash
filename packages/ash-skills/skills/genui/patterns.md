# 版式库

先在表里挑最接近的一种，打开 `examples/` 里的样例照着改字和数据。每个样例文件就是一次调用的参数：有 `a2ui` 的给 `human_show`，有 `schema` 的给 `human_form`；它们都过了检查，`problems` 和 `hints` 为空。

| 主人要的 | 版式 | 主角 | 样例 |
|---|---|---|---|
| 一个问题的答案、建议（天气、该不该、怎么办） | 结论卡 | 一句结论（h2） | `examples/answer.json` |
| 一个数和它的变化（花费、电费、步数） | 指标卡 | 大数字（h1）+ 变化 | `examples/metric.json` |
| 一个数的走势（体重、股价、汇率） | 走势卡 | 大数字（h1）+ 折线 | `examples/trend.json` |
| 两三样东西怎么选 | 对比卡 | 一句结论 + 表格 | `examples/compare.json` |
| 可以勾的事项（待办、购物、行李） | 清单卡 | 勾选列表 | `examples/checklist.json` |
| 按时间排的安排（行程、日程、当天计划） | 时间线 | 时间列 | `examples/timeline.json` |
| 进行中的事（快递、订单、退款、改签） | 进度卡 | 当前状态（h2） | `examples/tracking.json` |
| 要主人拍板的动作（预约、下单、发出） | 确认卡 | 要做的事 + 关键信息 + 按钮 | `examples/confirm.json` |
| 在几个里挑一个（时间、方案） | 选择卡 | 选项 | `examples/choose.json` |
| 一步步做（菜谱、教程、设置方法） | 步骤卡 | 编号步骤 | `examples/steps.json` |
| 要主人填写（账号、地址、参数、密码） | 表单 | 字段 | `examples/form.json` |

拿不准时问自己「主人看完这张卡要知道哪一件事」，那件事就是主角，用上表中主角相同的版式。

## 各版式要点

所有版式的骨架都一样：根 `Column` `gap: 14` 放几块；标题区是 `gap: 2` 的 `Column`；几行是 `gap: 8` 的 `Column`。

- **结论卡**：第一行就是结论（「明天下午有雨，带伞」），不是「今日天气」，前面可以有一个图标。下面至多 3 个关键数字并排（`h3` 数字 + caption 说明），再至多一句灰字提示。没有按钮。
- **指标卡**：caption 小标签 → `h1` 数字 → 一行变化（好用 `green`、坏用 `red`），这三行是一个 `gap: 2` 的块 → 可选的柱状图（高 80–100，只把要强调的一根标 `accent`，其余 `surfaceVariant`；图和横轴放进 `gap: 4` 的 `Column`）→ 至多 3 行「名称 … 数值」。
- **走势卡**：和指标卡一样，图换成折线（`color: "accent"`、`fill`），series 写 `min`（比最低值略低），横轴只写头尾两个日期（`spaceBetween`）。行情涨用 `red`、跌用 `green`。
- **对比卡**：`h3` 标题 + 一句结论（加粗胜出的一方）→ `Table`（≤ 4 列、≤ 6 行，第一列是项目名，单元格 ≤ 8 个字，更好的一方加粗）+ 一行 caption 注明来源。不替主人做选择：要他选就加选择，不放一实一虚两个按钮。
- **清单卡**：`h3` 标题 + 右边一个 `Badge`（「还差 3 样」）→ `CheckBox` 列表（`List` 的模板 `{componentId, path}`，`value` 绑定 `{path}`）。根 `gap: 8`，清单本身就是一块。过期、紧急的事用一句 caption（必要时 `red`），不用一行一个徽标。
- **时间线**：每一行是 `Row`：左边固定宽 52–56 的时间（加粗），右边 `weight: 1` 的 `gap: 2` 的 `Column`（事项 + caption 细节）；行与行 `gap: 12`。最重要的一行时间可以用 `accent`。不加竖线、圆点和图标。
- **进度卡**：caption（单号或对象）→ `h2` 当前状态 → 一句预计时间（一个 `gap: 2` 的块）→ `ProgressBar` + 下面 3 个阶段名（`gap: 4`）→ 分隔线 → 最近 1–2 条记录。完整轨迹不全列。
- **确认卡**：`h3` 问句（「确认预约体检？」）→ 2–4 行「标签（宽 56，`textSecondary`）+ 值」（`gap: 8`）→ 一句注意事项（caption；真冲突用 `orange`）→ 最后一行靠右：`borderless` 次要 + `primary` 主要（`gap: 8`）。
- **选择卡**：`h3` 问句 + 一句为什么（caption）→ `ChoicePicker`（`chips`，`value` 是 `{path}` 指向 `data` 里的数组，预选一个）→ 一个 `primary` 按钮。主人点按钮时你收到的 `data` 里就是他选的。
- **步骤卡**：`h3` 标题 + caption（用时、份量）→ 步骤和用料都有时用 `Tabs` 分开 → 步骤是 `Row`：左边宽 24 的编号（`textSecondary` 加粗，不用 `accent`）+ 右边一句话，关键数字加粗。
- **表单**：用 `human_form`，卡由中枢画，你只给 `title`（要做的事）、`why`（一句为什么要、密码去哪）、`schema`（字段 ≤ 6 个；能猜到的给 `default`，举例放 `examples`）和 `secret`（密码字段）。细节见 `mechanics.md`。
