package ai.ash.ui

import ai.ash.ui.HomeModel as M
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeModelTest {
    private fun ask(id: String, from: String, seq: Long = 5, expires: Long = Long.MAX_VALUE / 2, options: List<String> = listOf("once", "always", "deny"), valid: Boolean = true, kind: String? = null) =
        M.Ask(id, seq, from, "pending", "t", "d", null, null, expires, 0, options.map { M.Opt(it, it.uppercase()) }, kind, false, valid)

    @Test fun gateApprovalsComeFirstSoonestToExpireFirst() {
        val q = ask("q", "agent:a", seq = 1, options = listOf("x"))
        val late = ask("g2", M.GATE, seq = 3, expires = Long.MAX_VALUE / 2)
        val soon = ask("g1", M.GATE, seq = 4, expires = System.currentTimeMillis() + 60_000)
        val items = M.waitingItems(listOf(q, late, soon))
        assertEquals(listOf("g1", "g2", "q"), items.map { it.ask.id })
        assertEquals(listOf(true, true, false), items.map { it.approval })
    }

    @Test fun anApprovalWithAnOptionTheGateNeverOffersIsNotShown() {
        assertTrue(M.approvals(listOf(ask("a", M.GATE, options = listOf("once", "weird")))).isEmpty())
        assertTrue(M.approvals(listOf(ask("a", M.GATE, valid = false))).isEmpty())
        assertTrue(M.approvals(listOf(ask("a", M.GATE, expires = 1))).isEmpty())
        assertEquals(1, M.approvals(listOf(ask("a", M.GATE), ask("a", M.GATE))).size)
    }

    @Test fun memoryIsGroupedByItsSecondLevelHeading() {
        val groups = M.groupMemory("# 关于你\n- 她叫小林\n## 要紧的\n- 对花生过敏\n1. 别在 7:30 前打电话\n---\n## 空的\n")
        assertEquals(listOf("", "要紧的"), groups.map { it.title })
        assertEquals(listOf("她叫小林"), groups[0].items)
        assertEquals(2, groups[1].items.size)
        assertTrue(M.urgentGroup("要紧的"))
        assertEquals(3, M.memoryCount(groups))
    }

    @Test fun aMemoryLineBecomesAShortLabelByTheDesignersRules() {
        assertEquals("过敏", M.memoryChip("过敏：花生、海鲜"))
        assertEquals("起床时间 7:30", M.memoryChip("起床时间 7:30，不喜欢被打扰"))      // a colon between digits is not one
        assertEquals("喜欢喝咖啡", M.memoryChip("喜欢喝咖啡，尤其是早上"))
        assertEquals("数据库迁移不要放在周五下午做因为没人值班".take(11) + "…", M.memoryChip("数据库迁移不要放在周五下午做因为没人值班"))
        assertEquals("花生", M.memoryChip("：花生"))
    }

    @Test fun theHomePageShowsFiveLabelsUrgentFirstAndSaysHowManyAreLeft() {
        val groups = listOf(M.MemGroup("喜好", (1..6).map { "项$it" }), M.MemGroup("过敏", listOf("花生")))
        val shown = M.memoryChips(groups)
        assertEquals(4, shown.chips.size)
        assertEquals("花生" to true, shown.chips[0])
        assertEquals(3, shown.more)
        assertEquals(0, M.memoryChips(listOf(M.MemGroup("a", listOf("1", "2", "3", "4", "5")))).more)
    }

    @Test fun repeatsAreSaidInTheOwnersWords() {
        assertEquals("只一次", M.repeatText(null))
        assertEquals("每天", M.repeatText(86_400))
        assertEquals("每 2 周", M.repeatText(1_209_600))
        assertEquals("每小时", M.repeatText(3_600))
        assertEquals("每 90 分钟", M.repeatText(5_400))
    }

    @Test fun aRepeatingTimerFallsOnEachDayItReaches() {
        val timer = M.Timer("t", 1_000_000, 3_600, null, null, "x", false)
        assertEquals(listOf(1_000_000L, 4_600_000L), M.occurrences(timer, 0, 5_000_000))
        assertEquals(listOf(4_600_000L), M.occurrences(timer, 2_000_000, 5_000_000))
        assertEquals(listOf(7L), M.occurrences(M.Timer("o", 7, null, null, null, "", false), 0, 10))
    }

    @Test fun theClockListIsCheckedAndTheSystemsOwnPlansAreLeftOut() {
        fun list(vararg t: JSONObject) = JSONObject().put("timers", JSONArray(t.toList()))
        assertNull(M.normalizeClock(JSONObject()))
        assertNull(M.normalizeClock(list(JSONObject().put("id", "a").put("next", 5).put("every", 30))))   // under a minute
        assertNull(M.normalizeClock(list(JSONObject().put("id", "a").put("next", 5).put("label", "agent:x"))))   // a raw route
        val ok = M.normalizeClock(list(JSONObject().put("id", "a").put("next", 5).put("label", "喝水").put("created_by", "agent:x"), JSONObject().put("id", "b").put("next", 6).put("created_by", "service:pulse")))!!
        assertEquals(listOf("a"), M.userPlans(ok).map { it.id })
        assertTrue(M.isSystemPlan(M.Timer("c", 1, null, null, null, "pulse:wake:12", false)))
    }

    @Test fun quietHoursAndTheNameAreReadAsTheWebPageReadThem() {
        assertEquals(M.QUIET_DEFAULT, M.quietOf(JSONObject()))
        assertEquals("", M.quietOf(JSONObject().put(M.QUIET_KEY, "")))
        assertEquals("22:00-08:30", M.quietOf(JSONObject().put(M.QUIET_KEY, "22:00-08:30")))
        assertNull(M.quietOf(JSONObject().put(M.QUIET_KEY, "25:00-08:30")))
        assertEquals("小灰", M.nameFromIdentity("# 名片\n- 名字：小灰（初次见面时可以换成你喜欢的名字）\n- 称呼主人：你"))
        assertNull(M.nameFromIdentity("- 名字：a\n- Name: b"))
        assertEquals("叫你「阿杰」 · 温柔", M.identitySub("- 名字：小灰\n- 称呼主人：阿杰\n- 气质：温柔"))
    }

    @Test fun theQuoteDropsHeadingsAndListMarksAndIsCut() {
        assertEquals("她很温柔也很细心", M.quoteOf("# 她\n- 她很温柔\n- **也很细心**\n---"))
        assertEquals("a".repeat(90) + "…", M.quoteOf("a".repeat(100)))
    }

    @Test fun aTurnIsSaidByHowItEnded() {
        fun t(ended: Long?, outcome: String?) = M.Turn("x", "", false, 1_000, ended, outcome, null, null)
        assertEquals("running", M.outcomeText(t(null, null)).first)
        assertEquals("完成了 · 用时 5 秒", M.outcomeText(t(6_000, "completed")).second)
        assertEquals("error", M.outcomeText(t(2_000, "error")).first)
        assertEquals("ended", M.outcomeText(t(2_000, null)).first)
    }

    @Test fun activityIsSplitByDayFrontAndBack() {
        val base = M.startOfDay(1_700_000_000_000)
        val h = 3_600_000L
        val turns = listOf(M.Turn("a", "", false, base + 10 * h, null, null, null, null), M.Turn("b", "", true, base + 11 * h, null, null, null, null), M.Turn("c", "", false, base - 10 * h, null, null, null, null))
        val days = M.activityByDay(turns)
        assertEquals(2, days.size)
        assertEquals(listOf("a"), days[0].front.map { it.id })
        assertEquals(listOf("b"), days[0].back.map { it.id })
        assertEquals(listOf("c"), days[1].front.map { it.id })
    }

    @Test fun onlyHumanFacingStepsReachTheActivityPage() {
        val steps = M.stepsOf(listOf(JSONObject().put("label", "在看网页 · example.com"), JSONObject().put("label", "调用 service:gate"), JSONObject().put("label", "查了天气").put("tool", true), JSONObject().put("label", "x".repeat(200))))
        assertEquals(listOf("在看网页 · example.com", "查了天气"), steps.map { it.label })
    }

    @Test fun keysAreReportedByWhatTheProviderSays() {
        val bad = listOf(JSONObject().put("provider", "deepseek").put("configured", true).put("status", "rejected").put("reason", "401"), JSONObject().put("provider", "openrouter").put("configured", true).put("status", "low_balance"))
        assertEquals(2, M.keyProblems(bad).size)
        assertTrue(M.keyProblems(bad)[0].contains("401"))
        assertTrue(M.keyProblems(listOf(JSONObject().put("provider", "deepseek").put("configured", false).put("status", "rejected"))).isEmpty())
        assertEquals("已保存，已验证可用。", M.keyStateText(JSONObject().put("status", "ok")))
        assertEquals("DeepSeek", M.providerName("deepseek-chat"))
        assertEquals("OpenAI", M.providerName("gpt-4o"))
    }

    @Test fun herWorkFolderHidesWhatTheSystemKeeps() {
        assertTrue(M.isSystemEntry("soul.md", false))
        assertTrue(M.isSystemEntry("skills", true))
        assertTrue(M.isSystemEntry(".git", true))
        assertFalse(M.isSystemEntry("README.md", false))
        assertFalse(M.isSystemEntry("skills", false))
    }

    @Test fun moneyIsShownInYuanAndTimesInTheOwnersWords() {
        assertEquals("¥6.74", M.usdToCny(1.0))
        assertEquals("¥0.0067", M.usdToCny(0.001))
        assertEquals("—", M.usdToCny(null))
        assertEquals("3 秒", M.duration(3_000))
        assertEquals("2 分钟", M.duration(120_000))
        assertEquals("1.5 小时", M.duration(5_400_000))
        assertEquals("2 小时", M.duration(7_200_000))
        assertEquals("1.2 MB", M.sizeText(1_300_000))
        assertEquals("账户余额：无数据", M.balanceSentence(JSONObject()))
    }

    @Test fun theRelayAndItsSetupAreSaidInOneSentence() {
        assertTrue(M.relayText(null).startsWith("还没有设置中转站"))
        assertEquals("中转站已连接（https://r.example），账号 a@b.c。", M.relayText(JSONObject().put("configured", true).put("connected", true).put("url", "https://r.example").put("account_email", "a@b.c")))
    }

    @Test fun anEvidenceRecordReadsFromWhoAskedToWhetherItRan() {
        val rows = M.evidence(JSONObject().put("requester", "agent:p").put("member", M.GATE).put("word", "shell.run").put("effect", "execute").put("decision", "once").put("decided_by", "owner")
            .put("executed", JSONObject().put("ok", true)), 0, "小灰", "agent:p")
        assertEquals("小灰", rows.first { it.first == "谁要做" }.second)
        assertEquals("执行命令（执行命令）", rows.first { it.first == "要做什么" }.second)
        assertEquals("你", rows.first { it.first == "谁做的决定" }.second)
        assertEquals("做成了", rows.last().second)
    }

    @Test fun appsAreCountedForTheHandsCell() {
        assertEquals("还没有应用", M.appsSummary(emptyList()))
        val apps = listOf(JSONObject().put("granted", true).put("enabled", true), JSONObject().put("granted", true))
        assertEquals("2 个应用 · 1 个已启用", M.appsSummary(apps))
    }
}
