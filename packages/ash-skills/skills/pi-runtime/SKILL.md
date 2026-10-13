---
name: pi-runtime
description: 给帮手换模型、调思考强度、换到 pi 运行时；看哪些供应商和模型现在能用、不能用时怎么补齐（密钥、Codex 登录、代理 v2rayA），并看懂连不上时自动切到 DeepSeek 的提示。
whenToUse: 主人想换模型或换运行时、要用 Codex、问为什么被切到 DeepSeek、或你判断当前模型不合适（要看图、上下文太长、要更强的推理、想省钱）；用 service:agents 的 runtime.catalog、update、configure 之前。
---

# 模型与运行时

帮手的「脑子」由运行时（DSH 或 pi）和模型决定。你和主人用的是同一套词：**先看目录，再用 `update` 长期保存，需要临时试一下才用 `configure`**。主人在 App「幕后 → 模型」里改的也是这几个词；那一页只是兜底，改模型主要是你的事。

## 做法

1. **看现状和能用的**：`capability_call {member: "service:agents", word: "runtime.catalog", body: {agent}}`。返回：
   - `saved`：声明里长期保存的（`kind`、`model`、`effort`、每个模型自己的 `models`）；`effective`：现在真正生效的（可能因为临时改过、或连不上被换成 DeepSeek 而不同）。
   - `providers[]`：每个供应商有 `ready`（现在能不能用）、`auth`（要密钥还是要登录）、`how`（不能用时怎么补齐）、`needs_proxy`、`models[]`。模型有 `id`（写成 `提供方/模型`）、`context_window`、`images`（能不能看图）、`reasoning`、`efforts`（它接受的思考强度，`off` 是不思考；空表示不思考，不能设）。
   - `catalog`：模型清单有多新（`checked_at` 上次问上游是什么时候，`upstream_at` 收到的最新清单的日期，`refreshing` 正在更新）。清单自己跟着上游走（每天一次，读目录时发现过旧也会在后台更新），连不上就用上次的，不会报错；新模型出来了但目录里还没有，隔一阵再读，或者主人说马上要用就直接写 `提供方/模型`（OpenRouter 的未知模型会放行）。
   - 模型很多的供应商（OpenRouter）不列模型：加 `provider: "openrouter"`，再用 `search` 按名字找。
2. **选**：只在 `ready` 的供应商里挑；要看图的任务别选 `images: false` 的；资料特别长看 `context_window`；简单日常用 `deepseek/deepseek-flash` 配低强度，难的推理再升到 `high` 或 `max`；`effort` 只能取该模型 `efforts` 里的值，写错会被拒绝并告诉你可选项。
3. **长期保存**：`service:agents/update {agent, runtime: {...}}`。`runtime` 是补丁，可以不写 `kind`，`models` 按模型合并（写 `null` 忘掉某个模型的设置）：
   - 换模型：`runtime: {model: "openai-codex/gpt-5.5"}`
   - 每个模型各有各的强度，切换时自动套用：`runtime: {model: "openai-codex/gpt-5.5", models: {"openai-codex/gpt-5.5": {effort: "high"}, "deepseek/deepseek-flash": {effort: "low"}}}`
   - 换到 pi：`runtime: {kind: "pi", model: "deepseek/deepseek-flash"}`；换回 DSH：`runtime: {kind: "dsh"}`。
   - pi 运行时改模型和强度，下一轮就生效，不用重启；换运行时种类会重启这个帮手（会话接着用）。返回的 `notes` 说这个选择还缺什么（密钥、登录）。
4. **临时试一下**：`service:agents/configure {agent, config: {model: "deepseek/deepseek-v4-pro", effort: "max"}}`，只管现在，中枢重启就忘。不带 `config` 是读回，里面有 `effective`（现在生效）和 `saved`（长期）。
5. **别的运行时**没有目录时，目录会给一份它自己报的模型清单；DSH 的模型仍在 DSH 自己那里，你照 `runtime.catalog` 返回的为准。

## 供应商不能用时，引导主人

- **要密钥**（DeepSeek、OpenRouter）：`ready: false` 且 `auth.kind` 是 `key`。密钥只有主人能存，你代存不了，也不要让他把密钥发给你：告诉他「请打开 App 的 幕后 → 密钥，粘贴 XX 的 Key」。他说好了，再读一次目录确认 `ready`。
- **要登录**（Codex，用 ChatGPT 订阅）：`auth.kind` 是 `login`。先请主人**临时打开手机的全局 VPN**（他的浏览器要能打开 OpenAI 的页面，你开不了），然后 `configure {agent, config: {login: "openai-codex"}}`，返回 `verification_uri` 和 `user_code`（`expires_in` 秒内有效）。用 `human_say` 把链接和码一起发给他（码单独成一行），请他点链接、输码。不要轮询，登录好了你会收到一条「Codex 登录成功」，那时才告诉他可以关 VPN。返回 `unavailable` 说明现在到不了 OpenAI（VPN 没开，或 v2rayA 没配）。
- **日常出去的路 v2rayA**（只有用 Codex 才需要，DeepSeek 不用）：容器里的代理。主人在手机浏览器打开 `http://127.0.0.1:2017`，第一次建账号，导入订阅、选节点、启动，HTTP 端口保持 20171。订阅是主人的私有东西，不要问他要。

## 自动切到 DeepSeek

Codex 中途连不上、没登录、登录失效，或选了 OpenRouter 却没存密钥，pi 会在**同一个会话**里改用 DeepSeek 接着做（历史都在），并给主人发一句话；连不上的情况每分钟试一次，通了自动切回。这是设计，不是出错，不用重试。主人问起来，用读回的 `effective.fallback`（`network`、`login`、`key`）和 `effective.route` 解释。

## 好的样子

主人说：「这个任务要看图，而且很难，用最强的。」你 `runtime.catalog` 看到 Codex 的 `gpt-5.5` 能看图、`efforts` 有 `xhigh`，但 Codex 的 `ready` 是 `false`、登录是 `none`。你不会硬换，而是说：「Codex 还没登录。你先打开手机的 VPN，我给你一个链接和码，输进去就能用。」`configure` 发起登录，`human_say` 把链接和码发出去；收到「登录成功」后 `update` 保存 `{model: "openai-codex/gpt-5.5", models: {"openai-codex/gpt-5.5": {effort: "xhigh"}}}`，再读一次目录，看到 `effective.model` 是它，才告诉主人好了，顺便说可以关 VPN。

## 常见错误

- 不看目录就猜模型名或强度：会被拒绝；`efforts` 空的模型不能设强度。
- 选了 `ready: false` 的供应商还以为生效：看 `update` 返回的 `notes` 和读回的 `effective.model`。
- 让主人把密钥发给你、或自己去找密钥：密钥只能主人在 幕后 → 密钥 里存。
- 没让主人开 VPN 就发起 Codex 登录；或者不停地读状态等登录，等通知就行。
- 把「被切到 DeepSeek」当成故障去重试；或者以为换模型会丢记忆（会话是接着的）。
- 用 `configure` 当长期设置：中枢重启就没了，长期的要用 `update`。

## 怎么核对

`service:agents/runtime.catalog {agent}`：`saved` 是你要的，`effective.model` 和 `effective.effort` 也是，`effective.fallback` 是空；`providers` 里它所在的供应商 `ready: true`。再让这个帮手回一句话确认真的在回。
