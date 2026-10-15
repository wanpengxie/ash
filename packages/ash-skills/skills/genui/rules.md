# 对话卡片的细规矩

## 尺寸和字

- 卡片最宽 330 dp，去掉外框内容约 300 dp：正文（15）一行约 20 个汉字，数字字母约半个汉字宽。
- 字号只用 `variant`，是 App 自己的字号：`h1` 24（全卡至多一个，放一个数字或几个字）、`h2` 20（一句结论或状态）、`h3` 17（卡片标题）、`h4` 15 加粗（小标题）、`body` 15（正文，默认）、`caption` 13（说明，自动浅色）。不写 `fontSize`；强调用 `**加粗**` 或 `fontWeight: "bold"`。
- 长度预算：标题 ≤ 14 字；表格单元格 ≤ 8 字；按钮 2–6 字；一行事项 ≤ 18 字，超了写 `style.maxLines: 1`。写不下就删字，不要折成三四行。
- 价格、时间、数量、状态不截断，也不和单位拆开（「¥186」「15:00 起」）。

## 留白：容器的 gap

`Row`、`Column`、`List`、`Grid` 的 `gap` 是子元素之间的 dp，不写就是 0。只用三档：

| 关系 | gap | 例 |
|---|---|---|
| 配对：标题和它的说明、数字和它的标签 | 2 | `{"component": "Column", "gap": 2, "children": ["title", "sub"]}` |
| 行：列表行、键值行、步骤、两个按钮之间 | 8 | 键值 `Column`、按钮 `Row` |
| 块：标题区、数字区、图、表、按钮行 | 14 | 根 `Column` |

- 做法：先把配对包进一个 `gap: 2` 的 `Column`，把几行包进一个 `gap: 8` 的 `Column`，最后根 `Column` 写 `gap: 14` 放这些块。不要给每个子元素各写 `margin`。
- 图和下面的横轴、进度条和下面的阶段名贴得更近，用 4；两行一条的行（事项 + 说明）之间可以放宽到 12。
- 只有一个子元素要和别的不一样时才写它的 `style.margin`（比如列表最后一行上面多空一点）。
- 分隔线 `Divider` 当一块放进根 `Column`，上下自然各有 14，不用另写 margin。
- 并排的几个数字：`Row` + `justify: "stretch"`，每个是 `gap: 2` 的 `Column`（数字 + caption）。
- 「名称 … 数值」：`Row` + `justify: "spaceBetween"`。「标签 + 值」：标签 `style.width` 固定（48–64），值 `weight: 1`。

## 颜色

- 用 App 的配色，只写主题名，深色模式手机自己换：文字 `text`（默认）、`textSecondary`（次要）；底色不写；要分区用 `surfaceVariant`，全卡至多一处。不写十六进制色，不用 `translucentDark` 当底色。
- `accent`：主按钮、最重要的那个数字或那一行，全卡至多两处（`hints` 会提醒）。
- 状态：`green` 好、完成、省钱；`red` 过期、失败、超支；`orange` 注意、冲突。只在真有状态时用。
- 行情按国内习惯：**涨用 `red`、跌用 `green`**（股票、基金、汇率）。
- 重复出现的元素（步骤编号、时间列）不用 `accent`，用 `textSecondary` 加粗；`accent` 只给独一无二的那一处。

## 组件

- `Text`：支持 `**粗**`、`*斜*`、换行。三条以上的要点换成行或删掉，不写成 `- ` 长段。
- `Icon`：Ash 的单色线性图标（`rain`、`calendar`、`money`……，名字见技能 `widgets-design` 的 `reference.md`），颜色跟着 `style.color`。至多一个，放在标题前；数据行、按钮里不放。
- `Badge`：至多一个，写状态或数量（「还差 3 样」「派送中」），≤ 5 个字。
- `Table`：对比和多列数据用它，不用一堆 `Row` 拼表格。≤ 4 列、≤ 6 行，第一列是项目名（列名可空），更好的值加粗。
- `Chart`：必须 `style.height`（80–120）。上面一句结论，下面一行 caption 写横轴。少于 4 个点不画图。
  - 柱状（花费、次数这类从 0 起有意义的量）：`color: "surfaceVariant"`，要强调的一根用 `lastColor` 或 `colors` 标 `accent`。
  - 走势（股价、体重、汇率这类数大、变化小的）：折线 `color: "accent"`，可 `fill`，**写 `min`**（纵轴起点，比最低值略低：体重 70.8–72.6 写 `min: 70`），不然从 0 起画成一条贴底的平线。样例 `examples/trend.json`。
- `ProgressBar`：「走到哪一步」或「用掉多少」，下面一行 caption 写阶段名。
- `CheckBox` / `Switch` / `ChoicePicker` / `Slider` / `TextField`：`value` 写 `{path}`，主人改了立刻生效。
- `ChoicePicker`：`options` 是 `[{label, value}]`（value 是字符串）；`value` 是**数组**，单选也一样（`["15:00"]`），或 `{path}` 指向 `data` 里的数组。写成字符串会被当成一个元素的数组并记一条 `problems`，照样要改。单选写 `variant: "mutuallyExclusive"`；选项短（≤ 6 字）用 `displayStyle: "chips"`。样例 `examples/choose.json`。
- `Tabs`：内容分两类且都长（步骤/用料，概览/明细）时用，标签 2–4 个字。
- `Button`：`child` 是一个 `Text`。`primary` 至多一个放最右，`borderless` 放它左边，两个按钮放进 `gap: 8` 的 `Row`（`justify: "end"`）。
- `Html`：组件做不到的才用，见 `mechanics.md`。
