# 移动端盘点：对照 MOBILE-ARCH 的违规清单

依据 `spec/MOBILE-ARCH.md`（2026-10-15 定稿），范围按 §10.2。路径相对 `android/app/src/main/java/ai/ash/`；行号是 2026-10-15 的快照，之后请按符号定位。

**状态**：已修（提交号）· 部分 · 未修（下一轮）· 待定（要主人定）。“已修”只表示编译通过、相关 JVM 单测通过；涉及系统交互的一律**未验证**（见文末），要主人在真机上看。

**第一轮独立验收：不通过，暂不能合并。** 以下“一、二、三、四”为施工自述，不能据“已修”认定行为验收通过；源码反例、小修和独立测试结果见“五”。

## 一、§15.2 最严重的十项

| # | 页面 | 条款 | 现状 | 改法 | 状态 |
|---|---|---|---|---|---|
| 1 | 聊天 | §3.5 §4.2 | 点发送先清掉输入框和附件，再检查有没有目标；不知道主 agent 时直接 return，字和附件都丢了 | 待发队列 `ChatOutbox`：附件和消息先原子写盘，存好之后才从输入框清掉**发出去的那部分**，期间新打的字保留。不知道主 agent 时消息先排队、存在本地，发出时再定收件人。每次重试沿用同一个 `client_id` | 已修 86f99054 |
| 2 | 聊天 / Codex | §3.2 §13.1 | 聊天读取失败被当成空窗口，清空了历史；读取请求没有代次；Codex 读失败或旧回复会改 note/sessions | 聊天：`ChatWindow`，同时只有一个读取请求，带 generation；失败保留快照，在状态槽里显示时间；只有成功读到空结果才清空。Codex：`CodexState`，每次读取带票据（代次 / 电脑 / 会话），成功或失败只要票据过期就丢弃；失败保留列表和会话内容 | 已修 86f99054、83b44d45 |
| 3 | 聊天 / Codex / 主页 | §3.4 §11.1 §11.4 | 只保存了 tab；草稿、目标会话、附件、阅读位置都只在内存里，切主题 recreate 就丢 | `Drafts`：每个会话一份持久草稿（聊天按 agent 分，Codex 按会话和新建项目分），附件引用写盘。聊天的目标 agent 和阅读锚点（key + 偏移），以及 Codex 的路由，都进 saved state | 已修（聊天、Codex）；主页分页栈见下表 |
| 4 | Codex | §2.1–2.4 §3.3 | 回复一变就 `removeAllViews`，整页重画消息、审批和选中状态 | 会话列表和会话内容都改成 RecyclerView + `KeyedRowsAdapter`，按 key 增量更新；输入框不再随之重建；会话内容从底部排，按 `FollowEnd` 的规则滚动 | 已修 83b44d45 |
| 5 | 对话卡 | §2.2–2.3 §3.3 §12.6 | 卡片一更新就清空 fields/holder 再重建，之后抢回焦点，拼音组合态会丢；行签名用整项 JSON，范围太宽 | 按任务书暂不动：卡片运行时（`feat/card-runtime`）正在改 ChatCards，等它合进主线后再做 | 未修（等 card-runtime） |
| 6 | 聊天 / Codex / 所有窗口 | §1.3 §4.4–4.6 | 只有聊天整块平移；Codex 靠根 padding 缩放；根节点 `CONSUMED`；注释和实际不符 | `WindowInsetsOwner`：每个窗口只有一个 Insets 所有者。padding 以初始值为基准幂等计算，系统栏和刘海取并集，键盘盖住导航栏而不是叠加，只消费分配掉的 Insets。前台页面如果是 `KeyboardDeck`，就只按「键盘超出底边的部分」做 translationY（动画过程和停稳后都是），并计数处理动画反转和取消。聊天和 Codex 都是 deck；`Ui.insets` 的 7 个窗口改走这个协调器 | 已修 83b44d45 |
| 7 | 聊天 | §1.2 §2.4 | 断连条和授权条是 stage 前面的普通子项，出现或消失会改变消息区高度 | 改成浮在会话顶部的状态槽，列表的 top padding 跟着槽高（布局之后再设，不在布局过程中设）。从底部排的列表保住最底一行，所以读到的位置不动 | 已修 83b44d45 |
| 8 | 聊天 / 端口 | §1.4 §3.5 §7.2 | Outbox 在主线程读写文件和附件；端口在主线程解析 JSON、解码 Base64；每个出站帧都新建一个线程 | `UiIo`：一个有界的磁盘队列和一个解码队列，原子写入。`HumanPort`：在解码队列上解析、解码流数据；出站帧单线程按顺序发出；每个请求都有时限，超时返回 `result_unknown` | 已修 86f99054 |
| 9 | 主页 / 应用页 | §11.1–11.3 | 只用旧的 onBackPressed 和 moveTaskToBack | `BackRouter`：Android 13+ 用 OnBackInvokedDispatcher，只在有地方可退时注册；HomeActivity 已 opt-in；聊天根交给系统，不再 moveTaskToBack；旧系统走同一条路线 | 主页已修 83b44d45；**应用页 AppActivity 未改**（见下表） |
| 10 | 共用组件 | §5.1 §5.4 §5.5 | 触控和图标按钮 44dp、小按钮 34dp、删附件按钮 30dp；按钮定高，文字可以缩到 11sp；FrameLayout 按钮没有角色 | 令牌源改 touch / iconButton = 48，重新生成；胶囊按钮视觉尺寸不变，但套在至少 48 高的视图里，长文字或大字体时换行变高，不再缩字；开关绘制 46×28、视图 48；分段控件格子加高；`AshUi.role` 给按钮、开关、分段补角色和状态 | 已修 708ff6cc（对比度、200% 字体未测） |

