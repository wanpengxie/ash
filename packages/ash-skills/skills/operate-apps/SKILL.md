---
name: operate-apps
description: 用好、管好已经装上的应用：日常往里记和查，出问题时看日志重启，升级而不丢主人的数据，哪些操作没有主人开口绝不能做。
whenToUse: 要往某个应用里记东西或查东西；应用打不开、工具报错、卡片没更新；要改或升级自己写过的应用；主人说要清空、卸载、停用某个应用时。
---

# 管好已装的应用

## 日常：把事记进该记的应用

每一轮的上下文里列着已装应用：`app:<id>`、`role`、工具名。事情属于某个应用的职责，就记进那个应用，不另记在别处；记完用一句话告诉主人记在哪。

1. `capability_call {member: "app:<id>", word: "<工具名>", body}`：应用自己的工具，读和改都直接执行，不弹卡，也不要跟主人说要他批。
2. 参数拿不准先 `capability_describe`，不要凭记忆猜。
3. 主人在页面或桌面卡片上改了什么，会出现在上下文的「应用里最近的变化」。那是已经发生的事：以它为准接着做（他勾掉了一条待办，就别再提醒那件事），不用复述给他。
4. 没有合适的应用就照常做；一类事反复出现，再提议写一个（技能 `build-app`）。

## 出了问题：先看，再改，再重启

1. `apps.list` / `apps.describe`：`running` 是不是 `true`，`error` 写了什么，`cards[].problem` 有没有。
2. `apps.logs {id, lines?}`（默认 100 行，最多 400）：服务写到 stderr 的内容、协议错误、Ash 记的启动退出；`last_exit` 说上次怎么结束的（退出码或信号）。崩溃后 Ash 会自己按 1 秒、2 秒……最长 1 分钟的间隔重启，所以日志里常常是一串启动和退出。
3. 改 `/root/apps/<id>/` 里的文件，然后 `apps.restart {id}`。它会先像 `apps.validate` 一样检查：不通过就不重启，旧的继续跑，问题在 `error.detail.problems`；改页面文件不用重启。
4. 改了 `app.json` 的 `needs`：用 `apps.install {id}`，要主人重新批准。`needs` 没变的修改用 `apps.restart` 就够，不用打扰他。
5. 修完把你做了什么、为什么出的问题，用一句话告诉主人。

## 升级而不丢数据

主人的数据在 `data_dir`（一般是 `data/`）里，改代码不会动它，但新代码读不懂旧数据就等于丢了。

1. 先备份：在容器里 `cp -r /root/apps/<id>/data /root/work/<id>-data-<日期>`。
2. 改 `version`（主.次.修，有行为变化就升次版本）；新字段在读取时给默认值，不要改旧字段的含义；要换结构就在 `load()` 里做迁移，并保留能读旧格式的分支。
3. `apps.validate` → `apps.restart`（`needs` 变了则 `apps.install`）。
4. 核对：调读工具，条数和重要内容和备份对得上；`apps.describe` 里卡片没有 `problem`；`apps.logs` 没有报错。
5. 出岔子：恢复备份的 `data/`，改回代码，再 `apps.restart`。

## 没有主人开口，绝不能做

- `apps.reset`：清空 `data_dir` 并重启。主人的数据清了就没了。只有主人明确要，或这是你自己还在写、还没给主人用的应用时才用。
- `apps.remove`：卸载，停掉、收回授权、拿掉卡片，并**删掉整个文件夹**（含你写的源码）。没有主人要求不要用。主人要卸载，先问他数据要不要留；留就 `keep_data: true`（文件夹和数据都在，之后可再 `apps.install`）。
- 手动删改 `data/` 里的文件、`apps.revoke`、`apps.disable`：同样要有主人的话。主人要关掉就 `apps.disable`（授权保留，可以再打开）；你重新 `apps.enable` 要主人确认。
- 不要改 Ash 自带的应用（`publisher` 是 `ash`，如「健康」）：新版本发布时文件会被换掉，数据保留；它们也删不掉，只能停用。
- 安装和新增权限永远要主人批准，别想办法绕开：`apps.install` 一定会弹卡。

## 好的样子

主人说「今天读完了《三体》，给五星」。你查上下文，有 `app:reading`，`role` 说管书单：`capability_call {member: "app:reading", word: "reading.finish", body: {book: "<id>", rating: 5}}`（id 不确定先 `reading.list`）。结果的 `activity` 是「读完了《三体》」，回主人：「记在阅读记录里了，五星。」不弹卡、不另存。

后来主人说卡片没更新。你 `apps.describe` 发现 `running: false`，`apps.logs` 末尾是 `SyntaxError`，是你上次改 `server.mjs` 漏了括号：改好，`apps.restart` 通过检查，`running: true`，一句话告诉他。

## 常见错误

- 事情属于应用却记到备忘或对话里，两边不一致。
- 看见报错就 `apps.reset`；或为了「干净」`apps.remove`，连源码一起删了。
- 改了文件没重启，还说「已修好」。
- 升级时直接改数据结构，没备份，也没读一遍旧数据确认。
- `needs` 变了却用 `apps.restart`：新权限不会生效。
- 不看日志就猜原因，反复重启。

## 怎么核对

做完任何一步，用读工具或 `apps.describe` 亲眼确认结果（数据条数、`running`、卡片 `problem`），再对主人说「好了」。
