package ai.ash.host.cap

import ai.ash.host.shizuku.ShizukuState
import ai.ash.host.shizuku.VScreenClient
import ai.ash.host.system.Apps
import ai.ash.host.system.Clip
import ai.ash.ui.VScreenPreview
import android.content.Context
import android.os.Build
import org.json.JSONObject
import java.util.Locale

/**
 * A virtual screen the agent can use without touching the owner's screen: apps are launched onto a
 * separate (invisible) display, seen through screenshots and driven with injected input. Backed by the
 * privileged server ai.ash.vscreen.Main (see VScreenClient).
 */
object VScreenCapabilities {

    private fun ready(ctx: Context) = Build.VERSION.SDK_INT >= 29 && ShizukuState.ready()

    private const val NEEDS = "Requires Shizuku running with ash authorized (Android 10+)."

    private fun vcap(name: String, description: String, schema: JSONObject = schema(), body: (Context, JSONObject) -> CapResult) =
        Cap(name, "$description $NEEDS", schema, availableIf = ::ready, body = body)

    private fun fail(r: JSONObject) = CapResult.fail(r.optString("error", "virtual screen error"))

    /** Fails early with a clear message when no virtual screen exists (instead of starting a server for nothing). */
    private fun needScreen(ctx: Context): CapResult? {
        if (!VScreenClient.running()) return CapResult.fail("no virtual screen: call vscreen.create first")
        val st = VScreenClient.call(ctx, "status", timeoutMs = 5000, start = false)
        if (!st.optBoolean("ok")) return fail(st)
        if (st.optInt("displayId", -1) < 0) return CapResult.fail("no virtual screen: call vscreen.create first")
        return null
    }

    private fun simple(r: JSONObject, okText: String): CapResult =
        if (r.optBoolean("ok")) CapResult.text(okText) else fail(r)

    private val create = vcap(
        "vscreen.create",
        "Create (or reuse) the virtual screen: a separate phone-shaped display, invisible to the owner, on which apps " +
            "can be launched (vscreen.launch), seen (vscreen.see) and operated (vscreen.tap/swipe/key/type) without disturbing " +
            "what the owner is doing on the real screen. Only one virtual screen exists; calling again with another size or " +
            "orientation recreates it (apps on the old one are closed). Default 720x1280 portrait at 320 dpi, so screenshots are 1:1 " +
            "with tap coordinates. Close it with vscreen.close when done.",
        schema(
            "orientation" to prop("string", "portrait (9:16, default) or landscape (16:9).", enum = listOf("portrait", "landscape")),
            "short_edge" to prop("integer", "Short side in pixels, rounded to a multiple of 144 (288..1440, default 720). Larger means sharper but screenshots above 1280 px are downscaled."),
            "dpi" to prop("integer", "Density (default 320; lower shows more content, higher makes it bigger)."),
        ),
    ) { ctx, args ->
        val short = args.optInt("short_edge", 720).coerceIn(288, 1440)
        val long = short * 16 / 9
        val land = args.optString("orientation").lowercase(Locale.ROOT) == "landscape"
        val req = JSONObject().put("width", if (land) long else short).put("height", if (land) short else long)
        val dpi = args.optInt("dpi", 0)
        if (dpi > 0) req.put("dpi", dpi.coerceIn(120, 640))
        val r = VScreenClient.call(ctx, "create", req, 20_000)
        if (!r.optBoolean("ok")) return@vcap fail(r)
        // Let the owner watch: a live preview window (if ash may draw overlays; otherwise nothing).
        VScreenPreview.show(ctx)
        val d = JSONObject().put("displayId", r.optInt("displayId")).put("width", r.optInt("width"))
            .put("height", r.optInt("height")).put("dpi", r.optInt("dpi")).put("reused", r.optBoolean("reused"))
        CapResult.text(
            "Virtual screen ${if (r.optBoolean("reused")) "already exists" else "created"}: display ${r.optInt("displayId")}, " +
                "${r.optInt("width")}x${r.optInt("height")} px, ${r.optInt("dpi")} dpi. Next: vscreen.launch an app, then vscreen.see.", d,
        )
    }

