---
name: connect-device
description: 把新电脑、网页或服务器接进 Ash，或排查设备连不上：查中转站、没有就按技能 relay 搭、配对、等配对通知、验证，再按体检结果用一句大白话告诉主人哪里不通。
whenToUse: 主人要接一台电脑或浏览器、想让电脑上的 Agent 干活、说某台设备连不上或断了，或设备列表里没有他说的那台；用 device_pair_start、service:link/diagnose 之前；中转站没好时先用技能 relay。
---

# 接设备

**手机**在 Ash 本机，直接连，不用中转站和配对；手机显示 offline 就看「连不上」那一节。**电脑、网页、别处的服务器**要经**中转站**（主人自己 Cloudflare 账号里的一个小程序）连进来，再**配对**。下面的 `<编号>` 是 `device_list` 里 `device:` 后面那一串。`service:link`、`service:bodies` 各词的 `hand` 参数只填这串编号，`device_*` 工具的 `device` 参数要填完整的 `device:<编号>`。

## 做法：每步先看现状，再动手

1. **看现状**：`device_list`（有哪些设备、在线与否、授了哪些权）；`capability_call {member: "service:link", word: "gateway.status"}`（`configured` 有没有中转站，`connected` 连着没有）。
2. **中转站没好就先弄中转站**：没有、没认领、连不上，都按技能 `relay` 做（用 wrangler 部署新的或领回旧的，再 `service:link/gateway.use {url, claim_secret}` 交给中枢认领），好了再回来配对。
3. **配对**：`device_pair_start {kind: "computer", name}`（`kind` 还有 `server`、`browser`）返回 `pair_id`。**配对码只给主人看**，你拿不到，也不用他念出来；告诉他去电脑上打开推给他的那个地址（Mac 和 Linux 能装，Windows 这一版还不支持）。新电脑请求接入后，主人会收到一张卡，有四个勾：出借能力、当作 body（文件和命令）、跑本地 Agent、网页对话。**批不批、勾哪些都由他定**，你替不了（`device_pair_approve` 你来调也会问他）。要交开发活（技能 `delegate-dev`），要勾「当作 body」和「跑本地 Agent」；只想网页聊天，勾网页对话就够。
4. **等配对通知**：配对每走一步，你会收到一条后台消息：`waiting`、`requested`、`approved`、`connected`，或 `rejected`、`expired`。发出后告诉主人你在等什么，然后做别的或结束这一轮，**不要轮询**。想主动看才用 `device_pair_status {pair_id}`。过期了就重新发起一次。
5. **验证**：别只信「connected」。`service:link/describe {hand}` 看各通道开着没有；再做一次只读调用：当 body 的电脑调 `body:<编号>` 的 `body.info`，其余在 `capability_list` 里看它的 `device:<编号>` 有没有词。刚改过权限词没出现，`service:link/refresh_manifest {hand}`；要当 body 却没有 `body:<编号>`，`service:bodies/bind {hand}`（会问主人）。验证过了，再对主人说接好了。

## 连不上：先体检，再说一句人话

`service:link/diagnose {hand?}` 返回 `ok` 和 `findings`（每条有 `code`、`message`）。挑最要紧的一条，用一句大白话告诉主人该做什么，不要念代码。

| `code` | 对主人说 | 你接着 |
|---|---|---|
| `relay.none` | 「还没有中转站，现在只有这部手机能直连，要接电脑得先搭一个。」 | 第 2 步 |
| `relay.down` | 「Ash 现在连不上你的中转站，多半是网络，我过一会儿再试。」 | 稍后再体检；一直不通看 `gateway.status` 的 `last_error` |
| `relay.claimed_by_other`、`relay.bad_secret`、`relay.missing_secret` | 「这个中转站不是这台 Ash 的，或者口令不对。」 | 问主人：换一个新的搭，还是用他自己的（`gateway.use`） |
| `relay.unsupported` | 「中转站的版本跟 Ash 对不上，要重新部署一次。」 | 技能 `relay` 第 2 节，部署到同一个 Worker |
| `tunnel.missing` | 「电脑在中转站上线了，但还没连到 Ash。」 | `service:link/reconnect {hand}` |
| `tunnel.not_allowed` | 「这台设备只被允许网页聊天，所以没连通道。要让它办事，得在权限里勾上出借能力、当 body 或跑本地 Agent。」 | `device_access_set`（会问主人） |
| `hand.offline` | 「这台设备现在没连着，看看电脑是不是关了、睡了，或 Ash 程序没开。」 | 他处理后 `reconnect` |
| `handshake.4001` | 「这台设备的身份对不上，需要重新配对。」 | 第 3 步 |
| `handshake.4003` | 「这台设备被撤销了，不会再连；要用就得重新配对。」 | 等主人决定 |
| `handshake.4008` | 「设备上的 Ash 程序版本太旧，要升级。」 | 请主人升级；`device_update` 要版本号和校验值，没有就别猜 |
| `handshake.4009` | 「同一台设备又连了一次，旧连接被顶掉了，一般不用管。」 | — |
| `handshake.4400`、`handshake.4500` | 「Ash 这边出了点小问题，稍后再试；反复出现我告诉你。」 | 稍后再体检 |

## 好的样子

主人：「把我书房的 Mac 接上，以后让 Codex 在上面写代码。」`device_list` 没有 Mac；`gateway.status` 说 `configured: false`。你说「你还没有中转站，我先帮你搭」，按技能 `relay` 登录 wrangler、问清名字和地址、部署、`gateway.use` 交给中枢，`gateway.status` 显示连上了。然后 `device_pair_start {kind: "computer", name: "书房 Mac"}`，告诉他在 Mac 上打开推给他的地址、装好后在卡上勾「当作 body」和「跑本地 Agent」。收到 `connected`，`body:<编号>` 的 `body.info` 回得出系统和工作目录。再说「接好了」，并转到 `delegate-dev`。

## 常见错误

- 有中转站还重搭；没问主人就当他同意了。
- 向主人要配对码，或替他批准接入、勾权限。
- 发出后反复 `device_pair_status` 轮询。
- 看到 `connected` 就说接好了，没做只读验证。
- 把 `handshake.4003` 说成「连不上」，其实是被撤销了。
- 把 `diagnose` 的原文丢给主人。

## 怎么核对

主人说「接好了」之前，你亲手拿到了：`device_list` 里它在线且权限对；一次只读调用的结果。
