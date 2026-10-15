---
name: upgrade
description: 在线升级三样东西：这部手机上的 Ash（App 和内核两个包）、接进来的电脑上的 Ash 程序、自建在服务器上的中转站。都只从 GitHub 发布页下载、按发布页的校验值校验，失败不改旧版本。
whenToUse: 主人说「把手机升到 X」「升级 Ash」「电脑上的程序太旧」「中转站升一下」；设备体检报 handshake.4008；主人问现在是什么版本、有没有新版本。
---

# 升级

三条路线，下载都只走 GitHub 发布页，没有镜像。连不上 GitHub 是那台设备自己的网络问题（让主人配好代理，`HTTPS_PROXY`），不是你绕开的理由。每样都先校验再换，校验不过就什么都不改。

## 做法

### 手机（App + 内核）

1. `capability_call {member: "service:host", word: "update.install", body: {version: "0.4.49"}}`（不给 `version` 就是最新版）。中枢去发布页读 `SHA256SUMS`，交给宿主下载、校验、安装：先 App，后内核。发布仓库是私有的，就用保险箱里的 `GITHUB_TOKEN`（只读令牌，没有就只试公开地址；令牌你看不到，也不要问主人要原文）。
2. 它立刻回 `{started, version, via}` 并在后台做。`via: "shell"`：宿主用调试身份直接装，不用主人动手。`via: "installer"`：系统安装器，每个包会弹一条通知，告诉主人「点通知，在系统界面点「安装」」。
3. 用 `update.status` 看进度：`downloading`、`installing`、`waiting_user`（等主人点）、`done`、`failed`（`message` 说原因；下载或校验失败时什么都没装）。别连着问，隔一会儿看一次。
4. 装内核会重启中枢：你这一轮会断，回来时就是新版本。回来后看 `service:admin/status` 的版本确认。

### 电脑上的 Ash 程序

- 中枢自带一个版本和各平台的校验值。电脑连上来时比它旧，中枢会**自动**升级（设置 `devices.auto_update`，默认开；主人要关就 `service:admin/settings.set {"devices.auto_update": false}`）。
- 手动：`device_update {device}` 就够了，不用填版本和校验值。要装别的版本才给 `version` 和 `sha256`（从 `github.com/wanpengxie/ash/releases` 那个 `device-v*` 的 `SHA256SUMS` 里取该平台那一行，别猜）。
- 太旧、连协议都对不上的电脑（体检 `handshake.4008`）：中枢在加密连接里告诉它要装哪个版本，它会自己下载、校验、换版本、重启再连。你等它回来即可，不用主人动手。只有它连中枢都连不上时（比如中转站换了、它还在旧中转站上），才请主人在那台电脑上跑 `~/.ash-device/current/bin/ash-device update --version-to <版本> --sha256 <值>` 再重启服务。

### 自建中转站（跑在主人服务器上的那种）

- 这台服务器是你配好对、当 body 的电脑时：`capability_call {member: "body:<编号>", word: "workspace.bash", body: {command: "/opt/ash-relay/bin/upgrade.sh 0.7.1"}}`（以 root）。版本号看 `github.com/wanpengxie/ash-gateway/releases`。
- 脚本从发布页下载、按 `SHA256SUMS` 校验、切换、重启，等 `/v1/health` 报出新版本；起不来会自动回滚到原来的版本、退出码 1。看输出最后一行判断。
- 升级时中枢和所有电脑会断开一下再连上，这是正常的。
- Cloudflare 上的中转站不走这里（发版时自动部署；要自己部署按技能 `relay`）。

## 好的样子

主人：「把手机升到 0.4.49。」你调 `update.install {version: "0.4.49"}`，回来 `via: "shell"`，告诉主人「在下载，装好后我会重启一下，回来就是新版本」，过一会儿看 `update.status` 是 `installing`。断开、重连后看版本是 0.4.49，说「升好了」。要是 `via: "installer"`，就说「手机上会弹两次安装确认，点「安装」就行」。

## 常见错误

- 自己去找 APK 地址、手算校验值，或从别的网站下载：只用这些词，它们只认 GitHub 发布页。
- 下载失败就换镜像、改地址：不行，先查那台设备的网络和代理。
- `update.install` 一回来就说升好了：它只是开始了，等 `done` 或重连后看版本。
- 电脑报 4008 就让主人去手动升级：它会自己升，先等一会儿。
- 自建中转站升级失败后自己登服务器改文件：脚本已经回滚了，把输出告诉主人。

## 怎么核对

- 手机：重连后 `service:admin/status` 的版本是目标版本。
- 电脑：`device_describe {device}` 的 `version` 是目标版本，且在线。
- 中转站：`upgrade.sh` 最后一行是 `relay <版本> is up`；`service:link/gateway.status` 的 `connected` 为 true。
