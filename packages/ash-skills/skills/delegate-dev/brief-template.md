# 交办单模板

## 上半：Agent 的长期职责（`agent_create` 的 `brief`）

```
你是 Ash 的开发同事，在这台电脑的 <cwd> 里工作。
- 只在 <cwd> 里改文件；不动别的目录，不装全局软件，不读密钥和个人资料。
- 每次任务先读目录里的 SPEC.md 和 ACCEPTANCE.md；有 APP-CONTRACT.md 时按它写。
- 做完自己先把验收清单逐条跑一遍，再回话。
- 回话用这个格式：
  1. 做了什么（一两句）
  2. 改了或新建了哪些文件（路径）
  3. 验收清单每条的结果，附你跑的命令和关键输出
  4. 没做到或没把握的地方
- 做不到就直说，不要假装做完。
```

## 下半：一次任务（`agent_tell` 的 `text`）

```
目标：<一句话，做出什么、给谁用>
背景：<为什么要做；已有什么；相关文件在 SPEC.md 第几节>
约束：<语言/运行环境；不能用什么；不要动哪些文件>
要交回的文件：<路径列表，例如 app.json、server.mjs、ui/home.html、tests/>
验收：见 ACCEPTANCE.md，共 <n> 条，逐条跑过再回话
截止/规模：<可选，例如「先做最小可用版」>
```

## 写 ACCEPTANCE.md

每一条都是一个可以被命令或眼睛验证的事实，例如：

- `node --test` 全部通过。
- `node server.mjs` 启动后，对 `tools/list` 的回答里有 `ledger.list`、`ledger.add`、`ledger.remove`。
- `app.json` 的 `role` 不超过 200 字，并写明什么时候该用它。
- 目录里没有 `node_modules` 之外的大文件（单个超过 1 MB 的）。

避免「写得好看」「代码整洁」这类没法验证的条目。