## 二、其余页面（§10.2）

| 页面 | 条款 | 现状 | 改法 | 状态 |
|---|---|---|---|---|
| 体检 / 引导 / 感知设置 | §1.1 §3.6 | 各自 `HumanPort(...).start()`，会顶掉聊天占用的唯一页面槽，之后聊天收不到消息和回执；调用又发生在链接打开前，本身也会立刻失败 | `HumanCall`：直接走链接、有自己的小队列，不占页面槽 | 已修 9ddb0257 |
| 她做过的事 | §3.2 | 步骤读取失败后删掉记录再 draw，draw 又重新请求；离线时同步失败，无限递归直到栈溢出 | 失败的结果保留并在 turn 下显示，收起再展开才重读 | 已修 9ddb0257 |
| 桌面卡片组件 | §6.3 | `OpenUrl` 原样用 ACTION_VIEW 打开任意 URI | 只放行 https/http（浏览器）、tel（拨号盘）、mailto（草稿），其余打开 Ash | 已修 9ddb0257 |
| 等你的 | §3.2 | 还没读到时就显示「现在没有要你决定的事」；失败时空态一直不变 | 区分读取中、失败（保留上次读到的内容）、成功且为空 | 已修 bae678f4 |
| 密钥 | §3.2 | `keys.status` 失败时 health 被置空，看起来像「没有问题」 | 失败时保留已知状态，并提示没问到 | 已修 bae678f4 |
| 附件（聊天里的图片） | §7.2 | 在主线程做 Base64 和位图解码 | 移到解码队列 | 已修 bae678f4 |
| 审批通知 | §6.4 §13.2 | 划掉审批通知（以及一键清空）会发出「拒绝」 | 这看起来是有意的设计（问题类划掉是忽略，审批类是拒绝），方向是安全的；但它让一次没有明确选择的操作变成了决定 | **待定**（要主人定：划掉算拒绝，还是只算忽略、审批留在页面里） |
| 应用页 | §11.2 §12.5 | 返回和顶栏返回都是 `moveTaskToBack`；离开时 WebView 不暂停 | 改用 dispatcher；但应用页不是启动器根页面，交给系统返回会 finish、下次重新加载 WebView，要先定「应用任务要不要常驻」 | 未修（下一轮，要先定行为） |
| 主页各分页 | §3.4 §11.1 | 页面栈只在内存里；分屏缺 `screenLayout\|smallestScreenSize`，会重建 | 页面栈和参数进 saved state | 未修 |
| 记忆 / 身份 / 约定编辑 | §3.3 §3.4 | 草稿只在内存，返回时不检查 dirty；每次 render 都新建 EditText | 草稿接入 `Drafts`，返回前确认；EditText 保持实例 | 未修 |
| 等你的 | §3.3 §2.1 | 每次变化都整块重建卡片，「自己说…」输入框里的字被清掉 | 按 ask id 复用卡片，输入框保持实例，草稿按 askId 保存 | 未修 |
| 设备详情 | §3.3 | redraw 会重建名称框和权限开关，未保存的编辑被重置 | 字段建一次，只更新数据 | 未修 |
| 新设备批准 | §6.1 §6.2 | 批准 / 拒绝没有 pending 状态，也不带 client_id，连点会重复发送 | 动作状态机，持久化 operation id | 未修 |
| 主页（总览） | §3.6 §3.2 | 被压在下层的页面还在 1s / 15s / 60s 轮询；每 15 秒并发约 13 个请求，没有在途上限，也没有代次；失败时一直显示「正在读取…」 | 只有栈顶可见页订阅和轮询；每个数据源一个在途请求，带超时和错误态 | 未修 |
| 她的文件·单文件 | §7.2 | 在主线程做 Base64 和最大 20 MiB 的位图解码，每次刷新都重解 | 放进 `UiIo.decode`，结果缓存 | 未修 |
| 文件查看器 | §7.2 | 在主线程写缓存，以及解析文本、JSON、HTML、Markdown、图片 | 后台准备好，主线程只做绑定 | 未修 |
| 附件选择 / 拍照 / 保存 | §11.5 §3.5 | 结果靠内存闭包认领，用的是 `startActivityForResult`；进程被杀后结果没人接，拍照文件成了孤儿 | 用 Activity Result；请求身份和 capture URI 持久化 | 未修 |
| 设备权限 / 插件开关 | §5.4 §5.5 | 整行不可点，只有开关本身能点 | 开关已经是 48dp，并能读出开 / 关；整行可点还没做 | 部分 708ff6cc |
| 屏幕授权悬浮球 | §5.4 §5.5 §6.1 | 只用 OnTouch，没有点击语义；「收回权限」约 36dp，没有 pending；9sp 字、写死的颜色 | 补点击和自定义动作，48dp，处理中状态，改用令牌 | 未修 |
| 屏幕授权 | §3.6 §13.3 | 有租约时每秒 changed 一次、重发一次通知 | 通知用 chronometer，只在状态变化时更新 | 未修 |
| 虚拟屏预览 | §5.4 §5.2 | 关闭 / 放大只有 24dp；用 ✕ ⤢ ● ■ 当操作图标；10sp 字 | 48dp 命中区，换 Ash 图标 | 未修 |
| 音视频预览 | §3.6 | 每 400ms tick 一次直到关掉；切后台不暂停 | 不播放或 onStop 时停 | 未修 |
| 她做过的事 | §2.1 §2.4 | 每 5 秒整条时间线重建 | 改 RecyclerView + `KeyedRowsAdapter` | 未修 |
| 等你的 / 活动页 | §3.2 | 有请求在途时直接丢掉新的变化 | 打 dirty 标记，在途结束后补一次 | 未修 |
| 处理过的事 / 花了多少 / 她的文件 | §3.2 | 失败时清空或隐藏已有列表；目录读取没有代次 | 保留快照并叠加错误；带上 path 和代次 | 未修 |
| 模型 | §3.1 §3.3 | 每次 refresh 都 setText，盖掉正在输入的内容 | 只在未编辑时填值 | 未修 |
| 主页 | §6.2 | 审批答复、撤销、暂停用的 id 只在内存 | operation id 持久化 | 未修 |
| 主页外壳 | §1.2 | 断连提示是普通子项，出现时挤动页面 | 照聊天的状态槽做 | 未修 |
| 连一台新设备 | §6.5 | 带一次性密钥的命令放进剪贴板，没有标记敏感 | API 33+ 设 `EXTRA_IS_SENSITIVE` | 未修 |
| 主页各页 | §5.4 | 标题、链接、药丸等 24–32dp 可点 | 至少 48dp 命中区 | 未修 |
| 应用列表 | §2.4 §3.4 §3.2 §6.2 | 每次 render 新建 ScrollView，位置清零；刷新失败不提示；安装和收回没有 op id | 复用容器、恢复位置，显示错误，op id | 未修 |
| 体检 | §6.1 §6.4 | 开关改失败后停在错误状态；停止 / 重启大脑既不确认也没有处理中 | 失败时回滚，按风险确认 | 未修 |
| 引导 | §3.4 | history 和 cursor 不在 saved state 里 | 存进 saved state | 未修 |
| 浏览器接手 | §5.1 §3.4 | 用裸像素和裸 Button；主题变化后按原 intent 的 space 重新附着 | 改用令牌，当前 space 存进 saved state | 未修 |
| 审批通知 | §13.2 | 点通知只打开主页，不带审批 id | 走统一路由，带上实体 id | 未修 |
| 卡片运行时 | §12.2–12.3 | ChatCards 缓存卡片和 WebView，主要靠 close 才释放 | 归卡片运行时施工 | 未修（card-runtime） |

