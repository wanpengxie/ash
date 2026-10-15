package ai.ash.sysapps.devices

import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.HumanPort
import ai.ash.ui.UiIo
import ai.ash.ui.design.AshUi
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Canvas
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowPopupMenu
import java.io.File
import android.app.Application
import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.time.Duration
import android.widget.ScrollView
import android.graphics.Rect

/** Real Activity/View binding with a controlled hub boundary. No live phone, link, app startup or network calls. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w360dp-h800dp-mdpi")
@LooperMode(LooperMode.Mode.PAUSED)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class DevicesActivityAcceptanceTest {
    class DeviceScreen : DevicesActivity() {
        data class Read(val to: String, val word: String, val body: JSONObject, val done: (JSONObject?, HumanPort.Failure?) -> Unit)
        val requests = ArrayList<Read>()
        override fun request(to: String, word: String, body: JSONObject, done: (JSONObject?, HumanPort.Failure?) -> Unit) {
            requests += Read(to, word, JSONObject(body.toString()), done)
        }
        fun deliver(arg: String) = onNewIntent(Intent(this, DeviceScreen::class.java).putExtra(EXTRA_ARG, arg))
        fun connect() = onConnectionChanged(true)
        fun event(word: String, body: JSONObject) = onLedger(JSONObject().put("kind", "event").put("to", "service:devices").put("word", word).put("body", body))
        fun take(word: String, to: String? = null): Read = requests.first { it.word == word && (to == null || it.to == to) }.also { requests.remove(it) }
        fun answer(word: String, body: JSONObject) { take(word).done(body, null) }
    }
    private fun screen(arg: String): DeviceScreen {
        val controller = Robolectric.buildActivity(DeviceScreen::class.java,
            Intent().putExtra(SystemAppActivity.EXTRA_ARG, arg)).create().visible()
        val screen = controller.get()
        // Exercise the production route handler and View tree without starting the real shared link subscription.
        DevicesActivity::class.java.getDeclaredField("active").apply { isAccessible = true }.setBoolean(screen, true)
        SystemAppActivity::class.java.getDeclaredField("connected").apply { isAccessible = true }.setBoolean(screen, true)
        screen.connect()
        flushDisk()
        return screen
    }
    private fun flushDisk() {
        val drained = CountDownLatch(1); UiIo.disk { drained.countDown() }
        assertTrue(drained.await(5, TimeUnit.SECONDS)); shadowOf(Looper.getMainLooper()).idle()
    }
    private fun device(id: String, name: String) = JSONObject().put("device", "device:$id").put("name", name)
        .put("kind", "computer").put("online", true).put("lend", true).put("body", false).put("local_agents", false)
        .put("tier", "ask").put("version", "0.2.4").put("latest", true).put("capabilities", JSONArray().put("screen.read"))
    private fun devices() = JSONObject().put("devices", JSONArray().put(device("a", "Alpha")).put(device("b", "Beta"))).put("release", "0.2.4")
    private fun views(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
    private fun View.visibleInTree(): Boolean = visibility == View.VISIBLE && ((parent as? View)?.visibleInTree() ?: true)
    private fun DeviceScreen.texts() = views(window.decorView).filterIsInstance<TextView>().filter { it.visibleInTree() }.map { it.text.toString() }
    private fun DeviceScreen.button(label: String): TextView {
        if (label == "保存名称") openSettings()
        return views(window.decorView).filterIsInstance<TextView>().first { it.text.toString() == label && it.visibleInTree() }
    }
    private fun DeviceScreen.openSettings() {
        views(window.decorView).filterIsInstance<TextView>().firstOrNull { it.text.toString() == "改名" && it.visibleInTree() }?.performClick()
    }
    private fun DeviceScreen.access(label: String): TextView {
        val toggle = views(window.decorView).filterIsInstance<TextView>().single { it.contentDescription == label }
        assertTrue("The permission must be visible before a real click", toggle.visibleInTree())
        return toggle
    }
    private fun DeviceScreen.chooseAccess(label: String, allow: Boolean): TextView {
        val control = access(label); control.performClick()
        val popup = ShadowPopupMenu.getLatestPopupMenu()
        assertNotNull(popup)
        assertTrue(popup.menu.performIdentifierAction(if (allow) 1 else 0, 0))
        return control
    }
    private fun DeviceScreen.layoutScreen() {
        val view = window.decorView
        val width = (360 * resources.displayMetrics.density).toInt(); val height = (800 * resources.displayMetrics.density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
    }
    private fun DeviceScreen.settleScreen() {
        layoutScreen()
        // RecyclerView inserts animate after its first layout. Advance the actual main-loop animation frames before drawing.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
        layoutScreen()
    }
    private fun DeviceScreen.scrollToText(fragment: String) {
        settleScreen()
        val target = views(window.decorView).filterIsInstance<TextView>().first { fragment in it.text.toString() && it.visibleInTree() }
        val scroll = views(window.decorView).filterIsInstance<ScrollView>().single()
        val rect = Rect(0, 0, target.width, target.height)
        scroll.offsetDescendantRectToMyCoords(target, rect)
        scroll.scrollTo(0, scroll.scrollY + rect.top)
    }
    private fun DeviceScreen.capture(name: String) {
        settleScreen()
        val view = window.decorView
        val width = view.width; val height = view.height
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888); view.draw(Canvas(bitmap))
        val dir = File("/data/atoll/tmp/devices-v6-native").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    private fun DeviceScreen.name(): EditText { openSettings(); return views(window.decorView).filterIsInstance<EditText>().single() }

    @Test fun aWarmOpenSwitchesFromDeviceAToBAndKeepsEachNamesDraft() {
        val activity = screen("d/device:a")
        activity.answer("list", devices())
        activity.name().requestFocus(); activity.name().setText("Alpha 的未发送草稿")
        activity.deliver("d/device:b")
        flushDisk()
        assertEquals("d/device:b", activity.intent.getStringExtra(SystemAppActivity.EXTRA_ARG))
        assertTrue(activity.texts().contains("Beta"))
        assertEquals("Beta", activity.name().text.toString())
        activity.name().setText("Beta 的未发送草稿")
        activity.deliver("d/device:a")
        flushDisk()
        assertEquals("Alpha 的未发送草稿", activity.name().text.toString())
        activity.scrollToText("Alpha 的未发送草稿")
        activity.capture("warm-open-draft")
    }

    @Test fun aWarmOpenOfAPairRequestTargetsThatRequestInsteadOfTheOldDevice() {
        val activity = screen("d/device:a")
        activity.answer("list", devices())
        activity.deliver("p/pair-b")
        assertTrue(activity.requests.any { it.word == "pair_status" && it.body.optString("pair_id") == "pair-b" })
        activity.answer("pair_status", JSONObject().put("pair_id", "pair-b").put("state", "requested").put("name", "书房电脑"))
        assertTrue(activity.texts().any { it.contains("书房电脑 想连上来") })
    }


    @Test fun anOldRenameReceiptCannotClearANewerDraftAfterLeavingAndReturning() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        activity.name().setText("已提交的旧名称"); activity.button("保存名称").performClick()
        val oldRename = activity.take("rename")
        assertEquals("device:a", oldRename.body.optString("device"))
        activity.deliver("d/device:b"); flushDisk()
        activity.name().setText("Beta 草稿")
        activity.deliver("d/device:a"); flushDisk()
        activity.name().setText("Alpha 后来的新草稿")
        oldRename.done(JSONObject().put("device", "device:a").put("name", "已提交的旧名称"), null)
        assertEquals("Alpha 后来的新草稿", activity.name().text.toString())
        activity.deliver("d/device:b"); flushDisk(); activity.deliver("d/device:a"); flushDisk()
        assertEquals("Alpha 后来的新草稿", activity.name().text.toString())
    }

    @Test fun accessUsesTheConfirmedResponseAndALateOldReadCannotFlipItBack() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        activity.connect(); val oldList = activity.take("list", "service:devices")
        val toggle = activity.chooseAccess("文件和命令", true)
        val change = activity.take("access_set")
        assertEquals("device:a", change.body.optString("device")); assertTrue(change.body.getBoolean("body"))
        assertFalse(toggle.isEnabled)
        change.done(device("a", "Alpha").put("body", true), null)
        assertTrue(toggle.isSelected); assertTrue(toggle.isEnabled)
        oldList.done(devices(), null)
        assertTrue(toggle.isSelected)
        activity.capture("confirmed-access")
    }

    @Test fun diagnosisShowsAConclusionKeepsRawFindingsFoldedAndNeverInventsLatency() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        activity.answer("gateway.status", JSONObject().put("configured", true).put("connected", true).put("url", "https://relay.example"))
        activity.button("检查连接").performClick()
        val diagnose = activity.take("diagnose"); assertEquals("a", diagnose.body.optString("hand"))
        val raw = "Alpha is online at the relay and may be reached but has no tunnel."
        diagnose.done(JSONObject().put("ok", false).put("findings", JSONArray().put(JSONObject().put("code", "tunnel.missing").put("message", raw))), null)
        activity.take("list", "service:link").done(JSONObject().put("connections", JSONArray()), null)
        assertTrue(activity.texts().any { it.contains("设备已到达中转站，但还没有接通 Ash") })
        assertEquals(1, activity.texts().count { it.contains("设备已到达中转站，但还没有接通 Ash") })
        assertTrue(activity.texts().any { it.startsWith("连接需检查\n") && it.contains("连接状态待核实") })
        assertFalse(activity.texts().any { it.contains("连接已就绪") || it.contains("Ash 现在可以") })
        assertTrue(activity.texts().any { it.contains("Alpha") && it.contains("重启 Ash 并检查网络") })
        assertTrue(activity.texts().any { it.contains("延迟：尚无可用测量") })
        assertFalse(activity.texts().contains(raw))
        activity.button("查看诊断原文").performClick(); assertTrue(activity.texts().contains(raw))
        activity.button("收起诊断原文").performClick(); activity.scrollToText("设备已到达中转站"); activity.capture("diagnosis-conclusion")
        // A list read begun before the diagnosis cannot erase the newer failure merely because it says online.
        activity.take("list", "service:devices").done(devices(), null)
        assertTrue(activity.texts().any { it.startsWith("连接需检查\n") && it.contains("连接状态待核实") })
        assertFalse(activity.texts().any { it.contains("连接已就绪") || it.contains("Ash 现在可以") })
        // A later successful reread reconciles the page; the failure never mutates the stored device fact.
        activity.connect(); activity.take("list", "service:devices").done(devices(), null)
        assertFalse(activity.texts().any { it.contains("连接需检查") })
        assertTrue(activity.texts().any { it.contains("连接已就绪") })
        assertTrue(activity.texts().any { it.contains("Ash 现在可以：看屏幕") })
    }

    @Test fun revocationRequiresConfirmationDismissesOnNewTargetAndShowsTheRestorableState() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        activity.button("撤销访问").performClick()
        val staleDialog = ShadowAlertDialog.getLatestAlertDialog(); assertTrue(staleDialog.isShowing)
        assertFalse(activity.requests.any { it.word == "revoke" })
        activity.deliver("d/device:b"); flushDisk(); assertFalse(staleDialog.isShowing)
        assertFalse(activity.requests.any { it.word == "revoke" })
        activity.button("撤销访问").performClick()
        ShadowAlertDialog.getLatestAlertDialog().getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        val revoke = activity.take("revoke"); assertEquals("device:b", revoke.body.optString("device"))
        revoke.done(JSONObject().put("revoked", true), null)
        assertFalse(activity.button("保存名称").isEnabled); assertFalse(activity.access("文件和命令").isEnabled)
        assertTrue(activity.texts().any { it.contains("已撤销") })
        activity.button("恢复访问").performClick()
        val restore = activity.take("restore"); assertEquals("device:b", restore.body.optString("device"))
        restore.done(JSONObject().put("restored", true), null)
        assertTrue(activity.button("保存名称").isEnabled)
        assertTrue(activity.texts().any { it.contains("已恢复。请在设备上打开 Ash") })
    }

    @Test fun pairingStaysOnOneScreenFromCommandThroughApprovalToTheConnectedDevice() {
        val activity = screen("connect"); activity.answer("list", devices())
        activity.button("生成安装命令").performClick()
        activity.answer("pair_start", JSONObject().put("pair_id", "pair-a").put("command", "TEST-ONE-TIME-COMMAND").put("expires_at", System.currentTimeMillis() + 60_000))
        activity.answer("pair_status", JSONObject().put("pair_id", "pair-a").put("state", "waiting"))
        assertTrue(activity.texts().contains("TEST-ONE-TIME-COMMAND"))
        assertTrue(activity.texts().any { it.contains("终端粘贴并运行") })
        activity.capture("pairing-install-command")
        activity.event("pair.changed", JSONObject().put("pair_id", "pair-a").put("state", "requested"))
        activity.answer("pair_status", JSONObject().put("pair_id", "pair-a").put("state", "requested").put("name", "书房电脑"))
        assertTrue(activity.texts().any { it.contains("书房电脑 想连上来") })
        assertTrue(activity.texts().contains("帮手与审批边界")); assertFalse(activity.texts().contains("完全放开审批"))
        activity.capture("pairing-confirm-abilities")
        activity.chooseAccess("文件和命令", true); activity.button("允许接入").performClick()
        val approve = activity.take("pair_approve"); assertEquals("pair-a", approve.body.optString("pair_id")); assertTrue(approve.body.getBoolean("body"))
        assertFalse(activity.button("允许接入").isEnabled)
        approve.done(JSONObject().put("pair_id", "pair-a").put("state", "approved").put("device", "device:a"), null)
        activity.answer("pair_status", JSONObject().put("pair_id", "pair-a").put("state", "approved").put("device", "device:a"))
        assertTrue(activity.texts().contains("已批准，正在等设备连上…"))
        activity.event("pair.changed", JSONObject().put("pair_id", "pair-a").put("state", "connected"))
        activity.answer("pair_status", JSONObject().put("pair_id", "pair-a").put("state", "connected").put("device", "device:a"))
        assertTrue(activity.texts().contains("已接好，可在设备详情中查看它的能力。"))
        activity.capture("pairing-connected")
        activity.button("查看设备").performClick(); flushDisk()
        assertTrue(activity.texts().contains("Alpha")); assertTrue(activity.texts().any { it.contains("屏幕") })
    }

    @Test fun oldPairStatusAndDecisionCallbacksCannotReplaceTheNewPairRequest() {
        val activity = screen("p/old-pair")
        val old = activity.take("pair_status")
        activity.deliver("p/new-pair")
        val fresh = activity.take("pair_status"); assertEquals("new-pair", fresh.body.optString("pair_id"))
        fresh.done(JSONObject().put("pair_id", "new-pair").put("state", "requested").put("name", "新电脑"), null)
        old.done(JSONObject().put("pair_id", "old-pair").put("state", "connected").put("device", "device:a"), null)
        assertTrue(activity.texts().any { it.contains("新电脑 想连上来") })
        activity.button("允许接入").performClick(); assertEquals("new-pair", activity.take("pair_approve").body.optString("pair_id"))
    }

    @Test fun theHomeScreenExplainsWhatAshCanDoAndLeadsAnOfflineDeviceToRecovery() {
        val activity = screen("")
        activity.answer("gateway.status", JSONObject().put("configured", true).put("connected", true).put("url", "https://relay.example"))
        activity.answer("pair_pending", JSONObject().put("pairs", JSONArray()))
        val data = devices().put("release", "0.2.5"); data.getJSONArray("devices").getJSONObject(0).put("version", "0.2.5"); data.getJSONArray("devices").getJSONObject(1).put("online", false).put("lend", false).put("latest", false)
        activity.answer("list", data); activity.capture("devices-home")
        assertTrue(activity.texts().contains("接入新设备"))
        assertTrue(activity.texts().any { it.contains("中转站已连通") }); assertFalse(activity.texts().any { it.contains("正在读取中转站") })
        assertTrue(activity.texts().contains("屏幕"))
        val list = views(activity.window.decorView).filterIsInstance<androidx.recyclerview.widget.RecyclerView>().single()
        (list.layoutManager as androidx.recyclerview.widget.LinearLayoutManager).scrollToPositionWithOffset(3, 0)
        activity.capture("devices-offline-row")
        views(activity.window.decorView).single { it.contentDescription == "查看设备：Beta" }.performClick(); flushDisk()
        assertTrue(activity.texts().contains("Beta"))
        assertTrue(activity.texts().any { it.contains("Beta") && it.contains("这台电脑上启动 Ash") })
        assertTrue(activity.texts().contains("检查连接"))
        assertFalse(activity.texts().any { it.contains("到详情") })
        assertFalse(activity.texts().contains("保存名称"))
        assertFalse(activity.texts().contains("完全放开审批"))
        assertFalse(activity.texts().any { it.contains("Ash 现在可以") })
        activity.capture("offline-recovery")
        activity.button("检查连接").performClick()
        val diagnosis = activity.take("diagnose"); assertEquals("b", diagnosis.body.optString("hand"))
        diagnosis.done(JSONObject().put("ok", false).put("findings", JSONArray().put(JSONObject().put("code", "hand.offline"))), null)
        activity.take("list", "service:link").done(JSONObject().put("connections", JSONArray()), null)
        assertTrue(activity.texts().any { it.contains("设备当前离线") })
    }

    @Test fun settingsAndAdvancedPermissionsRequireVisibleUserChoices() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        assertTrue(activity.texts().contains("检查连接")); assertFalse(activity.texts().contains("保存名称"))
        assertTrue(activity.texts().contains("文件和命令"))
        activity.button("改名").performClick()
        assertTrue(activity.texts().contains("保存名称"))
        assertFalse(activity.texts().contains("运行本地帮手")); assertFalse(activity.texts().contains("完全放开审批"))
        assertFalse(activity.requests.any { it.word == "access_set" })
        activity.button("帮手与审批边界").performClick()
        assertTrue(activity.texts().contains("完全放开审批"))
        activity.chooseAccess("运行本地帮手", true)
        val request = activity.take("access_set")
        assertEquals("device:a", request.body.optString("device")); assertTrue(request.body.getBoolean("local_agents"))
        request.done(device("a", "Alpha").put("local_agents", true), null)
        activity.button("收起高级选项").performClick()
        assertTrue(activity.texts().any { it.contains("可运行本地帮手") })
        assertFalse(activity.texts().contains("完全放开审批"))
    }

    @Test fun diagnosticLatencyUsesOnlyThisDevicesExecutorConnectionAndKeepsUnknownExplicit() {
        val activity = screen("d/device:a"); activity.answer("list", devices())
        activity.answer("gateway.status", JSONObject().put("configured", true).put("connected", true).put("url", "https://relay.example"))
        fun connection(hand: String, channel: String, rtt: Double?): JSONObject = JSONObject().put("hand", hand).put("channels", JSONArray().put(channel))
            .put("latency", if (rtt == null) JSONObject.NULL else JSONObject().put("rtt_ms", rtt).put("age_ms", 12_000))
        fun diagnose(connections: JSONArray) {
            activity.button("检查连接").performClick()
            activity.take("diagnose").done(JSONObject().put("ok", true).put("findings", JSONArray()), null)
            activity.take("list", "service:link").done(JSONObject().put("connections", connections), null)
        }
        diagnose(JSONArray().put(connection("b", "device", 2.0)).put(connection("a", "human", 7.0)).put(connection("a", "device", null)))
        assertTrue(activity.texts().any { it.contains("延迟：尚无可用测量") })
        diagnose(JSONArray().put(connection("b", "device", 2.0)).put(connection("a", "human", 7.0)).put(connection("a", "device", 42.0)))
        assertTrue(activity.texts().any { it.contains("延迟：42") && it.contains("12 秒前的心跳样本") })
        assertFalse(activity.texts().any { it.contains("延迟：2.0") || it.contains("延迟：7.0") })
        activity.scrollToText("延迟：42"); activity.capture("measured-device-latency")
        activity.connect()
        val offline = devices(); offline.getJSONArray("devices").getJSONObject(0).put("online", false)
        activity.take("list", "service:devices").done(offline, null)
        assertFalse(activity.texts().any { it.contains("延迟：42") })
    }

    private fun sceneDevices() = JSONObject().put("release", "0.4.0").put("devices", JSONArray()
        .put(device("work", "开发电脑").put("version", "0.4.0").put("body", true).put("capabilities", JSONArray().put("workspace.bash").put("x.codex.send")))
        .put(device("home", "家用服务器").put("kind", "server").put("online", false).put("last_seen", System.currentTimeMillis() - 8 * 60_000)
            .put("version", "0.3.9").put("latest", false).put("lend", false).put("body", true).put("capabilities", JSONArray().put("workspace.bash")))
        .put(device("phone", "我的手机").put("kind", "phone").put("version", "0.4.8").put("capabilities", JSONArray().put("screen.read").put("calendar.list"))))
    private fun DeviceScreen.relayReady() = answer("gateway.status", JSONObject().put("configured", true).put("connected", true).put("url", "https://relay.example"))

    @Test fun theNativeHomeShowsTheSameRequestScopeAndApprovalStillWaitsForTheDevice() {
        val activity = screen(""); activity.relayReady(); activity.answer("list", sceneDevices())
        activity.answer("pair_pending", JSONObject().put("pairs", JSONArray().put(JSONObject().put("pair_id", "pair-travel").put("state", "requested").put("name", "随身电脑").put("kind", "computer"))))
        val status = activity.take("pair_status"); assertEquals("pair-travel", status.body.getString("pair_id"))
        status.done(JSONObject().put("pair_id", "pair-travel").put("state", "requested").put("name", "随身电脑"), null)
        activity.capture("devices-v6-home")
        assertTrue(activity.texts().contains("允许这台电脑接入？")); assertTrue(activity.texts().contains("随身电脑"))
        assertTrue(activity.texts().any { it.contains("文件命令：关闭") })
        assertEquals(View.GONE, views(activity.window.decorView).single { it.contentDescription == "返回" }.visibility)
        assertTrue(views(activity.window.decorView).single { it.contentDescription == "现在" }.isSelected)
        activity.button("调整接入权限").performClick()
        activity.chooseAccess("文件和命令", true)
        activity.button("帮手与审批边界").performClick()
        activity.chooseAccess("运行本地帮手", true); activity.chooseAccess("完全放开审批", true)
        activity.button("收起高级选项").performClick()
        activity.button("调整接入权限").performClick()
        assertTrue(activity.texts().any { it.contains("文件命令：允许") })
        activity.button("允许接入").performClick()
        val approve = activity.take("pair_approve")
        assertEquals("pair-travel", approve.body.getString("pair_id")); assertTrue(approve.body.getBoolean("body"))
        assertTrue(approve.body.getBoolean("local_agents")); assertEquals("full", approve.body.getString("tier"))
        approve.done(JSONObject().put("pair_id", "pair-travel").put("state", "approved").put("device", "device:new"), null)
        assertTrue(activity.texts().contains("已批准，正在等设备连上…"))
        assertFalse(activity.texts().any { it.contains("已接好") })
        activity.capture("devices-v6-approved-waiting")
    }

    @Test fun theQuietGridAndDetailReturnToTheOriginalPermissionSpace() {
        val activity = screen(""); activity.relayReady(); activity.answer("list", sceneDevices())
        activity.answer("pair_pending", JSONObject().put("pairs", JSONArray()))
        activity.capture("devices-v6-quiet")
        assertTrue(activity.texts().contains("本页当前没有需要你的决定"))
        assertFalse(activity.texts().contains("允许这台电脑接入？"))
        val list = views(activity.window.decorView).filterIsInstance<androidx.recyclerview.widget.RecyclerView>().single()
        assertTrue(list.layoutManager is androidx.recyclerview.widget.GridLayoutManager)
        views(activity.window.decorView).single { it.contentDescription == "权限" }.performClick()
        activity.settleScreen()
        val manager = list.layoutManager as androidx.recyclerview.widget.GridLayoutManager
        val position = manager.findFirstVisibleItemPosition()
        val beforeOffset = manager.findViewByPosition(position)?.top
        views(activity.window.decorView).single { it.contentDescription == "查看设备：家用服务器" }.performClick(); flushDisk()
        assertTrue(activity.texts().contains("家用服务器"))
        assertTrue(activity.texts().contains("允许她做什么"))
        assertFalse(activity.texts().contains("保存名称")); assertFalse(activity.texts().contains("完全放开审批"))
        activity.capture("devices-v6-detail")
        views(activity.window.decorView).single { it.contentDescription == "返回" }.performClick()
        activity.settleScreen()
        assertTrue(views(activity.window.decorView).single { it.contentDescription == "权限" }.isSelected)
        assertEquals(position, manager.findFirstVisibleItemPosition())
        assertEquals(beforeOffset, manager.findViewByPosition(position)?.top)
    }

    @Test fun aPhoneDoesNotExposeComputerBodyAndRestoringAccessDoesNotClaimOnline() {
        val activity = screen("d/device:phone"); activity.answer("list", sceneDevices())
        assertTrue(activity.texts().contains("我的手机"))
        assertFalse(views(activity.window.decorView).any { it.contentDescription == "文件和命令" && it.visibleInTree() })
        assertFalse(activity.texts().any { it.contains("Codex") || it.contains("相册影响") })
        activity.deliver("d/device:home"); flushDisk()
        activity.button("撤销访问").performClick()
        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertTrue(dialog.findViewById<TextView>(android.R.id.message).text.toString().contains("不保证停止"))
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick(); shadowOf(Looper.getMainLooper()).idle()
        val revoke = activity.take("revoke"); assertEquals("device:home", revoke.body.getString("device"))
        revoke.done(JSONObject().put("revoked", true), null)
        activity.button("恢复访问").performClick()
        val restore = activity.take("restore"); assertEquals("device:home", restore.body.getString("device"))
        restore.done(JSONObject().put("restored", true), null)
        assertTrue(activity.texts().any { it.contains("离线") }); assertFalse(activity.texts().contains("在线"))
        assertFalse(activity.texts().any { it.contains("已接好") })
    }

}
