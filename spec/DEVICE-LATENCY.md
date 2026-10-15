# 设备连接的心跳往返样本

只复用 ash-link/2 现有 ping/pong，不新增协议帧、词或轮询，也不因打开界面发送额外探测。涉及 MOBILE-ARCH §1.1、§3.2、§13.1。

数据路径：既有 FrameConn 心跳发出 ping → 同连接返回 pong → 用本机单调时钟计算往返 → LinkSession.latency → HubLinkServer 当前连接 → service:link/list、describe、diagnose → 设备详情。

- 每连接只留一条在途 ping 和一个成功样本；只接受该连接最近一次已发 ping 的 at，重复、未请求或被新 ping 替代的 pong 不更新样本。
- at 仍是原协议的回显字段。既有心跳保证本连接 echo key 递增，即使墙上时钟回拨，也不会把旧 pong 配到新请求。
- rtt_ms 和 age_ms 均从 performance.now 的单调时间计算；Clock.now 只用于既有协议与定时，不用于测差。测试可注入单调时钟。
- 未有样本时 latency 为 null；断开清空在途和样本。读样本不发包。age_ms 表示这个样本有多旧，不能当成持续实时测量。
- list/describe 每个连接加 `latency: {rtt_ms, age_ms} | null`；diagnose 加按 hand 过滤的 connections，保留 conn、hand、channels、via。现有结果 schema 允许附加字段，无需修改公共词源码。
- 设备界面仅使用目标 hand 的 device/agent 连接样本，不拿同手的 human-only 通道或别台设备的数值代替。没有样本时明确等待连接心跳；不把界面到中枢的一次调用耗时冒充设备往返。

验证：新增五项可控回归覆盖墙上时钟回拨、单调测差与样本年龄、未知/重复/迟到 pong、断开清样本、连接隔离、真实 LinkSession 暴露，以及 list/diagnose 的多设备/多通道过滤；与已有 silence、protocol、link-control 一起 45 项通过。TypeScript 编译在总控串行验收时执行。未操作手机、未作实际网络性能基准。
