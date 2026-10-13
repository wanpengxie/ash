# ash

ash 是运行在 Android 手机上的常驻个人 Agent。ash core 管理消息、设备、权限、定时和界面；[DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 运行 Agent。DSH 发布包不作修改，在 Ash 的主 body（手机上的 proot Ubuntu）里运行，经 ACP 被驱动、经 MCP 调用 Core 的工具。

当前代码包含：

- 中枢（`packages/core`）：账本、成员、路由、关口、定时、感知、语义层，所有进出都变成消息；
- 手机宿主、手 App、网页和电脑程序经 `ash-link/1` 连进同一个端口，agent 由 DSH 驱动并经 MCP 使用中枢的工具；
- 审批、定时唤醒、应用（器官）与本地暂停。

这些是代码能力清单，不代表真机回归和最终体验验收已经完成。进度以项目验收记录为准。

## 运行结构

```text
Android 宿主 ai.ash.kernel（Kotlin）：装运行环境、起进程并监管、签名、唤醒、保活
  └─ 启动 ash core（Node，单进程；ash-host/1：host.json + 环境变量 + 标准输入事件）
       ├─ 内核：账本、注册表、路由、关口、脱敏、保险箱
       ├─ 边缘：/link 连接服务端、工具面（MCP）、DSH 驱动、主 body、应用、宿主、小模型
       ├─ 服务：时钟、语义层、历史、设备目录、卡片、管理、用量、感知、反射
       └─ 网关出站连接 ── 配对浏览器 / 电脑程序
手 App ai.ash.agent、网页、电脑程序 ═ ash-link/1 ═ 本机端口
```

Android WebView 从 APK 加载静态界面，通过原生桥访问 Core；远程浏览器通过网关使用同一界面。设备能力经过成员与审批链路，不直接展开成一批 Agent 工具。详细结构见 [架构说明](docs/ARCHITECTURE.md)。

| 目录 | 内容 |
|---|---|
| `packages/sdk` | 契约：类型、JSON Schema、一致性样例 |
| `packages/core` | 中枢：内核、边缘、服务（结构见 `docs/ARCHITECTURE.md`） |
| `packages/link`、`packages/workspace`、`packages/device` | 连接协议实现、文件与命令操作、电脑程序 |
| `packages/web` | 网页界面（Core 当静态文件发，Android 打包进 APK） |
| `packages/ash-skills` | 人格模板、首次见面与其他技能 |
| `packages/android-compat` | Core 进程在 Android 上的运行时预加载（硬链接、flock 的兜底） |
| `payload/` | 运行时和 Core（DSH 在容器里）的锁定输入与组装 |
| `android/` | Android 宿主（Gradle/Kotlin） |
| `tools/` | 构建、验证和回归脚本 |

## 跨端项目协作（coworker）

本分支通过新的 `ash-link/1` 架构提供 Codex 项目协作。已配对电脑在项目目录运行 `ash-device connect codex --collaborate`，按提示授权读取、新建、发送/追加以及主动分享材料；材料授权默认 24 小时，续期运行同一命令。其他项目不自动开放。

手机从「电脑会话」选择电脑与会话。新版基础通道、图片集成、浏览器流程和 Android 关联测试已通过本地验证；新版正式 APK 和真机整体流程仍待验收，旧版 APK 的测试结论不适用于新版。完整进度见 [跨端开发状态](docs/CROSS-END-DEVELOPMENT-STATUS.md)。

## 本地构建与验证

需要 Node 22+、npm、`ar`/`tar`/`zip`、`patchelf`、Android SDK 与 JDK 17+。构建 payload 还需要 `payload/manifest.json` 指定的外部软件包可获取。

```bash
npm ci
npm run typecheck
npm test
npm run test:ui:e2e
npm run build:container
npm run build:payload
cd android && ./gradlew :app:assembleDebug
```

`npm test` 跑全部单元测试和中枢场景测试。浏览器 E2E 需先安装 Playwright Chromium。APK 输出为 `android/app/build/outputs/apk/debug/app-debug.apk`。

## 来源与许可

ash 分叉自 [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app)（MIT，v1.16.1 基线）。整体按 [MIT 许可](LICENSE)；虚拟屏模块源自 [Operit](https://github.com/AAswordman/Operit)，按 LGPL-3.0 分发。第三方软件包许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
