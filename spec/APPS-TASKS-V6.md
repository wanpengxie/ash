# 任务应用：当前冻结稿的原生实现

依据当前 app-design/SPEC（含第8节）、v6/BUILD-MAP、release 的任务正常/详情/平静图和地图动线。本轮不重新研究、设计或新增后端。这里描述施工映射与验证边界；旧 APPS-TASKS-DESIGN 中的首页布局属于此前迭代。

## 同一份任务，三处稳定目的地

- **现在**：需要补上 → 有确切已到时点的当前事项 → Ash 与具名帮手 → 你的待办 → 最近结果。未来提醒和普通 waiting 不自动需要人；不从 note 猜批准或步骤。责任人使用 assignee，subject:ash 只是同库承诺视角。
- **全部**：原任务及其真实状态；更多里保留 subject:ash 承诺、已完成/不做了筛选及回全部入口。
- **你的事**：实际由 person:owner 负责的 open 事项。没有新建主线或候选服务。

标题摘要只写最近成功读取的确认时间，无已见游标就不写未读/离开后变化。完成结果展示原 result 和谁标记的状态，不把生成材料推成现实提交。

## 原对象详情与精确写

点同 id，显示负责人、归属、状态、提醒和截止各自的本机时间、原 note/result，以及 delivery 原事实。pending 保留“已保存 / 提醒尚未安排 / 对话卡待恢复”，按钮只发 `update{id}`，不 add。缺 delivery 明说状态未取得；未确认的失败保留 pending 与原记录。

详情直接编辑原记录或改提醒；完整设置保留负责人、归属、全部状态、截止/提醒、说明和结果。原 note/result 支持多行。仅编辑记录时只发送 id/note/result，不误写负责人/状态/时间；普通保存也不删除另一组尚未提交的草稿。完成、不做了、重开沿同任务状态词，不覆盖原 note/result。修改经过按需读 get.changes，来源只沿原 source.message 跳回，不制造来源。

公共外壳提供应用身份、根页无返回Ash箭头、目的地、详情返回和非输入底部动作。返回保留原目的地及列表 key/offset。原 task-id 草稿、旧响应代次和活动 EditText/选区保护继续沿用。

## 快速记下和恢复

记一件事入口打开次级轻输入，可直接选提醒。沿原选择器，不声称本地理解自然语言。先保存 client_id 与冻结 body 再 add；未知结果只重试原 body，期间的新标题和时间成对保留。成功确认列出原标题及未设/已安排/尚未安排，并保留到随后的读取后。没有增加送达框架、自动派单或后台恢复机制。

## 定向验证

现有标准 Robolectric：TasksActivityProductTest + TasksModelTest，单命令、max-workers=1 按总控时段运行。测试不是实际模型或真机证据。当前源码新增实际360×800、mdpi、fontScale=1、SDK35 NATIVE的窗口截图：

- build/reports/tasks/tasks-home.png：原pending、具名agent事项及未来个人提醒；没有虚构当前决定。
- tasks-detail.png：同pending任务、事实/原note、真实update{id}入口。
- tasks-quiet.png：ready快照，普通waiting/未来无处理提示，仍可看agent与个人事项。
- tasks-ash-detail.png：原agent事项与note，不画固定候选。
- tasks-edited.png：真实输入、刷新保同一EditText/选区、保存回执后的原note。
- tasks-added.png：同一实际360×800窗口完成快速填写、选明天、add回执与列表重读，检查多行成功反馈完整可见。

保留原选择器、负责人单选、冷热路由、未知请求重试、新草稿不丢的真实View回归；Model直接区分已到提醒/截止、普通等待、未来、pending与缺delivery。结果和截图必须实际运行、打开后才记通过，源码就绪不算通过。

本轮不改任务后端。此前真实Router/Clock/对话脚本13项结果仅证明其当时后端路径，不代签新界面。跨应用完整注册和HomeActivity来源回跳在总控集成依赖中；本树不复制其他应用/注册表，未冒称跨App集成已通过。真实IME、系统手势返回、200%字体/RTL/TalkBack、OEM通知后台及真机帧耗时未验；不操作手机、不打包、不推送或合主线。

## 第一轮实际运行与看图

指定单命令已退出0：Activity 11/11、Model 6/6，0失败；包含生产与测试Kotlin编译。实际打开home/detail/quiet/ash-detail/edited五图，正文与恢复动作可见，普通waiting/未来无当前需人提示，实际记录保存和刷新保输入通过。此时尚未包括下面看图修正，不用17项绿测试替代当前图片复验。

看图明确修正：详情经过与来源改成稿中的无底展开/来源行；无时间不能因ready字段写“提醒已安排”，有截止但无提醒则称到期跟进安排；fixture无时间使用none，并给原source验证发出的同消息Intent。公共nav标签未居中已交base，业务不另修公共类。补充同窗口quick-add成功图，尚待总控下一时段复验后打开。

## 最终定向交付记录

第二轮指定单命令退出0：`TasksActivityProductTest` 11/11、`TasksModelTest` 6/6，0失败；生产/测试Kotlin编译通过。日志保存在施工指定临时目录的 tasks-v6-repeat-views.log，XML在 app/build/test-results/testDebugUnitTest/。未再运行构建或扩大测试矩阵。

实际逐张打开本轮 tasks-home/detail/quiet/ash-detail/edited/added 六图（均在 android/app/build/reports/tasks/），核对正常待恢复、同id恢复详情、平静/普通等待与未来、原agent记录、编辑后记录、真实填写选时并收到add回执后的多行确认。已确认输入刷新保实例/选区、只写note/result、来源Intent仍同message；未知添加沿原body且保新标题/时间的用例继续通过。native截图是确定性测试端口的实际Activity窗口，不是线上数据或真机截图。

总控 agent:codex:1790670726888 已独立读取本轮XML并实际打开六图，给出本轮定向done：与当前冻结稿无阻断偏离。未设置提醒在详情重复一处作为非阻断记录，不继续打磨。该结论不替代总控后续统一集成回归。

本轮自己的业务提交顺序：fab60114 → 3d4d486d → c7c652d3 → 4d70cedd → a2e0e22f，之后仅本最终文档提交。所有本轮业务/文档提交带Codex共同作者。

依赖副本必须排除（主线已有原提交时不重复引入）：

| 本树副本 | 公共原提交 | 内容 |
|---|---|---|
| a085d82f | a1714cd9 | HumanCall原始请求回执 |
| fd8964a5 | 80fdcef9 | 现有LinkClient端口与共享订阅顺序 |
| c8d5ad28 | e708fb3e | 可选原生应用身份/目的地/详情外壳 |
| a33bf4f1 | d013fbb5 | 状态槽稳定预算 |
| 2e69258c | 5b80be54 | 底栏标签居中 |

e708冲突采用其完整官方SystemAppActivity文件，未自行修改公共API；不引全应用注册混合提交。完整跨应用注册、HomeActivity来源导航和其他业务仍由总控集成，不用本树的来源Intent断言冒充跨App端到端通过。

最终边界：未验证真机IME/选词、键盘动画/手势返回、OEM通知/后台、TalkBack/RTL/200%字体、深色实测和帧耗时；dark只沿既有tokens实现，未声称审计通过。未操作手机、未打包/安装、未合主线或推送，无遗留命令。
