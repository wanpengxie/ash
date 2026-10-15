package ai.ash.human

import ai.ash.host.AppState
import ai.ash.host.BackgroundLaunch
import ai.ash.host.HandRuntime
import ai.ash.host.Present
import ai.ash.host.TaskStatus
import ai.ash.host.screen.ScreenBridge
import ai.ash.link.PresentOutcome
import ai.ash.ui.ChatCardPreview
import ai.ash.ui.HomeActivity
import ai.ash.ui.LeaseState
import ai.ash.ui.VScreenPreview
import ai.ash.widget.WidgetHost
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/** The phone's surfaces of the human channel (SPEC-03 §5.4), each one the handler it had before, now driven by `present`. */
internal object Surfaces {
    fun android(ctx: Context, chat: ChatBridge): HumanChannel {
        val app = ctx.applicationContext
        // What a present needs is running before it is shown: the hand's runtime (the island layer gets its context there).
        fun ready(handler: SurfaceHandler) = SurfaceHandler { op, body -> HandRuntime.start(app); handler.present(op, body) }
        return HumanChannel(linkedMapOf(
            // A card's picture is drawn off screen; a card that changed goes to the page as it is (the chat stays where it is);
            // every other op is the chat page's.
            "chat" to SurfaceHandler { op, body ->
                when (op) {
                    "card.preview" -> ChatCardPreview.present(app, body)
                    "card.patch" -> chat.deliver(op, body)
                    // An app (`person:owner/open {app}`): its own screen, not the chat's page.
                    "open" -> if (body.has("app")) ai.ash.sysapps.SystemApps.open(app, body.optString("app"), body.optString("arg").ifEmpty { null }) else chat.present(op, body)
                    else -> chat.present(op, body)
                }
            },
            "notification" to ready { op, body ->
                val id = body.optString("id")
                when (op) {
                    "show" -> Present.show(app, body)
                    "hide" -> if (Present.hide(app, id)) PresentOutcome(true) else PresentOutcome(false, null, "internal", "store_failed")
                    "alert" -> { Present.alert(app, id); PresentOutcome(true) }
                    else -> unknown("notification", op)
                }
            },
            "island" to ready { op, _ ->
                if (op == "query") PresentOutcome(true, JSONObject().put("showing", ScreenBridge.islandShown())) else unknown("island", op)
            },
            "widget" to ready { op, body ->
                when (op) {
                    "state" -> WidgetHost.accept(app, body)
                    "preview" -> WidgetHost.preview(app, body)
                    else -> unknown("widget", op)
                }
            },
            "status" to ready { op, body ->
                when (op) {
                    "frame" -> if (TaskStatus.accept(app, body)) PresentOutcome(true) else PresentOutcome(false, null, "bad_request", "invalid task frame")
                    // The virtual screen was made or closed: the live preview comes up or goes down.
                    "vscreen" -> { VScreenPreview.screenState(app, body.optBoolean("open")); PresentOutcome(true) }
                    // The owner's screen leases in force: the floating ball, the notice, the bar in the chat.
                    "lease" -> { LeaseState.accept(app, body); PresentOutcome(true) }
                    else -> unknown("status", op)
                }
            },
        ))
    }

    private fun unknown(surface: String, op: String) = PresentOutcome(false, null, "unavailable", "$surface has no op $op")
}

/** Brings Ash's chat page up from wherever it is (a `chat` present, or the notification and island taps). */
internal class HomeLauncher(private val ctx: Context) : ChatBridge.ChatUi {
    override fun bringToFront(): Boolean {
        if (AppState.homeVisible) return true
        // From the background the system drops the start unless Ash is exempt; then a notice the owner taps brings it up (and this is not yet "in front").
        return BackgroundLaunch.start(ctx, Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            "Ash 想让你看一下", "点这里回到 Ash") == BackgroundLaunch.Route.DIRECT
    }
}
