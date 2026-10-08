---
name: build-app
description: 为主人写一个 Ash 应用（有页面、有工具、可带桌面卡片的小程序）：什么时候值得写、怎么拆工具页面卡片和数据、固定的写法步骤、怎么自测。
whenToUse: 主人想要一个长期用的小工具（记账、书单、习惯、清单……），或一类事反复出现、值得有地方存数据并在页面和桌面上看；要改一个自己写过的应用的结构时。
---

# 写一个好的 Ash 应用

应用是你的器官：主人在页面里能做的，你用同一套工具也能做。写之前先读一遍完整契约（`apps.contract`，容器里 `/root/apps/APP-CONTRACT.md`）；本技能只讲怎么做得好。装好以后的管理见技能 `operate-apps`。

## 该不该写成应用

- **写**：同一类数据会反复读写（待办、书单、习惯、开销），主人要有页面看、有时还想在桌面上看，你也要随时记和查。
- **不写**：一次性的答案直接回复；一份报告写成文件交给他；到点说一句话用 `timer_set`；桌面只需要看一次的内容用独立卡片（技能 `widgets-design`）；只是提醒不需要数据。
- 先 `apps.list` 看有没有现成的应用可以承载，别重复造。

## 先想清楚再动手

用同目录 `design-sheet.md` 填一遍，答案要能写成这五样：

1. **role**（一句话）：它管什么、什么时候该用它。你每一轮都看得到，写得具体（「主人的书单：说到想读、在读、读完了哪本书，或读到哪一页，就记进来」），别写「阅读应用」。
2. **数据**：存在 `data_dir`（默认 `data/`）里的一个 JSON 文件，结构先画出来，每条有 `id`。页面里不要用 `localStorage` 存主人的数据，你看不到也改不了。
3. **工具**：页面上每种操作对应一个工具，**读和写都要有**，命名 `<应用 id>.<动作>`；读的标 `readOnlyHint: true`，改数据的标 `false` 并在结果里带 `activity`（一句话说改了什么，主人在页面里改的时候你就看到这句）。`title` 写中文动宾短语，`description` 写给你自己看的英文或中文都行，说清参数。
4. **页面**（surface，最多 16 个，通常 1–3 个）：窄屏竖排，一页里的多个视图用 `app.show` 切换，页面通过 `app.call` 调工具，不另存数据。出错时 `message` 直接显示给主人，写清楚的中文。
5. **卡片**（`cards`，最多 8 张）：画卡片的工具只读，从现在的数据画，大小按 `widgets-design` 选（多数 `4x2`），不要硬塞 30 条；`action` 工具处理卡上的勾选。卡片 id 在桌面是 `<应用 id>.<卡片 id>`，主人想放桌面就 `widget.bind`。

需要手机的东西（健康数据等）才写 `needs`，每项写给主人看的 `why`；不需要就留空，这样安装时主人看到的是「不需要用 Ash 的其他东西」。

## 做法

1. `apps.scaffold {id, name, summary, role, surfaces, tools}`：写出一个能直接运行的清单应用（工具 `list/add/done/remove`、一张卡片 `card`/`card.tap`、第一页）。你在 `tools` 里另起名字的工具先回占位话。它会替你写好 `publisher`，已有 `app.json` 的文件夹不会被覆盖。
2. 改 `/root/apps/<id>/`：`server.mjs` 里的 `TOOLS` 和 `handle()`、`card()`，`ui/<页面>.html` 的正文；`ui/app.js`、`ui/app.css`、`icon.png` 不用动（图标要 PNG 或 WebP）。服务只用 Node 自带模块最省事。**stdout 只能写协议**，日志用 `console.error`（脚手架已把 `console.log` 转到 stderr）。
3. `apps.validate {id}`：像安装一样检查并真的启动一次、调一次每张卡片的工具。`error` 必须清零，`warning`（没写 `role`、没标 `readOnlyHint`、只有只读工具、页面用了 `localStorage`……）也都改掉。
4. 自测：见下面「怎么核对」。
5. `apps.install {id}`：主人会在一张卡上看到它要的一切并决定，不通过检查就不会打扰他。**不要说「装好了」**，等批准、应用出现在 `apps.list`（`granted: true, running: true`）再说。

## 好的样子

同目录 `example-reading/` 是一个完整、能跑的应用「阅读记录」：脚手架的骨架，改成书的数据模型（`want/reading/done`、页数、评分），8 个工具（读 3 个：`list`、`stats`、`card`；写 5 个），两个页面（书架、统计），一张 4x2 卡片只放在读的三本书，每本一个「读完」勾选框加进度条，底下一行「想读 N 本 · 读完 N 本」。`app.json` 的 `role` 一句话讲清用途。照它的样子：数据模型先行，`activity` 句子具体（「《三体》读到第 120 页」），卡片只放最要紧的几行，重复添加同一本书时给出中文原因而不是静默成功。

## 常见错误

- 只写页面，没有工具，或只写读工具：`apps.validate` 会拦或警告。页面能做的你也要能做。
- `role` 含糊，之后你不知道该把事记进哪个应用。
- 画卡片的工具里写死内容，或没标只读；卡片放太多行被截断。
- 改了 `server.mjs` 或 `cards` 忘了 `apps.restart`；改了 `needs` 没重新 `apps.install`。
- 在服务里 `console.log` 打日志到 stdout 破坏协议（脚手架已转，自己换成别的输出就会出错）。
- 服务文件放进 `data_dir`；把 `ui/` 页面写成要加载外部脚本（页面是自包含的，默认不联网）。
- 装完不自测，把没用过的东西交给主人。

## 怎么核对

1. `apps.validate` 返回 `ok: true` 且 `problems` 为空，`tools` 里有你设计的全部工具，`surfaces` 里有全部页面。
2. 装好后，亲自 `capability_call {member: "app:<id>", word: …}` 用示例数据把每个读写工具各调一次：加一条、改一条、查出来、删掉，看结果和 `activity`。
3. `apps.describe` 里 `cards[].problem` 为空；`widget.list` 里 `<应用 id>.<卡片 id>` 这张卡的 `problem` 为 `null`。也可以自己调 `<id>.card` 取回卡片内容交给 `widget.card.validate`，并数一数行数，对照 `widgets-design` 里 4x2 能放几行。
4. `apps.logs` 里没有报错；页面你看不到图，所以保持页面简单，并请主人打开看一眼、说哪里不顺，再改。
5. 用一句话告诉主人：做了什么、记在哪、桌面上怎么放。