## 三、全局问题（各页反复出现）

- **§2.1 刷新整块重建**：主页各分页都靠 `HomeKit.redraw`（`removeAllViews`）整块重画，体检、应用列表、应用页也一样。聊天和 Codex 已经改成 `KeyedRowsAdapter`，其余页面下一轮照这个迁移。
- **§3.2 请求机制**：`HomePage.call` 没有超时、代次，也不限制同源只留一个在途；`HumanPort` 现在已经有时限，主页这条路径还没有。
- **§7.2 裸建线程**：HomeMain、HomeHands、HomeFiles、AppsPane、Console、Onboarding、ChatFiles、LeaseState 都是每个请求新建一个 `Thread{}`，应改走 `UiIo` 或 `HumanCall`。
- **§11.2 返回**：Console、Onboarding、AppActivity 仍然重写 `onBackPressed`；`BackRouter` 已经可以复用。
- **§5.5 / §5.6**：可点的 LinearLayout 单元格缺角色；原生文案都写在 Kotlin 里，没有进字符串资源（`strings.xml` 只有 7 条）。
- **§3.4**：页面状态挂在 Activity 或页面对象上，没有 ViewModel 或等价的 retained 状态。聊天和 Codex 现在已经有 saved state 加持久草稿。

## 四、§8.1 验证状态（这一轮）

