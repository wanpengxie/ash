package ai.ash.host

import ai.ash.host.a11y.A11yService
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capabilities
import ai.ash.host.shizuku.VScreenClient
import ai.ash.host.shizuku.ShizukuState
import ai.ash.ui.HomeActivity
import ai.ash.ui.VScreenPreview
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Build
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

/** Narrow authenticated host entrypoints for the peripheral decision service. */
class ScreenDecisionHost(private val ctx: Context) {
    private val state = ScreenDecisionState()
    private val main = Handler(Looper.getMainLooper())

    @Synchronized fun surface(b: JSONObject): JSONObject {
        state.beginTurn(b.optString("turn"))
        return JSONObject().put("home_visible", AppState.homeVisible).put("page_live", AppState.homePageLive)
            .put("visibility_epoch", AppState.visibilityEpoch.get())
            .put("virtual_available", Build.VERSION.SDK_INT >= 29 && ShizukuState.ready())
    }
    private fun epoch(): Long = state.epoch + AppState.screenEpoch.get() + AppState.visibilityEpoch.get()
    private fun foreground(): String = if (AppState.homeVisible) ctx.packageName else A11yService.instance?.foregroundPackage().orEmpty()

    fun snapshot(): JSONObject = synchronized(state) {
        JSONObject().put("foreground_package", foreground()).put("state_epoch", epoch())
            .put("virtual_generation", state.virtualGeneration).put("virtual_owner_turn", state.virtualOwner)
            .put("virtual_open", state.virtualOpen && VScreenClient.running())
    }

    /** Serialize virtual calls and cleanup so a newer display can never be closed by an old decision. */
    fun call(capability: String, args: JSONObject, turn: String): CapResult {
        if (capability.startsWith("screen.") || capability in setOf("apps.open", "settings.open", "intent.view", "input.key", "browser.show")) state.screenChanged()
        if (!capability.startsWith("vscreen.")) return Capabilities.call(ctx, capability, args)
        return synchronized(this) { virtualCall(capability, args, turn) }
    }

    private fun virtualCall(capability: String, args: JSONObject, turn: String): CapResult {
        val result = Capabilities.call(ctx, capability, args)
        if (capability.startsWith("vscreen.") && result.toJson().optBoolean("ok")) {
            when (capability) {
                "vscreen.create" -> state.virtualCreated(turn, result.toJson().optJSONObject("data")?.optBoolean("reused") ?: false)
                "vscreen.close" -> state.virtualClosed()
                "vscreen.status", "vscreen.see" -> Unit
                else -> state.virtualUsed(turn)
            }
        }
        return result
    }

    fun returnToAsh(b: JSONObject): JSONObject {
        val task = FutureTask<Boolean> {
            synchronized(state) {
                val id = b.optString("decision_id") + ":return"
                if (!state.mayReturn(id, b.optString("turn")) || AppState.homeVisible ||
                    epoch() != b.optLong("expected_state_epoch", -1) || foreground() != b.optString("expected_package") || foreground().isBlank()) false
                else {
                    ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    state.applied(id)
                    true
                }
            }
        }
        main.post(task)
        val acted = try { task.get(600, TimeUnit.MILLISECONDS) } catch (_: Throwable) { task.cancel(false); false }
        return JSONObject().put("acted", acted)
    }

    @Synchronized fun closeVirtual(b: JSONObject): JSONObject {
        val id = b.optString("decision_id") + ":close"
        if (!state.mayClose(id, b.optString("owner_turn"), b.optLong("expected_generation", -1))) return JSONObject().put("acted", false)
        // Claim before dispatch: an uncertain reply must not repeat destruction of a later display.
        state.applied(id)
        VScreenPreview.hide()
        val result = VScreenClient.call(ctx, "close", timeoutMs = 8000, start = false)
        VScreenClient.stop()
        state.virtualClosed()
        return JSONObject().put("acted", result.optBoolean("ok"))
    }
}
