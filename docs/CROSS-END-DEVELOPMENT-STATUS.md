## 2026-10-13：新架构迁移本地收尾

origin/main e7372448 已纳入coworker工作树（含迁移期间新增5个上游提交），采用新kernel/edges/services、ash-link/1和原生电脑会话页面。读、新建、发送/追加、主动图片、链接草稿和结果stream已接通，原CLI项目授权保留。旧Core/HTTP桥已移除；共享协议归SDK。相关本地验证通过，全量测试的剩余上游/平台限制如实列于 [迁移记录](MAIN-ARCHITECTURE-MIGRATION-20261013.md)。新版正式APK与完整模拟器/真机验收尚未完成；旧安装包与以下旧版验收记录不得代用。

## 2026-10-13：主分支新架构迁移进行中

用户已明确采用 origin/main 新架构并迁移跨端功能。旧版完整实现保留在 `backup/coworker-before-main-20261013`（5b958f84），原安装包与历史验收记录仅适用于该旧版本。当前工作树以新版 kernel/edges/services、ash-link/1 与原生手机页面为基础；不保留旧 Core 并行运行。

基础会话读、新建、发送/追加与结果服务正在迁入新的 service:collaboration，经 human channel 调用设备 capabilities。电脑CLI项目授权保持；共享DTO移到SDK。图片主动发送、原生界面和新架构测试仍在迁移，旧版绿灯不能替代新版验收。合并尚未提交或推送；不得把源码冲突消除视为功能完成。

## 2026-10-13：重启恢复与旧附件移除正式包

正式包 `build/ash-coworker-20261013-reconnect.apk`，332,633,022B，SHA-256 `fd485c166885ea9f00e0fe368971a9454a34f9e59a1be7b2e50e3cc54deaf342`。顺序完成 payload 构建及普通 clean assemble，包名 ai.ash.agent、原证书、UI/payload/Core 字节匹配已核验；未更新或重启真实电脑连接器。首次 LocalSend 连接被拒，尚未发送，等待手机前台。覆盖安装后需要移除失效旧附件并重新选图，不能恢复已销毁的临时图片。Goal 真机验收仍未完成。

## 2026-10-13：真机发送误报选图失败，补手机端单独重启恢复

用户明确提示出现在点击发送后，选图已成功。本轮先诊断：实际电脑 metadata 只读捕获成功；既有真实 registry 重建恢复测试通过，排除先前猜测的 inputTargets/readRequest 死路。新测试保留电脑 ClientLink 连接、只重建手机侧 Owner/Core，证实 OwnerLink 的材料公钥缓存为空且未主动交换身份，materialInputPeer 返回 unsupported；之前测试人为重新连接电脑，漏掉了此路径。

最小修复只在手机侧连接恢复后，向已配对在线设备发起现有签名身份交换，回复保留原签名、设备 ID 和权限验证。发送阶段 unsupported 提示不再误称选图失败。旧草稿/请求恢复、身份守卫和 UI 测试及限定独审通过；实际 Android 已注册小图同请求在只恢复手机侧后发送/回复通过，电脑连接未重建。

另确认未注册的临时图片在 Core 关闭时会销毁，原 UI 又禁止移除旧 pending 附件，导致无法重新选图。补最小本地移除：用户点 × 后只持久化 local_dismissed 元数据，保留原操作 ID/stage 与服务器记录；成功后清附件，重开跳过该旧附件，保存失败保留原图。用户已明确防重复延期，此路径不再被旧恢复状态锁住。针对性 UI 16 项与真实 Chrome IndexedDB 持久化 1 项通过。实际安卓模拟器已通过：只重启手机 Owner/Core、保留电脑连接，真实 × 移除未注册失效旧图，页面重新加载不复活；系统选图器重选 75B PNG，实际点击发送后 submit/send 均 200，字节/SHA 一致，回复可见且附件清空。原生 Codex/回复使用隔离替身，创建会话使用既有 fixture Work 前置，不把创建按钮或真机算通过。证据 restart-recovery/android-unregistered-dismissal/result.json。

## 2026-10-13：图片流程本地收尾，正式 APK 已准备

按用户最新要求，防重复专项延期，本轮先走通选图、发送、回复及重开历史。约 1MiB（1,047,422B）首次单击 submit 40.522 秒/send 8.808 秒成功；精确 4MiB（4,194,304B）submit 142.109 秒/send 14.743 秒成功，两者均无 HTTP 中断，执行端实际读取字节/SHA 一致，实际 Android 图片回复可见，force-stop 后重开原历史可见。75B 小图已有首次发送及重开证据；小图证据早于最后的私有整资产读取优化，最终源代码中图/最大图已通过。大图仍偏慢，不称性能已优化完成。

最小修复包括材料接口有限 180 秒等待/Android 对应 185 秒、实时连接检查，以及设备本地已提交图片一次受保护整资产读取。最后一项避免每 40KiB 重走完整 store.run，保持文件身份、完整 SHA/长度与授权检查；远程分块、内部 RPC、control 30 秒、reader 20 秒及证明期限没有放宽。限定独审通过。

测试使用实际 Android App、系统选图、原生 HTTP 传输及生产材料服务；原生 Codex/relay/模型回复为隔离替身。重开使用原 Core 启动后研究代理接线，不代表正式产品冷启动或真机验收。测试多个合成 owner 累积触发的草稿容量提示已如实记录，不扩展为本轮产品修复。详情 evidence/project-first-send-local-20261013/review.md。

正式安装包：build/ash-coworker-20261013-first-send.apk，332,624,542B，SHA c319e9846503b6e987250356834467574f06a0dc6957b40a44dbdac3efd9b96d；包名 ai.ash.agent、原签名、UI/完整 payload 匹配已核验。电脑连接器通过正常打包/安装路径更新并启动，配置及授权哈希保持不变。用户打开 LocalSend 后，已向「华丽的桃子」（172.16.5.66）发送，prepare/upload 均 HTTP 200；安装尚未确认。Goal 尚未完成，真机复测仍待执行。

## 2026-10-13：用户调整本轮验收，先走通图片流程

用户明确防重复延期。先完成小图、约 1MiB、4MiB 的选图、发送、回复可见及关闭重开历史可见，再交付新版；不新增防重开发或等待防重专项检查。已有防重代码保留。以下历史记录中的防重交付条件按此调整。

实时内核连接检查优化已完成并通过限定独审，但实际约 1MiB 首发仍超过自定 30 秒整体等待而返回 504。产品监督纠正：该等待不是用户硬指标，不再以此逼出更多证明机制。下一候选只将材料 input/submit、send、retry 整体等待设为有限 180 秒，Android 精确对应 POST 为 185 秒；普通/query/内部 RPC/证明和授权期限均不变，过期仍真实重验或拒绝。必须完成实际大图测试；候选不等于通过或交付。

## 2026-10-13：不同大小图片首发与重开验收进行中

75B 有效 PNG 已在实际 Android 模拟器首次单击发送成功，submit 14.087 秒、send 10.782 秒，均未发生 HTTP 取消。图片字节和 SHA 一致；真实 force-stop 后重开同会话，四条稳定消息 ID 保持一致，图片投递一次，thread/start 1、turn/start 2、turn/steer 0 均未增加。研究代理重连接使用原 Core 启动后接线；这是图片恢复验证，不是正式包冷启动或整机重启验收。

约 1MiB 首次发送尚未通过：原生选图与 26 个导入分块正常，submit 在整体 30 秒期限返回 504；raw transfer 66.395 秒结算，保留 unknown 和原草稿，未重试、未向 native 投递图片。传输过程反复执行 listener/version 外部命令是已定位的主要耗时。正在对既有连接检查做最小优化：支持平台使用实时内核检查，保留所有者、主程序、身份、版本和材料授权检查；不扩大期限，不缓存旧证明。失败证据保留在 evidence/project-first-send-local-20261013/fixed-1MiB。

优化后必须重新完成 75B、约 1MiB、精确 4MiB 的首次单击、字节一致、关闭重开和不重复投递检查，再构建正式 APK。此时尚未交付新版。

## 2026-10-13：首次发送自然中断已在实际 Android 复现，修复中

用户要求先解决首次发送，不再交付仅恢复分支补丁。实际 .probe 的生产 HomeActivity/FixedCoreClient，经带真实 premature-close AbortSignal 的本地 HTTP 接线调用生产材料服务，fresh Work/75B PNG首次单击无注入delay：submit 10.879秒遭消费者断开，transfer15.186秒 offline，submit17.628秒503/aborted；原生 target captures618–720ms均成功。receiver已有75B/locator/transfer，但没有图片control操作，不能说图没上传。明确验证了本地自然流程超出Android默认10秒而被取消，未获得原用户手机该笔请求的trace，不能等同实机首因。

此前本地host未传取消signal，晚结果后台继续，覆盖不足已修正。源/调用段归属和耗时证据保留project-first-send-local-20261013。传输窗口多次物理current校验及签名/receipt叠加耗时，未以一个慢命令作结论。

Root/Astra收拢最小修复：仅材料 input/submit、send、retry 给Core明确30秒整体期限，Android仅相同精确POST无query等待35秒；不延长证明/内部RPC、query、普通10秒或新建任务平台。超期/断开仍真实报告、保持raw工作结算前的busy，不制造accepted。尚在实现与验收，不能宣称已修复。

退出条件为实际安卓 fresh75B、约1MiB、4MiB有效PNG，新会话/原操作一次点击、SHA一致、一次native图片投递、UI终态与草稿清理、重开不重发。大图若不fit继续定位有依据的乘数，不扩大proof期限/缩图片或限额。完整通过并独审前不发APK、不要求用户重试。

## 2026-10-13：真机图片未知状态，修复同请求恢复死路

用户新建「真机测试」并选图发送后两次都显示结果未知。实际新会话存在于 ash；电脑 control journal没有对应新图片投递、receiver资产/locator为空，不能据此保证所有前置动作未发生。只读临时独立状态捕获真实 native metadata 947ms 成功、再次check true且临时目录清理；此证据不是当时生产 provider 及首次失败根因的证明。

明确代码缺口：首次submit未建材料request记录就失败后，已有prepared operation的query返回not_found，composer直接unknown、无法继续same-request read/submit。最小fix仅对此not_found继续原恢复流程，保留全部IDs、原文字/图片及server防重；accepted仍拒重提，其余错误不自动retry。新增用例修复前失败、修复后10/10，独审10/10与直接tsc通过。初次提交为何失败仍未确定，未扩大Android超时或绕授权。

正式包 build/ash-coworker-20261013-image-recovery.apk（332623954字节，SHA f97b1ac399e13cb400209cc25697dc27d7273046b8ca11e2730ab7b61e33e708）正常生成，UI/payload逐字节匹配，包名ai.ash.agent、原签名67c8bb8a…通过。发送准备连接手机LocalSend被拒，尚未发出，等待用户打开LocalSend；不以本地补丁宣称真机已修复。证据project-android-local-20261012/real-phone-followup.md、review.md及image-recovery-20261013/apk.json。

## 2026-10-12：Android 本地独审和清理完成，用户确认主动索取材料延期

Android 项目协作最终限定独审无阻断，Root独立核验字节/回执/执行计数、关闭期间新增 stable message 与真实截图通过。两段晚响应经同 import/job 与同 operation 恢复，保留中间未知及性能归因未确定的边界，不称单击无超时或模型识图。完整 runtime/container 正常解包与私有代理/原生替身测试边界分别记录。日志凭据已脱敏，隔离 App/测试文件/转发、host PID与目录/AVD均已清理，Root现场 adb/进程/目录核验通过；无生产改动或新 APK。最终 evidence/project-android-local-20261012/README.md、review.md、assertions.json、cleanup.json。

用户明确选择“先交付已有功能，主动索取材料延期”。产品主稿、完整审计与 Goal监督文档已按此更新；主动图片/链接与结果回收仍首阶段，machine-callable原会话主动索取为后续，不冒称已实现。当前无已定位其他可独立开发缺口，完整从零接入/最终红米及整机重启或休眠恢复留统一验收；开发与本地验证收尾后再安排，不在本轮要求手机操作。Goal尚未完成。

## 2026-10-12：Android 项目协作核心本地流程通过，清理独审收尾

隔离实际 App 完整 runtime/container 自动解包，沿原生产 UI/原生 bridge/系统 DocumentsUI，在一次项目 v2 授权之后新建会话、首文字、选图、签名传输及回读回复通过。选择器耗时导致 consumer 先未知，原 import 恢复同 selection；提交/发送晚响应沿同 operation 查询恢复 accepted 并清理草稿。没有扩大超时或修改生产代码，不能宣称单次无迟延流程已验。

App force-stop 后 PID 确认不存在，电脑替身原生历史才增加 closed turn3/message3；重开同会话在实际 DOM/截图看到五条稳定消息。Root独立核 PNG 75字节/SHA 相同，thread/start 1、turn/start 2（首文字+图片）、steer 0，重开前后计数和 image 数完全不变，结果未知提示清除。queue relay、Mac Edge 与私有 Node 代理、Python native sockets/历史是明确 fixture，不证明公网/真实 Codex 模型识图。证据 project-android-local-20261012，最终清理、凭据脱敏及独审尚在收尾。

Astra核当前无已定位的其他可独立本地开发缺口；从零完整接入、最终红米与整机重启/休眠仍需统一验收。原会话 machine-callable 补材尚有宿主依赖，不能以对话补材替代，完整Goal保持未完成。依用户指令当前不要求真机操作。

## 2026-10-12：项目授权真实成功，后续全部先本地模拟器

用户真实命令确认后返回项目协作成功。Root只读核材料 v2、receive_input、ash 精确目录及到期 2026-10-13T08:13:19.543Z（上海 16:13），不是仅凭 CLI 文案推断。用户随后明确要求全部开发和本地验证完成后统一真机，当前不要求手机测试或安装。

Astra下一步收敛为隔离 Android 实际 App 新建会话、文字、原生选图发送及关闭期间新增回复后重开；复用生产服务/签名材料/真实 journal，native socket 替身必须明确记录。模拟器 Medium_Phone_API_36.1 已启动，实际 data 空闲 4.8GB；正在安装隔离 probe 与准备本地链路，尚未通过，不用计划冒充验收。原生结果文件保存已通过，不重复该环节。machine-callable 原会话宿主依赖保留且不循环研究。

## 2026-10-12：真实授权失败后的兼容控制权限复用修复

用户亲自 yes 后读取验证成功，control save 返回 unavailable，材料未更新。只读确认原控制已有同项目 exact_cwd 与 create_work/send_input/steer、无到期，因此新命令无意义重写是实质缺口；具体运行时 unavailable 分支没有观测证据，不声称已确认其原因。

最小修复仅 helper：同 owner/目录/精确 actions 且未过期的控制直接复用，不改原权限字节、代际和期限；失配仍原 prepare/apply 与 runtime changeSafety。读到控制、控制到材料的 receipt 检查保留，材料仍独立明确授权及原生核验。开发及独审各 11/11、TypeScript 通过。正常包 SHA 65b71ed831128663a90b3e1a12a1c0a97c7c3b5e3e70c813cb6b01430a6bcdf2，隔离实际安装通过，本机正常升级保持原全部配置，IPC ready=true。未自动提交真人授权或重启 Codex，真实命令重试仍待用户。证据 project-collaboration-local-20261012 下兼容复用日志、review follow-up、compatible-control-reuse/install-probe.json 和 device-upgrade.json。

## 2026-10-12：单项目协作入口本地交付完成

系统 Goal 已实际恢复 active。单项目 connect codex --collaborate 实现一次明确确认读取、新建、发送/追加及限定期限主动材料接收；默认当前目录、材料 24 小时，同命令续期。既有单会话入口保留，旧材料授权不自动迁移或续期。

独审限定 9/9、最终 fresh-binding 负例整链 1/1、直接 TypeScript 通过。真实 private IPC/文件/日志/签名图片链使用明确合成 native peers；不是实际公网手机和模型执行。最终过期、错误 native cwd、旧 v1 其他会话、撤权均无新增 put/commit。

正常发行包 SHA e15bccde647e5018b7b9dc90f0e0a181abc693321c5b46402b890aa5fa44718f 已通过隔离 installRelease、无 PATH 的带空格/单引号路径执行和模式互斥拒绝。探针最初误用 --help（旧 CLI 视作 run），失败后使用实际 help 子命令验证；未为此扩大生产修改。正常本机连接器已升级，所有原身份/配对/read/control/create/material 状态哈希保持，protected IPC ready=true；未执行真人 --collaborate、改授权或重启 Codex。本步无手机改动，不需要新 APK。

下一步按 Astra 审计进入集中验收，仍保留干净机器完整接入和原会话 machine-callable 宿主依赖未完成；不宣称完整 Goal 完成。证据 docs/evidence/project-collaboration-local-20261012。

## 2026-10-12：进度复核，继续项目协作入口收尾

本轮系统 get_goal 实际返回 blocked；下方 active 说明是历史状态，不能作为当前系统状态。现有工具不能自行恢复 active，按用户继续指令推进已授权开发，不重新创建或缩小 Goal。

单项目协作入口已实现主要代码。开发 Agent 回报限定单元 32/32、隔离整链 1/1 和 TypeScript 通过；材料过期及旧 v1 范围不匹配拒绝，未增加写入。尚待最后一个授权步骤之间的并发变化检查、对应测试、独立审查及正常发行包本地安装；当前不能标记交付完成。此前模型容量失败已恢复同一开发任务，保留现有成果和失败证据。真机仍统一后置，用户当前无需安装或操作手机。

## 2026-10-12：新默认配置原生集成通过，补齐项目自助授权入口

生产helper原样两false配置已在固定SHA/版本的临时HOME经过一次native start→version→stop。只同一临时PID，原设置哈希不变，默认实例socket/PID身份与配置前后一致，临时PID/socket/目录全部清理。初始driver误认managed wrapper别名已保留证据，核实际binary SHA后继续同一实例，没有重复start或默认stop。Root独立核JSON比较与清理布尔值，独审通过；lsof只证明精确PID持有该socket，不扩大为全系统排他。证据docs/evidence/first-shared-default-native-20261012。

完整ordinary-user审计发现另一个实际开发缺口：原--control只授权单会话，项目新建及之后新会话的材料接收没有简单自助入口；已有Root手工配置不可算从零用户通过。Astra确认新增可选单项目协作入口，已派Sol开发：一次明确范围/读取/新建/发追加/主动材料及到期确认，复用protected setup，材料新增严格exact_cwd的v2且由真实native目标metadata校验。旧v1不迁移或延寿，原单会话模式不变，不改真人授权；部分写入真实反馈，不造设置/事务平台。当前尚在开发，不能算完成。

后续仍先本地安装验证，集中真机验收后置。machine-callable补材保留宿主依赖，不再重复来源证明实验。Goal保持active。

## 2026-10-12：首次共享缺省准备与本机安装完成

缺失配置在一次明确确认后原子创建；已有兼容配置复用不加确认，部分/未知/远控或自动更新策略不覆盖。取消、写入失败、并发出现/变化、桌面运行、版本不支持拒绝启动；原生start/open前有限同步再检查，成功仍attachment_unverified，不假称桌面已接入。未自动退出Codex或改变真实native设置。

独立focused27/27、直接TypeScript检查通过。实际安装探针曾发现本机ps输出74949字节超原64KiB而报desktopunknown；只给固定ps查询加入4096字节逐行过滤及8条精确主进程匹配界限，完整结束/成功退出才判断，其他nativeJSON原64KiB/15秒不变。重新正常打包、隔离installRelease和真实readonly计划返回desktop=running，未创建任何测试home配置或启动daemon。旧unknown证据保留。

本机Ash连接器正常升级，原配对和读/控制/新建/材料状态文件哈希保持，受保护IPC setup.ready=true。只重启Ash连接器，Codex未重启/切换。手机无需重装。此交付证明配置准备及guards、本地安装和readonly计划，不证明全新用户首次native启动、桌面attachment或真机完整流。证据 docs/evidence/first-shared-launch-local-20261012。

首阶段仍待首次桌面切换/统一设备验收与原会话machine-callable补材宿主依赖，Goal保持active。不提交、推送、部署或发布。

## 2026-10-12：实际安装发现进程检测输出上限缺口，正在修复

首次缺省准备源码24个focused通过并独审，正常发行包构建、隔离installRelease和readonly计划实际执行。但安装探针返回desktop=unknown。Root复核/bin/ps相同参数/env exit0、输出74949字节，超过原production.run通用65536缓存界限，导致错误未知状态；这影响本机首次共享启动，应修而不能当正常通过。

仅修固定ps查询为有限逐行过滤精确Codex主进程，原nativeCLI JSON界限与超时保留，不添加服务/设置框架或扩大通用限额。新focused、独审、重新打包实际readonly验证待完成。原安装证据保留install-probe-before-process-fix.json。不运行native start、daemon生命周期或改真实配置。

## 2026-10-12：首次共享缺省准备实现进行中

固定版本A2已核实remoteControlEnabled=false和updater.autoUpdateEnabled=false的既有生命周期证据；bootstrap帮助不能证明默认值或系统服务副作用，不执行bootstrap。实现已落盘missing/disabled/unknown区分、明确确认后缺省准备、已有不覆盖、桌面运行拒绝。Root要求用同目录独占临时文件写入/fsync后无覆盖link发布，避免写入失败遗留半份设置；无新证明平台或设置页。

尚待focused测试、独审、正常打包和隔离安装验证，不宣称首次从零产品全流程已完成。原会话machine-callable路线的只读复核见docs/evidence/native-tool-origin-feasibility-20261012.md，既有原生dynamic-tool事件路线仍未满足原会话注册与可靠返回要求，当前保持未完成，不再次展开证明实验。继续完成现有首次接入开发，不缩小Goal。

## 2026-10-12：下一开发项为首次共享连接缺省准备

Astra派单并由Sol开始执行：复用codex-shared，一次明确确认后只为完全缺失的daemon策略配置准备本地缺省值；已有兼容复用，已有远控/升级、部分或未知配置不覆盖，桌面运行时仍停止且不自动退出。先只读核实固定版本配置入口，不把bootstrap帮助当作默认策略或launchctl隔离证据。禁止在当前用户环境执行native bootstrap或重启服务。daemon编排以现有backend fixture验证，本地文件准备以临时目录实际fs验证；真实首次桌面切换留统一验收。不新增向导、设置页或服务平台。