| 项 | 状态 |
|---|---|
| 中文输入 / 选词期间刷新不丢编辑态 | 未验证：聊天和 Codex 的输入框不再重建；对话卡（#5）没改 |
| IME 开收、动画反转、返回收键盘：会话一体移动 | 未验证：要真机 |
| 历史上翻、新消息、分页、图片、展开、状态槽不抢位置 | 未验证：要真机 |
| 旋转 / 主题 / 重建保草稿、会话、锚点；进程回收后恢复待发 | 未验证：要真机。待发队列和草稿的持久化有 JVM 单测 |
| 断网、失败、旧响应、未知结果不丢内容、不盖新草稿 | 自动通过：reducer 和队列的 JVM 单测（`ChatStateTest`、`CodexStateTest`）；界面未验证 |
| 返回 / 预测返回 | 未验证：要 Android 13+ 真机 |
| 深浅色、200% 字体、TalkBack、48dp、对比度 | 未验证：48dp 已落到令牌和组件；对比度没测 |
| 离页停轮询 / 动画 | 未验证：Codex 离页时停轮询并收键盘；主页轮询未修 |

## 五、第一轮独立验收（Codex，2026-10-15）

基线：`3ba7b67d..dad456ab` 的七个提交，分支 `feat/mobile-r1`。结论：**否，暂不能合**。下面是源码可走到的反例，不冒充设备复现；#5 卡片子树复用按原任务继续暂缓，不是本次唯一否决理由。

### 5.1 合并前须处理的阻断

路径仍相对 `android/app/src/main/java/ai/ash/`；源码行号为本次复核时快照。

