---
name: relay
description: 用 wrangler 完整管理主人的中转站（他 Cloudflare 账号里的 ash-gateway Worker）：登录授权、查现状、部署新的、领回旧的（重置认领）、绑自己的域名、把认领交给中枢、验证。
whenToUse: 主人要搭中转站、换中转站、领回旧中转站、换域名，或电脑/网页连不上而 gateway.status 说没有中转站、没认领、连不上；接电脑（技能 connect-device）之前中转站还没好时。
---

# 管理中转站

中转站是主人自己 Cloudflare 账号里的一个 Worker，程序是公开仓库 `https://github.com/wanpengxie/ash-gateway`，每个版本都发布成可以直接部署的文件（Release）。手机（中枢）主动连它，电脑、网页经它连回手机。你在自己的 Linux 身体里用 **wrangler**（Cloudflare 官方命令行）管理它：部署、改密钥、绑域名、看日志都靠它。中枢只负责**认领**和**连接**：你把地址和认领密钥交给 `service:link/gateway.use`。

工作目录统一用 `~/relay`。命令都在你的身体里跑（`bash`），长的放后台、写日志、再读日志，别让一条命令卡住你。身体里没有 curl 和 git，下载和访问网址都用 node 自带的 fetch（下面的写法照抄）。

## 0. 先看现状（每次都先做）

- `capability_call {member: "service:link", word: "gateway.status"}`：`configured` 有没有中转站、`url` 地址、`claimed` 被这台手机认领没有、`connected` 连着没有、`last_error`。
- 有地址就看网关自己怎么说：`node -e 'fetch(process.argv[1]+"/v1/health").then(r=>r.text()).then(console.log)' <url>` → `claimed`（有没有主人）、`owner_online`、`bootstrap_configured`（有没有设认领密钥）。
- 连着且认领的就是好的，别动。

## 1. 登录 wrangler（只需主人授权一次）

```bash
mkdir -p ~/relay && cd ~/relay
npx --yes wrangler@4 whoami 2>&1 | tail -5     # 已登录就直接用，跳过下面
nohup node /opt/ash/ash-skills/skills/relay/login.mjs > ~/relay/login.log 2>&1 &
sleep 2; head -1 ~/relay/login.log             # 授权链接
```

- 用技能自带的 `login.mjs`，**不要用 `wrangler login`**：手机浏览器会把回调打开两次，wrangler 拿同一个授权码换两次，第二次 `invalid_grant`，令牌就坏了。`login.mjs` 只换一次，直接写好 wrangler 自己的令牌文件。
- **授权你自己点，不要把链接丢给主人**：先 `service:gate/lease.request {minutes: 10, goal: "在 Chrome 里替你点 Cloudflare 授权"}` 借一会儿屏幕（主人点一下），再 `capability_call {member: "device:<手机>", word: "apps.open_url", body: {uri: "<链接>", package: "com.android.chrome"}}` 在手机的 Chrome 里打开（主人的 Cloudflare 登录状态在那里），按技能 `phone-operation` 看屏幕、点「Authorize / 授权」。跳到 `localhost:8976` 显示「授权成功」就完成了。
- 只有页面要输密码、过验证码时，才告诉主人：「Chrome 里 Cloudflare 要你登录一下，登好跟我说」，他说好了你接着点授权。
- 等 `grep -q LOGIN_OK ~/relay/login.log`（`LOGIN_FAILED`、`DENIED`、`TIMEOUT` 就重来一次，`PORT_BUSY` 是上一次的还在等，`kill` 掉它的进程再来）。再 `npx wrangler@4 whoami` 看他的账号。**有几个账号就问他用哪个**，然后后面所有命令前加 `CLOUDFLARE_ACCOUNT_ID=<id>`。
- 令牌留在你身体的 `~/.config/.wrangler`，wrangler 会自动续期。**不要读出、不要打印、不要发给任何人。**
- npm 下载很慢或失败：加 `--registry=https://registry.npmmirror.com` 再试。

## 2. 部署一个新的

先问主人两件事，**他确认了再动手**：
1. **Worker 叫什么**（默认 `ash-gateway`；他账号里已经有同名 Worker 时要说清楚：会覆盖它）。
2. **用什么地址**：默认 `https://<名字>.<他的子域>.workers.dev`；要用他自己的域名，问他具体用哪个子域名（必须是他 Cloudflare 账号里已有域名下的、没被别的服务占用的子域名）。

```bash
mkdir -p ~/relay/release && cd ~/relay/release && rm -f ash-gateway.mjs wrangler.jsonc
node -e 'const b="https://github.com/wanpengxie/ash-gateway/releases/latest/download/";Promise.all(["ash-gateway.mjs","wrangler.jsonc"].map(f=>fetch(b+f).then(r=>{if(!r.ok)throw new Error(f+" "+r.status);return r.arrayBuffer()}).then(x=>require("fs").writeFileSync(f,Buffer.from(x))))).then(()=>console.log("ok"))'
```

这是网关仓库发布好的构建结果（一个模块加一份可直接部署的配置），不用源码、不用打包。