    private val status = vcap(
        "vscreen.status",
        "Report whether the virtual screen exists, its display id, size and dpi, and whether it has rendered a frame.",
    ) { ctx, _ ->
        if (!VScreenClient.running()) {
            return@vcap CapResult.json(JSONObject().put("running", false).put("displayId", -1))
        }
        val r = VScreenClient.call(ctx, "status", timeoutMs = 5000, start = false)
        if (!r.optBoolean("ok")) return@vcap fail(r)
        r.remove("ok"); r.remove("id"); r.remove("build")
        CapResult.json(r)
    }

    private val launch = vcap(
        "vscreen.launch",
        "Launch an app onto the virtual screen for delegated work, NOT to deliver an opened app to the owner " +
            "(use apps.open for visible delivery). `app` is a package name " +
            "(e.g. com.android.settings) or an app label as shown in the launcher (e.g. \"Settings\"). If the app is already " +
            "open on the owner's screen Android may bring that existing window instead. Wait a moment, then vscreen.see.",
        schema("app" to prop("string", "Package name or launcher label of the app.", required = true)),
    ) { ctx, args ->
        needScreen(ctx)?.let { return@vcap it }
        val app = try { Apps.resolve(ctx, args.optString("app")) } catch (e: Exception) { return@vcap CapResult.fail(e.message ?: "unknown app") }
        val r = VScreenClient.call(ctx, "launch", JSONObject().put("component", app.component.flattenToShortString()).put("pkg", app.pkg), 20_000)
        if (!r.optBoolean("ok")) return@vcap fail(r)
        val warn = r.optString("warning").let { if (it.isEmpty()) "" else " ($it)" }
        CapResult.text("Launched ${app.label} (${app.pkg}) on the virtual screen$warn.", JSONObject().put("package", app.pkg).put("component", r.optString("component")))
    }

    private val see = vcap(
        "vscreen.see",
        "Screenshot of the virtual screen (JPEG, long side at most 1280 px). The caption gives the screen size and the " +
            "factor to convert image pixels into the screen coordinates used by vscreen.tap/swipe (1 with the default size).",
    ) { ctx, _ ->
        needScreen(ctx)?.let { return@vcap it }
        val r = VScreenClient.call(ctx, "see", JSONObject().put("maxSide", 1280).put("quality", 80), 15_000)
        if (!r.optBoolean("ok")) return@vcap fail(r)
        val sw = r.optInt("screenW"); val sh = r.optInt("screenH"); val iw = r.optInt("imageW"); val ih = r.optInt("imageH")
        val scale = if (iw > 0) sw.toDouble() / iw else 1.0
        val caption = if (sw == iw && sh == ih) {
            "Virtual screen (display ${r.optInt("displayId")}) ${sw}x${sh}; image pixels = tap coordinates."
        } else {
            "Virtual screen (display ${r.optInt("displayId")}) ${sw}x${sh}; image ${iw}x${ih}: multiply image coordinates by " +
                String.format(Locale.ROOT, "%.4f", scale) + " for vscreen.tap/swipe."
        }
        CapResult.image(r.optString("jpeg"), "image/jpeg", caption)
    }

    private val tap = vcap(
        "vscreen.tap",
        "Tap on the virtual screen at (x, y) in virtual-screen pixels (see vscreen.see for the scale).",
        schema(
            "x" to prop("number", "X in virtual-screen pixels.", required = true),
            "y" to prop("number", "Y in virtual-screen pixels.", required = true),
        ),
    ) { ctx, args ->
        if (!args.has("x") || !args.has("y")) return@vcap CapResult.fail("x and y are required")
        needScreen(ctx)?.let { return@vcap it }
        simple(VScreenClient.call(ctx, "tap", JSONObject().put("x", args.optDouble("x")).put("y", args.optDouble("y")), 10_000), "Tapped.")
    }

