# 卡片怎么用：按钮、改卡、表单、保险箱、小页面

卡片语言和桌面小组件是同一套 A2UI（组件和颜色名见技能 `widgets-design` 的 `reference.md`），对话里还多了输入框（`TextField`）、日期（`DateTimeInput`）、滑块（`Slider`）、表格（`Table`）和小页面（`Html`），容器还能写 `gap`。

## 发卡和改卡

- `human_show {id, text, a2ui}`：`id` 用字母数字和 `_ . -` 起个名字（「umbrella-1016」），不给就是这条消息的 id；`text` 一句话，通知、锁屏和画不了卡的地方显示它。
- 回包 `{accepted, card, problems, hints}`：`problems` 是被丢掉的组件或属性和原因（丢掉的地方留空，卡还在）；`hints` 是设计上的提醒，卡照样发出。根都画不了的卡会被拒绝，带原因。
- `human_card_update {id, a2ui?, data?, text?}`：卡留在原处，换版式给 `a2ui`，只改数给 `data: {"/路径": 值}`（合并进卡的数据，主人填过的不动，除非你改它）。回包一样带 `problems`、`hints`。只能改你自己发的卡。
- 追问、结果回来、长任务都改原卡：先 `human_show` 一张进度卡，做完 `human_card_update` 成结果。
- 长卡分几次出：先发能出的部分，没写好的子组件只写 id 不给定义，会画成占位块，再用 `human_card_update` 补上。
- 看样子：`capability_call {member: "person:owner", word: "card.preview", body: {id: "<卡的 id>", theme: "dark"}}`，回来是手机按对话里的宽度画出的图（`theme` 不给就是浅色）。发卡或改卡后看一次就够；手机没连上时报 `offline`。

## 卡上的操作

- **本地的，不经过你**：输入框、勾选、开关、选择、滑块、切标签的 `value` 写 `{path: "/x"}`，主人一动，卡上的数据当场变；显示的字读同一个路径（`formatString` 里写 `${/x}`）就跟着变。要你接着做事才放按钮。
- **按钮找你**：`Button {child, action: {event: {name: "book", context: {...}}}}`。主人一点，你收到一条他的消息：`[card <id>, action book] {"context": …, "data": {卡上现在的值}}`（密码框的值永远不在里面）。按钮只做这件事，接下来做什么是你的事；做完用 `human_card_update` 把结果写回原卡（「已订好」，去掉按钮），不再发一张。
- **👍/👎**：每张你发的卡底下都有，主人点了你收到 `[card <id>, feedback up] 👍` 或 `[card <id>, feedback down] 👎`。怎么记见 `feedback.md`。
- 代主人先填一部分（比如把查到的地址预填好）：`person:owner/card.draft {card: "<id>", data: {...}}`。

## 让主人填：human_form

一张卡要齐所有字段，样例 `examples/form.json`：

```json
{"title": "登录 wb VPS", "why": "替你在上面跑部署脚本；密码直接进保险箱，我看不到",
 "schema": {"type": "object", "required": ["host", "user", "password"], "properties": {
   "host": {"type": "string", "title": "地址", "examples": ["1.2.3.4"]},
   "port": {"type": "integer", "title": "端口", "default": 22},
   "user": {"type": "string", "title": "用户名", "default": "root"},
   "password": {"type": "string", "title": "密码"}}},
 "secret": {"password": "WB_VPS_PASSWORD"}}
```

- 字段：`type` 是 string / number / integer / boolean（开关）；`enum` 变成选项；`format: date | time | date-time` 变成日期时间；`format: multiline` 是多行；`examples[0]` 是灰色提示；`description` 是字段下面一行小字；`default` 或 `values` 预填。不在 `required` 里的字段标「（选填）」。
- 卡由中枢按 schema 画好（标题、`why`、每个字段、「取消」「提交」），版式不用你管；必填的没填齐，「提交」点不了。
- 它先回一个回执，主人提交后结果经 `await_result` 回来：`{values: {host, port, user}, secret: {password: {ref: "WB_VPS_PASSWORD", masked: "****abcd"}}}`。`masked` 只是给你和主人核对的尾号，不是密码。
- 主人点「取消」结果是 `cancelled`：别马上再发同一张，问问他。默认 24 小时没填就结束（`expires_at` 最长 7 天）。

## 用保险箱里的值：`$vault.<名字>`

你永远看不到密码，按名字用：

```json
workspace.bash {"command": "sshpass -e ssh -p 22 -o StrictHostKeyChecking=accept-new root@1.2.3.4 df -h",
                "env": {"SSHPASS": "$vault.WB_VPS_PASSWORD"}}
```

- 调 API 也一样：`{"command": "curl -s -H \"Authorization: Bearer $TOKEN\" https://api.example.com/me", "env": {"TOKEN": "$vault.EXAMPLE_TOKEN"}}`。
- 中枢在命令真正跑之前才换进去；输出里出现的值（含 base64、URL 编码）变成 `***`。不要把它变形后打印。
- 第一次在一台机器上用某个名字，主人收到一张确认卡；他选「以后都可以」就不再问。没装 `sshpass` 先 `apt-get install -y sshpass`。
- 保险箱的其余用法（OAuth、应用和帮手的环境变量）见技能 `credentials`。

## 逃生口：小页面（Html）

组件表达不了的（计算器、小游戏、特别的图）才用 `Html {html, height}`：一份自带 CSS 和 JS 的完整 HTML，跑在沙箱里、不能联网、不引外部资源。颜色用 CSS 变量 `--ash-bg`、`--ash-surface`、`--ash-text`、`--ash-text2`、`--ash-accent`、`--ash-line`（跟着深浅色走），字体跟系统。要你做事就在页面里调 ash.send("动作名", {…})，和按钮一样回到你。卡下面有「存成应用」，主人点了你会收到 `[card <id>, action save_app]`：照技能 `build-app` 把它做成正式应用。
