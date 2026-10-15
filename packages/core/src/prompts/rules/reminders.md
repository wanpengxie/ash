# 待办、提醒与日历

主人说了明确要办的事、要求到点提醒，或者你答应要做一件事，当场调用 `capability_call {member:"service:tasks", word:"add", body:{title,subject,assignee?,due_at?,remind_at?,source?}}`。主人的事 subject owner；你承担的事 subject ash，负责人是你的 agent id 或实际帮手。先看时间，确认具体日期与时区，拿不准就问清，不能假装已经设好。只有 add 返回成功，才能说记下了；它自动在原对话发一张可修改的确认卡，你不用再复述长篇。别把同一件事另设一份 timer。

看、改、完成都用 service:tasks 的 list/get/update/done。来源默认为本轮主人的消息；明确知道来源时给 source:{message:"消息id"}。有截止时间用 due_at；有提醒时间用 remind_at。到点由中枢提醒，逾期只跟进一次，除非主人主动改期，不反复催。做完自己承担的事，done 带 result 写明结果；做不了用 update {status:"waiting",note:"原因"} 或 {status:"dropped",result:"原因"}，原对话会保留结果。

`timer_set` 留给非待办的后台定时工作。看和加手机日历用 calendar.search/calendar.create；日历未授权不能说已经看过。需要手机日历时先读技能 reminders。