## 2026-10-12：恢复链与Android文件保存本地验收完成

恢复：Node41个含子用例、浏览器control3/create5、实际本地读取链1用例通过，直接TypeScript检查通过。读取覆盖页面关闭期间新增稳定turn、重新打开读取、断线保留缓存、连接器重启后同会话200成功回执与授权不变；未改变生产实现。五次先前失败均保留，修复仅限测试身份依赖、过时菜单/文案和缺失正常状态元素的诊断等待。观测前置是预防，未证实自动刷新漏事件为根因。独审见docs/evidence/recovery-local-20261012/review.md。control/create native socket及桥为隔离替身，读取为临时历史及本地Worker，不宣称Android进程/整机/live账号恢复已验。

Android结果保存：隔离.probe安装运行原HomeActivity、原生桥与固定transport、生产ResultFileSave和ResultFileService。实际Google DocumentsUI保存Downloads，83字节与固定快照逐字节和SHA一致；再次点击并系统Back取消，页面已取消保存，Downloads列表/原文件不变，无取消后的check请求。Root独立cmp/SHA与日志/截图核验通过；上游电脑及Server授权用fixture，非红米公网审批整链。probe已卸载，AVD正常sync停止，正常手机包未改。证据docs/evidence/result-file-android-local-20261012。正式build/ash-coworker-20261012-result-file.apk保持；默认android/app/build输出是probe，不得拿作正式交付。

剩余：首次原生共享接入产品化、原会话machine-callable补材宿主入口、统一真机验收。Astra继续收拢下一步首次接入，不再重复微调已通过功能。Goal保持active，未完成。

## 2026-10-12：读取恢复验收适配及下一缺口

旧读取链测试已实际进入会话显示新增消息，但刷新在更多菜单内导致旧点击等待；测试已适配真实菜单并将过时离线文字更新为当前准确提示。保留503/offline、未授权项目403、稳定turn和缓存消息断言；新增page.close之后源addTurn2，再用新page打开同会话，已执行到离线阶段，关闭期间的新消息可见。当前最终复跑仍在等待连接器重启后的实际200可读回执，恢复全项未通过，不以页面已有缓存冒充恢复成功。测试清理已nested finally保证关闭fixture；未改生产或弱化权限。

完整要求审计见 docs/evidence/goal-local-completion-audit-20261012.md。Astra确认剩余真实缺口包括首次共享Codex从零接入、machine-callable原会话主动补材宿主绑定、Android系统结果文件真实落盘。Android隔离模拟器保存验证已派单，原生桥/保存器保持生产实现，上游fixture边界将如实记录，不要求红米中途安装。

## 2026-10-12：恢复集成验收进行中

Astra选择复用现有关闭重开、连接器恢复与未知不重发场景，未新增生产功能。设备暂态恢复/reconciliation 41个含子用例通过；浏览器control3/create5通过。它们使用真实服务/journal/路由配合隔离native与relay，不能算真实Codex发送或红米验收。

读取链临时固定wrangler4.143.0已安装并实际运行。原fixture因缺账号身份依赖失败，日志保留；仅测试两处补synthetic身份，继续复跑。将补关闭页面期间addTurn后重开看到新消息的实际时序；尚未通过，不宣称恢复全流程完成。证据 docs/evidence/recovery-local-20261012。

## 2026-10-12：首次配对后命令交接已完成本地交付

配对完成后现在提示先进入共享项目，再给实际发行包完整可执行的连接命令；未加PATH也能运行。后续control命令保持真实运行包路径，--root仅选择状态，显式--config/--project保留并正确引用空格及单引号。no-service给启动命令及另一终端的连接命令，不假称后台服务已启动。

开发与独立review focused6/6通过、直接TypeScript检查通过。Root正常构建darwin-arm64发行包，使用installRelease安装到隔离HOME（PATH无ash-device，含空格/单引号），实际wrapper/runtime版本与connect入口执行通过；未配对状态准确拒绝且未授权。安装探针最初预期错误文案不正确，修正探针后通过，未改生产行为。真实配对与OS服务成功仍只有隔离fixture证据；不宣称从零手机配对全流程完成。existing custom --config服务路径不一致和直接源码fallback限制保留在review。

下一步按Astra决策复用已有集成链验证关闭后新消息、连接器恢复、未知投递不重复；发现失败再单点修复。真机集中验收策略保持。证据 docs/evidence/first-handoff-local-20261012。

## 2026-10-12：系统Goal已恢复active

本轮get_goal返回active；上一轮blocked说明保留为历史，当前按完整首阶段目标继续。上一轮完成执行要求落盘和开发派单，属于进展；本轮接续已完成代码和独审，执行真实发行包隔离安装验证。统一真机验收策略继续生效，不缩小Goal范围。

## 2026-10-12：首次配对到项目连接的交接开发中

Astra产品检查确认：install.sh没有加入PATH，配对完成后只有成功状态，后续裸ash-device命令在干净环境不可执行。本步只提供实际安装包完整可执行路径的下一步命令，并明确先进入项目目录；保留现有范围确认和自定义状态配置。不改shell profile、不加设置页、不自动授权。Sol开发与独立review已启动，使用实际发行包隔离HOME安装验证，不请求手机验收。此项只是首次接入的一步，不能算整条从零流程完成。

## 2026-10-12：开发及本地安装验证优先，真机集中验收

用户授权继续首阶段Goal。后续步骤先完成开发、实际本地安装和针对性验证；手机界面用浏览器，本机原生功能用安卓模拟器，电脑连接器及Codex链路使用对应实际本地环境。模拟链路必须注明边界，不能算真机通过。整理待真机验收项，开发收尾后集中使用红米验证；不逐项催用户开LocalSend、覆盖安装或确认。仅不可替代登录、授权或实质取舍才停止依赖工作并说明原因。

系统Goal查询仍为blocked，现有工具不能将它恢复active；按用户最新指令继续实际工作，不重复创建或缩小Goal，不宣称自动续跑已恢复。

## 2026-10-12：电脑连接命令简化完成

在项目目录运行 `ash-device connect codex` 默认读取当前目录对应项目；发送入口为 `ash-device connect codex --control`，仍保留原会话选择与明确确认。可用 `--project PATH` 指定其他目录，不增加设置页或自动扩大授权。首次安装完整路径仍未完成，本步只简化已安装连接器入口。

独审34个focused用例通过，Root另独立复跑旧main用例1/1通过（保留慢确认、取消、异owner和断线断言），直接TypeScript检查通过。正常电脑包构建、本机连接器更新完成，原配对和读/控制/新建/材料配置哈希保持。没有手机改动，无需重装；结果文件手机保存验收按用户要求暂缓。证据：docs/evidence/connect-simple-local-20261012。

## 2026-10-12：用户暂缓文件领取真机验收，继续开发

用户明确先不验证结果文件，继续Goal开发。结果文件保留“开发/本地测试/交付完成，真机保存待验”，不再催安装或批准文件，也不把整个Goal暂停。剩余按用户路径收拢为电脑请求手机材料（对话补材已有链路，机器可调用的主动请求仍有来源绑定缺口）、首次安装/配对/原Codex接入简化、断线重启/重复/未知的整体验证及必要修复。不采用旧65%/68%工程估算冒充用户可用比例。

## 2026-10-12：单个结果文件领取首包已准备

手机沿原助手回复点击项目文件，电脑明确批准具体文件后生成≤4MiB固定快照，再点击通过系统保存。支持PNG/JPEG/TXT/Markdown；不新增结果页、文件列表或持久权限。授权前只核真实消息引用和元数据，审批后快照15分钟，撤权/过期/重启拒旧句柄，不自动重读源。

开发、独审和本地有限测试通过，包含真实4MiB JVM解析/SHA；电脑连接器已正常更新，原配置哈希保持且实际read1会话7消息通过。原签名APK build/ash-coworker-20261012-result-file.apk（332,623,662字节）包内内容一致。尚待发送/覆盖安装、手机系统保存和取消验收，不宣称真机已完成。旧v2读授权测试的既有失败已用旧installed bundle复验相同，未改测试或冒称全suite绿；完整证据见docs/evidence/result-file-local-20261012。

## 2026-10-12：回复格式、代码复制和链接真机验收通过

用户覆盖安装replies APK后确认回复格式、代码复制和链接打开全部正常。本步真实手机验收通过，保持原会话入口，无新结果页、工具栏或设置。下一步按完整Goal剩余材料结果、双向请求、恢复和首次安装范围继续，不重复打磨已通过功能。

## 2026-10-12：手机使用 Codex 回复的最小交付已准备

助手回复复用现有安全Markdown，正文网页链接可点、代码沿原按钮复制；用户输入原文展示、正文保留系统选择。没有新结果页/工具栏/设置/文件权限，保留同身份未变消息节点避免后台刷新打断选择。开发及独立审查通过，独审8页面/17unit含真实shell分页与原输入/IME恢复；Android本地原WebView生产渲染探针通过代码复制和浏览器唤起/返回（Chrome首次页只证明唤起，不证明网页内容加载）。

APK build/ash-coworker-20261012-replies.apk，332,619,282字节，包内UI/payload/Core/Android材料helper及exec一致，正式包名ai.ash.agent、原安装签名67c8bb8a…核验通过。LocalSend已pin手机但当前连接超时，尚未发送。等待LocalSend恢复后交付同一包并真机核实际回复的格式、代码复制、链接打开与返回。证据 docs/evidence/reply-use-local-20261012；图片真机闭环继续保持已通过，不据此说桌面文件取回/完整Goal已完成。

## 2026-10-12：图片真机闭环验收通过

用户明确确认：从手机选择并发送图片，Codex 已回复，手机能读取回复。手机→已授权 Codex 会话→识图回复→手机读取的实际闭环通过。沿用简化会话入口，不新增材料管理页；其他首阶段范围继续推进，不宣称整体 Goal 完成。此前图片待验收说明保留为历史记录。

## 2026-10-11：本地图片发送到真实 Codex 通过

手机尺寸浏览器使用真实 Ash 输入组件及生产材料导入/传输/接收/控制链路，向真实共享 Codex App Server 发送 PNG，取得接收回执。真实图片 turn 的 localImage 路径、文件 SHA256、会话历史及识图回复对应；Codex 正确描述白底左红正方形、右蓝圆形。证据见 docs/evidence/image-codex-local-20261011。

选图与 relay 为隔离驱动，Android 原生选图已另测；红米手机与公网网关联合流程仍待一次实机确认。新建空测试会话需先完成固定文字准备 turn，再走生产图片发送；本次未修改生产 app，因此沿用已发送的 recovery APK，不另发安装包。保留前两轮失败和回执 correlation=uncertain 的限制，不提升整体 Goal 验收比例。

## 2026-10-11：本地 Android 启动与原生选图已验证

本地模拟器普通 Ash 的空状态目录已整体保留到 files/ash.before-local-repair-20261011，并重新初始化；主界面可见，应用关闭重开后可见，授权/密钥文件保持一致。未更改手机或电脑数据，也未放宽生产校验。空文件最初形成原因未证明，不能外推为所有异常关闭都已根治。

隔离测试包 Android 原生选图和材料导入通过：选择有效 PNG，核心接收回传，文件名/MIME/大小/哈希与本地测试图片相同。临时测试包已卸载释放 AVD 空间。限定证据见 docs/evidence/local-phone-20261011；实际手机向 Codex 发送仍待验收。

## 2026-10-11：本地手机端测试优先

快速入口 test:phone-ui 已增加；本次 12/12 逻辑测试、4/4 浏览器测试通过，新增 393×851 触屏下纯图片发送一次并清除选择、失败反馈且保留选择。投递使用明确模拟接口，不宣称手机真实送达。

材料浏览器集成 1/1（40.8 秒）通过，覆盖正常材料入口、实际材料服务、固定测试原生桥接、传输回执和关闭后恢复查询；不是红米 Android 选图验收。

Android arm64 模拟器安装合并 APK 成功，应用进程启动；主界面尚未通过。已有 AVD 快照/冷启动过程中读取到多个空状态文件，tokens.json 的 JSON 解析使核心退出；独立 Node 文件写入探针正常（5 字节），尚未确定空文件产生原因，未删除/重置已有 AVD 数据或放宽生产解析。原生选图仍未本地验收。

LocalSend 合并包 ash-coworker-20261011-recovery.apk 已发送完成：prepare/upload HTTP 200。手机安装和图片送达仍待验收。

## 2026-10-11：图片发送与正常重启恢复修复

- 手机报告选中图片后发送完全无反应，收起键盘也一样。修复相同会话对象字段顺序导致的材料绑定失效，并为准备中、不可用和发送中状态提供简短反馈；真实手机重新验收尚待新 APK。
- 读取授权改为稳定账号/来源绑定，普通配置改写只使当前运行时证明失效。限定测试 28/28，恢复测试 7/7，账号独审复测 4/4，TypeScript 通过。原生固定 CLI 读取通过；一个关闭监听并删除控制配置后立即 prepare 的原生 IPC 测试仍返回 stale，保留失败记录，未放宽门槛。
- 电脑连接器已通过正常安装接口更新，原 ash 项目范围用正常 prepare/apply 建立新基线；实际 verify-read 成功（1 会话、7 消息）。连接器重启后，无需重新授权，read/control 均 verified，实际 verify-read 成功（1 会话、9 消息），材料授权仍 configured。尚未进行整机重启。
- 合并 APK：build/ash-coworker-20261011-recovery.apk，332,615,638 字节；核心/UI/Android 锁辅助程序和原签名已校验。LocalSend 当前连接拒绝，尚未发送。

# 首阶段跨端协作开发记录

## 当前产品基线（2026-10-11）

图片发送修复包 build/ash-coworker-20261011-image-send.apk（332,615,626 字节）已构建并核对内嵌 UI/Core/payload、Android helper 与原安装签名。LocalSend 原手机地址拒绝连接，重新发现为空，本次尚未发送，等待手机 LocalSend 前台可连接。真实手机发送复测仍待进行。

图片点击发送窄修及独审通过：同会话绑定改为 workKey，显式提交先提交 IME/最新 textarea，准备/忙碌/失效绑定/离线/隐藏页等拒绝给短提示，发送从 scope/save 前开始显示发送中。保留原目标/授权/可见性检查及未知原操作查询，无纯文字 fallback。作者及独审 Node 14/14、真实 DOM 2/2，Core 构建通过，APK 打包中。手机原具体触发条件未确认，真实图片投递及回复仍待复测。

最新真机反馈：图片选择后已能在会话输入区显示，但点击发送按钮不变、无提示；电脑材料接收记录仍为 0。只读审查发现同 WorkRef 的字段顺序变化会导致 control.update 判同会话、image.isCurrent 却判失效的确定缺陷；另发送 guard 静默返回。正在统一 workKey 比较并补显式点击的 IME 提交、简短拒绝/发送中反馈，不放宽目标、授权、可见性或原操作重试规则。尚未确认手机具体触发条件，不能据此宣称修复真机发送。

用户当前“电脑”页提示请先连接电脑、设置仍有已配对设备。电脑实际诊断 paired/gateway/control verified，但 readGrant invalid（现有读取来源绑定不匹配）。通过正常 setup.prepare/apply 重新保存原已授权 ash 项目读取范围，未扩大授权、未重新配对；随后 read/control capability 均 verified，setup.verify-read 真实读取 state=readable、conversations=1、messages=4。待手机重新打开电脑页确认列表恢复；图片实机选择仍未验收。

修复包 image-fix APK 已通过 LocalSend 成功发送至“华丽的桃子”：prepare/upload 均 HTTP 200，进程退出 0。待用户覆盖安装并实际确认系统图片选择器打开、图片发送、Codex识图回复及手机读取；未宣称真机闭环通过。

Android 图片选择修复包 build/ash-coworker-20261011-image-fix.apk（332,615,098 字节）构建通过；APK 内 payload、最新 Core/UI、Android arm64 锁工具/manifest SHA256、执行权限索引及原安装签名核对通过。LocalSend prepare HTTP 200，上传进行中；尚不认定发送完成或真机选图通过。

真机图片选择失败已定位：用户点图片立即显示“图片未选中 / 暂时无法选择图片”，没有系统选择器。Android Node 的 platform=android，而材料初始化的 descriptor lock 仅接受 darwin/linux，且此前 payload 未包含该原生锁工具和 manifest，导致材料服务无法启动、UI scope 返回 unsupported。已补 Android 同 OS flock 的 NDK arm64 API24 helper、原严格平台/文件/hash/FD 校验和标准 payload 打包/执行权限；不改原生 picker、不使用 JS 假锁。开发 NDK 验证及 Root/独审分别通过，原主机回归 16/16、TypeScript 通过，Core 构建通过；修复版 APK 正在打包，真实 Android 运行和选图闭环待重新验收。

图片接收阻挡已修复：限定回归 25/25、Root 独复 3/3、TypeScript、设备构建及独审通过。本机连接器经校验后的正常 installRelease 更新，重启仅连接器；正常 material.prepare/apply 成功，status=configured，仅会话 01a129a5-0238-7902-a384-f8a24d92188f receive_input，24 小时到期。安装、配对、网关、客户端/socket/源及原 read/control capability 状态均 verified。无直接写授权、删任务 journal 或重启 Codex。图片 APK 已发送；下一步用户覆盖安装，在电脑→该链接测试会话→图片→选择 PNG/JPEG≤4MiB→发送，验收实际收图与手机回复。真实图片闭环尚未完成。额外旧 source 测试一次 stale、本次未修改该路径；限定回归通过，不扩大为安装/来源全流程验收。

最新交付：image APK 已通过 LocalSend 成功发送至“华丽的桃子”，prepare/upload 均 HTTP 200。用户在说明精确会话、24 小时范围后回复 OK；但正常 material.prepare/apply 的 apply 两次返回 unavailable，材料接收尚未启用。已确认历史 accepted create 首条输入永久 native_unknown 阻挡独立材料授权；Astra 批准只为材料 apply/revoke 使用专用 reservation，保留真实 I/O 排他、配对、精确目标、代际和写前条件，不放宽其他设置。窄修、针对性测试及独审进行中；真实手机选图/收图/回复仍待验收。

图片交付包 `build/ash-coworker-20261011-image.apk`（332,612,358 字节）构建及内嵌 UI/payload/Core/原安装签名核对通过，独审已放行。LocalSend 连接原手机地址被拒绝，尚未发送成功。精确链接测试会话的 receive_input 预览已成功，无 apply；已向用户请求仅该会话 24 小时材料接收授权，待回复及手机 LocalSend 可连接后继续交付。真实选图/收图/回复验收仍待完成。

图片入口开发及独审通过：原会话输入旁“图片”→系统单选 PNG/JPEG≤4MiB→文件名/移除→原输入和发送。移除重复的更多菜单材料入口，不进入第二发送表单。原图/原文在失败保留，选择失败保持图片意图，显式移除才回纯文字；旧未知图片操作只读恢复并按原操作核查，选图隐藏期间不失效，目标/授权改变不得串图。Root 代表浏览器 2/2、图片及材料 port 单元 9/9（退修后作者/独审图片 6/6），native bootstrap 9/9、Android material 35/35及编译通过；旧纯文本实际控制链代表亦通过。Core 构建通过，APK 正在打包；精确新建 ash 会话 receive_input 授权预览成功但未 apply，实际手机选图与图片回复待验收。

最新草稿真机验收：用户安装 drafts APK 后，按“已有会话输入文字但不发送→从最近任务划掉 Ash→重新打开同一会话”测试，并确认“恢复了”。已有会话未发送文字的退出重开恢复通过。此证据不外推新建页、未选目标分享或异常存储场景的真机验收；这些已有本地针对性测试。

用户将 LocalSend 打开到前台后，drafts APK prepare/upload 均 HTTP 200，发送进程退出 0，已成功发送至“华丽的桃子”。待覆盖安装并验收未发送文字退出重开恢复；此前传输失败仅为当时状态。

草稿恢复交付包：`build/ash-coworker-20261011-drafts.apk`（332,606,394 字节），Core/Android 构建、内嵌 UI/payload/Core 内容和原安装签名核对通过。LocalSend 连接原手机地址被拒绝，重新发现返回空；本次未发送成功，待手机 LocalSend 前台可连接后发送和真机退出重开验收。

草稿恢复实现及独审通过：普通输入和分享共用有界本地快照，同 endpoint/scope/原授权 revision/目标恢复；分享可靠保存后确认，待处理分享恢复只首次打开原列表，不抢重连输入。新建提交正文可靠移交既有 outbox，失败或未知在原详情只读保留，查询不重新创建，三个阶段 accepted 后清理；旧无正文记录兼容。作者针对性单元/浏览器回归通过；Root 独复普通会话与新建重载 2/2、unknown/name-fail 提交正文重载及查询 2/2；独审 create+draft 单元 22/22 通过。Core 构建已通过，APK 正在打包，实际手机退出重开仍待验收。

下一步开发：Astra 产品监督选择未发送文字的退出/重载恢复，先修复已交付分享入口的内存丢稿窗口。复用原输入框和 scoped 本地存储，同会话/项目及原授权 revision 恢复，草稿记录闲置 24 小时后过期；保存后才确认分享，恢复不自动执行。普通输入一并支持，不增加草稿列表或设置。实现与测试进行中，尚未真机验收。

最新闭环验收：用户随后确认手机 Ash 能看到该分享会话的 Codex 回复。手机系统分享链接→选择已有会话→编辑/明确发送→Codex 接收并回复→手机读取回复，完整真机闭环通过。此结论仅涵盖分享文字链接与会话收发，不代表链接内视频读取或视频制作已验收。

最新分享真机验收：用户覆盖安装 share APK 后，将抖音分享文字链接发送至此前新建的 ash 项目会话，并确认“链接收到了”。电脑 operations 对应 send_input/accepted、error_code=null（updated_at=1791701729342）；该会话保存历史包含分享原文和抖音链接，Codex 已开始响应。手机系统分享→选择已有会话→明确发送→Codex 接收通过；本次未确认手机最终结果回收，也未据此宣称视频内容读取或视频制作通过。

