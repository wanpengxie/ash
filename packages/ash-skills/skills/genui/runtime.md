# 卡片背后：后端、按钮调用、实时数据、休眠

卡片可以只是展示，也可以是一个完整的小应用：背后是 Ash 中枢的全部词（经路由和关卡）、你用 `build-app` 现写的后端（一个 Ash 应用）、和帮手。

## 什么时候要后端

| 卡片要做的 | 怎么做 |
|---|---|
| 只是看（结论、对比、清单、日程） | 只发卡，不要应用 |
| 主人在卡上切换、勾选、筛选、拖滑块 | 只发卡，输入用 `{path}` 绑定，在手机上当场生效 |
| 主人按钮要你接着想、接着做 | 只发卡，按钮用 `{event}` 或 `{ask}` / `{tell}` |
| 按钮直接做事（建日历、开灯、记一笔、查一下） | 要应用：按钮 `{call}` 调词 |
| 数据要一直在变（心率、价格、进度、计数） | 要应用：`a2ui.sources` 绑数据源 |
| 存东西、算东西（记账、打卡、计分） | 要应用：后端存数据，卡片调它的词 |

要应用时：先照技能 `build-app` 写一个应用（`apps.scaffold` 起步），在 `app.json` 的 `needs` 里写清要用的词（比如手机的 `calendar.create`、`health.read`），主人装应用时批一次；再 `human_show {app: "<应用 id>", …}` 发卡。只为这张卡写的应用加 `temporary_app: true`：卡全部收起后它会被回收，主人点「存成应用」就留下。

## 按钮的动作

| 动作 | 做什么 |
|---|---|
| `{call: {member, word, body, result, timeout_s}}` | 以卡片所属应用的身份调一个词，结果写进卡片数据的 `result` 路径；不是只读的词，关卡会问主人（他就在屏幕前） |
| `{ask: {agent, text, result}}` / `{tell: {agent, text}}` | 问 / 交代一个帮手（默认是你），带着卡上现在的数据；回答写进 `result` |
| `{copy: {text}}` | 复制到手机剪贴板 |
| `{event: {name, context}}` | 一条主人的消息回到你（原来的做法） |

`body` 和 `text` 里可以写 `{path}` 或 `formatString`，用的是主人按下时卡上的值。按下后卡上自己显示「处理中」和结果（成功、失败的原因），不用你再说一句。

## 实时数据

`a2ui.sources` 把一个数据路径绑到数据源，只在卡片活跃时运行：

```
"sources": {"/bpm": {"member": "app:hr", "word": "hr.now", "every_s": 10, "pick": "/bpm", "keep": 60}}
```

- 定时读：`member` + `word` + `every_s`（至少 5 秒）；事件：`{"event": "device:*/sense.health", "pick": "/items/0/value"}`。
- `pick` 从结果里取一个值；`keep: n` 把值接成最近 n 个的列表，给 `Chart` 的 `values: {"path": "/bpm"}` 画实时折线。
- 被绑的路径在 `data` 里先给一个初值（空列表或空字符串），没数据时卡也画得出来。
- 没有 `app` 的卡不跑数据源。

## 让卡片该睡就睡

每张卡都会自己停，不用你写什么：离开屏幕 1 分钟「闲置」（数据源暂停），再 30 分钟「休眠」（数据冻结，临时应用停掉），24 小时没人看没人点就「收起」；主人再看到或点一下就醒（收起的不再醒）。

- 事情做完就 `human_card_update` 写上结果，再 `capability_call {member: "person:owner", word: "card.close", body: {id}}` 收起；临时的卡发的时候给 `ttl_min`。
- 常驻（离开屏幕也一直更新，比如正在派送的快递）**只有主人能开**：卡上有「常驻」开关。你觉得该常驻，就用 `service:cards/pin` 建议，`purpose` 写清理由——主人每次都会收到确认卡，由他点。`ttl_min` 只能让卡更早停，最长一天。
- `service:cards/list` 看哪些卡在跑；主人在应用「卡片」里也能看、能休眠、能收起。

## 例子

- `examples/heart-live.json`：心率实时图，应用 `hr` 的 `hr.now` 每 10 秒读一次，接成最近 60 个点。
- `examples/ledger-live.json`：记账卡，应用 `ledger` 存账；输入金额和用途，「记一笔」调 `ledger.add`，本月合计和柱状图从 `ledger.month` 来。
- `examples/booking-confirm.json`：确认预约，「确认」调应用 `booking` 的 `booking.confirm`，它用 `needs` 里批过的手机 `calendar.create` 建日程，结果写在卡上；「改时间」问你。也可以让按钮直接调手机：`{call: {member: "device:<手机编号>", word: "calendar.create", body: {…}}}`（编号从上下文的设备列表拿，卡片所属应用要在 `needs` 里有这个词）。
