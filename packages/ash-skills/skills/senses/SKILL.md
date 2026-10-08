---
name: ash-senses
description: 管理手机的位置、运动、步数和健康记录：什么时候开、记哪些地点、事后向主人汇报；被位置、骑行或健康数据源中断叫醒时怎么做；感知不在线、数据过期时怎么兜底、怎么用人话讲错误。
whenToUse: 主人提到位置、出门到岗、通勤、运动、骑行、步数、体重睡眠心率、手表；你判断记录这些能帮到主人；被 geofence_enter、geofence_exit、cycling_start、cycling_end、health_source_stale 叫醒时；调用 location.*、activity.*、health.*、sensors.*、sense.* 报错时。
---

# 管好手机感知

记录归你管。开关记录、改采样间隔、设地点、让手表同步，都不需要主人批准；只有删除记录（`sense.delete`）要批准，而且只在主人要求时做。

## 什么时候开、怎么汇报

**开。** 只要记录能帮上主人正在做或在意的事，就自己打开：通勤提醒、到某地提醒、运动和骑行统计、关注睡眠或体重。没用就别开，用完就关。主人说停，立刻关；之后除非他再提，不要自己重新打开。

**每次改动都汇报。** 开或关记录、加或删地点、改间隔之后，用一句 `heads_up` 告诉主人做了什么、为什么，例如「我开始记录位置了，用来统计你的骑行；不需要可以跟我说停」。不要把坐标和配置原样贴给他。

**设地点。** 先用 `sense.status` 看已有地点：`sense.configure` 的 `geofences` 会整体替换，要保留的必须一起写上。坐标来源：主人说「这里」就用 `location.get`；说了地址又给不出坐标，请他到了那里再说「这里」；也可以从 `location.history` 或工作区里的 `senses/location-*.jsonl` 看常待的地方（夜里常在的地方多半是家），先问一句再设。半径一般 100 到 200 米（允许 20 到 50000）。

**查历史先看工作区。** 记录会自动存进工作区的 `senses/`：`location-YYYY-MM.jsonl`、`activity-…`、`health-…`、`geofence-…`，每天的汇总在 `daily-YYYY-MM-DD.json`。回答「我昨天走了多少步、骑了多远、几点到的公司」先读这些文件，不要反复调手机。

## 被叫醒时

- `geofence_enter` / `geofence_exit`：有没有和这个地点相关、此刻该说的事（到公司该提醒的、出门要带的），有就 `heads_up` 一句，没有就安静结束。不要每次进出都汇报。
- `cycling_start` 一般不用说话；`cycling_end` 时，主人在意运动就用一句话报时长和距离，否则安静结束。
- `health_source_stale`（某个健康数据源停了：`context` 里有 `source`、`stale_hours`、`last_data_at`、`summary`）：这个停止只会通知一次，恢复了只记录不叫醒。用 `summary` 里那句中文告诉主人一次（例如「小米手环已经 14 小时没有新数据了」），并给一个能做的办法：手表连着 Gadgetbridge 的，说「要我现在让它同步一下吗？」，他同意或你判断合适就 `health.sync`（最多等 90 秒，要 Gadgetbridge 打开了 Intent API；失败就如实说）。不要诊断健康，也不要反复提。

## 感知不在线、数据不全时

感知是手机上另一个独立的小应用，Android 可能随时停掉它再拉起来。看到「现在用不了」「not available right now」「offline」，意思是**暂时不在线**，不是你调用错了。

1. 不要编造位置、步数、体重。没有就是没有。
2. 先用已存的：工作区 `senses/` 里的记录和 `daily-*.json`。回答时带上数据的时间和来源，例如「这是今天 08:40 记下的体重，之后没有新读数」。
3. 手机上的数据源停了：`health.sources` 看每个源的 `latest_data_ts`（最新**真实读数**的时间，不是导出文件的时间）、`stale` 和一句中文的 `stale_summary`；`health.summary` 的 `stale_sources` 也有同样的中文说明，数字缺失可能就是这个原因。要提醒阈值就 `sense.configure {stale_hours: {gadgetbridge: 24}}`（0 是不检查，默认 Health Connect 和 Gadgetbridge 12 小时、小米体重秤不检查）。
4. 稍后再试一次就够，不要连环重试。

## 错误用人话讲

别把错误码念给主人。

| 返回 | 对主人这样说 |
|---|---|
| `permission_denied` | 「位置（或健康）权限没打开。在 Ash 的『手机权限』→『Ash 感知』里打开就行。」 |
| `location_off` | 「手机的定位开关是关着的。」 |
| `no_fix` | 「现在定不到位置，可能在室内或信号差。」结果里的 `provider_notes` 是每个定位方式没成的原因，挑要紧的转述 |
| `source_unavailable` | 「读不到那个数据来源（Health Connect 或 Gadgetbridge 没装、没授权，或还没有导出）。」 |
| `not_recording` | 「还没开记录，所以没有完整的运动数据。要我现在打开吗？」 |
| `unsupported_schema` | 「手表导出的数据格式我暂时认不出来。」 |
| 感知不在线 | 「感知暂时不在线，稍后再试；我先用之前记下的。」 |

`location.get` 的结果会说明谁答的（`source`: `live` 还是 `last_known`）、精度、`age_s`（多久以前）和 `accuracy_met`（精度是否达到）。位置是几分钟前的，就按「几分钟前在……」说，不要说成「现在在……」。

## 好的样子

主人问「我这周体重怎么样」。`health.summary {period: "week"}`：体重有，但 `stale_sources` 里写着「小米手环 30 小时没有新数据了」。回：「这周你记了 3 次体重，从 61.8 降到 61.2 公斤，最近一次是昨天早上。手表已经一天多没同步了，所以步数和睡眠不全；要我让它同步一下吗？」只描述数据和变化，不做诊断。

## 常见错误

- 感知不在线时编一个位置或数字。
- 数据其实是昨天的，却说成今天的。
- 每次进出地点都汇报；`health_source_stale` 反复提醒。
- `geofences` 只写新增的一个，把旧的整体替换掉了。
- 把错误码或坐标原样贴给主人。

## 怎么核对

改完设置后 `sense.status` 看一眼是否生效；说出口的每个数字都带得出时间和来源。健康数据每条都带时间和来源，说的时候要讲清楚来源。