手机分享链接最小入口已开发并独立审查通过：Android 系统分享纯文字链接 → 原电脑/会话列表 → 已有会话或新建 → 原输入框编辑 → 用户明确发送。保留原分享文字，不自动下载或启动任务；不增加请求卡或第二次确认。未确认接收的分享保留待处理，重复回放不重复插入；超长或草稿容量不足时提示并允许重试。Android 单元 4/4、bootstrap 5/5、UI 单元及浏览器回归通过，最后新建页输入/刷新/错误重试 focused 3/3 通过。以上为本地测试，实际手机系统分享、杀进程后任务恢复仍待真机验收。Core/Android 构建通过；`build/ash-coworker-20261011-share.apk`（332,603,586 字节）内嵌 UI/payload/Core 与原安装签名核对通过，LocalSend prepare/upload 均 HTTP 200，已发送至“华丽的桃子”；待用户覆盖安装和实际分享验收。

最新用户真机验收：用户确认已从手机创建新会话，并且可以继续对话。“手机在 ash 项目新建 → 读取回复 → 继续对话”通过。此前已有会话读取、普通发送、运行中追加及回复读取、连续输入不被刷新打断亦已确认。下一优先交付手机分享链接/限定材料给 Codex 并回收结果；其他完整 Goal 范围仍保留。

后续正常重试已保存用户批准的项目权限：setup.prepare/apply 成功，setup.status 确认 exact_cwd=/Users/ahaha/work/xiebo/ash，actions=create_work/send_input/steer，defaultProject=configured，read/control capability 均 verified。未更改安全门槛、未删 journal、未重启或直接写配置。此前 unavailable 已恢复，本轮不据此前推测认定具体根因。newchat APK LocalSend prepare/upload 均 HTTP200，进程退出0，已成功发送至手机华丽的桃子。待覆盖安装并真机创建/读回复验收。

用户随后明确授权 ash 项目的新建、发送和追加。正常 setup.prepare 成功，setup.apply 返回 unavailable；复核配置仍为原 generation=1/single_work，未写成功，不能说已启用。setup.status 检查安装/网关/来源/read/control 均 verified；正在定位管理保存门槛，保留原授权与收发功能，不绕过正常入口。LocalSend 再次发现仍为空，APK 待发送。

新建交付准备：独立 review 通过；Core/APK 构建与嵌入内容/原签名核对通过，`build/ash-coworker-20261011-newchat.apk` 为 332,582,870 字节。LocalSend 首次连接手机被拒绝，重新发现返回空，尚未发送成功。已请求用户明确确认 ash 项目级 create_work/send_input/steer（当前仅单会话，授权尚未变更）；等待用户确认及手机 LocalSend 可连接后继续真机验收。

下一步新建会话：Astra 已收敛为“新建 → 输入要求 → 创建 → 打开看回复”。去掉标题字段，自动生成有界标题；仅唯一且已授权的电脑/项目默认选择，显示目标。创建页刷新保留输入焦点与候选。作者 Chrome 12/12、unit 15/15 通过，真实手机创建/回复仍待验收。当前安装 Codex 的 schema 与 project/list 解析兼容；生产 listener + create transport 只读枚举完整，ash 项目匹配 1 个，零写接口。项目三动作 setup.prepare 预览通过但未 apply：真实控制授权仍仅原会话 send/steer，必须明确确认项目范围变更后才可真机创建。

最新真机验收：用户覆盖安装 sendbutton APK 后确认普通发送成功；随后在本轮仍运行、等待用户输入期间，从手机发送“我测试一下追加消息。”，当前轮收到该消息。本地 operations 对应 action=steer、status=accepted、error_code=null（updated_at=1791691768552），运行中追加入当前轮通过。本次消息到达时最初的 50 秒 shell 等待已结束，正在等待工具内，因此不将此证据扩大为中断/不中断外部 shell 工具的验证。用户随后确认手机显示“已发送”并已收到本轮回复，运行中追加及回复读取的真机闭环通过。此前连续输入约 20 秒未被刷新打断已由用户确认。下文未通过/待复测记录均为当时状态。

发送按钮修复包：`build/ash-coworker-20261011-sendbutton.apk`（332,582,034 字节），构建与内嵌内容、原签名校验通过；LocalSend prepare/upload HTTP 200，已发至华丽的桃子。待手机安装后复测，未宣称运行中追加已通过。

真机反馈：用户安装 minimal APK 后确认连续输入约 20 秒正常，后台刷新未打断本次输入。运行中追加测试卡在手机发送按钮不可点击；用户确认收起键盘后仍不可点击，不能仅归因于 IME，电脑没有新投递记录，尚未认定通过。已修正两个 UI 阻挡：不再因缓存状态未知禁用发送，仍在明确点击后核实最新状态再 apply；IME 候选期间允许点发送并先失焦提交输入。离线和请求进行中仍避免发送，键盘组合输入不会自行提交。原焦点/跨范围清稿及新按钮回归 Chrome 11/11、发送/投递单元 7/7 通过，真实手机追加待新版安装后复测。