| 级别 / 条款 | 位置 | 反例及影响 | 施工要求 |
|---|---|---|---|
| P0 · §3.5、§9.4 | `ui/ChatOutbox.kt:100–103` | 初始化无条件删除旧 `files/outbox` 并清 `ash.chat.outbox`，没有迁移。只要旧安装有未发送消息 / 附件，覆盖升级即丢失；“未发布”注释不能作为删除用户数据的依据。 | 按原 client_id、目标、状态、ledger id、附件迁移并校验；成功提交新队列后才可回收旧项。加旧版本待发的升级回归。不能只删清理语句就称已完成迁移。 |
| P0 · §3.5、§6.2 | `ui/CodexPane.kt:45–46、239–244、249–255`；`ui/CodexModel.kt:189` | Codex 发送先清持久草稿，`sends`、client_id 和状态只留 Pane 内存。发出后旋转 / 切主题 / 回收进程，在途或未知结果全部丢失。CodexSend 还未绑定 device，重试用当前 state.device，不能保证回到原电脑。新建会话的写请求也没有持久操作身份。 | Codex 与新建操作建立持久待发 / 结果对账，操作固定原 device + thread / project + client_id；落盘后清稿。应用退出和未知结果后必须能继续对账，不用新 id 重发。 |
| P1 · §2.2–2.4 | `ui/CodexPane.kt:169、386–395`；仓库 `packages/device/src/codex-app.ts:685–705` | 任意成功详情读取就删除所有 SENT 待发，没有验证对应消息已出现在响应。读到发送前快照时待发行先消失，之后正式行才出现；即使同次出现，`send:<client_id>` 与 `<turn>:<index>` 也不是同一 key。另一个确定反例：后端 `items.slice(-30)`，第 31 项到达后同一 index 指向另一条消息，“turn 内只追加”的注释不成立。 | 后端保留消息稳定 id / 发送关联 id，客户端精确对账并沿用同一 key；未证实出现不删除待发。不以重复文本或窗口内 index 猜身份。测旧快照、同文连发、单 turn 超过 30 项。 |
| P1 · §1.2、§2.4、§2.6 | `ui/ChatScreen.kt:181、219–221`；`ui/CodexPane.kt:85、332–334` | 状态槽并非稳定预留：显示 / 隐藏后 post 改列表 top padding，既没有固定槽高，也没有 key / offset 补偿。已上翻历史时改变可用总空间，LinearLayoutManager 的 end anchor 会计入 totalSpaceChange，内容仍可能整体上移 / 下移。“stackFromEnd 自动保住最底行”不足以保证历史阅读位置。异步 post 的旧高度也未校验是否仍有效。 | 稳定预留槽，或共用显式锚点补偿；合并槽尺寸提交、校验当前状态，覆盖聊天和 Codex。测长历史、非末尾、断连 / 恢复 / 授权变化和大字体，不只测列表到底。 |
| P1 · §2.4 | `ui/KeyedRows.kt:49–53` | `atEnd` 在 submitList 前读取，异步 diff 后仍照旧值滚到底；期间用户已经上滑也会被拉回。规范明确禁止的旧滚动意图仍存在，抽成 FollowEnd 没有修掉。 | 共用滚动意图 / 用户滚动代次，提交时废弃过期自动跟随，保可见锚点；测 diff 计算期间上滑及连续提交。 |
| P1 · §3.4、§11.1 | `ui/ChatScreen.kt:583–586、769–786`；`ui/CodexPane.kt:137` | 聊天只存 key / offset，重建只拉最新 60 条；原锚点在更早历史时找不到却立刻清 restoreAnchor，不再读取 around / 历史。待发先填充也会提前消耗恢复机会。Codex 仅存路由，没存列表锚点 / 选区。不能认定原 #3 的阅读恢复已修完。 | 先按持久实体定位补齐窗口，锚点实际恢复成功后才清待恢复意图；Codex 分列表 / 会话保存锚点。测上翻超过一页后主题重建、有待发时重建。 |

