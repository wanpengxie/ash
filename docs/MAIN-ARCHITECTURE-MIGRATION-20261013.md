# coworker 主分支架构迁移

采用 origin/main e7372448（0.4.27）作为基础。迁移完成时上游又增加5个提交，已继续合入；新增pi运行时与会话路由38项检查通过，类型检查和Core构建再次通过。旧实现快照位于 backup/coworker-before-main-20261013，5b958f84；旧 APK 不代表新版验收结果。

## 运行方式

手机原生「电脑会话」和浏览器通过现有 human channel 调用 service:collaboration。服务经 kernel router 调用电脑 HandClient 提供的 capabilities。设备端保留项目CLI授权、Codex本地接口与私有setup IPC。共享DTO和校验协议归 SDK，不保留旧 WorldRouter、OwnerLink、HTTP EdgeRouter 或旧原生HTTP桥。

主动图片走现有 human channel 的分块导入，存入 Kernel Ledger/blob，然后经固定签名材料通道传输至电脑接收器，再提交给原会话。结果文件通过 human stream 下载并校验后进入系统保存器。新增、发送和运行中追加保留既有授权范围；手机刷新不重建输入框。链接分享保存为草稿，用户选择目标后发送。

## 本地验证

- 全库 TypeScript 检查、Core/device 构建通过。
- 新Core基础服务、真实hub/link路由、签名材料传输与本地native图片接口集成通过。
- Device最终针对性回归105项通过；先前失败分组中的headless browser、source settings、host proxy也复测通过。
- Web相关单元77项、Chrome流程40项通过；新增Android关联12项通过，随后Markdown格式、链接和代码复制相关9项通过，Kotlin编译通过。
- 主分支完整文件核对，无上游文件缺失；原始日志与截图保留本地，不随代码提交。

完整 npm test 首次结果为2513项、2457通过、49失败、1取消（其余跳过），此结果采集时部分测试迁移仍在进行，不能作为最终全绿证明。后续仅对失败和新增范围做复测。

剩余限制：上游技能规范3项与health场景在独立origin/main基线也失败；18个body/proot用例依赖Linux /proc，当前macOS无法运行，独立基线同样失败；workspace路径在使用canonical TMPDIR后通过。上游AshLetter组合emoji用例在当前JDK17失败，源码与向量均与main相同。WK原生文件夹面板在本机不可用，未重复弹窗或通过skip伪装为绿色。

上述本地验证不代替新版Android模拟器整套安装/启动和真机验收，不代表真实Codex模型识图或生产公网链路已通过新版验证。主动索取手机材料、防重复专项仍按用户决定延期。