- 改 `wrangler.jsonc`：`"name"` 改成定好的名字；用他自己的域名就加一项 `"routes": [{ "pattern": "<他的子域名>", "custom_domain": true }]`，只用 workers.dev 就不加。
- 在 `~/relay/release` 里 `npx --yes wrangler@4 deploy > ~/relay/deploy.log 2>&1`（按配置原样上传），从日志里拿到地址（workers.dev 那条和自定义域名）。
- 设认领密钥（见第 4 节），再交给中枢（第 5 节）。

## 3. 领回旧的（换了手机、重装过、旧手机丢了）

网关一次只认一个主人。`/v1/health` 显示 `claimed: true` 但不是这台手机（`gateway.status` 的 `claimed` 是 false），就要重置：

- **先问主人，说清后果**：「重置 <Worker 名>（<地址>）会清掉它上面所有已配对的设备和授权，之后要在这台手机上重新认领、电脑网页要重新配对。确认吗？」他确认了才做。
- `cd ~/relay && printf 'ash-%s' "$(date +%s)" | npx wrangler secret put RESET_EPOCH --name <Worker 名>`
- 再设一个新的认领密钥（第 4 节，同样带 `--name <Worker 名>`），然后第 5 节。
- 不知道是哪个 Worker：`npx wrangler deployments list --name <名字>` 或问主人；地址是自定义域名时，Cloudflare 后台该 Worker 的 Domains 里能看到。不要猜。

## 4. 设认领密钥

```bash
cd ~/relay && umask 077 && head -c 32 /dev/urandom | base64 | tr -d '\n' > secret
npx wrangler secret put BOOTSTRAP_SECRET --name <Worker 名> < secret > ~/relay/secret.log 2>&1
```

几秒后看 `<地址>/v1/health`（第 0 节的写法）应是 `"claimed": false, "bootstrap_configured": true`。

## 5. 交给中枢认领、连上

认领密钥要经过中枢，所以放进中枢的保险箱（技能 `credentials`），按名字交给中枢：

- `capability_call {member: "service:vault", word: "put", body: {ref: "relay_claim", value: "<secret 文件的内容>", label: "中转站认领密钥"}}`（只写，存进去就读不出来）。
- `capability_call {member: "service:link", word: "gateway.use", body: {url: "<地址>", claim_ref: "relay_claim"}, purpose: "让这台手机认领中转站 <地址>"}`。主人点一次确认卡，中枢从保险箱取出密钥、用手机自己的密钥完成认领并连上。
- 然后 **`rm -f ~/relay/secret`**，保险箱里的 `relay_claim` 也删掉不用管：认领只能成功一次，之后它没用了。
- **不要**让主人去设置里存密钥，不要把密钥发进对话。
- 用自定义域名时，`url` 填自定义域名（国内网络更稳）；地址以后要换，再 `gateway.use` 一次新地址即可（同一个 Worker 不用重新认领）。

## 6. 怎么核对

- `gateway.status`：`configured`、`claimed`、`connected` 都是 true；`/v1/health` 的 `owner_online: true`。
- 一句话告诉主人：中转站在哪个地址、好了；要接电脑就接着用技能 `connect-device` 配对。
- 失败时说人话：哪一步、什么原因（wrangler 日志里的报错原文摘一句），下一步打算怎么做。

## 好的样子

主人说「搭个中转站，用我的 ash.onestudio.cc」。你先看 `gateway.status`（没有中转站），`whoami` 发现还没登录，就起 `login.mjs`、在手机 Chrome 里打开授权页、自己点「授权」，登录成功后你看到他账号里已经有 `ash-gateway` 绑着 ash.onestudio.cc、`/v1/health` 显示被别的手机认领着。你问他：「你账号里的 ash-gateway（ash.onestudio.cc）现在归旧手机，重置会清掉它上面所有已配对的设备，之后在这台手机上重新认领。重置吗？」他说重置。你设新的 `RESET_EPOCH` 和认领密钥，`/v1/health` 变成 `claimed: false`，把认领密钥 `put` 进保险箱，再 `gateway.use {claim_ref}` 交给中枢，他点了确认卡，`gateway.status` 显示已连接。你告诉他：「中转站好了，地址 ash.onestudio.cc。要接电脑吗？」

## 常见错误

- 没问主人就覆盖、重置或换域名。
- 把 wrangler 的令牌打进对话或笔记；让主人去设置里存认领密钥；把认领密钥直接写在 `gateway.use` 里（它只收保险箱的名字）；把授权链接丢给主人自己点；用完没删 `~/relay/secret`。
- 用 curl、git（身体里没有）；用 `wrangler login` 登录（回调会换两次码而失败），或者自己另写一个登录程序。
- 看到 `connected` 就说好了，没看 `/v1/health` 的 `owner_online`。
- 主人有多个 Cloudflare 账号时自己挑了一个。

## 规矩

- **覆盖、重置、删除、换域名之前都先问主人**，说清是哪个账号、哪个 Worker、哪个地址、会影响什么。他说的名字或地址对不上他账号里的东西，停下来问，不要猜。
- 只在主人选的那个 Cloudflare 账号里动手。
- 令牌、认领密钥不打印、不写进对话和笔记；临时文件用完就删。
- 查日志用 `npx wrangler tail <名字>`（看实时请求）或读 `~/relay/*.log`。
