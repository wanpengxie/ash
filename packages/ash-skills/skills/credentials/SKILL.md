---
name: credentials
description: 中枢保险箱怎么用：经过中枢的服务连接（OAuth）、密钥、密码、中枢生成的密钥；自己拿、自己存、自己授权，拿不到才向主人要；命令行工具自己的登录不归这里。
whenToUse: 要连一个经过中枢的服务（OAuth），要存一个你在服务商后台拿到的密钥，要中枢生成一个密钥，或缺一个只有主人能给的密钥、密码时；用 service:vault 的 connect、put、generate、request 之前。
---

# 凭据：经过中枢的归保险箱

**平台不替任何服务写代码**：连什么、怎么连、怎么用，都是你自己写模板、自己建应用、自己维护。

**分界**：经过中枢的东西（中枢的服务连接、网站账号密码、中枢自己要用的密钥）放中枢的保险箱，值只写不读，你永远拿不到。你身体（Ubuntu）里命令行工具自己的登录（wrangler、gh、Codex、DSH）由工具自己存，**不进保险箱**，也不用这里的词。

全在 `service:vault`：

| 词 | 干什么 |
|---|---|
| `list` / `describe {ref}` | 有哪些、类型、状态（`ok` / `waiting` 等主人填 / `broken` 失效 / `expiring`）、到期；从不给值 |
| `services` | 中枢能连哪些服务、每个还缺什么（`needs`）、怎么补（`how`） |
| `provider {service, auth_url, token_url, scopes, …}` | 教中枢连一个新服务：照服务商的 OAuth 文档写授权地址、换令牌地址、权限范围（主人批一次） |
| `connect {service}` | 开始 OAuth，回你一个授权页地址 |
| `put {ref, value, label, kind}` | 存你自己拿到的密钥（只写；不能覆盖主人存的和连接的令牌） |
| `generate {ref, label}` | 中枢生成随机密钥，谁都读不到，中枢的词按名字用 |
| `request {ref, label, why, help_url}` | 拿不到时向主人要：他收到一张卡，点「去填写」在密钥页填，你会收到通知 |
| `token {ref}` | **只有应用能调**：`needs` 里声明了 `{credential: ref}`、主人批过的应用拿到当前有效的值 |

## 连一个服务（OAuth）

1. `services` 看它缺什么；列表里没有这个服务，先照它的 OAuth 文档用 `provider` 教给中枢。缺 OAuth 应用（客户端 ID/密钥）时，照 `how` 在主人手机 Chrome 里（他已登录）自己建好，`put` 存进去。
2. `connect {service}`：主人会先收到一张批准卡（连谁、什么权限），批了你拿到 `auth_url`。
3. **自己点授权，不要把链接丢给主人**：先 `service:gate/lease.request {minutes: 10, goal: "在 Chrome 里替你点 X 的授权"}` 向主人借一会儿屏幕，批了以后 `apps.open_url {uri: <auth_url>, package: "com.android.chrome"}`，按技能 `phone-operation` 看屏幕、选主人的账号、点「允许」（Chrome 自己弹的提示先关掉）。页面跳回 `127.0.0.1` 显示「已连接」就好了。
4. 只有页面要密码、验证码、扫码时才请主人：「Chrome 里 X 要你登录一下，好了跟我说」。
5. `describe {ref: service}` 看到 `status: ok`。令牌中枢自己续；`broken` 了你重新走一遍。
6. **自己写连接器应用来用它**（技能 `build-app`）：`app.json` 的 `needs` 写 `{credential: "<service>", why: "以你的身份读写 X"}`，服务里每次调接口前 `call("service:vault", "token", {ref: "<service>"})` 拿当前有效的令牌（不要存盘），按服务商的 API 文档做成几个词（查、读、发…）。主人装应用时批一次。之后你和别的帮手都用这个应用的词；服务改了接口，你自己改应用。

## 密钥和密码

- 能自己拿的自己拿：主人已登录的后台里你自己建 API 密钥，`put` 存进去。
- 拿不到才 `request`，`why` 写清用来干什么，`help_url` 给去哪拿的页面。**别让主人把密钥发在对话里**，也别让他去设置里找——卡上的按钮会直接打开填的地方。
- 中枢自己的词要一个随机密钥（比如签名用），用 `generate`。

## 好的样子

主人说「以后用 Slack 通知我」。你 `services` 看到 slack 缺应用，就在主人 Chrome 的 api.slack.com 里建好应用、`put` 存客户端 ID 和密钥，`connect {service: "slack"}`，主人批了连接卡，你在 Chrome 里打开授权页、点「允许」，`describe` 显示 ok，告诉他：「Slack 连好了，以后通知会发到那里。」接着你写一个「Slack」应用（`needs` 里 `{credential: "slack"}`），有 `slack.post` 这个词，主人装的时候批一次。整个过程主人只点了两张卡。

## 常见错误

- 把授权链接发给主人让他点。
- 让主人把密钥、密码发在对话里，或叫他去设置里找。
- 把 wrangler、gh 这类命令行工具的登录塞进保险箱，或者反过来把中枢服务的令牌拿到身体里用。
- 没看 `describe` 的 `status` 就说连好了。

## 怎么核对

- `describe {ref}`：`configured: true`、`status: ok`。
- 连接类再用一次它的词（读一条数据）确认能用。
