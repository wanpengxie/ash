# 第三方组件与开源许可声明 · Third-Party Notices

本仓库**整体**采用 **MIT** 许可（见 [`LICENSE`](LICENSE)）。

但**虚拟屏（vscreen）功能**包含来自 **Operit** 的代码，**该部分按 LGPL-3.0 分发**。
同一个仓库里同时存在两种许可，**请分别遵守**——尤其当你要复用/修改虚拟屏相关文件时。

---

## 1. Operit — LGPL-3.0（虚拟屏 vscreen）

| 项 | 内容 |
|---|---|
| 项目 | **Operit** — Android 上能力强大的 AI Agent |
| 仓库 | <https://github.com/AAswordman/Operit> |
| 作者 | [AAswordman](https://github.com/AAswordman) |
| 许可证 | **GNU Lesser General Public License v3.0（LGPL-3.0）** |
| 许可证全文 | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)（LGPL-3.0 以 GPL-3.0 为基础，故同时提供 [`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt)） |

### 1.1 本项目中源自 Operit 的部分

虚拟屏功能的实现**移植/对齐自 Operit 的 shower（虚拟屏）模块**。原先取自 Operit、带 LGPL 头的 `FakeContext.java`、`Workarounds.java`
已按 scrcpy（Apache-2.0）重写，在 `android/kernel/src/main/java/ai/ash/kernel/host/`（虚拟屏程序和内核宿主共用，见第 2 节），不再含 Operit 代码。

| 文件 | 与本项目的关系 |
|---|---|
| `android/kernel/src/main/java/ai/ash/kernel/host/vscreen/Main.java` | 虚拟屏服务端（0.4.7 从 app 包移到内核包，由内核宿主以调试身份拉起）。其**核心机制移植/对齐 Operit**：`MediaCodec` H.264 编码器 Surface + `setVideoSink` 推流、SPS/PPS（csd-0/csd-1）缓存重放、`DisplayManager.createVirtualDisplay()` 建屏、`InputManager` 反射定向注入、`ActivityOptions.setLaunchDisplayId` 启动到指定虚拟屏、idleWatcher 保活 |
| `plugins/dsh-tool-vscreen/` | 本项目自研的 DSH 插件封装（通过 HTTP 调用上述服务端；接口与工具 schema 为本项目设计） |

> **保险起见的口径**：本声明**按最保守方式把整个虚拟屏模块
> （`android/kernel/src/main/java/ai/ash/kernel/host/vscreen/`）视为 LGPL-3.0 覆盖范围**。
> 这样无论后续维护者把哪些文件判定为"衍生作品"，都不会出现许可缺口。

### 1.2 如果你要继续修改这些文件

- **修改后的这些文件（及其衍生）必须继续以 LGPL-3.0 分发**，并保留原始版权与许可声明（LGPL-3.0 §2、§4）；
- 不得对本模块附加任何"禁止修改 / 禁止为调试而反向工程"的限制（LGPL-3.0 §4）；
- 本项目**不要求**你对仓库其余（MIT 部分）做任何开源——两部分的许可彼此独立。

### 1.3 本项目已履行的 LGPL-3.0 义务

| 义务（条款） | 履行方式 |
|---|---|
| 显著声明"使用了该 Library 且该 Library 及其使用受 LGPL-3.0 约束"（§4a） | 本文件 + `README.md` 的「致谢与开源许可」章节 |
| 随作品附带 GPL-3.0 与 LGPL-3.0 全文副本（§4b） | [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)、[`licenses/gpl-3.0.txt`](licenses/gpl-3.0.txt) |
| 提供可重新链接/重新编译的对应源码（§4d） | **本仓库即为完整对应源码**（含 `android-app/`、`plugins/`、构建脚本 `android-app/build.sh`），任何人可获取、修改、自行编译与重新链接 |
| 允许为调试修改而反向工程（§4） | 本项目未附加任何禁止条款 |

> 若发现归属有遗漏或希望调整声明方式，欢迎提 [Issue](https://github.com/woaiys3/deepseek-harness-android-app/issues) 或直接联系作者。

---

## 2. 「后台也能动手」（手机的调试身份）用到的开源代码

`android/kernel/src/main/java/ai/ash/kernel/host/` 与 `android/kernel/src/main/jni/`：内核宿主——和手机的无线调试配对、以调试身份看护中枢，并直接向中枢提供白名单动作（虚拟屏、按键、打开应用）。（配对、白名单和虚拟屏程序在 0.4.7 从 app 包移到了内核包。）
下列代码经改写后并入，各文件头写明了来源与改动。Apache-2.0 全文见 [`licenses/apache-2.0.txt`](licenses/apache-2.0.txt)。

| 来源 | 许可证 | 用到的部分 |
|---|---|---|
| **Shizuku** <https://github.com/RikkaApps/Shizuku> | Apache-2.0 | adb 客户端与配对（`adb/AdbKey.kt`、`adb/AdbClient.kt`、`adb/AdbMdns.kt`、`adb/AdbWire.kt`、`jni/adb_pairing.c`），配对通知的 RemoteInput、独立通知频道、前台服务回复与权限检查做法（`host/KernelPairing.kt`、`Notifications.kt`），以及经 ContentProvider 把连接信息交给 App 的做法（`ProviderClient.java`）。未使用 Shizuku 的名称、图标、包名或权限名 |
| **scrcpy** <https://github.com/Genymobile/scrcpy>，Copyright (C) 2018 Genymobile, (C) 2018-2026 Romain Vimont | Apache-2.0 | `FakeContext.java`、`Workarounds.java`（app_process 里的 Context） |
| **BoringSSL** <https://boringssl.googlesource.com/boringssl>（经 `io.github.vvb2060.ndk:boringssl:20251124` 预编译包，静态链接进内核包的 `libashadb.so`） | Apache-2.0 | 配对用的 SPAKE2、HKDF、AES-GCM |
| **okhttp-tls** <https://github.com/square/okhttp>（`com.squareup.okhttp3:okhttp-tls:4.12.0`） | Apache-2.0 | 为配对证书生成自签名证书 |

---

## 3. payload：运行时与 npm 依赖

| 项 | 说明 |
|---|---|
| `runtime/` | Termux 的 aarch64 软件包（Node.js、Python、Git、ripgrep、Bash、curl、pnpm、OpenSSL、ICU 等），版本与哈希锁定在 `payload/manifest.json`，只做了可重定位处理（RUNPATH、shebang），各自原许可 |
| `dsh/` | 来自 npm 的 `@deepseek-ai/dsh` 及其依赖闭包，**原样分发**，版权与许可归各自作者所有；本仓库不重新授权它们 |

---

## 4. 智能体容器（`assets/container/ash-container.tgz`）

App 里随附一个 Linux 容器，智能体在其中运行。它由 `tools/build-container-rootfs.mjs` 从锁定的来源组装（版本与 sha256 写在脚本里），各组件**原样分发**、保留各自许可：

| 组件 | 来源 | 许可证 |
|---|---|---|
| PRoot 5.1.107.96（`proot/bin/proot`、`proot/libexec/loader`） | Termux 的 `proot` 软件包，上游 <https://github.com/termux/proot>（源自 <https://proot-me.github.io/>） | **GPL-2.0**，全文见 [`licenses/gpl-2.0.txt`](licenses/gpl-2.0.txt)。对应版本的源码可从上游仓库与 Termux 软件包源（<https://github.com/termux/termux-packages>，`packages/proot`）获得 |
| talloc 2.5.0（`proot/lib/libtalloc.so.2`） | Termux 的 `libtalloc` 软件包，上游 <https://talloc.samba.org/> | **LGPL-3.0**，全文见 [`licenses/lgpl-3.0.txt`](licenses/lgpl-3.0.txt)；以独立动态库形式分发，可被替换 |
| libandroid-shmem 0.7（`proot/lib/libandroid-shmem.so`） | Termux 的 `libandroid-shmem` 软件包 | BSD 式许可（版权声明见该包的 `share/doc/libandroid-shmem/copyright`） |
| Ubuntu Base 24.04 arm64（`ubuntu/`） | <https://cdimage.ubuntu.com/ubuntu-base/> | 各软件包各自的许可，见容器内 `/usr/share/doc/*/copyright` 与 `/usr/share/common-licenses/` |
| Node.js（`ubuntu/opt/node`） | <https://nodejs.org/> | MIT 及其依赖各自的许可（见 `ubuntu/opt/node/LICENSE`） |
| DSH（`ubuntu/opt/dsh`） | npm 上的 `@deepseek-ai/dsh` 及其依赖 | MIT 及各依赖各自的许可，原样分发 |

---

## 5. 手机上的文字识别（`ocr.read`）

手机端（`android/app/.../caps/perception/`）用 ONNX Runtime 在本机跑文字识别模型；模型文件**不在安装包里**，首次使用时从 Hugging Face（或其镜像）下载到应用私有目录，并核对 sha-256。

| 来源 | 许可证 | 用到的部分 |
|---|---|---|
| **ONNX Runtime** <https://github.com/microsoft/onnxruntime>（`com.microsoft.onnxruntime:onnxruntime-android`） | MIT | 链接进手机应用的推理库 |
| **PP-OCRv6 medium 检测 / 识别模型、PP-LCNet 文字行方向模型**（PaddlePaddle，ONNX 导出） <https://huggingface.co/PaddlePaddle> | Apache-2.0 | 运行时下载，不随包分发；识别字典（`assets/perception/ppocrv6_dict.txt`）取自识别模型的 `inference.yml` |

---

## 6. 摘要

| 范围 | 许可证 |
|---|---|
| 本仓库其余全部内容（ash core、SDK、DSH 绑定、Android 宿主、构建脚本、文档） | **MIT** |
| `android/kernel/src/main/java/ai/ash/kernel/host/vscreen/`（虚拟屏） | **LGPL-3.0**（源自 Operit） |
| `android/kernel/src/main/java/ai/ash/kernel/host/`、`android/kernel/src/main/jni/` 中改写自 Shizuku、scrcpy 的文件 | **Apache-2.0** |
| `libashadb.so` 中静态链接的 BoringSSL；依赖 okhttp-tls | **Apache-2.0** |
| 手机上的文字识别：ONNX Runtime；PP-OCRv6 模型与字典 | MIT；Apache-2.0（模型运行时下载） |
| payload：DSH（`@deepseek-ai/*`）及其 npm 依赖 | 各自原许可，原样分发，本仓库不重新授权 |
| payload：Termux 软件包（node、python、git、ripgrep、bash、curl、pnpm、openssl 等） | 各自原许可（见 payload 内 `runtime/share/LICENSES` 与各包说明）；版本与哈希锁定在 `payload/manifest.json` |
| 智能体容器：PRoot | **GPL-2.0** |
| 智能体容器：talloc | **LGPL-3.0** |
| 智能体容器：Ubuntu Base、Node.js、DSH 及其余组件 | 各自原许可，原样分发 |
