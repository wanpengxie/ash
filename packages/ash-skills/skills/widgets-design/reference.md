# 桌面卡片速查

这些都来自手机和核心的实际检查（`widget.card.validate` 与 `widget.card.put` 的说明是同一套规则）。

## 标称尺寸与字号

| size | 还没放到桌面时核对按 | 预览图按（手机宽 360–411 dp） | 预览的内容区（外框留 14 dp） |
|---|---|---|---|
| 2x2 | 150×150 dp | 148–174 × 164–192 dp | 120–146 × 136–164 |
| 4x2 | 330×150 dp | 312–363 × 164–192 dp | 284–335 × 136–164 |
| 4x4 | 330×330 dp | 312–363 × 345–401 dp | 284–335 × 317–373 |

预览图的大小按桌面四列格子算：格子宽 =（屏幕宽 − 32）÷ 4，高是宽的 1.1 倍，小组件 = 格子 × 列数（行数）− 16。13sp 正文一个汉字宽 13 dp、一行高约 18 dp。

放到桌面后按那个小组件实际的大小画（主人可以拉伸）。`variant` 字号（sp）：`h1` 30 粗、`h2` 17 粗、`h3` 15 粗、`h4` 14 粗、`h5` 13 粗、`body` 13、`caption` 12（次要色）。大数字用 `h1`，标题用 `h3`/`h4`，`style.fontSize` 可改。卡片内容第一行文字如果就是卡片 `title`，外框不再重复印标题；否则外框在上面多印一行 12sp 小标题。

## 组件

能画：`Text`、`Image`、`Icon`、`Row`、`Column`、`Stack`、`Grid`、`List`、`Card`、`Tabs`、`Divider`、`Spacer`、`Button`、`CheckBox`、`Switch`、`ChoicePicker`、`ProgressBar`、`Badge`、`Clock`（实时）、`Timer`（实时正计时或倒计时）。

画不了，会被拒绝并给出原因：`Video`、`AudioPlayer`、`TextField`、`DateTimeInput`、`Slider`、`Modal`、网页、脚本、动画、图表、地图、SVG 图片；`style` 里的 `border`、`shadow`、`gradient`、`fontFamily`、`transform`。要边框，把元素放进背景色是边框色、padding 是边框宽的容器；要图表，用 `ProgressBar`、`Row` 的色块，或送一张图片。

`style` 可用：`background`、`color`（子孙继承）、`cornerRadius`、`padding`、`margin`（数字、`[上下, 左右]`、`[上, 右, 下, 左]` 或 `{top, end, bottom, start}`，单位 dp）、`width`/`height`（dp、`fill`、`wrap`）、`fontSize`、`fontWeight`、`italic`、`underline`、`strikethrough`、`textAlign`、`maxLines`、`ellipsize`（`end`/`middle`/`start`/`none`）、`lineHeight`、`letterSpacing`、`opacity`、`place`（`Stack` 子项位置）。

文字里写 `**粗体**`、`*斜体*`、行内代码、删除线、链接、标题或 `-` 列表这类简单 Markdown，会画成对应的格式，不会原样显示。图片是 `https://` 或 `data:image/...;base64`（不支持 SVG）；`Image` 的 `url` 还可以是 `avatar`（Ash 的脸）或 `icon:<名字>`。图标名：A2UI 常用名（`check`、`close`、`star`、`favorite`、`home`、`settings`、`refresh`、`add`、`delete`、`edit`、`mail`、`phone`、`person`、`search`、`share`、`warning`、`info` 等）和 Ash 自己的（`sun`、`cloud`、`rain`、`snow`、`wind`、`moon`、`heart`、`steps`、`weight`、`sleep`、`water`、`fire`、`calendar`、`clock`、`alert`、`bell`、`car`、`money`、`chart`）。

## 主题色

`text`、`textSecondary`、`accent`、`onAccent`、`background`、`surface`、`surfaceVariant`、`line`、`transparent`、`translucentDark`、`translucentLight`、`white`、`black`、`red`、`orange`、`yellow`、`green`、`teal`、`blue`、`purple`、`pink`、`gray`，都随深色模式变。具体色写 `#RRGGBB` 或 `#RRGGBBAA`（透明度在最后），或 `{light, dark}`。外框默认背景在浅色下接近白、深色下接近黑，圆角 22 dp；根上写 `background` 后默认补 14 dp 内边距和 22 dp 圆角。

## 限制

- 嵌套最多 10 层，用了 `sizes` 是 9 层；带 `weight` 的子项多占一层；`List` 的每一行各有一份新的额度。
- 一张卡最多 1500 个组件、16 个 `List`、16 套 `sizes`；整张卡 JSON 不超过 512 KB；单段文字不超过 20000 字；`title` 1–40 字；`id` 小写字母、数字、`. _ -`，最多 64。
- 桌面最多同时存 50 张卡；一个创建者的卡只有它自己或主人能改、能删。
- 图片的总内存有上限，太多太大会有的画不出。

## 事件

`{event: {name, context?}}` 点了以后，核心给卡片的创建者发 `widget.action {card, action, component, item?, checked?, value?, context?}`；创建者是 Agent 时，它还会收到一条 `[widget.action] …` 的消息。应用的卡片则交给应用自己的 action 工具。`Tabs` 的切换只在手机上，不通知。