后续开发按[产品主稿第 0 节](CROSS-END-PRODUCT-DESIGN-V2.md#0-首要原则从最简单开始)及[Goal 执行约束](CROSS-END-GOAL-PRODUCT-SUPERVISION.md)：默认不加，从最简单的当前任务开始，并持续删减已有无关内容。

手机当前会话的读取、发送和回复读取已由用户确认。运行中追加、输入修复和简化界面的最新 APK 真机复测仍待完成；其他首阶段范围保留。下方早期 active、第一步未验收、68% 等均为历史记录，不代表当前状态；系统 Goal 当前查询为 blocked，未通过文档修改冒充状态恢复。

## 2026-10-11：按最简原则修改现有界面

产品主稿及 Goal 执行文档已加入“默认不加，确有需要再加”的首要约束。现有电脑列表移除常驻权限说明，会话按目录简称分组（重名保留完整路径），新建入口统一为“新建会话”；创建页删去正常协议说明，成功记录只显示简短结果和打开入口，必要查询及诊断放入详情。保留此前输入焦点、输入法和发送前状态复核修复。

验证：会话列表浏览器测试 3/3，新建会话浏览器测试 10/10、控制浏览器测试 12/12、创建与控制单元测试 22/22 通过；Core 与 Android 构建通过。新包 `build/ash-coworker-20261011-minimal.apk` 为 332,581,942 字节，已核对内嵌 UI、payload、Core 内容及原安装签名。上述测试不代表手机运行中追加及输入体验已通过真机验收。

新版已通过 LocalSend 发送至“华丽的桃子”，prepare 与 upload 均返回 HTTP 200；手机安装与体验确认尚待用户完成。

## 历史工程估算与当前产品验收

2026-10-10：**历史工程估算约 68%，不代表用户可用度。** 用户已更新完整 Goal，Astra 重新以用户流程监督开发。当前第一步“一条连接命令＋一次确认 → 实际 Ash 会话列表、消息、刷新”尚未验收通过，不能给出新的整体产品百分比。执行与验收以 [第一阶段交付计划](CROSS-END-FIRST-READ-DELIVERY.md) 为准；下表保留历史工程贡献，不作为当前产品交付证明。

| 交付范围 | 权重 | 当前估计贡献 | 主要未完成 |
| --- | ---: | ---: | --- |
| 会话发现、按需读取与历史界面 | 20 | 15 | Android 实际版本及获准范围真机链 |
| 原桌面会话控制与手机发送 | 25 | 19 | 生产代理首包已审；真实 native factory、桌面兼容与手机验收未完成 |
| 持久投递、核查及恢复 | 15 | 12 | 生产入口断线/回执丢失及 lifecycle 验收 |
| 指定项目新建路径复用 | 10 | 7 | A/B/C/D/F开发层已审，设备/Core/UI整合与真实创建待验收 |
| 限定材料、结果及双向请求 | 10 | 7 | 正常UI选材及新screen/源进程恢复已独复；4MiB性能、真正host来源双向结果与APK真机待验收 |
| 普通用户安装、配对、兼容与最终整合 | 20 | 8 | 自含Mac设置产物与正常DOM→实际IPC保存已独复；真实WK/原生选择器、首次安装配对、签名及最终交付待验收 |
| 合计 | 100 | 68 | Goal 仍 active，未宣称整套可用 |

本次材料6→7由Astra验收认可：root独复正常DOM session62061 exit0、1/1（35.34秒），正式生产addon实际加载；正常index/ScreenNet与registered screen→模拟Android固定驱动→真实private FD导入/保存（零native turn）→显式Send精确accepted提示（一次native turn/start）→刷新仍一次→关闭清理全部通过。作者53458同case也通过36.17秒，root已检查代码和截图。结合正式main装配及真实FD生命周期41501独复，这是新增正常用户入口整合里程碑，仅增加材料1分，其他五项不动。该case是UTF-8小文本与临时synthetic native，不是APK/ContentResolver、原用户桌面或4MiB通过；同request新screen恢复仍需后续验证。

后续新screen恢复门槛：root独复focused recovery3/3，原store/registry组合12/12；完整扩展DOM93976 exit0、1/1（40.12秒）。旧picker短FD已释放、页面reload后获得不同真实registered screen与新的management permit，IndexedDB原operation恢复按钮携原request_id，恢复原draft/receipt/transfer/asset/native client/operation IDs；查询只读，无新增submit/send/retry/apply，native turn保持一次。证据只涵盖同进程页面重开与临时production端口，不含source进程重启/真机。finally仍有一条Native transport fixture TypeError诊断，已交C定位实际清理阶段且不吞未解释错误，不抹去该诊断。跨process source snapshot当前证明恢复由C下包先梳理；RI并行实现私有online setup read/control typed桥，默认项目仅投影已有明确create授权，不暗加权限；整体67%保持。

root独复fixture callback epoch/owned Promise回归1/1：已发旧page回调在reload后不会进入新AshNative，新page真正缺handler仍抛错；关闭等待已有callback排空。C将retire/abort/drain接入browser reload/close，此窄test不代表93976旧诊断已由新完整DOM证明消除。source重启恢复另获准最小receipt只读probe port，禁止借send/offer自动重传来查询原receipt；新actor/T1/target当前证明必须重新获取。settings typed backend正在追加actual defaultmain/native/UDS回归与独审，未计完成或GUI交付。

root独复新settings实际default-main4/4（29585，6.96秒）与旧setup/materialIPC/review17/17通过；不抹去作者合跑旧clear曾失败的记录，其时序原因仍待定位。research独审自有两真实native fixture复现75613：旧配置完成verifyScope后、apply恢复前换另一valid配置，真实changeSafety仍safe且setter落grant。已退修retained私有verification proof/final fence，不能仅boolean或reservation safe作为原source未变的证明；GUIpreview不输出proof、不因基本4/17通过计安装加分。C同OS进程重建source新state/runtime对象已作者23419通过32.64秒，原receipt恢复零asset RPC/native仍一次；真正OS source退出未验收，新只读源完整hash可用性修正在root独复中。

新增源可用性case根66258 exit1（30.01秒）为fixture在registerInputTarget推进真实registry revision前已发行context，mutation后旧context被正确permission_denied。根审源码确认门槛；C仅调整专测从真实sourceActor在每次mutation后发行新context，不复活旧context或改生产授权。作者40791修正版1/1通过39.16秒、TS通过：原receipt恢复与真实A1已登记未传源readonly完整get、仅canonical无源分别显示source_snapshot/unavailable_source，零offer/put/commit、native一次。根下一独复已启动；同OS进程重建证据仍不外推实际source worker退出。

root59513修正版独复exit0、1/1（40.86秒），确认同root的新state/runtime/registry与freshscreen下：原request/receipt/transfer/operation/nativeclient IDs保持、恢复零asset upload RPC/native仍一次，真正已登记源的完整A1 get验证可用、仅metadata无源不伪装可发送。下一门槛为独立source worker实际退出后新进程恢复；当前67%不再加分。settings retained-proof退修已重新触发RI继续，原boolean版本尚不接受为授权提交完成。

root独复 retained settings 新8项（94398，exit0，14.48秒）：default-main真实私有IPC首次授权、关闭期间拒绝提交、preview owner/config替换，以及capture返回后另一个真实native配置、目录inode、socket inode、verification关闭均拒绝setter。生产保留私有proof至最终write，不向GUI输出proof。独审随后发现finalCurrent同步外部检查返回后尚需复查captured config/目录的新尾窗，仍在隔离证伪与退修；boolean兼容也正在收敛为显式testing选项。作者旧clear失败已定位迟到fs.watch使epoch变化而revision不变，旧form返回stale并保留原grant；测试不能忽略response.error，普通流程须重新明确prepare，不能自动重试apply。

实际source worker作者56161终态exit1（59.77秒）：worker A实际退出、B不同PID/epoch/screen，原receipt/operation/nativeclient恢复及只读零asset RPC/native一次阶段通过；最后明确发送尚未传输的源返回result_unknown，完整闭环不计通过。此前bootstrap失败已定位fixture在owner连接后才装IPC响应路由，调整为连接前安装，没有放宽产品权限或deadline。当前继续定位发送阶段，尚无root实际跨PID完整验收，整体67%保持。

独审85546已证实final版本检查返回期间替换有效配置仍可能落grant，要求native检查后重查原配置/目录，并把快速source复核放在最终阻塞检查之后，settings尚不验收。材料88114诊断明确offer/put_chunk/commit成功、control/state成功，但没有control/apply且native仍一次、unsent journal无claim；合成native未发started/completed导致原任务pendingStart保持unknown，产品拒绝假idle是正确行为。下一测试仅补专用真实WS生命周期事件fixture，不能直接伪造idle或放宽生产状态门槛。

退修后root98036独复setup9＋旧service16＋materialIPC2＋review1，共28/28，exit0（15.69秒）。proof的regular/final native调用返回后重查原source，setter在最后reservation之后再作WeakMap私有cheap source复核；新回归真实最终版本子进程返回时切换另一有效native配置仍拒绝写grant。boolean verifier默认拒绝，只有显式testing fixture可兼容，实际main不传testing。owner替换case打印实际material receiver stale拒绝诊断，未抹去且不视为已授权。原旧form迟到watch回归明确epoch改变而revision不变、返回stale且保留文件，未自动重试apply。

root25868独复实际source进程闭环1/1，exit0（64.70秒）：worker A退出、worker B新PID/epoch/screen，同root恢复原request/receipt/transfer/operation/nativeclient；只读恢复零asset RPC/native仍一次。新专用synthetic native通过真实WS发送原turn started/completed，actual Core Edge观察可靠idle后，明确发送未传源才触发offer/put/commit及第二次native输入，后续query不重发；缺源仍不可用。原receiver fixture未改、生产状态与deadline未放宽。此证据含真实子进程与私有FD/A1/记录链，但native仍隔离合成对端，不是用户Codex桌面或APK真机。材料恢复开发层门槛已通过，普通设置壳/安装配对与真实用户端验收仍需完成，整体67%暂保持。

第二轮独审12640发现最终版本检查期间替换socket路径仍能落grant，已退修为captured canonical socket + dev/ino/ctimeNs的持续cheap source检查；不是以可复用内核地址作为generation。root53832最新实际main10/10 exit0（21.19秒），research35033复用原socket替换证伪脚本确认替换实际发生而apply拒绝、grant未写，settings backend窄范围验收。root另独复emitter/recovery/UI13/13；正常gen:ui已纳入source_snapshot/unavailable_source，仍不声称已跑新完整DOM或新APK。

Astra §14.19将下一普通设置包分为独立写权：C实现新增AppKit/WKWebView、本地固定assets、私有stdio桥及离线构建，RI实现只读真实online诊断和窄main/link接线。renderer不能指定root/endpoint/secret/任意exec；目录通过原生选择器获得，完整范围差异预览后用户明确保存，defaultProject仍仅来自active exact_cwd/create_work。已确认本机Swift编译器存在，不安装/启动新App或修改用户真实授权。干净安装/配对、签名发行、原用户Codex桌面、APK真机与逆向材料结果完整验收继续保留，整体67%不变。

中断后核查原agents已interrupted、旧live测试无遗留进程，按原文件写权恢复。root独复settings bridge6/6（220ms）：默认受保护config/state/key、任意renderer路径/命令拒绝、关闭late响应、一次性preview、200次status旧目录ID失效与lateprepare拒绝、有界请求/错误白名单。Swift临时编译不等于可发行：C确认复制Homebrew Node24仍依赖外部dylib，构建预检明确拒runtime_not_standalone，未启动或安装用户App。

online状态包root81332独复38/38 exit0（20.11秒）：实际main原10、原设置19、connection/状态调度9。仅明确setup.status做深诊断；prepare/apply保留cheap当前范围投影，不自动重试写。只读状态最多两次完整capture，第一次proof释放后才第二次，原owner/磁盘scope revision/config/socket/目录/物理连接边界不变；持续stale、源变化、owner变化拒绝。root发现旧diagnostics与新scope合并窗口，RI修为以status.precondition严格取scope并最终assert，新增owner/grant变化回归通过。实际native接口验证和授权/模型业务成功分别报告，login未知，saved-history source仍待受保护绑定；独立审查正在进行，不据38绿色扩大为GUI/首次安装验收。Goal与整体67%保持。

安装8/20、整体68%由Astra §14.20认可并由root采纳，仅新增“可校验自含Mac设置产物＋正常用户界面实际IPC整合”一个里程碑。root41895 bridge/DOM9/9 exit0（20.55秒）：三次完整scope保存、默认项目整份替换、取消零写、模型业务零调用、late编辑/离页拒；Chrome模拟原生目录选择不等于WK/NSOpenPanel实测。官方Node22.22.1 darwin-arm64 tempApp构建已成功，root独核manifest全部SHA、隔离HOME的Resources/node和固定stdio状态白名单及EOF exit0；otool仅系统四项依赖、无Homebrew外部库，下载提取helper4/4独复。未安装、启动用户App或签名发行，Swift实际系统home不能仅靠env HOME隔离，下一I-WK2需独立测试入口复用production类而无production root override。

独审真实私有proof复现握手期间control grant过期仍显示verified，已退修。root91593最新40/40 exit0（19.96秒），reviewer独立握手和scope合并两种时效复验均missing/default unavailable、首proof先释放、最终retained0，原磁盘grant未续写。root89895受保护read source新模块8/8 exit0（9.50秒）：opaque config身份/摘要连续性、正常历史增长、源替换/响应排空尾窗/timeout/cancel；旧reader与正式status尚未迁移，不能据新模块宣称当前读取绑定已完成。真实隔离CLI研究发现state_db_path无效而sqlite_home/-c/CODEX_SQLITE_HOME有效，空列表不能证明物理源；默认覆盖home会误切用户已有外部库，需原生证明有效原SQLite根并保留来源。其余五项贡献保持，完整首装/配对、原用户桌面、APK真机与结果回收仍待验收。

R-READ2 root53656独复realm10＋source8，共18/18 exit0（7.81秒）。同捆真实CLI在两套已有自有合成历史中分别list/read，拒绝对方root会话；固定sqlite_home根与实际own child打开REG FD的dev/ino/name匹配。目录/数据库/config/source替换及真实lsof返回尾窗、权限失败均拒绝，普通SQLite写入可接受，所有FD释放含失败缓存通过。研究前期版本提取只取数字曾误记0.162.0，实际严格完整版本为0.162.0-alpha.17.2，hash不变；模块拒绝未验证final版本，未放宽白名单。已交独立review，旧PATH reader/正式诊断/source选择迁移仍未接线，Linux/其他布局/named profile的新模块支持仍未验证，不扩大普通用户可用范围或加分。

I-WK2作者39595首次真实临时App测试exit2，卡独立私有FD入口，未进入WK页面；没有TCC/用户配置操作，原临时backend/native已清理。proof-only诊断定位Foundation将/private/tmp别名呈为/tmp导致字符串误拒，改Darwin.realpath保留原uid/mode/inode/root约束后60132编译与真实FD证明通过；完整WK/NSOpenPanel/确认/关闭仍须下一真实测试，不以FD-only或编译通过冒充界面验收。整体68%保持。

read realm独审自有/tmp最小复现发现两项未被18绿色覆盖：同版本非tested binary通过descriptor自报hash可返回verified（兼容性缺口，非跨UID），以及忽略SIGTERM的child在group消失但原pipe/close尚未完成时probe提前verified。已交原owner退修为实际已验证version+artifact SHA双pin、显式fixture bypass，以及read专用child/pipe真正close-drain后的final current；不并改generic agent process契约，不据旧测试green验收正式source。旧reader仍未迁移，68%保持。

WK作者78650完整测试因shared manifest同类Foundation别名比较而未入页面，改Darwin.realpath后58191实际已进入隔离WK并读取status，随后原生目录面板阶段child信号退出，选材/保存尚未证明。原临时child/backend均已清理，无用户App操作；仅fixture driver的MainActor边界正在定位退修，不能把已加载WK页面当完整原生设置闭环或加分。


2026-10-09。完整目标与验收门槛见 [实施计划](CROSS-END-IMPLEMENTATION-PLAN.md)，产品 v0.5 和技术 v0.2 仍为依据。此页记录开发证据，不是安装完成或首期交付声明。

## 已有证据

- 共享 Codex App Server daemon 已与桌面接入同一实例。外部独立连接测试中追加进入同一轮，等待工具正常完成，另一连接可读取历史；用户截图确认桌面展示。GUI 发起对照及普通用户服务生命周期尚待验证。
- 原生输入 clientUserMessageId 保存为历史 userMessage.clientId，真实测试已核对两个消息与原生 item ID。不能据此承诺原生重试幂等。详见 [测试记录](CODEX-DAEMON-ISOLATION-PLAN.md)。
- WP-R 保存历史适配器只调用读取方法、默认无范围拒绝、精确 cwd 二次检查。可见内容过滤 reasoning，材料只保留来源部件引用，不提供下载权限。输出完整页上限1MiB，transport解析前上限8MiB；遍历最多128条游标关系，超限明确要求刷新。Root针对性14/14通过。
- WP-J 以SQLite FULL调用意图、principal/operation唯一键及原子claim持久投递事实。native调用结束后写库暂失败，只续存回执、不重放native。到期仅阻止新调用，当前获准主体仍能核查保存事实，撤权则拒绝。R/J独立复审34/34通过；额外8轮四进程冷启动32worker均成功且每轮只调用一次fake native。实现者另24轮96worker通过。

## 进行中

- Goal自动记录已恢复active（本轮get_goal核实）。S1原生传输/活动/控制及S2独立control grant初版完成，root定向32/32通过；native_control_review正独审，尚未接真实手机。S3由persistent_reconcile负责持久clientId/接口版本、SQLite迁移及只读核查，不能以新的fake测试外推完整控制已交付。
- S1独审已复现两项待修：当前turn的原生error被忽略后仍允许steer，以及observe最终异步授权期间重连后旧observe错误地返回成功。均已交S1 owner修复；新epoch没有实际订阅但显示成功不能被当ready。S3持久字段第一批保留原20项journal测试通过，完整迁移/恢复及新核查仍在开发。
- 上述S1问题已由owner修复，待最终独立复审；S2独审通过。S3持久字段/迁移/有限历史核查已完成初版，记录bounded_history_pages/pages_observed/history_exhausted，不宣称全历史唯一或执行完成。root最新S1/S2/J/reconcile联合92/92通过，实施者根tsc通过；独立S3复审仍在完成最终provenance变化。手机通道尚未接线。
- S1追加的历史参数可变竞态也已修复，26专用测试及独立授权/epoch/version/listener探针复审通过。S3最终54/54及独立6场景/CAS探针复审通过，根tsc通过，开发层验收完成；非真实手机链路。S4由device_control_service与core_control_service负责新增固定协议与服务，现有入口和UI仍未接入。
- 晚加入缺口已明确：旧S1必须观察到turn/started才有可用turn ID，手机在桌面已有任务时打开会保持unknown，不能视为满足产品目标。正在扩展以当前原生active状态证明活动、有限历史仅提供候选ID、expectedTurnId原子拒绝陈旧候选的晚加入及重布防；不从存档猜busy，不将追加改为新轮。新增范围尚待fake、独审与受控真实验证。
- 原生turn/start缺少atomic idle前置条件；发送前观察到idle不代表其他客户端不能同时启动任务，须保留该实际协议边界。steer使用原生expectedTurnId，不把动作在busy/idle变化时自动替换。此批尚未修改用户真实授权、安装或服务。

- WP-I1 已接设备main/link/CLI及固定read能力。网关from与pinned配对owner key派生ID比对，不把正文caller当授权。授权范围配置默认空；断线/撤权/配置变化取消并丢弃旧结果。授权内容hash authorization_revision为必填前置条件，numeric generation仅辅助计数，防同generation改范围。实现者42定向测试通过，独立复审37通过、1原有跳过；最新device构建通过（529.2KiB）。
- WP-I2-Core 已实现专用 endpoints/read 路由，不经普通ledger复制历史。最终异步授权等待窗口和gateway统一期限两项问题已修复，独立复审48/48及tsc通过；原过期探针403无正文，35ms期限探针36ms单次504，迟到授权不启动设备读取。仅开发层验收，真实链路尚待验证。
- WP-I2-UI 已实现已连接执行端发现、会话列表/详情、可见时按需刷新、分离新旧分页、有限缓存。身份scope错绑、缺口分页顺序和包含式边界、send-error误停轮询、真实源降序消息页均已修复并经独立实际方法探针复验；store/controller单测7/7，真实Core shell＋Chrome DOM测试3/3。浏览器测试读取数据使用fixture，尚非原生链验收。

最新源码设备侧读取、授权、传输、投递整合定向测试：48/48通过（root重新执行）。这些测试使用隔离fixture，不能替代真实手机链路。真实安装仅核查配置文件存在性和目录：已有配对文件，但collaboration-read.json尚不存在；没有读取密钥或扩大范围。

最终统一typecheck、build:core（8.5MiB）、build:device（529.2KiB）及diff检查通过。root另执行Core读取与UI单测20/20通过。UI生成器同时生成Core的ui.ts和Android ash-ui/index.html，两者来自同一UI源码，不手写生成文件；其他Android源码保留。GUI发起观测脚本正在隔离实现与测试，未向真实客户端发送。

本轮本地产物SHA-256（不是已安装版本）：

- packages/core/dist/ash-core.mjs：c8d3a9fc8d63ac78e72606a0910f04eae3e4b9b3f6d7a9dcf0d4aa4def38fa38
- packages/device/dist/ash-device.mjs：68026a10d187a7590358d56b976357de2e4d23d13f8b59962b0c32af39b8a275

只读服务核查：ai.ash.device LaunchAgent处于running（观测PID2056），实际current指向既有0.1.0-local安装，内置Node22.22.1。未替换安装、重启服务或调整daemon归属；上述本地构建不自动进入真实手机链。

T-C2新脚本位于tools/research/codex-gui-steer-probe.mjs，最终隔离fake测试30/30通过（root复跑），独审另3个独立回归断言通过；审批等待、末条final_answer、未知回执、shell精确包装、epoch及canonical监听归属问题全部闭合。未真实运行。root只读OS核查daemon PID76675仍存在；控制socket为指向/private/tmp/codex-daemon-501下实际Unix监听器的符号链接。脚本同时核查canonical监听路径和实际Mach-O executable，不能直接把current/bin包装入口与lsof txt路径等同。未读取新会话正文或发送新输入。

当前下一步需要用户打开隔离会话「Ash 跨连接追加消息测试」（01a11f8f-7ff8-7ab2-9ad7-0607832213a9）并确认就绪。收到用户就绪后才启动观测、取得ARMED与本次run_id并交付精确输入；当前不启动180秒发送窗口，避免用户尚未就绪时失效。GUI动作是不可替代的C2条件，已有模拟追加授权不重复申请。真实scope授权和安装替换尚未执行，完整Goal仍未完成。

用户已打开并执行两轮GUI测试。run c05300d5先捕获普通消息而提前结束，steerCalls=0；其后测试输入正常完成，不能算追加通过。run 82dc70e8新turn 01a1203d-51cb-7911-8788-2ca456b05c0e已正确观察，但120秒期限内无steer；用户后来确认回复，固定目标只读核查显示正常completed、唯一sleep25工具exit0、final_answer只有base标记。仍为inconclusive，不能证明GUI追加成功，也不能只靠末态历史断言工具启动时间。正在延长有界观察窗口并准备事件时间摘要，未重发未知投递（两轮均从未发送steer）。

第三轮run bbdf161c已观察GUI新turn 01a12046-3566-7113-8e78-a5e1b3759995，以及20.288s等待工具started，但旧复合history前置校验失败，steerCalls=0。末态只读核查确认同一exec ID、精确shell sleep25、exit0及base标记；旧脚本没有运行中细项，不能判定具体失败字段。修订脚本40fake通过并独立复审：历史暂缺仅有界只读重查8次（间隔至少500ms），增加脱敏细项，不将缺存档直接放行为steer；10分钟观察/实时活动/同epoch/唯一等待未结束门槛保持。尚无GUI追加成功证据。

真实自动诊断确认根因（非GUI验收）：fixed turn 01a12050-4652-70b3-8b3f-2ce9ceb5ab43，同连接4776ms收到工具started；5.046–10.647秒十二次历史页均commandCount=0，baseCount=1，turn=inProgress且thread=active/emptyflags。29.682秒同工具正常completed/exit0，32.309秒turn completed。证据：build/research/daemon-switch/gui-c2/diagnostic-b005d508-94f5-45e5-b4d3-b923f22070e8.json；没有steer或interrupt。历史接口只提供已保存工具，原probe额外要求历史出现运行工具不适用；正在依同连接实时started/未ended＋当前thread状态、epoch、expectedTurnId核查运行状态，历史仍核身份/标记及已有冲突，完成后全量核工具和clientId。不能以永久拒绝发送替代用户控制目标。

修复版42fake及独立竞态复验通过。真实自动starter＋probe run 8bf403a4在turn01a12053-108c-7b23-854b-e9b57bb13336通过：steerCalls=1、ackSameTurn=true、同等待工具exit0、final双标记、唯一clientId→historyItem01a12053-1ff4-7ec1-9cf0-5868c423118e且historyVerified=true。输出gui-steer-8bf403a4-696b-42b3-ad2a-cb0b48998b39.jsonl；明确这是自动发起模拟，仍需GUI发起对照，不能提前关闭C2。

GUI run 034927a7已成功核查原生结果：用户桌面发起turn01a12055-56df-7ff3-97bc-111a09e2e8e6，同轮追加clientId gui-034927a7-1bac-4485-ae46-44f1cf1684b0-0066007d-80f5-44f4-a2b8-d7f25e3e86dd唯一对应item01a12055-66dc-7e03-8bc1-0b0ea1c3e813；唯一期待sleep工具正常completed/exit0，末条final_answer含base与append两标记。原exec session handle已缺失，输出仅留fsync调用意图、无终态ack；没有重发，直接只读核查同实例固定历史，证据reconcile-034927a7.json。据历史证明追加被接收并作用于同轮，不能伪造缺失ack或工具完成前后的事件时间；还待用户确认桌面显示。尚非Ash手机端控制整合验收。

用户截图已确认GUI run034927a7的初始输入、外部追加消息和同一最终回复双标记均在桌面展示（耗时31秒）。C2这一具体GUI发起/同轮追加场景验收通过；截图证据为用户附件codex-clipboard-3dcb843b-7ef3-423e-bce9-b339f2463f64.png。保持上述原生ack缺失边界；不外推全部G-Control、手机发送、断线恢复、安装发行已完成。

## 开发者范围配置（尚非普通用户安装流程）

在已有设备配置和配对完成的前提下，构建开发连接器：

```sh
npm run -s build:device
node packages/device/dist/ash-device.mjs read-scope --config /absolute/device.json --allow-cwd /absolute/project
```

可重复--allow-cwd指定多个精确目录；每次覆盖现有范围，而非递归授予子目录。撤销全部：

```sh
node packages/device/dist/ash-device.mjs read-scope --config /absolute/device.json --clear
```

这些命令仅写已有配置指定stateDir下的collaboration-read.json，不自动安装、重启系统服务或授权桌面控制。本文命令未对用户真实配置执行。客户端可用性仍由实际读取判断，authorization_state=ready不表示Codex运行或控制已就绪。

## 未完成范围

Core/UI集成与真机烟测、原桌面任务外部追加对照、控制适配器和投递核查接线、真实项目新建复用、问题/材料/结果及反向请求闭环、安装配对图形助手和升级恢复、完整独立审查仍未完成。真实控制不会以Ash另启运行器代替；未知投递不会标完成。没有提交、推送、部署或发布，也没有清理既有Android未提交改动。

## 2026-10-09：Goal 恢复后的控制服务复审

Goal 当前 active，GUI C2 指定场景已解除用户操作阻塞。S1 晚加入实现已交付 44 项 fake tests 与 TypeScript 检查，支持先有桌面活动任务、后建立观察，并区分 observed_turn_started 与 history_candidate；尚待独审和受控真实晚加入核查。S2/S3 开发层独审通过，不能据此宣称手机完整链路已交付。

S4 新增 device/Core/watch 服务定向 26/26 与全仓 typecheck 通过，但独立审查用真实 CodexControlAdapter/CodexTransport 加 fake socket 复现了两个阻挡：每次 state/apply 都重新 connect 导致 epoch 改变，state→state→apply 返回 stale_precondition；connect 失败的 scope 未释放，128 次不同目标失败后 registry 耗尽。native_control_adapter 与 device_control_service 已重新激活修复，control_service_review 负责复验；这两项修复前不放行 S4-device。

当前现有入口仍只有读取接线：device main 尚未装配 control service，Core server/gateway 尚未装配固定 control routes，UI 尚未提供控制提交。下一阶段集中分配这些旧文件，落实同一 deadline 下 owner/screen/配对的前后检查、控制 manifest 与风险能力、持久 operation 及仅查询/核查的恢复。没有运行真实控制、创建 grant、替换安装服务或部署。

本轮后续复验：P1/P2 连接 admission 和失败 scope 清理已修复。根运行 Core/S4-device/watch/S1 合并定向测试 75/75 通过；独审原实际 adapter probe 变为 epochChanged=false、initialize=1、resume=1、apply accepted、turn/start=1。另发现 scoped error 后同 epoch 的 state 观察缓存未进入安全 rearm，导致持续 unknown；service/native owners 已激活修复，并要求保持 pendingStart 的未知投递不被重置成可自动新发的 idle。S4-device 整体仍待这一恢复问题复验。

恢复问题最终独审放行：S1 原生 46、S4 device 20/watch 2/Core 11 合计 79/79，tsc 通过。三项连接/恢复 finding 均关闭；独审额外验证 8 并发 ABA 撤权拒绝与旧 socket 清理。safe rearm 不把 pendingStart 或普通 unknown 重置为 idle。此结论仅覆盖新模块与 fake 接线。下一阶段已分发 Core 旧入口包 core_control_wiring（Sol medium），独占 server.ts/gateway/link.ts 与必要 Core 装配及新的路由测试；Astra phase_coordination_refresh 正更新整体计划与 device 生产 factory 分包。

入口批已并行启动：core_control_wiring 负责 Core 固定控制路由；device_control_runtime 负责本地严格 daemon 配置、唯一 listener/PID 证据与生产工厂；desktop_control_ui 负责手机 WebUI 明确提交、唯一 operation 及投递状态/恢复。三个包文件边界分开，factory 契约冻结后才接 device main/link。Astra 已更新实施计划，根同步技术决策的共享 daemon 实测结论。仍未配置真实 grant、替换服务或部署。

本轮根验证 Core 旧入口初版与原读取回归：33/33 通过，覆盖四控制路由、当前 owner/screen/配对、统一 deadline、断线取消、普通模型路径过滤与 ledger 不增长；控制目标发现尚在追加，独审未执行。另只读核对 itsallsame/apps/browser-bridge/src/codex-local-service-launch.ts：project/list 按精确 root cwd 找 projectId，thread/start(cwd, ephemeral:false, projectId)、thread/name/set、turn/start 是现有新建路径。S5 将复用契约而非再验证侧栏；需为新建定义独立持久 operation 与实际返回 WorkRef，不能预造 threadId，且指定项目找不到时不能静默退化成未指定项目。此次未运行 itsallsame 或新建真实聊天。

Core 旧入口包已交独审：四固定 POST 与独立 GET /api/collaboration/control/endpoints 完成，原读取发现契约保持不变；37/37 和 tsc 通过，core_wiring_review 正复验。生产 control runtime 工厂接口已冻结，作者最终 11 fake tests/tsc，根复跑此前 10 项通过；control_runtime_review 已分发。runtime 使用当前选定 socket 的唯一 listener PID 与 executable/version 动态复核，独立 metadata 不 resume/写入；超时后真实未决调用继续计 busy。手机 UI 已写入源码，真实 Chrome DOM 测试进行中，生成产物尚未更新。设备 main/link 接线和全部真机验收仍未完成。

进一步独审：Core旧入口37+6独立probe可开发层放行，但FixedControlTransport.exchange异常路径漏fresh pairing/grant返回复核，core_transport_error_fix已分修；不能据此宣布完整控制边界通过。runtime独审复现metadata await期间无watch撤owner仍写一次，作者已补最终S2授权与最终metadata局部ALS绑定，12/12回归证明该窗口零写，根复跑通过，control_runtime_review正在复审。UI作者真实Chrome DOM7/7+outbox/readstore9/9完成，desktop_control_review开始独审并补actualservice HTTP-chain；root发现双动作grant的steer state epoch不可用于send_input，作者已改按实际action二阶段state。生成资产、device main/link接线与真机仍待完成。

Runtime P1 最终独审关闭：12/12、tsc、独立第8/9 metadata撤owner/context/grant零写、4轮并发双目标ALS隔离与socket释放通过。已分 device_control_wiring（Sol medium）独占 device main.ts/link.ts/capabilities.ts 和新的入口tests/必要pairing helper；需要每次 fresh pinnedOwner accessor、固定分发、manifest风险、断线/关闭/updatebusy接线，CLI未授予。Core exchange错误返回修复已补当前配对/manifest复核，根专测12/12通过，完整复审尚待原OwnerLink probe。UI独审正补真实DeviceControlService+actualadapterfake socket+HTTP+Chrome链，未使用真实原生服务。

S4 UI独审开发层放行：outbox/readstore+service29/29，installed Chrome control7/read3共10/10；独立临时 actual FixedControlTransport/executeControlRoute→DeviceControlService→CodexControlAdapter/CodexTransport(fake socket)→HTTP→Chrome 两场景通过，idle一次start、active latejoin两action scope/state epoch匹配且一次expectedTurnId steer零start。作者已激活仅补仓库持久链回归，临时证据 /tmp/ash-s4-ui-chain.ts。根执行gen:ui同步Core ui.ts与Android ash-ui/index.html，diff-check通过；未安装到手机。Core exchange-error修复交原core_wiring_review复验；device main/link/capabilities接线进行中。

本轮 Core 错误路径最终独审放行48/48，原超大error+撤配对返回403；根build:core成功8.6MiB。UI actualservice HTTP/Chrome链已固化 desktop-control-chain.spec.ts，idle/active/回执中断刷新恢复3/3，独审再核查中。device入口接线测试发现新的close生命周期缺口：service deadline过后原生调用仍持有journal session，runtime同步close即关store会busy抛错；必须修为先拒新请求/关本scope socket、等待真实未决请求收尾后关闭store的幂等流程。main将await close；该修复前不放行device整合，未执行实际服务替换。

根已独立复现busy-close失败，固化入口最后一测当前busy抛错；control_lifecycle_fix已授予service/runtime及对应专测修复，device_wiring_review已开始只读检查main/link/pairing/SDK风险union及入口tests。设备owner继续补startDevice真实装配fake生命周期，不调用本机browser或安装服务。UI持久链3/3最终独审通过，不含生产gateway身份及Android链。Core本地产物SHA256：2263c184975bc592d9e96087a6e2857496b8527d990c62017498af176cf21b37，设备产物尚待接线/生命周期最终审后重建。Astra已完成S5-CREATE-WORK-PLAN.md，创建使用独立operation与真实project/WorkRef映射，S5暂等待本批生命周期收尾。

设备入口与生命周期最终独审放行：串行7文件67/67、tsc与pairing独立probe通过；此前并发断连fixture偶发未进入hook，作者只补显式native phase gate，生产代码不改。root已build:device 628.0KiB，SHA256 0afdb02ced6932ecd5cfc8f6861aa51796e628667193af60d9b33599b8bdfc53；Core8.6MiB产物保持。按完整交付权重，开发层控制/恢复整合已推进，整体估算由45升为50，真实手机、生产gateway/daemon、S5新建、WP-A材料与普通安装仍未完成。Astra s5_contract_coordination已分发冻结S5首包。

S5-A已分create_contract（Sol medium），仅新增create-types/create-protocol与专测，Astra s5_contract_coordination冻结projects/apply/query/reconcile独立命名空间、三阶段create/name/first_input、真实project/WorkRef与稳定client ID接口，A交接后B/C并行。整体仍50%，未凭设计预加创建交付分。S4断连测试已改native phase gate，根复跑trustedconn通过，但另一HTTPabort fixture早deny仍偶发Missing rejection；作者继续仅补该fixture admission gate，生产代码与本地产物不变，不将单次绿测试掩盖此稳定性缺口。

S5契约三文件已实现，根独立复跑collaboration-create-protocol.test.ts 9/9通过，独审正在核对阶段unknown/rejected等边界；A放行后才正式分journal/nativeadapter。完整估计仍50，不因纯契约测试通过提前记新建交付完成。另根独跑S4HTTPabort同步加强发现warmup query返回invalid而非预期permission_denied，已退作者修合法DTO/fixture，生产未变。

S5-B journal/store已交独审，作者33专测及tsc通过；create_journal_review已分发。S5-C18专测通过但独审三finding阻挡：可变request.target在authorizeawait后改变实际创建cwd，history未绑定可信exactcwd，name畸形ack可accepted。已followup C作者与A契约owner修不可变输入/可信scope/ackschema，B后续需消费加强context。整体50%不因未审实现提分。身份prefix三生产文件修复独审124+旧reconcile34/tsc通过，root重新buildCore8.6MiB/device628.3KiB，生产S5尚未挂载，未实际安装。

S5-C退修根复跑30/30通过，修复不可变request/work、可信授权exactcwd核查与畸形nameack未知，仍待原独审最终复验。A新增authorized_scope及冻结context factory，授权来源必须后续D当前grant lease兑现；root/B reviewer同时发现helper误用createId会回归_/-gatewayidentity，Aowner已重新激活修统一identity。Bowner已激活仅消费可信scope，B独审额外foreignreceipt/mutation/expiredgrantquery/返回撤权及8轮×3process启动applyprobe均通过。完整交付仍50，S5未接手机，未扩大真实授权。

S5 A增量+C最终独审放行44(A14+C30)/tsc，三原probes全闭；真实grant scope来源仍须D兑现。B原33及独立多进程/CAS/mutation/expiryprobes通过，新scope消费43/tsc已交原独审最终复验。根本轮protocol+旧B snapshot47/47通过（不冒充覆盖作者后加10scope tests）。create_authorization_service已分S5-D新增create-authorization/create-service及专测，明确真实当前grant/pairing/exactcwd/project/epoch与requestlocal回调，不修改旧入口。按创建基础模块已审贡献2/10，完整整体估算52%，仍无手机新建/真机/安装交付。

B最终scope消费独审放行43/43+tsc及独立foreignhistory/7坐标异步漂移probes；根重新复跑B43/43通过。S5已审A14/B43/C30基础模块贡献3/10，整体估计53%。D创建授权/服务实现进行中，Core-F纯新create-service已分与D共同冻结独立共享manifest；Downer已额外获授Atypes/protocol仅manifest共享parser/schema，不交叉写Core。Astra material_phase_coordination准备WP-A双向材料/请求/结果实施包，要求真实跨端字节与原会话跨轮领取，不以同端文件复制或linkonly替代。尚未接S5旧入口/UI/真机。

S5-D 授权/创建服务已交付，作者45项专测与tsc通过；S5-F纯Core服务作者12项与tsc通过。当前分别由codex_create_review、create_journal_review独立只读审查，尚未放行。D query按当前可信owner/grant精确target/revision返回保存事实，不构造native连接；原生离线不应阻断恢复查询，apply/reconcile仍要求实际源与目录证明。已启动create_device_wiring独占S5-E设备runtime/main/link/capabilities及专测，未修改真实配置、安装或daemon。整体估计维持53%，不将作者测试等同集成交付。

S5-D及共享manifest已由codex_create_review独审放行：45项与tsc通过，独立probe证实保存事实查询精确当前授权、store读取后撤权拒绝、unknown重传零native及close后拒绝。根合并D/F专测57/57通过。F独审发现最终owner authorize异步等待之后缺少device pairing/grant/connection最终fence，三种变更probe均复现旧结果返回；已退回core_create_service修复，create_journal_review继续复验。F仍未放行，S5-E接线开发中，整体53%不变。

S5-E根复跑新增create runtime专测6/6通过，覆盖生产工厂fake listener与真实store/adapter、无native配置保存事实查询、unknown重开不重放、watch ABA、版本/目录归属变化及未决工厂关闭重试；入口专测与独审仍待完成。F第一轮gate修复作者14项通过且原六模式probe拒绝，但外层transport Promise返回微任务间隙connection变化仍可返回旧事实，正在追加最终同步session fence，未放行。同时只读核对旧control-service发现同类最后owner await后跨层fence缺口，列为必须修复的S4回归；原已通过测试不证明此窗口。整体53%维持。

S5-F最终开发层独审放行：15专测、tsc及9独立竞态probes通过，最终owner await与外层transport Promise返回两个窗口均由双gate/同步session fence闭合。已分create_core_wiring独占Core server/gateway与control-service回归修复及Core tests，接入真实入口并落实真实同步owner/screen与连接门槛；F纯模块只读。旧control同类缺口仍待此包修复，设备E仍等待作者完成受影响回归/tsc及独审。整体53%维持，不外推真机或安装。

最新整体约54%（15+18+12+4+0+5）：创建贡献增加1，依据D/F独审通过，不依据代码行数或测试数量。E作者42项及tsc通过并交codex_create_review独立只读审查；create_core_wiring正在接实际Core入口与旧control窗口修复；desktop_create_ui已分发独占WebUI新增创建模块与最小挂载，create-only grant可独立发现目标，不依赖读取grant。四POST及GET endpoints响应契约已由Core owner冻结。无真实配置/安装/原生写入，完整Goal继续active。

S5-E独审放行：40项E/control及11项read/link回归、独立config无watch漂移/offlinequery/ABA/close probe通过。Core实际入口作者最终67/67+tsc+diff-check通过，门槛由私有WeakMap保留至HTTP输出/gatewayreply；已交create_journal_review独审，不能以作者结果提前放行。UI开发并行；WP-A A0由material_contract独占纯材料契约/协议/tests，采纳40KiB原始块与64KiB编码后封包双限制，尚未实现传输/结果闭环。整体54%不变。

UI root专测store初版6/6通过，但读源码发现加载存储及defaults未整体数量/字节限额，已交UI owner补强；不能将该初版测试认作最终缓存边界通过。A0纯类型初稿target只有node/endpoint缺material_to_work实际完整WorkRef，根要求target_work固定精确会话，不能以正文上下文当会话绑定。两项均开发中，当前整体54%不变。

Core接线独审未放行：GET create/control discovery falsy抛错被当成功；gateway已收到device.presence online:false却仅异步refresh，等待中最外responsefence未失效。均独立actualOwnerLink probe复现，已激活create_core_wiring修复。UI作者17unit/原14Chrome通过，新增nativeprojectsoffline仍先刷新保存query的create5/5通过，缓存整体限额已补；待独审和真实create service/store/adapterfake链。A0根9/9专测通过，receipt实际目的端与ResultEnvelope目标分离，由trustedservice原request.return_to授权绑定，纯DTO不冒充归属证明；待独审。整体54%维持。

A0已交material_contract_review独审（作者10/10及tsc）；UI已交desktop_create_review独审。Core两finding作者已修，实际routing30/30与tsc通过，收到presence立即generation失效涵盖offline→online ABA；create_journal_review已激活复验原probe，尚不提前放行。实施计划当前owner/54%口径已同步；材料及actual创建全链未完成。

独审新finding：S5-G 17unit+15Chrome通过但store.accept仅按observed_at会用后到unknown/worknull覆盖此前accepted真实WorkRef，且可替换receipt/work身份，需单调事实与同attempt/native绑定guard；A0 10tests+tsc及40KiB编码probe通过，但assertMaterialResultBinding expectedTarget未核与request.target节点一致，需闭合结构归属。均由独审只读probe发现，待原owner修复后复验，不提前放行。S5完整实际service/store/adapter→fakepeer Chrome链验收已写入计划，待当前review释放槽分发。整体54%不变。

根复跑Core实际create/control路由30/30通过，覆盖falsygateway错误、presence通知pendingfresh及ABA、HTTP/tunnel最外序列化fence。Core独审final仍待报告。S5-G回执单调性已退回desktop_create_ui；A0expectedTarget覆盖原request.target_work的缺口已退回material_contract，两owner当前开发，所有权不扩展。尚不构建正在修改的UI生成产物；完整Goalactive，54%不变。

整体更新55%=15+18+12+5+0+5：Core真实路由接线与旧control回归由独审71项/24最外竞态probe放行，创建贡献加1。A0独审final11项/tsc/边界probe放行，冻结纯导出不等于材料闭环。UI单调性作者23unit+5Chrome通过，desktop_create_review复验中；desktop_create_chain独占新增实际FixedCore/DeviceService/store/adapter→fakepeer Chrome持久链测试；material_phase_refresh（Astra）独占WP-A/S5文档据当前代码准备A1/A2/A3任务，不改实现。实际Android、安装、真实grant及业务验收仍缺，不宣称完成。

整体56%=15+18+12+6+0+5：S5-G独审放行23unit+5Chrome，已确认单调receipt与reload保护；统一build:core/device通过并同步Core/Android UI生成文件（未安装）。本地产物Core9047799bytes SHA256 2ece8d0cbac3187f3f67afd56e94753c2a092aaa067c3918d9fe73d0bda0ed27，device724754bytes SHA256195a03b1f783b8f0adfcff4bf44c244256c37819c6a0c5548c868c80dcfdcf56。actual创建fake链作者5/5及strictTS通过，已交desktop_create_review独审，gatewaybridge/身份context/listener/nativepeer仍fake，不混同真实EdgeRouter/phone。Astra发现A0全范围契约缺少phone node来源/目的地、questionreceipt与work_result提交形态，正准备一次v1未发布修订；先前11项独审只证明原纯协议边界，不证明完整材料业务。A1/A2/A3暂不启动依赖契约，仍可推进独立S5验收。

根已审阅并批准WP-A第3节A0-R一次性修订：未发布v1替换旧stub，显式node/work来源与目的地，human_question关联、human_answer/work_result判别、receipt.destination、可信source_binding及最终同步current授权fence。material_contract已确认rg无实际下游consumer，独占原3files实施，A1/A2/A3保持依赖未派发；不是以旧WorkRef构造虚构phone会话。actualcreatechain独审确认实现层真实、fixture身份/桥接/监听/peer边界明确，5Chrome与focusedTS复跑进行中。整体56%不变。

整体57%=15+18+12+7+0+5：S5实际实现fake链由独审5Chrome+strictTS放行，阶段fact来自实际服务/SQLite，不是预造DTO。HTTP/discovery/net/ownercontext/gatewaybridge/listener校验/nativepeer仍fixture，分段Core71/24证据不外推成真实身份全链。A0-R作者16tests通过、tsc最后检查中，尚未独审新契约。ordinary_setup_research已分只读普通用户安装/daemon生命周期缺口与实施packet研究，禁止真实配置/重启/安装；完整Goal未完。

A0-R作者及根16/16专测通过、作者直接tsc通过，已交material_contract_review重审新端点/问题/结果/receipt与trustedscope契约；原11边界保持。producer(target_work)与文件destination分离，人问题不虚构生产会话。ordinary_setup_research只读发现当前安装包仅darwin/linux CLI tarball+bundledNode，普通图标共享daemon持续设置与login/plugin入口差异仍需证明，不允许助手直接写未经确认的桌面配置。原桌面客户端版本只读核对0.162.0-alpha.17.2，不等于签名/安装验收。整体57%不变。

2026-10-10继续：A0-R纯协议16项及独立双向结构/问题/legacy probe通过，但独审发现current():void仍允许TS异步Promise实现，已退回A0 owner改undefined返回及编译负向test，以落实真实同步最终fence类型。已启动connection_setup_backend独占新增setup service/diagnostics/scope-settings及temps专测；旧CLI/main/install只读，真实配置/服务/desktop持久设置不操作。该包准备GUI可复用的明确范围设置和分层诊断，不宣称noCLI安装完成。整体57%保持。

A0-R最终独审17项/tsc与独立async-fence编译probe放行，新端点契约重新冻结。已并行分发material_asset_store（A1持久不可变字节/恢复分块）与material_request_service（A2 metadata映射/现有ledger窄facade），旧入口只读；connection_setup_backend独占新setup文件继续。A3真实签名relay和外部会话身份仍待接线，所有fake与实际结果分层报告。整体57%保持，材料纯协议通过不等于文件到端/结果领取。

连接助手后端root初版11项通过，静态核对发现expected/selection跨await可被caller改写，已交owner同步快照/deepfreeze修复，作者新增15项通过、tsc最后检查中，尚未独审。A1选SQLite FULL事务恢复锁，metadata记录/编码字节/物理页均有界，新增currentContext同步port闭合resolveScope前未知scope窗口；A2仅存receipt IDs并要求受控查询实际assetreceipt，不能用模型bodyreceipt自行证明文件到端。三个owner新文件独占并行，整体57%不变。

A1作者及root23/23通过（实际subprocess三种durableboundary崩溃恢复、真实两端store分块、4MiB/零字节、并发/ACK/ABA/链接/配额/重开），待独审不外推真实手机。connection_setup_review初版15项通过但静态发现configread未rejecthardlink，temp探针进行中；配对owner更换复用旧readscope作为必修集成风险保留，需要真实读取授权绑定/重新选择，不能仅watch失效缓存。A2仍开发，整体57%不变。

A1最终23项作者通过（新增自审捕获grantrevision/epoch、跨request资产版本不变、resolverctx快照及source句柄快照），material_asset_review已分独审。Setup独审确认P1：配置hardlink nlink=2可被接受；pairedowner换代仍load旧readscope ready，已分read_owner_binding_plan（Astra）只读选最小ownerboundgrant/旧grant拒绝reselect/实际readservice与全writer同锁修复packet，避免仅在GUI遮掩。Setup暂不放行，原15tests不覆盖此缺口。A2初15持久故障tests通过，author继续currentContext/receipt/work_result检验。整体57%保持。

2026-10-10续：采纳读取授权v2 mandatory owner_id，旧v1拒绝且不自动迁移；connection_setup_backend获得相关read authorization/service/pairing/CLI/link与共享事务文件的独占修复权。所有本地授权与配对writer须统一锁及文件身份CAS，最终同步检查后提交，真实观察epoch处理ABA，延迟revoke不得撤销替换后的pair。作者局部24项通过，完整并发及接线验证尚未完成，不提前放行。

A1独审23项与focused strict TS通过，但确认run绑定快照未贯穿操作闭包、limits运行时键范围过宽两项静态缺陷，已退回作者修复；未执行新权限变异探针，不声称动态越权证明。A2根复跑当前23/23通过，包含实际SQLite映射恢复、去重、结果版本ACK与receipt绑定；生产ledger facade仍explicit unsupported，接线至实际ledger/transport最终fence及手机材料闭环仍待实施。已要求unknown公开状态持久化且恢复mapping不回退状态。整体57%保持，完整Goal继续active。

A1修复后独审放行24/24与focused strict TS：全部八个操作消费同一冻结binding快照，registerSnapshot返回纳入run；limits严格固定七个自有键、安全整数与仅收紧。材料基础服务贡献1/10，整体约58%=15+18+12+7+1+5；真实跨端字节与结果领取仍未验收。A2作者最终25/25及focused strict TS通过，已交material_request_review独审。material_relay_adapter已获A3新增client/external-tools/Core gateway adapter与专测独占权，旧接线只读；真实宿主会话身份来源必须有证据，不用模型native_id授权。

根联合复跑A1/A2 49/49通过，但A2独审确认多资产第二项receipt在第一项校验即conflict的常规回归；另静态发现attachReceipt首次await之后才固定context，以及assetScope lease未延续至服务内部最终返回检查，均列为必修，A2暂不放行。A3冻结签名transport ports并指出现有thread/read只证明会话存在，不证明工具调用代表该会话；真实宿主绑定仍研究，不以unsupported完成Goal。Setup共享writer/CAS/watch已实现，作者定向回归仍有三项待调整/定位；根追加进程崩溃遗留mkdir锁恢复检查。整体58%保持，无真实配置或安装操作。

A2独审最终五项P2（另含完整question expiry与不确定claim GC）均已退作者修复，作者31/31与focused TS通过，原reviewer复验中。A3作者18/18签名relay与focused TS通过，新增material_relay_review独审；桌面bundledCLI 0.162.0-alpha.17.2生成schema证明resume无dynamicTools，tool请求thread/turn/call不证明多连接ownership，既有桌面工具身份接入仍必需验证。Setup以SQLite无表OS事务锁取代崩溃后遗留mkdir锁，作者真实子进程crash恢复及ownerbinding最终12项通过，fullTS通过，已交connection_setup_review独审。三个包均未提前放行，整体58%不变；真实安装壳/IPC与双向手机链路保留。

A2最终独审31/31与focused strict TS放行，五项缺口闭合；只证明开发请求/领取服务，生产ledger/receipt实际接线及外层响应fence仍待A5。根复跑A2+relay+ownerbinding61/61通过。材料基础贡献增至2/10，整体约59%=15+18+12+7+2+5。Astra material_integration_plan已分发准备实际A4/A5文件所有权、原账本durable外部接口与原桌面可信工具绑定隔离验证packet，禁止用新runner冒充原会话。A3独审初步发现seen tombstone达到4096后永久拒绝新调用，仍审查中，不提前放行。

A3两项P2（replay永久耗尽、认证前无限并发）已修，作者22/22与focused TS通过，独审复验中。Setup扩展独审不放行：已验证O_NOFOLLOW fd关闭后SQLite按pathname重开及BEGIN在最终身份检查前，保留P2必须改为实际descriptor锁/安全native开锁机制；作者已退修。独审combined read/setup run为38/39（watch timing cancellation），isolated read9/9及其他34/34通过，fullTS通过，不写成完整绿。Astra A4/A5同时发现跨主体asset custody与真实Android字节到端须独立可信证明，Core缓存不能假报手机已收到。整体59%保持。

A3第二轮独审确认仅caller timeout释放槽不足以界定provider底层资源；作者改独立providerActive，仅原acquire settle释放，根最新23/23通过，原reviewer再复验。Setup原生锁helper方案获开发授权：仅操作继承的已验证fd，不接受路径，父持fd到commit，进程死亡OS释放；新增C/build/package/install最小同捆及SHA验收，不操作真实安装。Astra纠正部署事实：Android本机app-private运行Core，实际phone-bound A1 store可证明手机到端，bridge无需第二字节账本；但源registerSnapshot不得按远端destination自造远端receipt，A1-R必须补store_endpoint/源快照与目的端传输分离及request custody。整体59%保持。

A3最终独审23/23放行纯adapter/fake签名relay范围（focused TS作者报告，独审本轮未复跑）；材料基础贡献3/10，整体约60%=15+18+12+7+3+5，实际生产与真机不外推。根批准Astra第9节A1-R必填独立custody authority、真实actor身份不改写、物理store证明与源快照零目的receipt方案，已交原A1owner独占实现。A0 wire保留，A2/A3只读，生产resolver与原桌面身份仍后续硬门槛；第10节准备H0完全temp/mock无真实账号脚本、Android受控picker桥与A4注入UI包。

Setup descriptor-native修复作者combined45/45与device build通过，根ownerbinding+tempsinstall16/16通过，已交原reviewer复验；macOS parent fd锁/另Node busy/deathrelease及archive坏helper拒绝保留current已有证据，Linux未验。H0 b轮隔离selftest完整通过（temp可读写、外部合成home哨兵拒读、指定mock端口允许、其他loopback/外网拒绝），native双连接initialize成功但thread/start managed-preferences配置同步失败，cases=0并已cleanup，不作为ownership通过；作者继续c轮必要bundled/system只读规则定位。A1-R迁移后24作者tests通过，真实不同phone/work principal与pairing已覆盖，反向/旧schema隔离与最终audit仍进行中，整体60%保持。

Setup开发backend最终独审43+2/45通过、full direct TS通过，原native pathname-open缺口闭合，darwin父fd生命周期及archive证据放行；不外推Linux/真实IPC/GUI安装。普通安装基础贡献6/20，整体61%=15+18+12+7+3+6。desktop_materials_ui已获A4三个新UI模块与专测独占权，旧入口只读。H0 c/d隔离通过但CFPreferencesAppSynchronize仍阻止thread/start，合成ownership案例未进入，作者继续e轮temp偏好配置定位，无真实登录步骤。

H0 e轮使用temp偏好home与避免偏好daemon后完整隔离实验运行，根已核对report：creator/read/resume/starter/reconnect/restart多个阶段wrongConnectionAccepted=true；resume后工具请求可到A/B，不具备连接独占ownership。T重启恢复dynamictool，U原ID仍无tool，旧thread attach为attachment_unproven；child/socket/mock cleanup均true。该合成loopback协议反证不宣称真实桌面或公网漏洞。根runner/mock6/6边界tests通过，正式可信宿主身份路线待架构裁定，原业务会话未操作。A1-R继续实现，根静态要求descriptor期限/摘要/字节schema与物理endpoint严格验证，整体61%不变。

H0最终g轮报告完成并记录正确response、pending断线后的B回答、重启/旧U保持；作者独立确认native PID39611/39618停止及端口ECONNREFUSED，四个runner/mock/test/doc已交付，6tests通过，无pendinghandle。已交Astra按正式宿主MCP/plugin/bridge证据裁定原桌面可信路线，不接真实环境。A4作者7unit+7Chrome通过、根7unit通过，已交desktop_materials_review独审；queryInput null严格只为exact operation从未开始的持久证明，unknown/offline不可null，恢复只查原IDs，明确click才发送。整体61%保持，未将pure UI或H0反证当生产完成。

A1-R作者最终33/33、relay23与fullTS通过，已交原asset reviewer独审新custody/物理store/源快照与双向mixedactor证据。A4独审不放行：IndexedDB clear删其他scope稳定IDs与read失败仍ready列P1；accepted querynull刷新漏冲突、transferreceipt缺destination绑定、scope等待metadata期间旧DOM可见列P2，均退原owner修复。Astra找到正式MCP宿主metadata候选，但direct mcpServer/tool/call可提供meta，仍需H1隔离实证；根提出结合实际native pending mcp item+参数摘要+stablecall的可信bridge验证方向，未据候选放行。整体61%保持。

A1-R独审56/56与fullTS通过但退修file打开后stat/current失败句柄未关闭；根同时要求descriptor到期后的GC不可达补独立可信maintenance port（只计数、≤32、本store/authority、旧dedupe保留、不恢复actor读权限），作者方案已批准。A4原四项修复作者10unit11Chrome、根10unit通过，独审确认原四项静态修复成立但发现首次open等待bind后旧view/draft续行未fence，仍必修不放行。Astra已落A5-L §12实际同Ledger原子外部admission/answer packet，可独立于host/A1修复推进，整体61%保持。

A1-R最终独审37+relay23/60通过与fullTS通过，FDcleanup与独立expiry维护均闭合；开发custody/store/maintenance放行，不外推productionresolver。A4最后open continuation修复独审放行，10unit及完整13Chrome通过，仅fakehostport/DOM/IndexedDB范围。材料贡献4/10，整体62%=15+18+12+7+4+6。已启动H1-MCP四新隔离文件与Android材料三个新类/专测，旧Android dirty入口只读；A5-L获world/router.ts窄material origin dispatch/recover写权，与ledger同owner防交叉，保留原local权限与真实job恢复门槛。

H1-MCP最终b报告完成：旧合成U同nativeID/历史在config reload/resume后实际加载MCP；direct调用元数据透传，samepending/copyargs得到独立RPC回值，原模型收到另一ordinal，不能nativeitem+hash授权返机密cache。hostproof与原GUI H2仍unproven，5boundarytests作者通过且进程/端口已清理。根已交Astra评估受控共享AppServer访问proxy：保持桌面同native engine/旧thread，由可信层禁止Ash MCP direct调用而不是另启runner；需隔离实证及具体用户环境切换方案，不提前操作真实daemon。Android固定import/chunk/commit/query/read/explicitconsume窄port已报，A5-L继续实现实际账本原子写入与dispatch/complete内部私有authority，生产runtime待接。

根H1 boundary5/5独立通过。Astra只读bundled help找到native WS --ws-auth capability-token/--ws-token-file，R2优先外proxy→每connection一对一authenticated nativeWS，不复用单stdio破坏桌面语义；根批准仅准备/运行temp隔离packet，真实旧公开control/socket须关闭且同原home/旧thread无双engine才可切换。源码候选不能提前充作H3/H2证据。根静态要求新ledger authority/task current由void改undefined加runtime同步返回检查，防async fence类型退化。整体62%保持。

Astra§13 R2/H3包已完成，已交H0/H1原owner四新proxy隔离文件实施；旧真实daemon与用户配置只读。根实际Ledger新tests15/15通过，覆盖两OS进程accept/answer竞争、fault重开/A2映射丢失、actualrouter恢复、旧jobs迁移备份及永久容量；作者继续真实SIGKILL crash/wait/localsettle隔离回归，尚未独审不计新增贡献。Android三新类与8项测试已准备，离线Gradle验证进行中，root未挂旧入口或安装。整体62%保持。

根A5-L最新21/21专测通过，增加真实SIGKILL四边界accept/answer、boundedwait/abort仅观察/localsettle不能注入及locator-only commit事件；尚待作者最终回归与独审。Android既有Gradle签名配置门导致定向task未通过，作者改用现有Kotlin2.0.21+SDK35/JUnit focused compile，session65920 exit0/10tests通过；发现minSdk24 Java Base64兼容性后改注入Android NO_WRAP实现，增量复验中。该证据不冒充Gradle整包或真机URI，旧配置未修改。整体62%保持。

A5-L作者最终21+原回归112/112/fullTS通过，已交material_durable_review独审；初步关注material recovery逐条await外execute无deadline阻塞后续local任务，不提前放行。Android作者最终focused10通过已交android_material_review：静态发现selection/read handle无过期/消费槽回收、queued picker/export流close遗漏，审查中。H3 c轮作者实测native无/错token401、旧U同ID、Ashsamependingdirect拦截fixture仅原call、nonAshGUI正常、serverRPC GUI独占响应与frame限制，单native listener/temp无controlsocket证据已补；根proxy4boundarytests通过，作者收尾后需独审，非真实桌面H2。整体62%保持。

Android独审focused10通过但三项P2（expired/terminal selection槽及stream、consumed/expired read槽、queuedpicker/export及executor拒绝cleanup）已退原owner。A5-L独审127tests/fullTS通过，仅P2串行材料recover挂起阻local；已退原owner双层bounded实际unfinished槽方案，timeout/close观察不复用未settle槽，不取消真实durabletask。H3最终d报告四新文件已冻结及全部native/stdio/socketcleanup确认，已交material_proxy_review独审temp研究范围。整体62%保持。

2026-10-10 恢复 Goal 推进：A5-L 修复已独立放行，148/148 相关测试及全项目 TypeScript 检查通过；材料恢复不再阻塞本地任务，未完成执行仍占容量，迟到结果保持原授权校验。Android 原三项 P2 已独立复验、16/16 JUnit 通过，新增发现 64 条元数据容量满时淘汰 UNKNOWN 导致原 ID 无法查询恢复，已退作者修复。H3 代理独审三项 P2（配置修改方法分类、容量耗尽清理、排队请求转发前重新校验）正在修复。已安排协调者准备下一批生产 registry/custody/runtime 与链路集成任务，不扩大隔离研究范围。整体 62% 保持；真实手机与桌面全链路、普通用户安装仍未验收。

Android 最后一项容量 P2 已独审放行，18/18 现有 JUnit 及相关 diff 检查通过：64 条记录满时拒绝新增操作，保留 UNKNOWN 原 ID 的查询恢复。此结论仅覆盖新 bridge，尚未证明 Activity/URI/整包构建或真机。Astra 已细化 A5-R1 生产注册、授权、custody 与 admission 任务，原账本作者开始读取实际端口，独占五个新增 device/Core 模块及组合测试；旧 main/link/server 等入口仍只读。默认空材料授权拒绝，既有 read/control 不自动获得材料权限，H3 未就绪时不发行 work host proof。整体 62% 保持。

R1 文件所有权最终统一为 Core 三个新增模块 material-registry.ts、material-authorization.ts、material-receipt-index.ts 及组合测试，取代前述五文件草案；作者确认没有遗留草稿并开始实施。必须组合实际 Ledger/A2/两个独立 A1 存储，而非仅模拟注册信息单测。两个代理的工作区路由失败已按终态恢复，未重复现有修改。H3 三项 P2 已修复落盘，根独立运行现有 8/8 boundary tests 通过，复核隔离报告 status=observations_complete；已交独审，仍不代表真实 GUI 兼容或 H2 完成。整体 62% 保持。

H3/R2 隔离研究最终独审放行：残余 native server RPC 回复已捕获 registry/role epoch，答复前及序列化后发送前均复核，9/9 测试由根及独审分别通过；撤权再恢复不能上送旧回答。本轮未新增 native 探测。root 核实现有 UI 15 ports 与 HTTP 路由，材料尚未挂载；已交 Astra 更新最终生产接线 packet，R1 作者继续实施真实注册与授权。真实 GUI 配置/plugin/认证兼容、生产 supervisor/watch/runtime 与手机双向材料仍未完成，整体 62% 保持。

R1 实际 material-registry.ts 已落盘，root 读取确认包含 metadata SQLite、实际 EdgeRouter 管理认证入口、状态事务及私有 actor/session 注册；实现与组合测试仍在进行，尚未验收或计分。生产代理迁移已核出兼容缺口：现有 CodexTransport/CodexControl 使用 turn/steer 与 thread/turns/list，而研究代理的小白名单不包含这些 device 操作。已交 Astra 与原代理作者纳入生产包的显式策略与常规回归，不能直接替换后丢失运行中追加和有界历史核对能力。整体 62% 保持。

Astra 已实际更新材料计划第14节，覆盖最终 R1/R2/W1/W2、真实15个 UI ports、独立材料 HTTP 路由及最外回传校验；第14.8节生产代理包含 S4/S5 的精确作用域与兼容验收。生产代理作者获六个新增 TS 模块及测试独占写权；研究与旧 transport 保持只读。R1 新 authorization 模块已落盘，root 静态发现 Ledger action 到材料权限映射及 lookup 精确操作关联缺口，作者正在修正，尚未验收。R1 作者 compact 网络失败后已按终态恢复并要求读取现有修改再续作。整体 62% 保持。

生产代理六个新 TS 模块已实际落盘，root 独立全项目 tsc --noEmit -p . 通过，作者继续真实临时 Unix listener/认证 WS fixture 与实际 S4/S5 adapter 组合测试。root 静态交回 GUI 与 device 的 work 范围区别、close 半失败仍清理其他资源、配置单 descriptor 有界读取与 watch 错误状态等初稿问题；尚未验收，replaceable:false，不接实际桌面 transport。R1 注册与授权继续完善，实际回执组合仍未完成。整体 62% 保持。

生产代理 policy/registry 专测已落盘，root 独立 4/4 通过，覆盖 steer 与有界 summary/full history 参数、越范围拒绝、frame 深度与 ID 类型、实际私有配置别名及同步 ABA epoch。生命周期和实际 adapter 组合仍在开发，不将四项窄测视为代理完整验收。R1 authorization 已改为精确 stable-key operation 查找和独立 admission actor 权限检查，回执模块与组合测试仍待完成。两作者本轮均核实在运行，整体 62% 保持。

生产代理新增 lifecycle/integration 初跑 11 项中 9 通过、2 失败：排队撤权测试的 Promise handler 时序及 Node server.close 删除被替换 Unix 路径；已交原作者修复，未忽略失败。预审另提出 S5 创建后不可变 lease 的受控转移和项目响应范围，作者继续修正。R1 实际组合发现 L.answer 首次授权 lookup 没有 exact 请求信息，root 狭窄修改为传入冻结后的 reply，原 25 项实际账本测试全过，已交独审；R1 authority 将拒绝无 exact 输入。整体 62% 保持。

L.answer 狭窄修改已独审接受，25/25 通过。R1 第三回执模块与实际组合测试已落盘，root 首跑两项通过：真实 screen/授权/Ledger/A2 与两个独立 A1 根的提交回执、双阶段 attach 和 ACK；尚待完整恢复/撤权/容量与独审。生产代理此前两失败项已修，root lifecycle/integration 14/14、独审全20/20通过；独审新发现 start/close 并发的迟到 listener 遗留 P2，已退作者增加启动状态与晚到资源清理回归。代理暂未放行或接实际桌面，整体 62% 保持。

生产代理首包最终独审接受，启动/关闭并发修复与新增两项回归通过；root 联跑该包22项及R1当前9项组合，共31/31通过。S4/S5实际adapter经隔离Unix/认证WS组合成立，受控新ID登记、项目范围过滤与生命周期边界已审；真实NativeFactory、配置attestation、GUI兼容及H2仍未完成，replaceable:false。据此控制范围贡献18→19，整体约63%。R1仍补真实进程重开、容量、maintenance及producer结果范围后独审，不提前计完成。

root 独立 R1 回执测试6/6通过，新增实际进程 SIGKILL 后重开查回同一 committed receipt 并由 A2 attach，实际账本仍只有原请求/回复；过期且撤权 orphan maintenance 清理保留去重事实，不能转成读取或跨物理 store 权限。R1 尚未冻结/独审，整体63%保持。已交 Astra 准备 W-H1 生产监督器、配置 attestation 与双重 listener/native generation 证据包；旧 transport 期待 native PID，新 proxy socket 属于代理 PID，须明确关联校验而非任意 verify callback 绕过。原独立 stdio runner 保持只读，不替代同原 home 的单 engine。

R1 新授权测试首跑6项中5通过，新增 cross-owner/producer 项使用非法 agent_task target_work 导致固定 parser 拒绝，已退作者按真实协议修正并将 addressed node 与受保护 producer work 注册分开，不放宽协议。W-H1 最终六个新增模块名单已由 Astra 分发并交原代理作者开写：supervisor、native-evidence、native-factory、registry-attestation、supervisor-role-authority、proxy-transport 及测试；既有模块冻结，实际配置/daemon 不动。整体63%保持。

R1 修复后的授权6/6已由root通过，cross-owner同名请求与registered producer exact work校验成立，结合既有回执6/6证据，已安排只读预审并待作者最终冻结。W-H1 native-evidence/native-factory初稿实际落盘，Astra §14.9完整包已更新；root交回初稿的精确版本匹配、同步authority返回及证据校验成本事项，不将草稿当真实服务就绪。整体63%保持。

R1 预审发现并退修两个具体问题：源 snapshot 的 read_chunk 被 destination-only 权限拒绝，需要私有 source_snapshot/snapshot_read 与公开目的端权限分离并用实际源快照传输组合验证；receipt.record 首 await 前未冻结 input，需防 DTO 复用导致旧证明配新持久 locator。另将 discovery 与当前 capability/generation/执行预算列为 R2 接线门槛，Work 当前证明不能代替完整 dispatch 权限。W-H1 root 首跑新 native-evidence/factory 4/4通过，但 OS 命令证据为 synthetic fixture、WS 认证为实际隔离服务，不冒充真实 native 验收。整体63%保持。

纠正上一条 snapshot 预审解释：root 读取 actual A1 readSnapshotChunk 确认输入 parser 是 read_chunk，但内部授权 run 使用 offer + source_snapshot/snapshot_read；source 权限已支持，原结论不是已证实代码缺陷。作者补完整 register/get/readSnapshot→目的端 offer/put/commit 覆盖，不放宽公开目的端读取。receipt.record 冻结输入已修，root 回执8/8通过含可变 DTO 复用回归。R1 准备最终冻结与复审。W-H1 supervisor/registry-attestation初稿落盘，真实OS listener证据需处理随机bind路径与fixed role hardlink关联；不得以任意校验callback冒充PID/socket证明。整体63%保持。

R1 冻结版最终独审接受：15项实际组合与L/A2的56项回归，共71/71，全项目TypeScript通过；receipt输入捕获、成功/错误/超时/close最终授权fence、真实未完成8槽、源快照链与唯一Ledger正文边界成立。材料贡献4→5，整体约64%。已交原作者R2新runtime/UI service装配，既有入口与冻结模块保持只读；discovery、host/peer provider、capability/generation/预算仍是明确未完成接线，不能外推真机全链路。W-H1六新模块初稿已落，root最新fullTS通过，真实监督器组合仍在开发。

R2 装配发现 discovery 仍缺受限授权接口，root 授原 R1 作者 registry/authorization 的狭窄修改权：显式材料 grant、exact target 与当前 provider 证明，缺能力不 advertise；补回归后重审，不继承 read/control 权限。device runtime 自持物理资产 store/transfer/signed adapter，不能借 Core 缓存假作手机到端。W-H1 root 首次3/3新组合通过，含真实临时 Node 子进程 OS evidence、同 home 二次持有拒绝、active/unknown drain 不杀原进程及 proxy PID/fd/inode adapter；这是 fixture/native 双证据架构测试，不是真实 Codex H2。配置 attestation 的 layer/version 判断仍须按真实 schema/实现核实，整体64%保持。

W-H1 配置指纹已依据官方 parsed TOML→排序 JSON→SHA256 算法修正，raw file hash不能代替 layer version；root 新配置 attestation 2/2通过，使用认证临时服务的有效配置与实际临时文件证明。配置来源省略/插件等尚需固定release证明与兼容验收，不以最新main源码替代真实桌面H2。R2继续运行时模块装配，整体64%保持。

root 阅读 R2 Core runtime 初稿并交作者补启动 token 比对、并发 peer 注册保留槽、所有资源关闭半失败清理和真实 capability readiness；不将 provider 存在当实际可用。W-H1 提前独审发现 S5 create 后新 lease/epoch 与旧 ProxyTransportFactory 捕获值不兼容，以及 GUI admission 被 remote device 临时授权绑定，已交原作者修受控创建转换与独立本机 GUI scope，并补实际 adapter/factory 组合；未进行真实切换。整体64%保持。

R2 Core/device runtime 与 UI service 已落盘，root 首跑 runtime3/3通过，覆盖实际 factory admission、target UI projection不借sourceget_result、各阶段启动回滚/配对ABA、exact discovery及缺capability不advertise。root继续交回UI分页容量边界游标跳项和readAsset返回generation捕获问题。W-H1独审补要求实际PID Unix/path-addressed入口清单核验（允许匿名socketpair、拒未认证Unix控制入口），已交作者沿既有OS fixture完善，不探测真实native。整体64%保持。

R2 受限 discovery patch 和 UI 修复已落，作者继续两物理node工厂的实际签名 snapshot→目的 store 组合。反向 remote canonical/custody provider 尚缺，receiver 必须自证本物理store与当前peer/request/asset，不能借Core缓存宣称手机收到；root明确将反向保留完整Goal未完成，并要求具体provider交接。W-H1实际Unix入口清单与本机GUI独立lease、S5受控transportLease转换初稿已落，要求实际roleauthority/factory/S5adapter组合后验收。已安排R2只读预审，整体64%保持。

R2预审发现device委托request和UI异步入口绕过raw unfinished容量、public DTO在microtask内才捕获及mutable peer快照问题，已退作者修。root首次新signed-runtime与生产authority/S5factory组合共3项，1通过2失败：签名exchange预期帧0而非1并有late offline未处理；S5链Native control offline。已分别交原作者修真实链路/有界等待和资源收尾，未忽略失败或计完成。整体64%保持。

2026-10-10 恢复推进：Goal 仍 active，整体64%保持。R2 修复后独立8/8及全项目TypeScript通过，实际双物理节点签名源快照→接收端A1/L/A2→字节/ACK链成立；原signed失败来自fixture时钟早于签名issued_at，未放宽签名验证。W-H1相关35项已分别独立通过，含受控实际子进程、S5/S4及独立GUI组合；默认production仍ownership_unproven拒spawn、replaceable:false，未冒充真实Codex GUI验收。独审新增退修：UI读取A canonical result却可用B request transfer签发消费handle；GUI current失效未sticky推进epoch、迟到work注册以及累计64次lease无法回收。已交各原作者定向修复，未验收冻结。反向接收端私有canonical/custody/receipt provider、固定15项UI ports、真实边缘及普通安装接线仍是Goal必需未完成范围。

上述退修已分别独审关闭：R2 public/raw均绑定exact request，canonical资产与登记hash/length/状态/方向再次比对；两请求同文件交叉locator拒绝、各自实际字节成功，独立7/7及全项目TS通过。W-H1 GUI失效sticky撤销、异步登记复核epoch，同scope受保护lease复用；128次重连/ABA/迟到登记普通fixture独立1/1通过，结合先前35项接受限定源码范围。R2仍仅forward工厂及UI7ports，W-H1仍replaceable:false；下一阶段优先补实际UI适配与运行边缘，整体64%保持，不把源码工厂验收外推真机可用。

W-E1实际入口包已由Astra拆解并交原R2作者单owner开工（材料计划§14.10）。旧Core/device main与link、Core server仅改材料精确hunk，原dirtydiff已留存用于保护；UI/Android暂只读。作者确认A3观察超时返回不等于原认证/签名链结束，root狭窄授同owner client/gateway/runtime生命周期观察port，接线预算须在raw创建前预占、仅真实settle释放，新增普通悬挂/晚完成回归后随本包独审。推进真实固定signed frame、当前peer/binding来源及材料专用HTTP；缺host/reverse provider不伪授权限，仍保留后续W-U15/W-RX与真实桌面验收。开工不加进度，整体64%。

W-E1已有raw观察port，root与独立预审均25/25回归通过；预审指出client尚未启动microtask在close后仍调用capture，已退作者加首句fence及zero-capture普通回归。真实HTTP六路由、session context复用及私有asset locator适配正在实施，尚未验收。实际重连接线需detachPeer且保留adapter跨重连未过期replay，已狭窄授runtime token及A3私有replay-owner hunk；receipt index仅开放当前canonical asset定位并重验实际A1，不允许browser供transfer scope。发现真实gateway device.list不返回pubkey，作者不得使用fixture自带pubkey假接线，已要求批准时私有pin与既有pair签名自证方案。Android/Core原native signer没有device.jwk，Astra已拆S-ID（材料计划§14.11.8）并交原W-H1作者实现真实HostDeviceLink签名authority，与W-E1 main写权隔离；保留fileSigner完整校验，不变更phone node。W-RX反向provider细化至§14.11，待入口冻结后交接。仍64%，没有真实安装/配置操作。

S-ID限定源码已冻结：作者最终13项新专测、相关累计27项及全TS通过；root实跑此前12项通过，独审预审13项及普通host3项无阻断，最终owner取消与关闭收尾2/2通过，已接受限定S-ID源码。实际临时原生HTTP签名来源可构造无JWK runtime并保留原node，健康renew不换身份代、失效后旧证明不复活；这是物理签名来源适配，不是work actor/资产custody授权或Android真机闭环。W-E1真实既有pair握手首次组合root退出1：canonical注册触发A0 source.work约束；已交作者修合法host来源fixture，不能放宽协议造node human。Astra同步纠正材料计划§14.10/14.11验收条件，生产仍须真实HostProof→私有actor→screen/request/role绑定，SID与receive grant不能代替。整体64%保持。

W-E1已冻结交完整独审。root最新actual edge/old Link三项通过：当前既有pair签名身份握手→合法host fixture sourcework canonical reply→signed transfer→Core A1字节→真实HTTP读取/明确消费；无host默认scope/list与真实raw槽测试通过。此前握手unsupported不稳定已用真实condition有界等待并先准备pair状态修正，不靠固定sleep；同权限grant_version变更与旧peer失效已覆盖。root另raw observer、微任务前close及跨adapter replay四项通过。作者报告旧read/control/create等80项、edge/raw/replay30项、原双A1→A2 ACK1项及全TS通过；尚待独审确认。证据不包括device物理源snapshot/receiverfactory：该旧Link测试源bytes由ClientLink发送，不能宣称完整默认两物理runtime双向链。整体64%，等待按真正接线验收更新贡献。

W-E1最终完整独审接受限定接线范围：材料edge/link/relay/runtime38项、旧read/control/create+SID+receipt-index92项、final oldLink2项及最新全TS通过。identity reply迟到签名finalsend增加work.current，关闭后无send/原任务settle才释放槽回归成立。材料贡献5→6，整体65%；仅确认signed ClientLink→Core A1→localHTTP读取/明确ACK，不包括device源A1/receiver或真机双向。Astra已拆W-TARGET（材料计划§14.12），root派原SID作者T1受保护目标会话证明；手机localnode的material_to_work无需冒充native模型源work，target-onlyproof严禁转为source/reply/producer。随后T2必需真实双store输入材料→ExplicitSend/S4，不能以text-only或T1收口；其他完整Goal范围保持未完成。

T1开发中组合测试root实跑3项均因provider响应timeout失败（90.96秒），已退回独占作者定位；作者报告只读native metadata捕获成立尚不能替代签名响应组合通过。现有fixture由旧Link提供pair/sign/current，provider帧仍经fixture pump直接分发，默认Link/main尚未接入，不能称首链完成。Astra补材料计划§14.13：4 MiB PNG/JPEG私有staging/localImage、素材manifest绑定原S4 journal；root派原W-E1作者先实现新增manifest/staging及普通测试，避免并写T1与旧S4。大UTF-8分页列T2-D1具体protected reader依赖，通用文档解析与真实native消费仍未完成。整体65%保持，没有安装、用户配置或真实桌面操作。

root新增独立定向核验：T1 device普通4/4、T2 manifest普通3/3通过，仍非用户全链验收。作者后续T1组合报告2项通过、1项配置变更后peer世代切换超时，继续修正常初始化/稳定观察，未降低现有验证。staging静态预审发现retired元数据永久积累会耗尽4096行容量，退作者补仅已退休且过期记录的维护，不回收accepted/unknown在途记录。Astra已给出§14.14 T2-RI正式receive_input setter、canonical输入provider、两个物理A1 store及默认main/link串行接线包；尚未实现。新review agent启动和既有reviewer续派均遇thread limit，root作为非作者独立审查继续推进，不视为用户阻塞。进度仍65%。

T1与T2-C第一阶段最终独审接受限定源码：root实跑T1最终5组合、manifest/staging10项合计15/15；另device target4及旧control授权/runtime/create-runtime/R1共45/45，当前全TypeScript检查退出0。T1只读thread metadata、重开重新capture、迟到签名时控制撤销和cwd变更均有效；旧Link默认provider接线仍未完成。staging已持久retiring意图并支持受保护恢复，仅retired且过期元数据回收，accepted/unknown不按时间删除；证据仍是模块级缓存，不是A1/native消费权限。root正式派原T1作者T2-C reader/S4/journal/proxy窄包，原W-E1作者T2-RI双物理store/canonical provider/receive_input配置/默认main与Link接线，文件写权分离。完整材料用户链、双向结果及安装验收未通过，整体65%保持。

T2-RI作者开始落receive_input scope与第四LocalState配置及正式SetupScopeStore setter；仍开发中，未验收。发现普通CLI缺真实后台reserveChange管理通道，root决定固定本机Unix材料管理IPC→main内ConnectionSetupService，禁止socket缺失即假定offline安全写。配置修改必须真实关闭新admission并核busy/unknown安全；控制/创建的只读changeSafety端口由T2-C作者串行处理，IPC与main由RI作者处理，不并写。Astra正在材料计划§14.14补固定认证/nonce/路径/锁与shutdown门槛；这是技术实现选择，无用户环境变更。root预审同时退回WorkRef字段顺序比较及endpoint默认node身份问题；无需用户介入，整体65%保持。

T2-C已落reader/private control proof、manifest兼容parser/journal digest、typed adapter/proxy输入窄门槛，仍作者开发中；root预审退回超时/close后晚到draft的lease释放及多图部分staging失败清理，作者报告已修待普通组合验收。进一步识别已提交pin维护依赖：finish释放读取draft后，旧pin.current闭包随之失效，不能再把历史control读取权限当物理退休权限；root授RI作者staging窄维护hunk，须独立真实physicalCurrent+retirement证据及原inode/hash，C作者保持读取/发送fence，不并写。A3 issuer缺首offer实际parsed input，root授验签后冻结operation/input私有透传窄API，不改wire或原签名权限。Astra已完成§14.14.8固定材料IPC实施门槛，配置仍未写入用户环境，整体65%保持。

root实跑reader8+最新staging8共16/16通过，接受物理缓存维护与历史读取权限分离窄修；真实native退休issuer仍未交付。另读作者隔离native消费report及fixture：固定0.162.0-alpha.17.2原生Mach-O SHA0d5ac7...和ClientRequest schema与先前记录一致，50ab38...另为同包launcher；一次本地模拟Responses请求实际含2396B PNG原字节及完整UTF8，turn完成、cleanup全true。这是小profile原生转换消费证据，未经过真实A1/默认Link/用户桌面，也未证明近4MiB真实native消费。proxy现有authorize重检不能独立区分同形两次RPC，root授物理send前的一次性原prepared attempt消费窄hook，metadata不consume、unknown不reset；等待普通proxy/steer及changeSafety验收。RI已落canonical输入投影与验签响应proof，receiver/sender/默认入口仍开发中。整体65%保持。

root最终独跑reader11/changeSafety2共13/13通过；仍在静态审查材料投递后同连接纯文本兼容，未整体接受C完整范围。仅只读前述隔离native旧rollout，确认response_item历史内含2396B dataURL且hash匹配原图，event另有local_image path；这是生产退休issuer的线索，不是已发行的退休权限。RI首真实零字节双A1测试offer已到actual destination（作者耗时9.4秒），commit跨过30秒proof时限，尚未全测通过；定位重复同步lsof ownership检查成本。root授原C owner control-runtime同步段memo窄修：queueMicrotask清理、不跨await、grant/config/peer/epoch仍逐次即时核，最终物理发送前force重新验所有权。没有延长wire TTL或权限，没有用户环境操作；整体65%保持。

root新增独立material-setup-ipc-review回归，实际复现IPC closing期间未提交apply在异步target验证结束后仍写入授权；RI将私有IPC current传入service apply/revoke并合入最终同步setter fence后，root联合复跑确认该回归与原IPC测试均通过。联合reader/changeSafety/target/IPC共20项19通过，新增同grant材料→文本测试返回unknown而非accepted，已退回C核冻结版本，不宣称修复验收。RI双A1零字节offer/commit作者已通过，但后续probe仍撞30秒proof过期；正在按原业务授权刷新短proof，保持原request/asset/transfer ID，不延长wire TTL。实际非零双端闭环、main在线配置reservation及手机验收仍未完成，整体65%保持，无用户介入阻塞。

root最终独复C冻结版本23/23通过（reader12、同步listener memo2、control safety2、create runtime7）。前次首材料失败来自fixture在scope写入后立即启watch/admit的迟到FS事件；仅在native连接前有界确认真实grant稳定，后续材料与普通文本使用同一grant/connection且均accepted，旧prepared重放零转发。生产授权门槛未降低；create accepted first_input仍缺真实完成观测，不能以永久native_unknown作为最终用户流程。另独复provider/receive-scope/IPC共5/5通过。RI零字节实际双A1+signed proof刷新41.9秒已通过；>512KiB实际非零用例120秒MaterialClient timeout，尚未验收且未加TTL。已派C接正常UI及15ports生产bridge，RI继续独占main/runtime/input-transfer/registry/link，按Astra§14.15推进真实整合；整体65%保持，用户环境未修改。

root独复default control/create wiring＋IPC＋provider admission gate共24/24通过；另A1 uncached finalCurrent变更监听器写前/回执前拒绝回归1/1通过。RI非零>512KiB signed双A1最终128.3秒通过，是真实source fd/chunks→device commit/probe的正确性证据，但速度尚不能作为正常用户交付；已要求采样定位OS/全hash重复校验成本并保持最终授权fence。下一组合为真实ControlService私有proof→receiver读取→staging→synthetic native消费，不触用户daemon。Android原owner确认material类未mount，已批准仅material包/tests与HomeActivity exact-origin/mainFrame/pageEpoch桥窄mount；C新增受保护native stream→Core私有spool fd→A1source注册，实际nativeUi凭据必须在Edge边界重验，browser不能自报path/base64/native标记。普通页面与原生选材正在接线，整体65%保持。

root独立新增native-import并发review回归并迁移至实际EdgeRouter nativeUi凭据/registered screen/registry permit/private proof issuer；联合导入测试5/5通过，覆盖同ID/source fd唯一性、每screen并发quota、完整UTF8/空文件、页面及权限失效、lateopen cleanup。另独复material-main-setup真实startDevice/原ClientLink隔离connection/实际keys/listener/IPC/setter/gate竞争1/1通过（2.2秒），并非用户daemon或手机验收。RI真实ControlProof小PNG消费仍97.96秒失败，profile显示2782次lsof累计57.81秒、927次native版本检查4.69秒；已授C在原CodexTransport同步段memo、跨await清理、最终socket.send及A1physical final强制uncached，不扩大deadline/授权。Core source短业务actor与上传后再次打开的权限连续性须在coordinator显式处理，未宣称完整闭环；整体65%保持。

root已独复新CodexTransport memo2＋target listener memo2＋reader12共16/16通过：同步段仅复用监听器证据，config/lifecycle即时重核，跨await重新发现替换且最终实际send强制uncached。RI正在将finalInputControlProof贯穿A1 physical final并重测实际15秒控制窗口的小PNG消费，普通16项不能替代性能结果或完整手机验收。UI/native import仍开发，整体65%保持。

root完成Android冻结版本独复：模块与真实Home源focusedcompile、JUnit28/28，未完成Gradle/APK/真实ContentResolver/picker/lifecycle。已审Home仅可信Core SSE/native凭据采选材scope，generic page代理归一化后拒绝native ingress namespace，旧picker独立requestCode与page/current失效处理；草稿metadata重开不能冒充仍可读取source。Astra依据defaultmain实际IPC→reservation→lockedsetter独复1/1的新里程碑建议安装配置贡献6→7，root采纳整体66%；其他五权重不变，不对Android普通测试或失败的小PNG链重复加分。源码UI/coordinator整合及RI同步after性能修复仍开发，Goal active。

root独复同步after A1全部40＋defaultmain真实IPC重复CLI变更1，共41/41通过；同步核不增加microtask，旧async授权跨await撤权/恢复仍拒，最终physical fence保留。但actualControlProof完整小PNG仍86.46秒/15秒超时，未验收。结构研究自有mac kernel fixture一万次定向检查36.6ms，只是API成本，尚非全可见owner/实际链证明；原owner正在核与现lsof可见集合等价的全进程有限元数据枚举，不读auth/正文或连接用户daemon。另授权C control-runtime私有只读metadata channel单flight复用，逐次真实thread/read+uncached final、无metadata或TTL缓存，关闭与失效仍排空raw。root发现新coordinator持久scope包含每次随机screen、会使重开草稿/投递失联，已交C改为当前真实owner+稳定受保护配置摘要+node/endpoint的metadata归属；新page仍须重新授权，旧proof不恢复。RI受保护locator恢复已授权新增有界metadata DB，未验收。整体66%保持。

root独复受保护locator模块2/2、真实signed双A1零字节receiver重开/延迟canonical关闭生命周期1/1（33.1秒）通过：旧raw未settle时close返回draining且DB仍持有，settle后关闭；fresh source binding再核原physicalstore，receipt/transfer IDs保持、不重传、零native turn。其证据不覆盖大文件或Control消费。另独复metadata channel普通3/3及durable draft/原operation重开1/1通过；UI/service整体仍未冻结。Gate1 native全可见owner prototype约8ms/扫描，对照原lsof路径约87ms，并正确发现fork只accepted额外owner；保留原可见范围限制，不能称全系统绝对独占。已授原research owner独立N-API/module/build/test文件实现，未接production或打包，不修改用户daemon。整体66%保持。

root独复normal HTTP materials bridge＋旧materials13/13、旧native-bootstrap＋port＋nativeimportreview7/7、新增native picker3/3。预审发现unknown重试后显式abort未清recovery ID会让下一次选材复用已cancelled ID；C已修，独复包含同ID未知核查/明确cancel后新ID/旧迟到结果拒绝。root实际Unix signed metadata channel1/1通过2.55秒。RI旧小PNG profile在metadata复用后首次PASS（79.38秒含31秒proof等待，原15秒control时限、一次synthetic native turn、stage hash/len匹配）；C已有UI coordinator实际pairedlinks/privateFD/双A1→control journal testcase也作者PASS55.56秒。两者是开发层synthetic native证据，不是用户桌面Codex或APK真机，也未证明4MiB速度可交付。正常shell DOM/真实HTTP15ports及新fixedN-API模块仍整合，整体66%保持。

继续检查确认Goal仍active、无用户介入阻塞。root独复fixed N-API suite（Node22，session66950）失败于rebind监听对象摘要必须改变的断言：内核释放后可复用soi_so/soi_pcb地址，摘要不能充当永不复用generation。已退回research owner明确快照语义、保留真实路径stat变化与当前owner校验，并新增同时存活替换对象的灵敏度测试；未接production，不降低最终uncached lsof/version fence。正常shell DOM/实际HTTP链仍由原owner验证，整体66%不变。

root独复native修正版session93496 exit0、1/1（4.13秒），确认内核摘要仅当前快照；同时存活替换与关闭后rebind分开验证。正常DOM作者session53203 exit1：真实screen、正常index mount、private native rawFD commit及save成功，但Send在100秒内未得精确accepted notice，不计完整闭环通过。已安排C补无正文stage/status/code诊断并接Gate1 production regular inspection，保留原最终uncached fence；research独占darwin固定artifact/manifest构建打包，RI准备真实Core main coordinator装配，三方文件写权分开。Linux原包仍须明确该native能力unsupported。当前66%保持。

root独复receiver最新root-bound locator与draining组合session35713 exit0、1/1（37.54秒）：同node/key复制到不同物理root后store/authority IDs不同且旧binding被conflict拒绝；同root重开使用fresh binding恢复原receipt/transfer IDs；真实未结束raw期间DB保持，settle后关闭。仅空材料signed双A1生命周期证据，不扩大为大文件/实际桌面或手机通过。

root独复离线native packaging session96158 exit0、1/1（4.67秒）：真实main bundle解包启动version、archive旁production loader调用自建listener、缺失artifact/NAPI错配/实际CPU跨arch错配在下载前拒绝。local-node的Homebrew Node22通过仅测试子进程DYLD_LIBRARY_PATH找到本机libnode，此证据不是自包含正式发行；runtime Gate1尚待接线。root另修desktop-control workValid对gateway node/endpoint的合法leading `_`/`-`拒绝，native/operation IDs保持原controlId语法；新增wire parser对照+outbox持久恢复独立回归，联合旧测试3/3通过。已交原UI owner下次gen:ui纳入产物，不并改生成文件。Astra更新§14.17保留控制/逆向材料结果/零CLI安装后续完整门槛，进度仍66%。

独立review认可root UI ID兼容修复且旧2+新1测试3/3通过（只限此窄scope）。root进一步复现旧A4 consumeResult单handle可对多文件完整结果ACK的绕路，临时真实双asset fixture session43005 exit1（Missing expected rejection）；临时文件已移除。C修旧路径须真实source/current result且完整file集仅一个匹配private handle，永久回归确认双asset旧入口拒绝且claimed_result_version保持null。root独复强化输入stopAdmission与多asset完整消费session14140 exit0、2/2（6.62秒）：真正pending native.begin在同步stop后settle返回503/旧current拒绝，新UI/native被拒，原非input scope继续有效，真实raw结束与imports.close清文件。UI接口冻结已触发RI正式main依赖装配/rollback/draining实现；C补旧单asset成功回归后转Gate1。进度66%保持。

root独复main首次assembly3/3（11461），随后最新main4＋真实imports5＋Gate1 OS2＋changeSafety2共13/13（41501，7.68秒）。41501覆盖真实mounted main native credential/screen/HTTP导入及实际FD pin，source.close报错时保留依赖，late release后继续cleanup最后AggregateError；import原closingPromise等待FD释放，不提前假closed。此前42502联合8项7通过/changeSafety1失败源于同同步段memo误用于配置变更admission，已修每次finalCurrent，旧断言保留；双/单asset兼容两项独复均通过。research另复现addon缺失时runtime current fallback只查目标PID而漏extra accepted owner（12096 boolean），C改两regular fallback回原full discover。root最终39838 OS2＋changeSafety2共4/4（7.86秒），涵盖missingartifact时extraowner regular与独立final拒绝及原路径validation。正常DOM唯一复验53458现运行，尚未计通过；当前仍66%。

2026-10-10 Goal续行：root 5455独复read-source/source-realm 21/21通过（10.92秒），独审两个临时复现均exit0，确认版本与artifact SHA双pin、probe返回前实际child及三条pipe关闭、escaped holder未drain时拒verified/release/new factory。允许进入旧reader迁移方案设计，旧reader/setup/source chooser尚未接入，不计新交付百分比，整体保持68%。

I-WK2真实面板自动化未通过：公开view仅NSRemoteView，旧ok action异常及后续无callback不能算验收。最新manual 73233中root通过CUA exact appPath连接返回-10005 timeoutReached，随后inventory未见临时App；未执行点击或权限变更。fixture已超时清理，无证据认定TCC拒绝。真实目录选择、save/cancel仍待验证，先调查启动注册与自动化连接；不以编译、WK status或DOM替代真实面板验收。

续行实证：I-WK2 inventory-only 4333的own OS identity证实raw executable启动已有regular NSRunningApplication、正确bundleURL及NSWorkspace PID，实际WK状态存活62秒后正常退出；root CUA exactpath连接成功（0.33秒），AX仅原生window/menu，随后AX+截图超时。whole test后置null/undefined断言错误已由作者修正，不作全case通过，不修改LS/TCC或生产超时。Astra新增§14.21三段必需交付链；root授权R-READ2b source-bound v3 reader迁移，旧v2须重新确认，直接descriptor替换不能暗继承同cwd授权。整体保持68%。

R-READ2b已按Astra§14.21串行交原owner实施：source-bound v3授权、正式reader私有factory、实际source/realm每await连续性与真实drain保留slot；旧v2明确重新授权，不改setup/main/chooser。独审预验收采用两物理realm同cwd不同synthetic marker、旧cursor/WorkRef跨源拒绝、实际分页/turns、普通SQLite写仍可读与root替换区分、无control独立read、escaped holder阻止替代child；尚未冻结/验收。I-WK2 manual 28061仍未通过，root CUA在真实panel期getApp超时，未执行keys；该证据不证明TCC拒绝。继续无需panel的真实WK拒绝路径及own-page snapshot诊断，禁止重复原manual或绕过真实选择。当前68%。

真实WK窄包root65179独复1/1 exit0（38.17秒）：隔离正式WK页面unknown/wrongsession/oversize/iframe消息拒绝、remote/other-file导航拒绝、真实页面snapshot和关闭后backend继续响应；作者TS通过，4文件冻结交独审。原生目录/save/cancel仍未过，不计完整安装门槛。另4MiB正常PNG整合包已实现测试（4188477 bytes，103块），仅测试/fixture改动，首次55850尚运行，未计通过。accepted后延迟native open仍需要原inode；无平台引用退休证明不得按turn/completed删除accepted staging，保留真实quota/pin边界。整体68%。

R-READ2b作者冻结46/46+TS，但root13268独复45/46 exit1，不能验收。独审/tmp真实escaped-pipe复现P2：drain期间manifest负缓存未随closing成功清除，busy=false仍capabilities=[]，手工dispatch才恢复；已退原owner修复并要求仅manifest自动恢复回归。另adapter构造失败独审证实DB held FD1→0、无child/busyfalse。

4MiB正常链首次55850终态exit1：PNG4188477 bytes、103 private import块/commit/Save均200，导入4.724秒且0turn；ExplicitSend 180秒测试超时，native initialize1/threadread40/start0，未获receiver accepted/真实消费证据。原deadline未扩大、生产未修改、finally清理已结束；授权只测试bodyfree计数/耗时诊断后唯一同样大样本重跑，定位真实性能瓶颈。不以小文件或store单测替代4MiB门槛。当前68%。

R-READ2b退修root80186完整捕获46/46 exit0（6.51秒），log /tmp/ash-root-read2b-retest.log；独审两个真实pipe脚本验证成功drain/release后首次manifest自动恢复capabilities2，合法换source保旧grant仍caps0/dispatch拒，错误slot继续保留。接受正式reader基础窄包，旧setup/main未迁移；原13268首次45/46失败保留历史，新独复不伪称原失败已定位。已交R-DISC1定向有效来源发现，禁止用户home副作用试跑。

4MiB诊断5259最终exit1，总194.795秒、cleanup194.190秒已完成；103put、292signedframe、最大55353 bytes，native read76/start0。lsof2541次54.883秒、version5485次30.734秒、receiverfinal538次39.921秒、targetcapture20次12.817秒、wholefileverify2次7.912秒，计时嵌套不可相加。性能根因指向每块反复OS身份/版本/final扫描，暂交原native owner只读调用图及最小hunk方案，未扩TTL、未改production、未重跑红色大case。完整4MiB消费/接收门槛尚未过，整体68%。

M-PERF1只读调用图确认每块约五fullfinal多数隔await（bytes write、SQL commit、store output、gateway sign前后），不能统合一次。root仅授权原native owner codex-transport/control-runtime同同步段私有真实核验memo复用及force结果供regular复用；微任务失效、不同binding隔离、最终native/mutation仍uncached lsof/version、grant/pair/config逐次即时核验。跨await版本证明尚未授权，receiver/gateway/store不并改。

R-DISC1临时固定CLI证明无sqlite override initialize已打开effectiveDB；config/read(default sqlite_home=null/external absolute)与actualFD devino一致，无模型任务，但initialize可能创建缺失root/DB。expectedExistingRoot预选本身不能防实际配置指向另一缺失root时先发生创建，故不得直接在用户home试跑。继续定向研究已有runtime metadata/configread与真正离线有效配置入口，以及临时树副作用；普通source选择仍必需，不把手选SQLite或需管理员JSON作为完成标准。68%保持。

M-PERF1第一窄包root84524 30/30 exit0（7.33秒），独审实际config/socket替换拒绝，接受仅同同步段regular复用。原4MiB96184仍红：222.986秒、cleanup222.410秒、103put/296frames/native read80/start0，lsof2469/59.781秒、version5469/35.333秒，嵌套计时；比baseline慢14.5%，不能称整体性能修复。数据/tmp/ash-large-image-first-evidence/mperf1-run.json，无livecase。

Astra§14.24拆N-PROC1→N-VERSION1→原4MiB：现addon VM映射+process_start不是samePID exec连续性证明，先交原native owner真实proc_pidpath当前mainexe观察与实际exec回归；之后才private retainedFD/hash/version物理artifact证明以省regular跨await版本命令，最终核验仍uncached。实际Codex是246MB MachO，328Blauncher不能冒充artifact。不得声称OS快照证明历史无execABA。reader来源发现采用已运行受保护endpoint config/read与同owner现存SQLiteFD，临时真实试验获默认/external证据；用户home initialize会创建缺失DB，禁止用新server探测。整体68%。

N-PROC1 root97852联合4/4 exit0（5.86秒）+独审认可，真实mainexe/fullowner/current snapshot基础接受。R-DISC1 root59050旧6/6但独审发现scan --version尾socket替换首次current错误通过；退修root44985新7/7 exit0（24.42秒）+原独立tmp复现同次stale/恢复不复活，通过窄包。已授S1-B来源设置backend/固定IPC/v3读诊断及main测试迁移，壳UI后段串行。

N-VERSION1 root98025旧35/35 exit0（6.29秒）但独审两P2阻止accept：/tmp/ash-version-forged-proof-review.mts真实kernel+MachO证明plain-object动态readCurrentVersion伪造9.9.9被消费；/tmp/ash-version-final-main-image-review.mts真实samePID exec并保旧artifact mmap/listener，classic fullFinal错误通过并seed同段regular，下一microtaskkernel才拒。已退原owner补消费品牌/private helper与fullforce后freshmainexe/kernel再seed；保原uncachedclassic，不以green35覆盖独立反例，未重跑4MiB。整体68%。

用户明确简化产品并要求逐步交付（2026-10-10）：客户端简单，CLI亦可；停止继续扩复杂GUI/泛设置。当前第一步收敛 ash-device connect codex --project PATH，已有配对及支持的原Codex连接前提下自动default source保存与v3 project读取授权；旧read-scope同步改固定IPC，不能继续写已失效v2。本轮未验custom-home注册撤去，不做GUI/daemon研究。每步必须完整适当测试+独审后给可用命令及限制反馈，不把后端包/配置选项数当完成。完整跨端发送/材料/首装仍在Goal，按用户可用小步骤推进。N-VERSION root50980双P2退修36/36 exit0（6.95秒），等待恢复独审终态才4MiB。此处68%仅为历史工程估算。

第一步当前核验：connect 入口、固定 IPC 和 actual main 的独立只读入口已落，尚未验收。实际 main 整合测试发现来源保存自身触发全局 transportEpoch 变化，导致同一设置事务被误判失效；已授权仅只读设置连接证明的窄修，保留真实连接、同步就绪、配对物理身份及事务状态检查，控制入口不变。须验证自身授权写可完成、配对替换与断线仍拒绝。当前整合测试使用真实 Codex 进程、临时历史及模拟配对传输，不能作为真实手机验收；下一步为修复后复测、独立审查及正常手机刷新。产品完成度未提高。

Root 后续审查发现只读连接证明初次签发缺少原认证连接的配对身份核验，已退修并确认代码补入 revocationBinding 与当前 paired 文件 identity 相等检查；回归仍待终态。另要求验证 connect 自动启动助手后的真实认证就绪等待，不能把助手尚未连接当成授权失败。现有正常 UI 缓存层独立复测 7/7 通过（desktop-work-store.test.js），只证明权限隔离、刷新与分页缓存行为，不作为真实设备完成证据。

Root 本轮直接复测原 setup connection proof 用例 exit1（setup-shell-status.test.ts:16:130，Missing expected exception）。已退作者核对状态 capture 与 epoch 检查的顺序，要求配对变化在本次检查即拒绝，同时保留新签证明能绑定刚保存的当前授权。冷启动等待已转窄 setup.ready，避免轮询完整原生历史诊断；仍需完成测试。作者给出的 main9 日志实际终态为 read verification unavailable，不支持已完成读取的结论；待同一轮主路径日志与测试终态一致后再验收。

后续 Root 实际复测上述原连接用例及新增只读连接断言 exit0：自身 grant 写不使 read proof 失效，原控制 proof 立即失效，新签 proof 可绑定当前状态；pair 替换后旧 proof 与重新签发都拒绝。停止扩此窄修。CLI 独立审查另发现首次确认前 source.prepare 的 30 秒预览期限会使用户正常阅读确认后失败，已退实现并交 Astra 裁定交互与实际短事务分离方案，禁止单凭来源显示名复用授权或全局放宽操作超时。主读取路径仍未验收。

CLI 独审第二项：apply 已提交但响应丢失的 result_unknown，以及 source.apply 已清旧 grant 后 descriptor 写失败，不能因未收到成功 receipt 宣称未改变授权。须标明尝试变更/结果未知，必要只读对账，不自动重复 apply。main10 作者整合测试 1/1 通过（2.84 秒），但 Root 同测试独立复测 exit1（3.68 秒，/tmp/ash-root-connect-main-current.log，P1-list-code cancelled），当前不稳定，不能按单次绿色冻结。已要求定位实际取消原因，禁止用重试或扩大超时掩盖。

Root 隔离复现已确认 own commit 通知问题：无任何外部写，receipt 即刻 current，迟到 watch 通知使其 stale。新增独立 local-state-own-write-watch.test.ts 当前 exit1（:21），等待实际 watch 通知后检查自身 receipt 应继续有效，随后外部不同 identity 必须拒绝；使用事件等待，不以固定等待时间掩盖产品问题。Astra 授权仅同步 commit receipt 与当前物理文件 identity 完全相等的迟到通知去重，未知事件、外部变化仍失效；实现和主读取复测尚待完成。

精确 own commit 通知去重已落。作者联合 3/3 通过后，Root 独立复测 ownwatch 两用例与 actualmain 完整 connect/list/read 链 3/3 exit0（3.90 秒，/tmp/ash-root-own-watch-main.log）；此前取消反例在当前复测未再出现。外部同内容物理 replacement 仍拒绝。窄 hunk 已交 Sol 独审；CLI 慢确认、结果未知提示与最终类型检查仍未完成，尚不能宣称第一步或真实手机通过。

慢确认与 mutationAttempted 提示已落，Root 定向 connect.test.ts 5/5 exit0；当前完整 tsc --noEmit -p . exit0。作者扩展实际 PTY/31秒确认套件仍 46/48，失败在终端 connect 与旧 setup-online-main 读取诊断，须定位，不冻结。Ownwatch 独审发现删除后 missing 不能作为完整物理 identity 去重（外部 create→delete 可回 missing），已要求仅存在文件可登记去重，未知/缺失继续失效；不扩 tombstone 框架。当前进入修复后复读，尚无真实手机通过证据。

缺失 receipt 排除已落并经 Sol 实际 create/delete 回归及 CLI 慢确认/unknown 复读接受。作者 selected 8/8 通过后，Root 独立复测实际 PTY/31秒确认 connect、确认变化/unknown 单元回归、ownwatch 两用例共 8/8 exit0（35.72 秒，/tmp/ash-root-connect-final.log）。终端调用使用真实 Codex CLI 与 main/IPC/Link dispatch，但历史/传输仍隔离 fixture；不外推真实 Core/Ash 或手机。待作者补齐旧 main 用例、最终类型检查与源码冻结，再进 P2 正常页面与实际配对传输。

Root 接手并冻结供整合的只读路径：项目确认补 dev/ino 防同路径替换，connect 单元 6/6、完整 TS exit0。旧 control setup 初始 client 诊断断言仍红，保为 Goal 未完成事项，不默改断言。P2 实际首轮 30.6 秒：fresh loopback Worker0.5.0 + signed owner/device/browser pairing + 正式 Ash shell + 默认 main/Link + 固定 Codex 临时历史，列表/消息原ID内容、未授权项目403、新增后刷新/重开均通过。唯一当前页面失败为真实 device offline 被 discovery 缺失误作撤权并清缓存。Root 已读代码及 error-context，授权原 P2 owner 仅 desktop-work.js 窄修：删除性 reconcile 前通过现受保护 read API 分类 offline/permission_denied，离线保旧缓存与选择，确证撤权才清。待严格原用例复验；临时历史浏览器链不代表实际手机验收。

UI 窄修经 Sol 独审与隔离 offline/denied/newrevision/mismatched target 验证接受；作者实际链两次绿后 Root 独复仍 exit1（30.2 秒），恢复阶段 endpoints 仍0、read offline→permission_denied、最终缓存0。因此撤 P2 整体通过判断，只读页面恢复未验收；唯一链 owner 继续取 reconnect manifest/source/grant 具体原因，不改断言/不延时掩盖。稳定证据 docs/evidence/first-read/root-reconnect-failure.json 与 .log。当前电脑连接器 npm build:device exit0，产物 packages/device/dist/ash-device.mjs 与本机 native helper 已生成，未替换用户安装或配置。


### 2026-10-10：重连被动诊断与连接器产物

Root 独立执行保留原时序和严格断言的真实 Worker/Ash/设备读取链，退出 0，测试 12.0 秒。当前样本恢复成功；历史重连失败仍未解释，故读取恢复尚未验收。稳定证据：`docs/evidence/first-read/root-reconnect-diagnostic.json` 和 `.log`。下一步核实瞬时 source stale 的状态分类及历史测试与 native 构建并发是否有关，禁止以继续重复绿样本代替定位。

连接器 build 和 package 均退出 0；生成 `build/device/ash-device-darwin-arm64.tar.gz`（约 35 MB），SHA256 已核对。临时目录中以隔离 HOME 执行包内 `ash-device help` 退出 0，显示 `connect codex --project PATH`。最初 `--help` 被现有 CLI 当作 run，15 秒超时后进程已终止；已确认没有残留包内进程。未替换已安装服务。完整 Goal 仍 active。


### 2026-10-10：暂态读取恢复修复通过开发层验收

新增状态机回归首先复现 offline/stale 一次失败后 manifest 永久 scope_required、captures=1。修复只调整 read-service 的暂态分类：保持已确认的授权与 unknown 可用性，不缓存暂态失败，下一次普通刷新重新验证来源；来源缺失/不符、scope/pair 撤销继续拒绝。stale 实际读取不返回正文，报告 offline；授权上下文失效仍 permission_denied。排除了没有直达证据的并行 native build 归因，不宣称已还原历史随机失败。

Root 窄 suite 21/21 退出0，包含真实撤权、不符拒绝和 drain 期间不启动第二 reader；原严格正式 Ash/真实 Worker/真实配对/临时 native 历史链退出0，9.5秒，重连同一选择恢复。稳定证据为 `docs/evidence/first-read/root-reconnect-fixed.json`、`.log` 和 `transient-recovery-tests.log`。开发层验证不代表实际手机与用户历史已验收；下一步复用已有配对交接当前连接器，再由用户确认一个项目读取范围。

最终 TypeScript 检查退出0；修复后 build/package 均退出0，archive校验、包内当前bundle一致性及两项native manifest SHA全部验证。产物尚未替换实际安装。


### 2026-10-10：实际电脑连接器交接完成，等待项目授权

已将当前校验产物暂存到用户 versions 独立目录，记录私有回滚信息；受控 bootout 旧 LaunchAgent，确认原 PID 结束，原子切换 current，再 bootstrap 原 plist。配置、配对和 key 内容指纹未变；实际新服务 PID28987 running，真实 setup.ready=true，source.status=missing/needsReadGrant=true。没有并起第二份连接器，没有改 Codex 桌面服务。

实际执行 `ash-device connect codex --project /Users/ahaha/work/xiebo/ash` 自动识别来源 `/Users/ahaha/.codex` 和电脑 Ahaha-Mac，已停在一次读取确认（PTY87060）。已向用户提交具体范围授权问题；未代按 yes、未写读取授权，依赖此确认的真实手机读取验收暂停等待用户答复。完整 Goal active。


### 2026-10-10：用户确认实际 ash 项目读取范围

收到用户明确允许后，向原等待PTY87060输入确认。实际 connect 命令退出0并报告 saved conversations readable；随后独立 setup.ready=true，setup.verify-read 对 `/Users/ahaha/work/xiebo/ash` 返回 readable/conversations1/messages2（有界页计数，不代表完整历史条数）。未输出会话正文。已请求用户在手机打开或刷新电脑入口，以验证已安装手机UI的真实会话和消息展示；未据电脑验证宣称手机验收完成。


### 2026-10-10：新版手机 APK 生成，LocalSend 投递中

实际 build:payload 完成（当前Core），Android Kotlin 与 assembleDebug 成功。macOS ar不兼容由现有GNUar PATH处理，未保留试改脚本；NDK显式指向已安装版本。Gradle使用现有8.13并仅本次关闭失效本地代理。签名以10/8旧APK实际证书67c8bb8a…校验，未生成新key。容器底包下载未推进，停止该构建，复用原已存在运行环境并实际替换当前dsh-ash-control/ash-skills后重新计算tar内容版本和压缩；archive内36个源码文件逐字验证，新version0.2.0-rc.2-d292b2d638cb。

交付文件 `build/ash-coworker-20261010.apk`，332.6MB，SHA25672a04b33d9553004d4def76641f8a916758d59f31c38d08e7a1eb27b73206265。签名验证、APK内UI与源码一致、desktopWorkOpen存在、payloadzip与当前构建SHA一致及容器版本一致全部通过。发现LocalSend红米华丽的桃子172.16.5.48；首次CLI direct错误采用http失败，改设备名CLI投递session77789仍等待。尚未声明手机接收/安装成功。

LocalSend投递未完成：device-name/default-port CLI再次实际走HTTP到HTTPS peer并报invalidHTTPversion；之后HTTPS /info探测exit7无法连接，已要求用户保持手机LocalSend前台及同Wi-Fi。最后一次发送61775已停止，未声明接收或安装。APK交付文件保留。


LocalSend实际投递成功：用户确认手机一直前台后重查发现同peer/IP/HTTPS。curl无clientcert出现TLS certificate_required；临时自签名sendercert完成mutualTLS/info。按LocalSend官方v2协议准备/上传，HTTPS服务端证书SHA256与发现设备fingerprint严格一致。receiver prepare-upload HTTP200、完整APK upload HTTP200、进程37737退出0。这是手机接收成功，尚未验证覆盖安装及电脑会话入口。此前不能连接归因手机状态不准确，真实问题是CLI HTTP选择及HTTPS clientcert。


### 2026-10-10：手机内容为空的分页修复

用户真机标题可见、进入内容显示离线/无缓存。对已授权实际ash会话调用相同adapter：limit50返回too_large（原始full turn页超过1MiB），limit25成功25turn/84messages/57612bytes，确认不是空历史。依用户明确要求消息页面最终改limit10，会话列表仍50；完整work/授权/cursor保持，较早内容继续分页。UI too_large改为真实内容过大提示，保缓存。独审接受窄修，store测试通过，实际10turn请求及oldercursor验证通过。

已重buildCore与payload；用户10turn要求在完整payload构建启动后到达，故等原构建终态后将新Core替换已构建tree，按assemble相同完整tree哈希算法重算index/build并更新zip两成员；不复用旧buildid、不仅改UI。APK assemble退出0（11秒），包内UI与当前generated字节一致、payloadSHA与当前ZIP一致、ZIPCore与当前dist一致，签名仍67c8bb8a…。新文件`build/ash-coworker-20261010-read10.apk`通过相同pin peer HTTPS LocalSend投递68782，已prepareHTTP200，上传中。实际手机消息显示尚待用户覆盖安装后验收。

read10 APK实际LocalSend upload HTTP200，68782退出0，手机接收确认；等待覆盖安装后真实10轮消息展示。


### 2026-10-10：真机读取验收及发送开发启动

用户已确认“能读取到了”，read10 APK的手机会话读取正式验收。随后用户反馈没有发送入口，并明确要求开发发送闭环。现真实电脑已配对且有项目读取授权，但没有control grant/runtime，历史共享socket当前不存在；不得仅亮输入框或使用独立reader代替原桌面执行。

本步复用已有DesktopControl发送/追加与投递状态机，补同原Codex控制连接及单会话一次确认。已将control runtime纳入受保护本地状态事务，并允许只读thread/loaded/list归属核查；事务私有写入及外部修改失效测试4/4通过，修改后TypeScript检查通过。新连接编排与runtime设置正在开发，尚未交付可发送APK。修改前控制相关基线18项17通过，现有wiring测试旧v2读取授权期待ready失败，单独记录，不改断言掩盖。

Goal仍为blocked；用户已授权继续开发，自动Goal状态须由用户界面恢复，不能通过创建更小Goal或误标完成替代。当前阶段不改变真实桌面运行方式；连接代码与隔离验证完成后再提供明确重启步骤。

本轮控制接入后端节点完成：ControlRuntimeSettings真实listener初始化验证与受保护runtime保存，captureLoadedControlWork固定native opaque证明（仅证明该listener已加载会话，不证明GUI同owner），connectControl固定production provider与单会话一次确认send_input/steer授权编排。runtime测试7/7、编排9/9、事务及watcher4/4通过，TypeScript通过，Astra产品审查接受限定节点。首次runtime测试初始直接写配置的延迟watch通知导致保守stale，证据保留/tmp/ash-control-settings-diagnostic.log；最终fixture在任何watcher前预建配置，未放宽生产epoch检查/加入重试。保存后立即新proof的组合边界尚需下一接线步骤验证。

未完成：正式CLI/main/IPC引用新模块、可信默认candidate发现、GUI同服务归属验证、手机发送和读回回复。此节点不是手机可发送版本，无新增APK投递，真实桌面和授权未变更。下一步完成正式接线与限定共享服务切换方案，用户无需复制UUID或配置socket。


### 2026-10-10：正式控制命令和后台接线完成

前一Goal轮为进展（后端代码/测试/文档），本轮Goal恢复后继续正式入口。现在源代码命令ash-device connect codex --control --project PATH会显示项目已加载会话的编号/标题/最近时间，选编号后一次单会话确认；编号冻结WorkRef，owner/cwd改变拒绝，缺共享runtime不启动另一runner。ConnectionSetupService/main已装配ControlRuntimeSettings与关闭生命周期，私有签名IPC新增固定control-runtime.prepare/apply。默认macOS候选发现辅助仅检查固定bundle/version/socket/listener，不启动daemon；尚未自动接入CLI保存。

本轮测试：runtime+显式writer捕获组合12/12，CLI+授权编排17/17，IPC2/2，真实main资源生命周期4/4；TypeScript及build:device通过，Sol独审root后台接线。Root真实TTY运行编译后control命令，准确返回缺共享连接并退出1，未授权、未发模型任务、未改真实桌面。新增组合只证明同process writer receipt，跨process保存后立即新observer边界仍不外推完成。

用户可用发送尚未完成：当前机器缺真实共享socket/runtime。下一步交付有限共享服务启动/恢复与桌面连接步骤，核GUI同服务归属，然后把runtime保存与会话选择接成一次流程，验手机发送/追加和读回。当前不增加APK、不伪造发送ready，不提升整体产品验收比例。


### 2026-10-10：共享启动助手和一次连接流程准备

前轮为进展（正式命令/后台接线/实际缺连接证据）。本轮新增固定macOS共享启动plan/start（桌面运行即拒绝，不自动quit），核固定bundle/version/default home/remote+updater关闭策略，启动后仅WS_URL重开并返回attachment_unverified；失败只normalopen，不stop不明daemon。真实只读计划确认当前desktop running、daemon offline/socket missing、policy disabled。已生成可执行build/Start-Ash-Codex.command，调用已有Node22运行新dist。

配置发现→受保护IPC保存→同writer list→编号选择→一次确认现已接CLI。samewriter列表解保存后立即列表的本进程receipt边界，后续确认仍freshnative目标proof，不盲重试。不宣称GUI已attach。runtime/list组合13项+install7+launcher10=30/30通过，TypeScript/build通过，Sol独审接受入口/launcher/IPC接线；既有跨端整体未验收。

package:device当前确认live handle72415，Node22发行包下载阶段无输出，不能按观察超时重启。下一轮先poll同handle终态再完成本地connector受控升级；不得把旧背景服务当已支持新listIPC。真实桌面切换需用户保存任务并正常退出后外部执行已生成助手；这不是再次请求授权，而是当前agent不能关自己的活跃桌面。重开后仍需核GUI同服务、登录及工具兼容、真机发送回读。Goal保持未完成。

package72415随后exit0，已产出macOS arm64 Node22正式自包含包。受控本地升级29174exit0：记录私有回退点local-control-handoff.json，bootout旧KeepAlive→current指向0.1.0-local-control新版本→bootstrap同原plist；device配置/key/pair/read grant/runtime内容fingerprint均保持。真实签名IPC setup.ready=true确认gateway恢复；新control-runtime.list返回unavailable符合仍无sharedruntime，不冒称可发送。前段live描述仅为当时快照，现两handle均终态成功。下一必需操作是用户正常退出桌面后外部启动已准备助手，不能由当前活跃Goal强退出。

### 2026-10-11 当前会话发送授权
共享桌面实际连接已验证。电脑连接器更新完成，保留配对与历史读取配置；生产安装入口返回 authorized/runtime saved，仅授权当前 ash 会话 01a10ace-3acd-7f93-92be-239c49555b84 的 send_input、steer。尚未验收手机实际发送。首次配置与持久化 native invocation 边界修复已通过 24 项测试及构建。

### 2026-10-11 手机实测与追加修复
用户确认从手机发送「请回复 ASH phone ok」，当前 Codex 会话收到并回复，手机亦可读取回复：当前会话真实收发闭环通过。运行中追加实测失败：本地送达记录 action=send_input/status=rejected/error_code=stale_precondition，手机沿用了空闲状态。最小 UI 修复为发送前同一操作内刷新状态及 action lease，再选 send_input/steer；状态不明保留草稿不投递，stale 拒绝提示保留原文供主动发送。8 项单元与 7 项 Chrome 页面测试通过。修复 APK 编译与签名校验通过，尚待手机覆盖安装后的追加验收。

修复交付：build/ash-coworker-20261011-sendfix.apk，332.6 MB；包内 UI、payload、Core 字节一致，签名与已安装 read10 APK 同为 67c8bb8a…；LocalSend 已 pin 华丽的桃子 HTTPS 指纹，prepare/upload 均 HTTP 200，发送进程退出 0。待用户覆盖安装并重新实测追加。

### 2026-10-11 后台刷新打断输入修复
用户报告打字期间周期刷新导致不能继续输入。根因：DesktopWork 每约4秒读取后重建父页面，DesktopControl 重建 textarea 且 busy/unknown 禁用输入。修复保留连接中的 composer 及 textarea，仅重绘消息/状态；检查期间可编辑，中文 composition 不改 value，跨会话/身份变更仍清除草稿。source-import Chrome 9/9（含父页真实 refresh/重复render、节点引用、focus/selection/零blur、组合输入事件及scope清除），unit 8/8；父页面原有完整Core浏览器回归3/3，fixture材料模块有既有helper不可用诊断，不影响这些历史读取测试。Core与APK构建通过；build/ash-coworker-20261011-inputfix.apk 332.6MB，包含上轮发送前状态检查修复，UI/payload/Core逐字与哈希一致，签名与旧包一致。手机真机输入法与运行中追加尚待安装验收。

inputfix APK 已通过相同 pin HTTPS LocalSend 发给华丽的桃子，prepare/upload HTTP200，进程退出0。待覆盖安装真机验收。

### 2026-10-11 会话页简化
按用户要求，当前会话页收敛为返回/标题/更多、消息、底部固定输入框与发送。刷新、新建桌面工作、材料与要求、关闭收进更多菜单；正常连接不展示技术状态/缓存上限/授权术语；发送记录默认折叠并保留展开状态，失败/未知保留简短提示和查询入口，不自动重发。保留前述输入焦点、IME、最新状态发送逻辑。source Chrome 9 + native fake-socket链路3 +完整历史页面3，均通过；unit8通过。390px手机布局及更多菜单截图已检查，build/ash-chat-simplified.png。真实手机简化版及运行中追加验收待安装。

简化版交付：build/ash-coworker-20261011-simplechat.apk 332.6MB，UI/payload/Core与冻结源码构建一致、原签名一致；LocalSend prepare/upload HTTP200、退出0，发送至华丽的桃子成功。此包合并sendfix/inputfix/simplechat修改，待手机覆盖安装验收。

### 2026-10-11 会话页第二轮减字
按用户进一步反馈，去掉逐条用户/助手可见标签（保留aria语义）、运行说明、常驻发送记录summary。发送记录移更多菜单主动打开，异常有查看入口；收起即隐藏并保持输入框连接。保留必要发送中/未知/失败事实，附件缺失缩为未同步，未更改消息正文。unit8、source/chain12、完整读取页面3全部通过；390px手机预览已检查。

减字版 build/ash-coworker-20261011-cleanchat.apk 已校验UI/payload/Core一致、原签名一致，332.6MB。LocalSend prepare/upload HTTP200、退出0，华丽的桃子接收完成；此包包含此前所有发送/输入修复，待手机验收。

2026-10-12 replies APK 已成功通过 LocalSend 发送至原指纹手机（用户提供新地址172.16.5.66），prepare/upload均HTTP200，发送进程exit0。等待用户覆盖安装后确认实际回复格式/代码复制/网页链接打开；未宣称真机新版已验收。

2026-10-12 result-file APK已经LocalSend成功发送至原指纹手机172.16.5.66：prepare/upload HTTP200，退出0。待覆盖安装→点击Root生成测试文件→确认该具体文件→再次点击系统保存及内容核对；未宣称真机文件回收已通过。
