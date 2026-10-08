---
name: delegate-dev
description: 把开发活交给电脑上的本地 Agent（Codex、Claude Code 等）：什么活该交、怎么写交办单、怎么自己验收、怎么把文件取回来装成应用、怎么把日志整理成 issue。
whenToUse: 主人要做一个需要在电脑上写代码、跑测试或编译的东西，活太大或太久不适合你自己在容器里做；要给已经交出去的活补充修改；要把应用的故障整理成 issue 交回开发 Agent 时。
---

# 把开发活交给电脑上的 Agent

电脑上的本地 Agent（runtime：`codex`、`claude`、`workbuddy`）是你可以指派的同事：它在那台电脑上写代码、跑命令，答完交回给你。你负责说清楚要什么、**自己验收**、再交给主人。它只带 Ash 的三个沟通工具（`agent_list`、`agent_ask`、`agent_tell`），**用不了手机和 Ash 的其他能力**，也看不到你的容器。

## 什么活该交，什么不该

- **交**：多文件的开发、要装依赖和跑测试的、要在 Mac 或有特定环境的电脑上做的、预计超过十来分钟的、一次要大改的重构。
- **不交**：几行的小改、用脚手架就能完成的小应用（自己写更快）、要用手机能力的、涉及密钥或付款的、描述不清楚的。描述不清先问主人。

## 做法

1. **找电脑。** `agent_runtimes`：列出在线、且主人已允许使用本地 Agent 的电脑，以及上面装了什么 runtime、能选哪些模型。是空的就 `device_list` 看看：电脑没连上，或还没授权「使用本地 Agent」。授权要主人点头（`device_access_set` 会弹卡），告诉他去做，**不要绕开**；`logged_in: false` 就请主人先在电脑上登录那个 runtime。
2. **找或建 Agent。** 先 `agent_list`，有合适的、空闲的（`idle`）就复用。没有就 `agent_create`：`id`（`agent:` 加小写名字）、`name`、`summary`（一句话擅长什么）、`brief`（长期的职责和规矩，见 `brief-template.md` 上半）、`runtime: {device, kind, cwd, model?, effort?}`。`cwd` 用一个专门给这件事建的目录，别用主人的主目录。
3. **备料。** 开发 Agent 看不到你的容器，所以把要它读的东西写到它的 `cwd`：用 `capability_call {member: "device:<编号>", word: "workspace.write", body: {workdir: <cwd>, path: "SPEC.md", content}}` 写 `SPEC.md`（要什么）、`ACCEPTANCE.md`（验收清单）；要写 Ash 应用就把 `apps.contract` 返回的契约存成 `APP-CONTRACT.md` 一并写过去，并说明模板在契约里。写文件在审批模式下可能要主人批，照审批流程来。
4. **交办。** 用 `agent_tell` 发任务（它做多久都行，回话会作为一条消息回到你这里）。不要用 `agent_ask` 等：它只等 50 秒，之后只给回执，要一次次 `await_result` 去收，开发活不合适。任务正文按 `brief-template.md` 下半写：目标、背景、约束、验收清单、要交回哪些文件、怎么汇报。**同一个 Agent 同一时间只能做一件事**，上一件没完发新的会失败（「Previous remote task is still running」）；要换方向先 `agent_stop`。
5. **等。** 发出去就告诉主人「交给了谁、大概要做什么」，然后做别的事或结束这一轮，**不要轮询**。想知道它还忙不忙看 `agent_list` 的 `state`。
6. **验收。** 它回话了先别信，自己查：
   - `device:<编号>` 的 `workspace.bash {workdir, command}`：`git status`、`git diff --stat`、跑它说跑过的测试和构建，看 `exit_code` 和输出；超过 10 秒会先回 `process`，用 `workspace.poll {process}` 接着读到 `running: false`；
   - `workspace.read`、`workspace.grep` 看关键文件，对着 `ACCEPTANCE.md` 逐条打勾；
   - 它声称的和实际不符就 `agent_tell` 指出哪一条没过、证据是什么，让它改；
   - 同一条反复改不好，换思路或告诉主人，不要无限来回。
7. **取回文件。** 没有直接复制文件的能力，只能用 `workspace.read` 把文本读出来，再用自己的写文件工具写进容器（应用写到 `/root/apps/<id>/`）。单个文件不超过 4 MiB，长文件按 `next_offset` 分页读。图片和二进制读不回来原文（图片只能看）：让它把图标之类转成 base64 文本放进文件再读，或者干脆用脚手架生成的图标。
8. **装。** 应用文件取回后：`apps.validate`，修到没有 `error`，`apps.install`（主人批准），再按技能 `build-app` 的自测过一遍。不要把它的东西不经检查直接交给主人。
9. **收尾。** 用一句话告诉主人：做了什么、验证了什么、没验证什么。不再需要的 Agent 用 `agent_stop` 或 `agent_remove`。

## 把故障交回去：issue

应用出问题、你又不想自己重写时：`apps.logs` 取日志，复现一次，按 `issue-template.md` 写成 `ISSUE-<编号>.md`，用 `workspace.write` 写进开发 Agent 的 `cwd`，再 `agent_tell`「读 ISSUE-<编号>.md，修好，跑验收，回报改了哪些文件」。改完回到上面第 6 步验收，再取回文件、`apps.restart`（`needs` 变了用 `apps.install`）。

## 好的样子

主人说：「做一个能记账的应用，要能按月出图表，用 Mac 上的 Codex 来做。」

1. `agent_runtimes`：Mac 在线，Codex 已登录。`agent_create {id: "agent:coder", name: "写代码的", summary: "在 Mac 上写和测试代码", brief: …, runtime: {device: "device:mac", kind: "codex", cwd: "/Users/…/ash-work/ledger"}}`。
2. 把契约写成 `APP-CONTRACT.md`，把需求写成 `SPEC.md`，把验收写成 `ACCEPTANCE.md`：①文件夹里有 `app.json`、`server.mjs`、`ui/`；②读写工具齐全（`ledger.list/add/remove/summary`）；③`node server.mjs` 能按 MCP 回答 `tools/list`；④它自己写的测试全过；⑤不用任何要联网下载的运行时依赖。
3. `agent_tell` 交办，回主人：「交给 Mac 上的 Codex 了，做完我会验一遍再给你。」
4. 回话到了：`workspace.bash` 跑 `node --test`，读 `app.json` 和 `server.mjs`，发现第②条少了 `summary` 工具。`agent_tell`：「验收第②条没过：缺 ledger.summary，补上并跑测试。」
5. 通过后读回文件，写进 `/root/apps/ledger/`，`apps.validate`，`apps.install`，自测，再告诉主人。

## 常见错误

- 任务只写一句话，没有验收清单。它交回来的就是它自己觉得好的东西。
- 用 `agent_ask` 等一个很长的开发任务。
- 相信它的回话，不自己跑一遍。
- 把密钥、验证码、主人的私人资料写进交办单。
- 同时给同一个 Agent 派两件事。
- 没有授权就想办法让它跑起来，或者替主人答应「允许使用这台电脑」。
- 文件取回后不 `apps.validate` 就装。

## 怎么核对

验收清单每一条都有你亲手拿到的证据（命令输出、文件内容）；`apps.validate` 通过；装好后读写工具各调过一次；告诉主人时说清哪些是你验过的。
