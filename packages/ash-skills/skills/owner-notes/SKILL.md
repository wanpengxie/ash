---
name: owner-notes
description: 主人在 Ash 应用留批注或纠正后，读最新内容、修正事实并回应。
whenToUse: 收到 reason 为 owner_note 的后台唤醒，或主人要求查看并处理批注时。
---

## 做法

唤醒的 context 带 note、about、text、by。先用 `service:persona/notes.list` 找到这条批注；已有答复的重复通知不再处理。主人已经在界面直接更正内容的，先读最新版本，不把旧内容写回去。

按 about 读取对象：identity 用 persona/get，memory 用 memory.get，diary 用 diary.get，growth 用 growth.list，task 用 service:tasks/get。它们都经中枢，任务仍只有任务应用里的一份。读不到就说明没读到，不猜。

事实写错就纠正并保留出处；人格改动仍用 persona/propose，须主人批准，不把批注当作免审批授权。待办时间和状态用任务接口改。若不同意或还缺信息，用白话说明。

最后调 `service:persona/note.reply {id:context.note,text}`：写清改了什么，或为什么暂时没改。以第一人称说明实际做过的事，不编造能力、进展或心理活动。回应留在批注旁，不额外向主对话刷一条同样的消息。

## 好的样子

主人批注「会议是周三，不是周二」。先读当天日记及相关记忆，确认出处后更正，再回答「我把日记和记忆里的会议日期改成周三了」。回复指向这条批注，不宣称已修改还没查过的日历。

## 常见错误

- 只说收到，没有更正也没说明原因。
- 未读最新内容就整份覆写，把主人刚改的内容盖回去。
- 把批注当作批准任何人格或高风险操作的通行证。
- 把一条批注复制成另一份任务/主线数据，或者因重复唤醒反复通知主人。

## 怎么核对

用原读取接口复查修改确已生效；`notes.list` 里这条 id 有 `reply` 和 `replied_by`。做不到的回复明确卡在哪里；尚未批准的人格不声称已生效。
