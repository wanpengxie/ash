# ash

**ash** is a resident personal agent for your Android phone, built on [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh).

ash 是一个常驻在安卓手机上的个人 Agent，以 DSH 为底座。它不是 DSH 的一个插件，也不是 DSH 的一个壳：**ash 是 personal agent 的"系统"，DSH 是跑在上面的 agent harness"应用"**。两个世界之间是一套带版本号的双向 SDK（`ash-api/1`），在同一个进程里直接调用。

- **一直在**：前台服务守护 ash core；开机、升级、被杀后自动回来。Agent 设的提醒到点会把它自己叫醒。
- **你的手机就是它的手脚**：读屏、点击、输入、剪贴板、应用、系统设置、Shizuku shell、虚拟屏——都是"手机"这台设备的能力，由 ash 统一授权，敏感操作先问你。
- **在任何地方找到它**：配合自部署的 Cloudflare 网关 [ash-gateway](https://github.com/wanpengxie/ash-gateway)：
  - 你自己的浏览器配对后，打开网关地址就是同一个 Ash 界面（可以添加到主屏幕）；
  - 你的笔记本以 client 角色运行 ash core，把本机的 MCP 服务借给手机上的 Agent——Agent 直接多出这些工具，不用改任何配置。
- **DSH 原样**：手机上跑的是 npm 上发布的 DSH，逐字节一致；Android 适配全部在 DSH 之外完成（平台包、运行时预加载、宿主补丁层），社区插件、技能、MCP 照常可用。

## 架构

```text
 浏览器 / 笔记本 / 其他设备 ──── ash-gateway（你的 Cloudflare 账户）────┐
                                                                     │ WSS（手机只发起出站连接）
┌─────────────────────────── 手机 ────────────────────────────────────▼──────────┐
│ Android 宿主（Kotlin）        ash core（Node，一个进程）                          │
│  前台服务、payload 安装       ├─ 成员·设备·能力·授权·确认·定时·通知·事件日志       │
│  本机桥 127.0.0.1:4710 ◀─────┤─ 网关链接（配对、隧道、调用笔记本）                │
│  Keystore 身份、通知卡片      ├─ HTTP 边缘 127.0.0.1:4700（ash 界面、SDK、MCP 投影）│
│  屏幕/应用/Shizuku/虚拟屏     └─ DSH 绑定 ── DSH core（profile ash = dsh-base）    │
│  WebView 打开 ash 界面            ① ash → DSH：ctx.agents、session/event、gate    │
│                                   ② DSH → ash：ctx.ash、ash_* 工具、设备能力工具   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

| 目录 | 内容 |
|---|---|
| `packages/sdk` | `ash-api/1`：类型、边缘 HTTP 客户端 |
| `packages/core` | ash core：系统本身（与具体 Agent 运行时无关）、ash 界面、网关链接、MCP 投影 |
| `packages/dsh-binding` | 用 DSH core 实现 Agent 运行时契约（进程内，DSH 零修改） |
| `packages/android-compat` | 让原样的 DSH 跑在 Android 上：平台包与运行时预加载 |
| `payload/` | payload 清单（锁定 DSH、Termux 运行时的版本与哈希）和组装脚本 |
| `android/` | Android 宿主（Gradle，Kotlin，`ai.ash`） |
| `tools/` | 端到端测试、回归脚本 |

## 构建

需要 Node ≥ 22、npm、`ar`/`tar`/`zip`、[patchelf](https://github.com/NixOS/patchelf)，以及 Android SDK（build-tools 35、platform 35）和 JDK 17+。

```bash
npm ci
npm test                              # 契约测试：第 1 组（core）、第 2 组（DSH 绑定，需要本机装一份 DSH）
npm run build:payload                 # → build/payload/payload.zip（DSH + 运行时 + ash core）
cd android && ./gradlew assembleDebug # → android/app/build/outputs/apk/debug/app-debug.apk
```

升级 DSH：改 `payload/manifest.json` 里的一行版本号，重新 `build:payload`，跑一遍 `npm test`（第 2 组契约测试守住绑定层）。

笔记本当设备：

```bash
npm run build:core
node --expose-internals packages/core/dist/ash-core.mjs --config laptop.json --pair <手机上生成的配对码>
```

`laptop.json`：`{ "role": "client", "name": "MacBook", "stateDir": "~/.ash/laptop", "gateway": { "url": "https://ash-gateway.<子域>.workers.dev" }, "mcp": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/ash-shared"] } } }`

## 来源与许可

ash 分叉自 [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app)（MIT，v1.16.1 基线），之后重写了架构：原项目的真机经验（Shizuku、无障碍、虚拟屏、Android 上跑 node 的各种坑）保留在代码和注释里。

整体按 MIT 许可（[LICENSE](LICENSE)）；虚拟屏模块源自 [Operit](https://github.com/AAswordman/Operit)，按 LGPL-3.0 分发；payload 里的 Termux 软件包各自遵循其许可。见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