状态槽判断另核对了实际依赖 RecyclerView 1.3.2 的 `AnchorInfo.assignFromView` 字节码：从末尾定位时使用 decoratedEnd + totalSpaceChange，不是无条件保绝对屏幕坐标；[AndroidX 源码](https://github.com/androidx/androidx/blob/androidx-main/recyclerview/recyclerview/src/main/java/androidx/recyclerview/widget/LinearLayoutManager.java)亦可对照。该证据是布局机制核对，仍不是实际设备截图测试。

### 5.2 本次直接修复的小问题

- `ui/HumanPort.kt`：stop 幂等地封端，置 open=false，清超时、待处理 / stream 与监听，关闭每实例 outQueue；在解码入口、回主线程和出站前拦住关闭后的工作。原先只 detach，Activity 销毁后旧线程 / 超时仍存活，旧页面还可继续重试。
- `ui/design/AshUi.kt`：分段项自己的可点高度由 42dp 改为至少 48dp；父容器的 3dp padding 不算子项命中区。令牌测试的最低断言同步从 44 改为 48。
- `ui/CodexPane.kt`：显式返回会话列表前清输入焦点并收键盘，避免顶栏返回隐藏 composer 后遗留 IME。发送路径不主动清焦点。
- `ui/HomeActivity.kt`：主页浮层开 / 关时显式请求 Insets，让布局所有者在 chat deck 与普通表单间切换；不只在切 tab 时重算。

这些是局部安全修补，**没有**修复上表的大问题，也不等于所有生命周期泄漏已清零。

### 5.3 独立编译、单测和验收边界

在 `android/` 下执行（不是只读取施工方报告）：

```sh
ANDROID_HOME=/home/xiewanpeng/android-sdk ./gradlew \
  -Dorg.gradle.java.home=/home/xiewanpeng/ashwork/jdk21 \
  :app:compileDebugKotlin :app:testDebugUnitTest \
  --tests 'ai.ash.ui.*' --tests 'ai.ash.apps.*' --rerun-tasks
```

- 强制重跑：BUILD SUCCESSFUL，26 个任务实际执行；读取 JUnit XML：28 个 suite，210 tests，0 failures / errors / skipped。
- 四处小修最终版本又执行同一编译 / 指定测试命令（不加 rerun），Kotlin 与测试确实执行，仍为 210/210；`git diff --check` 通过。
- 未运行 assemble / APK 构建、设备安装、模拟器矩阵；未推送、未合并。现有 JVM 测试以数据 / reducer 为主，不覆盖真实 View 布局、IME、预测返回和上述关闭竞态；新增令牌断言也不能证明命中区测量。
- 键盘源码：聊天和 Codex 的 keyboard() 均只设 deck.translationY，WindowInsetsOwner 对 deck 不叠加 IME padding，终态没有改成重排归零；发送未主动 clearFocus / hide IME。这部分静态链路成立，但动画反转 / 收回不闪和锚点不跳尚未设备验证，不能直接报通过。
- 返回源码：主页仅在有子路由时注册，聊天根交系统；未发现一个系统返回直接跳过 Codex 子页的确定路径。根返回本来允许系统离开 App；Android 13+ / IME 优先和手势取消仍待定向验证。AppActivity 的旧返回未修仍是已知遗留。

### 5.4 其他风险，不能称已解决

- `HomeActivity.onResume` 仍无条件 `chatScreen.shown(true)`；切 tab / 打开主页未同步聊天 shown，隐藏聊天会继续报可见 / tick / 读数据。Codex 隐藏仅停 tick，未使在途票据失效，回调的 again 仍可能继续请求。需按 Window + 当前路由统一暂停 / 恢复。
- UiIo 的 newSingleThreadExecutor 只是线程数为一，任务队列仍无界；HumanCall 同理。UiIo.disk / decode 的 runCatching 吞错误，任务异常可能永不回传，让 loading / storing 卡死。HumanPort 的流聚合和最终复制仍在主线程，且没有总字节预算。
- ChatScreen.send 的 attachments 仍是可变 JSONArray 引用：磁盘存储期间选择更多附件会修改同一数组，完成后按对象身份清掉 picked，可能把未包含在写盘快照里的新附件一并清掉。需要不可变发送快照及独立编辑代次。
- 卡片 #5、主页各编辑器 / Web 生命周期、对比度、200% 字体及短窗口降级维持原盘点的未完成 / 未验证，不因本次测试全绿改成已完成。