    private val swipe = vcap(
        "vscreen.swipe",
        "Swipe on the virtual screen from (x1, y1) to (x2, y2) in virtual-screen pixels, e.g. to scroll (drag upwards to scroll down).",
        schema(
            "x1" to prop("number", "Start X.", required = true),
            "y1" to prop("number", "Start Y.", required = true),
            "x2" to prop("number", "End X.", required = true),
            "y2" to prop("number", "End Y.", required = true),
            "duration_ms" to prop("integer", "Duration in ms (default 300; longer is slower, 1000+ acts like a drag)."),
        ),
    ) { ctx, args ->
        for (k in listOf("x1", "y1", "x2", "y2")) if (!args.has(k)) return@vcap CapResult.fail("$k is required")
        needScreen(ctx)?.let { return@vcap it }
        val dur = args.optInt("duration_ms", 300).coerceIn(10, 10_000)
        val req = JSONObject().put("x1", args.optDouble("x1")).put("y1", args.optDouble("y1"))
            .put("x2", args.optDouble("x2")).put("y2", args.optDouble("y2")).put("durationMs", dur)
        simple(VScreenClient.call(ctx, "swipe", req, dur + 10_000L), "Swiped.")
    }

    private val KEYS = mapOf(
        "back" to 4, "home" to 3, "enter" to 66, "menu" to 82, "app_switch" to 187, "tab" to 61, "escape" to 111,
        "delete" to 67, "forward_delete" to 112, "search" to 84, "space" to 62,
        "dpad_up" to 19, "dpad_down" to 20, "dpad_left" to 21, "dpad_right" to 22, "dpad_center" to 23,
        "page_up" to 92, "page_down" to 93, "move_home" to 122, "move_end" to 123, "paste" to 279,
    )

    private val key = vcap(
        "vscreen.key",
        "Send a key press to the virtual screen: a name (${KEYS.keys.joinToString(", ")}) or an Android keycode number.",
        schema(
            "key" to prop("string", "Key name, or a numeric KeyEvent keycode.", required = true),
            "long_press" to prop("boolean", "Long-press instead of a short press."),
        ),
    ) { ctx, args ->
        val k = args.optString("key").trim().lowercase(Locale.ROOT)
        val code = KEYS[k] ?: k.toIntOrNull() ?: return@vcap CapResult.fail("unknown key \"$k\"; use one of ${KEYS.keys.joinToString(", ")} or a keycode number")
        needScreen(ctx)?.let { return@vcap it }
        simple(VScreenClient.call(ctx, "key", JSONObject().put("keycode", code).put("longPress", args.optBoolean("long_press")), 10_000), "Key $k sent.")
    }

    private val type = vcap(
        "vscreen.type",
        "Type text into the focused field of the virtual screen (tap the field first). ASCII is typed as key input; " +
            "text with other characters (e.g. Chinese, emoji) is put on the clipboard and pasted, replacing the owner's clipboard content.",
        schema("text" to prop("string", "Text to type.", required = true)),
    ) { ctx, args ->
        val text = args.optString("text")
        if (text.isEmpty()) return@vcap CapResult.fail("text is required")
        needScreen(ctx)?.let { return@vcap it }
        val ascii = text.all { it in ' '..'~' }
        if (ascii) {
            return@vcap simple(VScreenClient.call(ctx, "text", JSONObject().put("text", text), 20_000), "Typed ${text.length} characters.")
        }
        try { Clip.set(ctx, text) } catch (e: Throwable) { return@vcap CapResult.fail("could not put the text on the clipboard: ${e.message}") }
        simple(VScreenClient.call(ctx, "key", JSONObject().put("keycode", 279), 10_000), "Pasted ${text.length} characters (through the clipboard).")
    }

    private val close = vcap(
        "vscreen.close",
        "Destroy the virtual screen (apps running on it are closed or moved) and stop its server. Call when the task is done.",
    ) { ctx, _ ->
        if (!VScreenClient.running()) return@vcap CapResult.text("No virtual screen was open.")
        VScreenPreview.hide()
        val r = VScreenClient.call(ctx, "close", timeoutMs = 8000, start = false)
        VScreenClient.stop()
        if (r.optBoolean("ok")) CapResult.text("Virtual screen closed.") else fail(r)
    }

    val list: List<Capability> = listOf(create, status, launch, see, tap, swipe, key, type, close)
}
