---
name: cards
description: 在对话里给主人发任意卡片：展示信息（表格、图表、列表、标签页）、让他选、让他填（含密码框，直接进保险箱）、内嵌小页面；怎么改原卡、怎么接住他在卡上的操作。
whenToUse: 要给主人看结构化的东西（比价、日程、清单、数据、图表），要他在几个东西里选、调个数、填信息（登录一台服务器要地址端口用户名密码），或要一个小工具（计算器、小游戏）时；用 human_show {a2ui}、human_card_update、human_form 之前。
---

# 对话里的卡片

想给主人看什么、要他选什么、填什么，**直接在对话里发一张卡**。不要让他去设置页、密钥页或别的地方填，也不要让他把密码打在对话里。

卡片语言和桌面小组件是同一套（A2UI，组件和颜色见技能 `widgets-design` 的 `reference.md`），对话里还多了输入框、日期、滑块、表格和小页面。

| 工具 | 干什么 |
|---|---|
| `human_show {a2ui, id, text}` | 发一张卡。`id` 给它起个名字（以后改它用）；`text` 是一句纯文字摘要（通知、锁屏、看不了卡的地方显示它） |
| `human_card_update {id, a2ui?, data?}` | **改原卡**，不发新卡：换版式给 `a2ui`，只改数给 `data: {"/路径": 值}`。追问、结果回来、长卡分几次补全都用它 |
| `human_form {title, why, schema, secret?}` | 一张表单卡，主人填完点「提交」才回来；`secret` 里的字段是密码框，值直接进保险箱 |
| `widget.card.validate {a2ui, surface: "chat"}` | 发之前先查一张卡（`service:widgets`） |

## 展示：一张卡说清楚

- 比价、日程、清单用 `Table` 或 `List`；趋势用 `Chart`（要 `style.height`）；几类信息用 `Tabs`。
- 主人可以自己动的东西（切标签、勾选、拖滑块、筛选）放进卡里，`value` 写 `{path: "/x"}`：手机上当场生效，**不经过你**。显示的字读同一个路径（`formatString` 里写 `${/x}`）就会跟着变。
- 要你接着做事的才放按钮：`Button {child, action: {event: {name: "book", context: {...}}}}`。主人一点，你收到一条他的消息：`[card <id>, action book] {"context": …, "data": {卡上现在的值}}`。按钮只做这件事，接下来做什么是你的事；做完用 `human_card_update` 把结果写回原卡（比如「已订好」），不要再发一张。
- 长卡先发能出的部分，没写好的子组件只写 id 不给定义，会显示成占位块；后面用 `human_card_update` 补上。

## 让主人填：human_form

一张卡要齐所有字段。例：登一台 VPS。

```json
{"title": "登录 wb VPS", "why": "替你在上面跑部署脚本",
 "schema": {"type": "object", "required": ["host", "user", "password"], "properties": {
   "host": {"type": "string", "title": "地址", "examples": ["1.2.3.4"]},
   "port": {"type": "integer", "title": "端口", "default": 22},
   "user": {"type": "string", "title": "用户名", "default": "root"},
   "password": {"type": "string", "title": "密码"}}},
 "secret": {"password": "WB_VPS_PASSWORD"}}
```

回来的是 `{values: {host, port, user}, secret: {password: {ref: "WB_VPS_PASSWORD", masked: "****abcd"}}}`。你永远看不到密码，按名字用：

```json
workspace.bash {"command": "sshpass -e ssh -p 22 -o StrictHostKeyChecking=accept-new root@1.2.3.4 uptime",
                "env": {"SSHPASS": "$vault.WB_VPS_PASSWORD"}}
```

调 API 也一样：`{"command": "curl -s -H \"Authorization: Bearer $TOKEN\" https://api.example.com/me", "env": {"TOKEN": "$vault.EXAMPLE_TOKEN"}}`。第一次在一台机器上用某个名字，主人会收到一张确认卡；他选「以后都可以」就不再问。没装 `sshpass` 先 `apt-get install -y sshpass`。

字段：`type` 是 string / number / integer / boolean；`enum` 变成选项；`format: date | time | date-time` 变成日期；`format: multiline` 是多行；`examples[0]` 是灰色提示；`values` 预填。主人点「取消」时结果是 `cancelled`：别马上再发同一张，问问他。

## 逃生口：小页面（Html）

组件表达不了的（计算器、小游戏、特别的可视化），放一个 `Html {html, height}`：一份自带 CSS 和 JS 的完整 HTML，跑在沙箱里、不能联网。颜色用 CSS 变量 `--ash-bg`、`--ash-surface`、`--ash-text`、`--ash-text2`、`--ash-accent`、`--ash-line`（跟着深浅色走）。要你做事就在页面里调 ash.send("动作名", {…})，和按钮一样。卡下面有「存成应用」，主人点了你会收到 `[card <id>, action save_app]`：照技能 `build-app` 把它做成正式应用。

## 好的样子

主人说「帮我在 wb 那台 VPS 上看看磁盘」。你发一张 `human_form`：地址、端口（预填 22）、用户名（预填 root）、密码（`secret` 存成 `WB_VPS_PASSWORD`）。他在对话里填完点提交，你拿到地址和用户名，用 `workspace.bash {command: "sshpass -e ssh … df -h", env: {SSHPASS: "$vault.WB_VPS_PASSWORD"}}` 登上去；他点了一次「以后都可以」。你把结果做成一张卡：一个 `Table` 列出各分区用了多少，满了的标红，底下一个「清理日志」按钮。他点了按钮，你清完用 `human_card_update` 把表里的数字改掉、按钮换成「已清理 3.2 GB」。整件事里他没离开对话，也没见到密码。

## 常见错误

- 让主人去设置页、密钥页填东西，或让他把密码发在对话里。
- 一个信息问一句，来回五六轮；该一张表单卡填完。
- 主人每点一下都发一张新卡；应该改原卡。
- 把能在卡里本地完成的切换（标签、筛选、滑块）做成按钮让你来回处理。
- 拿到 `masked` 以为是密码；它只是给你和主人核对用的尾号。

## 怎么核对

- 发卡的回包里有 `problems` 就照着改（`human_card_update`），它列出了被拿掉的部分和原因。
- `workspace.bash` 的输出里密码应是 `***`；看到明文说明它被你变形输出了，别这么做。
