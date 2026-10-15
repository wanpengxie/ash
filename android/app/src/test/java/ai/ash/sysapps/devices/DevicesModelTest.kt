package ai.ash.sysapps.devices

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesModelTest {
    private val now = 1_800_000_000_000L
    private fun dev(id: String, name: String, kind: String = "computer", online: Boolean = true, extra: JSONObject.() -> Unit = {}) =
        JSONObject().put("device", "device:$id").put("name", name).put("kind", kind).put("online", online).apply(extra)
    private fun list(vararg d: JSONObject, release: String = "0.2.4") = JSONObject().put("devices", JSONArray(d.toList())).put("release", release)

    @Test fun theFirstScreenPutsTheRelayFirstThenRequestsThenThisPhoneOnlineOnesAndHidesRevoked() {
        val s = DevicesState()
        s.relayRead(s.begin(Refresh.RELAY), JSONObject().put("configured", true).put("connected", true).put("url", "https://59.110.9.8"))
        s.requestsRead(s.begin(Refresh.PAIRS), JSONObject().put("pairs", JSONArray().put(JSONObject().put("pair_id", "p1").put("state", "requested").put("name", "书房 Mac"))))
        s.devicesRead(s.begin(Refresh.DEVICES), list(
            dev("b", "Zed", online = false) { put("last_seen", now - 3 * 3600_000) },
            dev("a", "Alpha"),
            dev("p", "手机", kind = "phone") { put("via", "local") },
            dev("r", "旧电脑") { put("revoked_at", now - 1000) },
        ))
        val keys = s.rows(now).map { it.key }
        assertEquals(listOf("status", "pair/p1", "device:p", "device:a", "device:b", "revoked"), keys)
        assertEquals("中转站已连通 · 59.110.9.8", (s.rows(now)[0] as DevicesState.Row.Status).text)
        assertEquals("离线 · 3 小时前在线", (s.rows(now)[4] as DevicesState.Row.Item).presence)
        s.showRevoked = true
        assertEquals("device:r", s.rows(now).last().key)
        assertEquals("已撤销", (s.rows(now).last() as DevicesState.Row.Item).presence)
        assertEquals(s.rows(now).size, s.rows(now).map { it.key }.toSet().size)
    }

    @Test fun aFailedReadKeepsWhatWasShownAndAnOlderAnswerIsDropped() {
        val s = DevicesState()
        val first = s.begin(Refresh.DEVICES)
        s.devicesRead(first, list(dev("a", "Mac")))
        val second = s.begin(Refresh.DEVICES)
        s.devicesRead(second, null)
        assertEquals(listOf("device:a"), s.devices!!.map { it.id })
        assertTrue(s.rows(now).any { it is DevicesState.Row.Note && it.text.contains("上次") })
        val third = s.begin(Refresh.DEVICES)
        s.devicesRead(second, list())                     // late answer to an older read
        assertEquals(listOf("device:a"), s.devices!!.map { it.id })
        s.devicesRead(third, list(dev("b", "Linux")))
        assertEquals(listOf("device:b"), s.devices!!.map { it.id })
        assertNull(s.error)
    }

    @Test fun versionAndWhatItGivesAreSaidInTheOwnersWords() {
        val s = DevicesState()
        s.devicesRead(s.begin(Refresh.DEVICES), list(
            dev("a", "MBP") { put("version", "0.2.4").put("latest", true).put("capabilities", JSONArray(listOf("workspace.bash", "body.info", "x.codex.send", "x.ash.update", "browser.open", "x.mac.thing"))) },
            dev("b", "mini") { put("version", "0.2.3").put("latest", false) },
            dev("c", "box") { put("version", "0.2.3").put("latest", false).put("updating", "0.2.4") },
            dev("p", "手机", kind = "phone") { put("version", "0.4.49").put("capabilities", JSONArray(listOf("screen.read", "camera.capture", "config.switch.set"))) },
        ))
        val items = s.rows(now).filterIsInstance<DevicesState.Row.Item>().associateBy { it.device.id }
        assertEquals("0.2.4 · 最新", items["device:a"]!!.version)
        assertEquals("0.2.3 · 有新版本 0.2.4，连上时会自动升级", items["device:b"]!!.version)
        assertEquals("0.2.3 · 正在升级到 0.2.4", items["device:c"]!!.version)
        assertEquals("0.4.49", items["device:p"]!!.version)
        assertEquals(listOf("文件和命令", "Codex", "浏览器", "其他 1 项"), items["device:a"]!!.abilities)
        assertEquals(listOf("屏幕", "相机"), items["device:p"]!!.abilities)
    }

    @Test fun eventsSayWhatToReadAgainAndWhoMadeAChange() {
        fun msg(to: String, word: String, body: JSONObject = JSONObject()) = JSONObject().put("kind", "event").put("to", to).put("word", word).put("body", body).put("ts", now - 60_000)
        assertEquals(setOf(Refresh.DEVICES), Refresh.of(msg("service:devices", "device.changed")))
        assertEquals(setOf(Refresh.DEVICES), Refresh.of(msg("service:link", "disconnected")))
        assertEquals(setOf(Refresh.PAIRS, Refresh.DEVICES), Refresh.of(msg("service:devices", "pair.changed")))
        assertEquals(setOf(Refresh.RELAY), Refresh.of(msg("service:link", "gateway.changed")))
        assertEquals(emptySet<Refresh>(), Refresh.of(msg("agent:main", "say")))
        assertEquals(emptySet<Refresh>(), Refresh.of(JSONObject().put("kind", "request").put("to", "service:devices").put("word", "device.changed")))

        val s = DevicesState()
        s.heard(msg("service:devices", "device.changed", JSONObject().put("device", "device:a").put("change", "renamed").put("by", "agent:main")))
        assertEquals("1 分钟前，Ash改了名字", DevicesText.change(s.changes["device:a"]!!, "agent:main", now))
        s.heard(msg("service:devices", "device.changed", JSONObject().put("device", "device:a").put("change", "updating").put("by", "service:devices").put("version", "0.2.5")))
        assertEquals("1 分钟前，自动让它升级到 0.2.5", DevicesText.change(s.changes["device:a"]!!, "agent:main", now))
        assertEquals("你", DevicesText.who("person:owner", null))
    }

    @Test fun theRelayLineSaysWhatIsWrong() {
        assertEquals("还没有中转站：只有这台手机能用，电脑连不进来" to true, DevicesText.relay(Relay(false, false, null, null)))
        assertEquals("中转站连不上 · ash.example：连不上中转站" to true, DevicesText.relay(Relay(true, false, "https://ash.example", "连不上中转站")))
    }

    @Test fun pairingRunsOnOneScreenFromTheCommandToConnected() {
        val f = PairFlow()
        assertTrue(f.start())
        assertFalse("one at a time", f.start())
        f.issued(JSONObject().put("pair_id", "p1").put("command", "curl … | sh -s -- x y z").put("expires_at", now + 120_000), null, null)
        assertEquals("1:00", PairFlow.left((f.step as PairFlow.Step.Waiting).deadline, now + 60_000))
        f.changed(JSONObject().put("pair_id", "other").put("state", "requested"))
        assertTrue("another pairing is not this one", f.step is PairFlow.Step.Waiting)
        f.changed(JSONObject().put("pair_id", "p1").put("state", "requested"), "书房 Mac")
        assertEquals(PairFlow.Step.Asking("p1", "书房 Mac"), f.step)
        assertTrue(f.approve())
        assertEquals("没批准成功：the relay refused", f.approveAnswered(null, "conflict", "the relay refused"))
        assertTrue("back to asking, with the reason", f.step is PairFlow.Step.Asking)
        f.approve()
        f.approveAnswered(JSONObject().put("device", "device:mac"), null, null)
        assertEquals(PairFlow.Step.Approved("p1", "device:mac"), f.step)
        f.changed(JSONObject().put("pair_id", "p1").put("state", "connected").put("device", "device:mac"))
        assertEquals(PairFlow.Step.Connected("device:mac"), f.step)
    }

    @Test fun aPairingThatEndsSaysWhyAndWhatToDoNext() {
        val f = PairFlow()
        f.start(); f.issued(null, "unavailable", "the hub is not connected to the relay right now")
        val ended = f.step as PairFlow.Step.Ended
        assertTrue(ended.why.contains("中转站")); assertTrue(ended.next.contains("中转站"))
        assertTrue(f.start())
        f.issued(JSONObject().put("pair_id", "p2").put("command", "c").put("expires_at", now + 1000), null, null)
        assertTrue(f.expiredBy(now + 2000))
        f.changed(JSONObject().put("pair_id", "p2").put("state", "failed").put("reason", "the device could not prove the pairing secret"))
        assertTrue((f.step as PairFlow.Step.Ended).why.contains("安全校验"))
    }

    @Test fun anActionHoldsOnlyItselfAndAnUnknownAnswerIsNotAFailure() {
        val a = Action()
        assertTrue(a.start()); assertFalse(a.start())
        a.failed("result_unknown", "x")
        assertEquals(Action.Phase.UNKNOWN, a.phase)
        assertTrue(a.start())
        a.failed("conflict", "已撤销，先恢复")
        assertEquals(Action.Phase.FAILED to "已撤销，先恢复", a.phase to a.message)
    }
}
