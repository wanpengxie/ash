package ai.ash.screen.switches

import ai.ash.bridge.KeepAliveSwitches
import ai.ash.bridge.KeepAliveSwitches.Kind
import ai.ash.bridge.KeepAliveSwitches.Outcome
import ai.ash.bridge.KeepAliveSwitches.State
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SwitchFlowTest {
    private val all = KeepAliveSwitches.targets.map { it.pkg }
    private val labels = KeepAliveSwitches.targets.map { it.label }

    private fun run(phone: FakePhone, packages: List<String> = all, totalMs: Long = 90_000) = SwitchFlow(phone, packages, totalMs = totalMs).run()

    @Test fun turnsOnWhatIsOffAndLeavesWhatIsOn() {
        val p = FakePhone(boot = mutableMapOf("Ash" to true), background = mutableMapOf("Ash" to false))
        val r = run(p)
        assertEquals(Outcome.DONE, r.outcome)
        assertEquals(State.WAS_ON, r.state("ai.ash.agent", Kind.BOOT))
        assertEquals(State.TURNED_ON, r.state("ai.ash.agent", Kind.BACKGROUND))
        for (t in KeepAliveSwitches.targets) assertTrue(t.label, r.verified(t.pkg))
        for (l in labels) { assertTrue(p.boot[l] == true); assertTrue(p.background[l] == true); assertTrue(p.behavior[l] == true) }
        assertTrue(p.returned)
        // The switch that was already on was never tapped.
        assertEquals(2, p.clickedLabels.count { it == "开机自启动" })
    }

    @Test fun onlyAshsOwnAppsAreOpenedAndNothingElseIsTouched() {
        val p = FakePhone()
        run(p)
        val allowed = setOf("应用", "自启动", "Ash", "Ash 感知", "Ash 屏幕助手", "开机自启动", "后台自启动", "耗电管理", "允许应用后台行为")
        assertEquals(emptySet<String>(), p.clickedLabels.toSet() - allowed)
    }

    @Test fun scrollsToRowsBelowTheFoldAndBackUp() {
        // 微信 is first, 屏幕助手 near the end: after the last app the list stays scrolled down, "Ash" is above.
        val p = FakePhone()
        val r = run(p, listOf("ai.ash.screen", "ai.ash.agent"))
        assertTrue(r.verified("ai.ash.screen")); assertTrue(r.verified("ai.ash.agent"))
    }

    @Test fun confirmationDialogIsAnswered() {
        val p = FakePhone(asksFirst = setOf("Ash 感知"))
        val r = run(p)
        assertEquals(State.TURNED_ON, r.state("ai.ash.senses", Kind.BACKGROUND))
        assertTrue(r.verified("ai.ash.senses"))
    }

    @Test fun aSwitchThatDoesNotTurnOnIsFailedNotTurnedOn() {
        val p = FakePhone(stuck = setOf("Ash"))
        val r = run(p)
        assertEquals(State.FAILED, r.state("ai.ash.agent", Kind.BACKGROUND))
        assertFalse(r.verified("ai.ash.agent"))
        assertTrue(r.verified("ai.ash.senses"))
    }

    @Test fun missingRowIsNotFoundAndTheRestGoesOn() {
        val p = FakePhone(apps = listOf("微信", "Ash", "Ash 屏幕助手"))
        val r = run(p)
        assertEquals(State.NOT_FOUND, r.state("ai.ash.senses", Kind.BOOT))
        assertEquals(State.NOT_FOUND, r.state("ai.ash.senses", Kind.BACKGROUND))
        assertTrue(r.verified("ai.ash.agent"))
    }

    @Test fun aPageWithoutTheBootSwitchStillCounts() {
        val p = FakePhone(noBootRow = setOf("Ash"))
        val r = run(p)
        assertEquals(State.NOT_FOUND, r.state("ai.ash.agent", Kind.BOOT))
        assertTrue(r.verified("ai.ash.agent"))
    }

    @Test fun anotherAppInFrontStopsItBeforeAnyTap() {
        val p = FakePhone(foreignAfter = 30)
        val r = run(p)
        assertEquals(Outcome.ABORTED, r.outcome)
        assertTrue(r.stoppedAt, r.stoppedAt.contains("com.tencent.mm"))
        // Its "后台自启动" row (clickable) was never tapped.
        assertTrue(r.items.size < 9)
        assertTrue(p.returned)
    }

    @Test fun theTotalTimeIsCapped() {
        val r = run(FakePhone(), totalMs = 3_000)
        assertEquals(Outcome.ABORTED, r.outcome)
        assertTrue(r.stoppedAt, r.stoppedAt.contains("总时限"))
    }

    @Test fun settingsThatNeverComesUpAbortsWhereItStopped() {
        val p = FakePhone()
        val dead = object : SwitchUi by p { override fun root(): UiNode? = null }
        val r = SwitchFlow(dead, all).run()
        assertEquals(Outcome.ABORTED, r.outcome)
        assertTrue(r.stoppedAt, r.stoppedAt.startsWith("设置 →「应用」"))
        assertTrue(r.items.isEmpty())
    }

    @Test fun packagesOutsideAshsOwnAreIgnored() {
        val p = FakePhone()
        val r = run(p, listOf("com.tencent.mm", "ai.ash.agent"))
        assertEquals(setOf("ai.ash.agent"), r.items.map { it.pkg }.toSet())
        assertFalse(p.clickedLabels.contains("微信"))
        assertEquals(0, run(FakePhone(), listOf("com.tencent.mm")).items.size)
    }

    @Test fun packageAllowList() {
        for (ok in listOf("com.android.settings", "com.oplus.battery", "com.coloros.safecenter", "com.oplus.athena")) assertTrue(ok, SwitchFlow.allowedPackage(ok))
        for (no in listOf("", "ai.ash.agent", "com.android.systemui", "com.android.settingsx", "com.coloros", "com.oplusx.a", "com.tencent.mm", "com.android.settings.evil.not"))
            assertFalse(no, SwitchFlow.allowedPackage(no))
    }

    @Test fun onlyColorOsIsSupported() {
        for (m in listOf("OPPO", "OnePlus", "realme")) assertTrue(m, SwitchFlow.supported(m))
        for (m in listOf("samsung", "Xiaomi", "")) assertFalse(m, SwitchFlow.supported(m))
    }

    @Test fun reportRoundTripsAndAggregates() {
        val r = run(FakePhone(stuck = setOf("Ash 感知")))
        val back = KeepAliveSwitches.Report.fromJson(JSONObject(r.toJson().toString()))
        assertEquals(r.outcome, back.outcome)
        assertEquals(r.items, back.items)
        assertTrue(back.verified("ai.ash.agent")); assertFalse(back.verified("ai.ash.senses"))
        assertTrue(back.summary(KeepAliveSwitches.targets).contains("Ash 感知：开机自启动（没打开成功）"))
        assertFalse(KeepAliveSwitches.Report(Outcome.ABORTED, "x", emptyList()).verified("ai.ash.agent"))
    }

    @Test fun theFlowIsNotInTheAgentsManifest() {
        assertTrue(ai.ash.screen.ScreenCapabilities.list.none { it.name == KeepAliveSwitches.CAPABILITY })
        assertTrue(ai.ash.screen.ScreenCapabilities.hidden.any { it.name == KeepAliveSwitches.CAPABILITY })
    }
}
