package ai.ash.screen

import ai.ash.bridge.KeepAliveSwitches
import ai.ash.host.cap.Cap
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.host.cap.prop
import ai.ash.host.cap.schema
import ai.ash.screen.a11y.A11yService
import ai.ash.screen.switches.AccessibilityUi
import ai.ash.screen.switches.SwitchFlow
import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale

/**
 * Seeing and operating the phone's screen through ash's accessibility service ([A11yService]).
 * Listed only while the user has turned the service on (Settings → Accessibility → Ash).
 *
 * Coordinates everywhere: x/y are physical screen pixels in the current rotation (what screen.read
 * reports); fx/fy are fractions 0..1 of the screen width/height and win when both are given —
 * prefer them when working from a screenshot, whose image is scaled.
 */
object ScreenCapabilities {

    private const val MAX_IMAGE_SIDE = 1280
    private const val MAX_IMAGE_BYTES = 900_000

    private fun svc(): A11yService = A11yService.instance
        ?: throw IllegalStateException("the accessibility service is off (Settings → Accessibility → Ash)")

    private val connected: (Context) -> Boolean = { A11yService.instance != null }
    private val canShoot: (Context) -> Boolean = { A11yService.instance != null && A11yService.canScreenshot }

    // ---------------------------------------------------------------- schema helpers

    private fun num(d: String) = prop("number", d)
    private fun int(d: String, required: Boolean = false) = prop("integer", d, required)
    private fun point(prefix: String = "", what: String = "point"): Array<Pair<String, JSONObject>> = arrayOf(
        "fx$prefix" to num("$what x as a fraction 0..1 of screen width (preferred)"),
        "fy$prefix" to num("$what y as a fraction 0..1 of screen height (preferred)"),
        "x$prefix" to num("$what x in screen pixels"),
        "y$prefix" to num("$what y in screen pixels"),
    )

    private fun heldText(r: JSONObject): String {
        val held = r.optJSONArray("held") ?: JSONArray()
        if (held.length() == 0) return "No finger is held."
        val parts = (0 until held.length()).map { i ->
            val h = held.getJSONObject(i)
            val s = String.format(Locale.US, "finger %d at (%d,%d) = (fx %.3f, fy %.3f)", h.optInt("finger"), h.optInt("x"), h.optInt("y"), h.optDouble("fx"), h.optDouble("fy"))
            if (h.has("elapsedMs")) "$s, held ${h.optLong("elapsedMs")} ms" else s
        }
        return "Held: " + parts.joinToString("; ") + "."
    }

    private fun gestureResult(r: JSONObject, what: String): CapResult =
        if (!r.optBoolean("ok")) CapResult.fail(r.optString("error", "$what failed"))
        else CapResult.text("$what done (${r.optLong("durationMs")} ms). ${heldText(r)}", r)

    // ---------------------------------------------------------------- element list rendering

    /** The node dump as a numbered list; coordinates are element centres (tap-ready). */
    private fun renderTree(d: JSONObject): String {
        val sb = StringBuilder()
        sb.append("Foreground app: ").append(d.optString("package").ifEmpty { "unknown" }).append('\n')
        sb.append("Screen: ").append(d.optInt("screenW")).append('x').append(d.optInt("screenH")).append(" px\n")
        sb.append("Elements: ").append(d.optInt("count")).append(if (d.optBoolean("truncated")) " (truncated: only the first ${A11yService.MAX_NODES})" else "").append('\n')
        d.optString("note").takeIf { it.isNotEmpty() }?.let { sb.append("Note: ").append(it).append('\n') }
        d.optString("hint").takeIf { it.isNotEmpty() }?.let { sb.append("Hint: ").append(it).append('\n') }
        val nodes = d.optJSONArray("nodes") ?: JSONArray()
        if (nodes.length() > 0) sb.append("Format: [i] label @(centerX,centerY) WxH flags id=…\n")
        for (i in 0 until nodes.length()) {
            val n = nodes.getJSONObject(i)
            val text = n.optString("text")
            val desc = n.optString("desc")
            val label = when {
                text.isNotEmpty() && desc.isNotEmpty() && desc != text -> "\"$text\" ($desc)"
                text.isNotEmpty() -> "\"$text\""
                desc.isNotEmpty() -> "($desc)"
                else -> "<" + n.optString("cls").substringAfterLast('.').ifEmpty { "no text" } + ">"
            }
            val x = n.optInt("x"); val y = n.optInt("y"); val w = n.optInt("w"); val h = n.optInt("h")
            val flags = ArrayList<String>()
            if (n.optBoolean("clickable")) flags.add("clickable")
            if (n.optBoolean("input")) flags.add("input")
            if (n.optBoolean("checked")) flags.add("checked")
            if (n.optBoolean("selected")) flags.add("selected")
            if (n.optBoolean("scrollable")) flags.add("scrollable")
            sb.append('[').append(i).append("] ").append(label)
                .append(" @(").append(x + w / 2).append(',').append(y + h / 2).append(") ").append(w).append('x').append(h)
            if (flags.isNotEmpty()) sb.append(' ').append(flags.joinToString("/"))
            n.optString("id").takeIf { it.isNotEmpty() }?.let { sb.append(" id=").append(it) }
            sb.append('\n')
        }
        return sb.toString().trimEnd()
    }

    // ---------------------------------------------------------------- image helpers

    /** Grid lines (semi-transparent, thin) to help the model locate things by row/column. */
    private fun drawGrid(b: Bitmap, grid: Int) {
        if (grid <= 0 || b.width <= 0) return
        val cv = Canvas(b)
        val paint = Paint().apply { color = 0x66FFFFFF; strokeWidth = maxOf(1f, b.width / 540f) }
        val shadow = Paint().apply { color = 0x44000000; strokeWidth = paint.strokeWidth }
        for (i in 1 until grid) {
            val gx = b.width * i / grid.toFloat()
            val gy = b.height * i / grid.toFloat()
            // A dark twin line keeps the grid visible on white screens too.
            cv.drawLine(gx + 1, 0f, gx + 1, b.height.toFloat(), shadow)
            cv.drawLine(0f, gy + 1, b.width.toFloat(), gy + 1, shadow)
            cv.drawLine(gx, 0f, gx, b.height.toFloat(), paint)
            cv.drawLine(0f, gy, b.width.toFloat(), gy, paint)
        }
    }

    private fun downscale(src: Bitmap, maxSide: Int): Bitmap {
        val long = maxOf(src.width, src.height)
        if (long <= maxSide) return src
        val s = maxSide.toFloat() / long
        return Bitmap.createScaledBitmap(src, maxOf(1, Math.round(src.width * s)), maxOf(1, Math.round(src.height * s)), true)
    }

    /** JPEG bytes, lowering quality until under [MAX_IMAGE_BYTES]. */
    private fun jpeg(b: Bitmap): ByteArray {
        var bytes = ByteArray(0)
        for (q in intArrayOf(70, 55, 40, 30)) {
            val out = ByteArrayOutputStream()
            b.compress(Bitmap.CompressFormat.JPEG, q, out)
            bytes = out.toByteArray()
            if (bytes.size <= MAX_IMAGE_BYTES) break
        }
        return bytes
    }

    private fun gridArg(a: JSONObject): Int {
        val v = a.opt("grid")
        return when (v) {
            is Boolean -> if (v) 4 else 0
            is Number -> v.toInt()
            is String -> if (v == "true") 4 else v.toIntOrNull() ?: 0
            else -> 0
        }.let { if (it >= 8) 8 else if (it > 0) 4 else 0 }
    }

    // ---------------------------------------------------------------- capabilities

    private val read = Cap(
        name = "screen.read",
        description = "Read the phone's current screen as a list of UI elements (via accessibility): foreground app package, " +
            "screen size, and each visible element that has text/description or is clickable/editable/scrollable, with its " +
            "centre point @(x,y) in screen pixels (usable directly as screen.tap x/y), size, flags and view id. " +
            "Waits briefly for the UI to settle first. Use it to see what's on screen, find a button, or check where you are " +
            "after acting. Returns up to ${A11yService.MAX_NODES} elements. Games and custom-drawn screens expose nothing: use screen.see then.",
        availableIf = connected,
    ) { _, _ ->
        val s = svc()
        s.awaitIdle()
        val d = s.dump()
        CapResult.text(renderTree(d), d)
    }

    private val see = Cap(
        name = "screen.see",
        description = "Take a screenshot of the phone's screen and look at it (returned as an image; JPEG, long side ≤ $MAX_IMAGE_SIDE px). " +
            "Use it when the element list (screen.read) isn't enough: images, layout, games / custom-drawn UIs. " +
            "The image is scaled: to act on a point seen at image pixel (ix,iy), use fx = ix/imageWidth, fy = iy/imageHeight " +
            "(fractions work in screen.tap/swipe/hold/touch/gesture); the caption gives the exact sizes. " +
            "grid: 4 or 8 overlays an N×N grid to help locate things by row/column. elements: true also returns the screen.read list. " +
            "Needs Android 11+. Secure screens (passwords, payments) can't be captured.",
        schema = schema(
            "grid" to int("0 (default) = no grid; 4 or 8 = overlay a 4×4 / 8×8 grid of thin lines"),
            "elements" to prop("boolean", "also include the UI element list (as screen.read) in the caption"),
            "display" to int("display id to capture (default 0 = the main screen; a virtual display id also works)"),
        ),
        availableIf = canShoot,
    ) { _, a ->
        val s = svc()
        s.awaitIdle(250, 1000)
        val displayId = a.optInt("display", 0)
        val grid = gridArg(a)
        val full = s.screenshot(displayId)
        val size = if (displayId == 0) s.screenSize() else intArrayOf(full.width, full.height)
        val img = downscale(full, MAX_IMAGE_SIDE)
        if (img !== full) full.recycle()
        drawGrid(img, grid)
        val bytes = jpeg(img)
        val iw = img.width
        val ih = img.height
        img.recycle()
        val cap = StringBuilder()
        cap.append("Screenshot").append(if (displayId != 0) " of display $displayId" else "")
            .append(" (foreground: ").append(s.foregroundPackage().ifEmpty { "unknown" }).append(").\n")
        cap.append("Screen ${size[0]}x${size[1]} px; image ${iw}x${ih} px")
        if (grid > 0) cap.append("; ${grid}x$grid grid overlaid (cell = 1/$grid of width/height)")
        cap.append(".\nTo act on image point (ix,iy): fx = ix/$iw, fy = iy/$ih (preferred), or screen pixels x = ix*")
            .append(String.format(Locale.US, "%.3f", size[0].toDouble() / iw)).append(", y = iy*")
            .append(String.format(Locale.US, "%.3f", size[1].toDouble() / ih)).append('.')
        if (a.optBoolean("elements") && displayId == 0) cap.append("\n\n").append(renderTree(s.dump()))
        CapResult.image(Base64.encodeToString(bytes, Base64.NO_WRAP), "image/jpeg", cap.toString())
    }

    /** Not offered to the agent: Ash's own screen.screenshot writes the file, with Ash's storage access. */
    private val capture = Cap(
        name = "screen.capture",
        description = "A full-resolution PNG of a display, for Ash.",
        schema = schema("display" to int("display id to capture (default 0 = the main screen)")),
        availableIf = canShoot,
    ) { _, a ->
        val bmp = svc().screenshot(a.optInt("display", 0))
        val png = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        val data = JSONObject().put("png", Base64.encodeToString(png, Base64.NO_WRAP)).put("width", bmp.width).put("height", bmp.height)
        bmp.recycle()
        CapResult.text("Captured ${data.optInt("width")}x${data.optInt("height")} px.", data)
    }

    private val tap = Cap(
        name = "screen.tap",
        description = "Tap an element on the phone's screen. Target it by text (matches the element's text or content description, " +
            "case-insensitive; exact match beats contains, clickable elements win), by view id, or by coordinates (fx/fy fractions " +
            "preferred, or x/y screen pixels). With text/id the element is clicked through accessibility (reliable even under " +
            "floating windows); if that's refused, a real touch is sent at the given coordinates or the element's centre. " +
            "long: true long-presses instead. Held fingers (screen.touch) stay held. To focus a text field before screen.type, tap it.",
        schema = schema(
            "text" to prop("string", "text or content description of the element (case-insensitive, exact or contained)"),
            "desc" to prop("string", "alias of text (matches description or text)"),
            "id" to prop("string", "view resource id, e.g. \"send_button\" or \"com.app:id/send_button\""),
            *point(),
            "long" to prop("boolean", "long-press instead of a tap"),
        ),
        availableIf = connected,
    ) { _, a ->
        val s = svc()
        val size = s.screenSize()
        val x = s.resolveCoord(a, "fx", "x", size[0])
        val y = s.resolveCoord(a, "fy", "y", size[1])
        val q = a.optString("text").ifEmpty { a.optString("desc") }.takeIf { it.isNotEmpty() }
        val id = a.optString("id").takeIf { it.isNotEmpty() }
        if (q == null && id == null && (x < 0 || y < 0)) return@Cap CapResult.fail("screen.tap needs text, desc, id, or x/y (fx/fy)")
        val r = s.tap(q, id, x, y, a.optBoolean("long"))
        if (!r.optBoolean("ok")) return@Cap CapResult.fail(r.optString("error"))
        val how = when (r.optString("method")) {
            "node-text" -> "clicked the matching element"
            "node-coord" -> "clicked the element at that point"
            else -> "touched (${r.optInt("x")},${r.optInt("y")})"
        }
        CapResult.text((if (a.optBoolean("long")) "Long-pressed: " else "Tapped: ") + how + ".", r)
    }

    private val type = Cap(
        name = "screen.type",
        description = "Type text into an input field on the phone's screen (via accessibility; any language / emoji). " +
            "Targets the field matching `field` (its text, hint, description or view id), else the focused field, else the first " +
            "editable one. mode \"set\" (default) replaces the field's whole content (text \"\" clears it) — right for normal app " +
            "fields. mode \"paste\" pastes via the clipboard at the cursor — use it for web pages / WebView fields, where \"set\" " +
            "changes nothing visible. Each mode falls back to the other when the field refuses it. It does not press Enter/send: " +
            "tap the send button afterwards. If nothing happens, tap the field first so it gets focus.",
        schema = schema(
            "text" to prop("string", "the text to enter (\"\" clears the field in set mode)", required = true),
            "mode" to prop("string", "set (default): replace content; paste: clipboard paste at the cursor", enum = listOf("set", "paste")),
            "field" to prop("string", "optional: text, hint, description or view id of the input field to type into"),
            "paste" to prop("boolean", "legacy alias: true = mode paste"),
        ),
        availableIf = connected,
    ) { _, a ->
        if (!a.has("text") || a.isNull("text")) return@Cap CapResult.fail("screen.type needs text")
        val text = a.optString("text")
        val mode = if (a.optString("mode") == "paste" || a.optBoolean("paste")) "paste" else "set"
        val r = svc().type(text, mode, a.optString("field").takeIf { it.isNotBlank() })
        if (!r.optBoolean("ok")) return@Cap CapResult.fail(r.optString("error"))
        val how = if (r.optString("method") == "paste") "pasted" else "set the field text"
        CapResult.text("Typed ${text.length} chars ($how${if (r.optBoolean("fallback")) ", after the other mode was refused" else ""}" +
            "${if (!r.optBoolean("focused")) "; the field does not report focus" else ""}).", r)
    }

    private val scroll = Cap(
        name = "screen.scroll",
        description = "Scroll the scrollable area on the phone's screen one page. direction is where you want to see more content: " +
            "down = further down the list (like swiping up), up = back towards the top, left/right for horizontal lists and pagers. " +
            "Uses accessibility scrolling; if the screen has no scrollable element (web pages, games), swipes across the middle instead.",
        schema = schema("direction" to prop("string", "up | down | left | right", required = true, enum = listOf("up", "down", "left", "right"))),
        availableIf = connected,
    ) { _, a ->
        val dir = a.optString("direction", "down").ifEmpty { "down" }
        val r = svc().scroll(dir)
        if (!r.optBoolean("ok")) CapResult.fail(r.optString("error"))
        else CapResult.text("Scrolled $dir (${if (r.optString("method") == "node") "accessibility scroll" else "swipe gesture"}).", r)
    }

    private val swipe = Cap(
        name = "screen.swipe",
        description = "Swipe one finger from a start point to an end point on the phone's screen (press → move → lift). " +
            "Give the start as fx1/fy1 (fractions 0..1, preferred) or x1/y1 (pixels) and the end as fx2/fy2 or x2/y2. " +
            "durationMs is the swipe time (default 300; 800-1500 for a slow drag). finger: if that finger is currently held " +
            "(screen.touch down), it swipes from where it is to the end point and lifts. Held fingers stay held.",
        schema = schema(
            *point("1", "start"), *point("2", "end"),
            "durationMs" to num("swipe duration in milliseconds (default 300)"),
            "finger" to int("optional finger 0-7"),
        ),
        availableIf = connected,
    ) { _, a ->
        val op = JSONObject().put("kind", "swipe")
        for ((from, to) in listOf("x1" to "x", "y1" to "y", "fx1" to "fx", "fy1" to "fy", "x2" to "x2", "y2" to "y2", "fx2" to "fx2", "fy2" to "fy2", "durationMs" to "durationMs", "finger" to "finger")) {
            if (a.has(from) && !a.isNull(from)) op.put(to, a.get(from))
        }
        if (!(op.has("x") || op.has("fx")) || !(op.has("y") || op.has("fy")) || !(op.has("x2") || op.has("fx2")) || !(op.has("y2") || op.has("fy2")))
            return@Cap CapResult.fail("screen.swipe needs a start (x1/y1 or fx1/fy1) and an end (x2/y2 or fx2/fy2)")
        gestureResult(svc().gesture(JSONArray().put(op)), "Swipe")
    }

    private val hold = Cap(
        name = "screen.hold",
        description = "Press and hold one point on the phone's screen for durationMs (default 500), then lift — long-press an icon, " +
            "charge a game action, etc. To keep a finger pressed across calls (joysticks, drag-and-hold), use screen.touch " +
            "action=down instead. Coordinates: fx/fy (fractions 0..1, preferred) or x/y (pixels).",
        schema = schema(*point(), "durationMs" to num("how long to hold, milliseconds (default 500)"), "finger" to int("optional finger 0-7")),
        availableIf = connected,
    ) { _, a ->
        val op = JSONObject().put("kind", "hold")
        for (k in listOf("x", "y", "fx", "fy", "durationMs", "finger")) if (a.has(k) && !a.isNull(k)) op.put(k, a.get(k))
        if (!(op.has("x") || op.has("fx")) || !(op.has("y") || op.has("fy"))) return@Cap CapResult.fail("screen.hold needs x/y or fx/fy")
        gestureResult(svc().gesture(JSONArray().put(op)), "Hold")
    }

    private val touch = Cap(
        name = "screen.touch",
        description = "Stateful virtual touchscreen for multi-finger control. action=down presses finger N at a point and KEEPS it " +
            "pressed after the call; move slides a held finger to a new point; up lifts it; release_all lifts every finger. " +
            "Fingers are numbered 0-7 and several can be held at once. Typical: joystick = down(finger 0 on the stick), then " +
            "move(0) towards the direction, up(0) to let go; other taps/swipes/gestures meanwhile keep held fingers pressed. " +
            "A finger held for 30 s is lifted automatically. Coordinates: fx/fy (fractions 0..1, preferred) or x/y (pixels); " +
            "up needs none (with a point, it slides there before lifting).",
        schema = schema(
            "action" to prop("string", "down = press and keep holding; move = move a held finger; up = lift it; release_all = lift all", required = true, enum = listOf("down", "move", "up", "release_all")),
            "finger" to int("finger number 0-7 (required except for release_all)"),
            *point(),
        ),
        availableIf = connected,
    ) { _, a ->
        val s = svc()
        val action = a.optString("action")
        if (action == "release_all" || action == "release" && !a.has("finger")) {
            s.releaseAll()
            return@Cap CapResult.text("All fingers lifted.", JSONObject().put("ok", true).put("held", JSONArray()))
        }
        if (action !in listOf("down", "move", "up", "release")) return@Cap CapResult.fail("action must be down, move, up or release_all")
        if (!a.has("finger")) return@Cap CapResult.fail("screen.touch needs finger (0-7)")
        val finger = a.optInt("finger", -1)
        if (finger !in 0 until A11yService.MAX_FINGERS) return@Cap CapResult.fail("finger must be 0-${A11yService.MAX_FINGERS - 1}")
        val op = JSONObject().put("kind", if (action == "release") "up" else action).put("finger", finger)
        for (k in listOf("x", "y", "fx", "fy")) if (a.has(k) && !a.isNull(k)) op.put(k, a.get(k))
        if ((action == "down" || action == "move") && (!(op.has("x") || op.has("fx")) || !(op.has("y") || op.has("fy"))))
            return@Cap CapResult.fail("$action needs x/y or fx/fy")
        gestureResult(s.gesture(JSONArray().put(op)), "Touch $action")
    }

    private val strokeSchema: JSONObject = schema(
        "kind" to prop("string", "stroke type", required = true, enum = listOf("down", "move", "up", "tap", "swipe", "hold", "wait")),
        "finger" to int("finger 0-7 (needed for down/move/up; optional otherwise)"),
        "fx" to num("x as a fraction 0..1 (preferred)"), "fy" to num("y as a fraction 0..1 (preferred)"),
        "x" to num("x in pixels"), "y" to num("y in pixels"),
        "fx2" to num("swipe end x fraction"), "fy2" to num("swipe end y fraction"),
        "x2" to num("swipe end x pixels"), "y2" to num("swipe end y pixels"),
        "durationMs" to num("stroke duration ms (tap 60, swipe 300, hold 500, move/up 100 by default)"),
        "ms" to num("wait duration ms"),
    )

    private val gesture = Cap(
        name = "screen.gesture",
        description = "Perform a multi-finger gesture on the phone's screen: strokes run one after another on a single timeline and are " +
            "injected together as one real multi-touch gesture. Stroke kinds: down {finger, point} press and keep holding; " +
            "move {finger, point} move a held finger; up {finger} lift; tap {point, [finger], [durationMs]}; " +
            "swipe {point → x2/y2 or fx2/fy2, [durationMs]}; hold {point, [durationMs]} press, wait, lift; wait {ms}. " +
            "A point is fx/fy (fractions 0..1, preferred) or x/y (pixels). Examples: hold the joystick while tapping a button = " +
            "[down(0, stick), tap(1, button)]; drag the joystick = [down(0, centre), move(0, direction)]. Fingers left down stay " +
            "held after the call (see screen.touch) until up / release_all / the 30 s auto-release. Total length ≤ 60 s.",
        schema = JSONObject().put("type", "object").put("properties", JSONObject().put("strokes",
            JSONObject().put("type", "array").put("description", "gesture strokes, in timeline order").put("items", strokeSchema)))
            .put("required", JSONArray().put("strokes")),
        availableIf = connected,
    ) { _, a ->
        val strokes = a.optJSONArray("strokes")
        if (strokes == null || strokes.length() == 0) return@Cap CapResult.fail("screen.gesture needs a non-empty strokes array")
        gestureResult(svc().gesture(strokes), "Gesture")
    }

    private val touchStatus = Cap(
        name = "screen.touch_status",
        description = "Show which virtual fingers are currently held down (from screen.touch / screen.gesture): finger number, " +
            "position in pixels and fractions, and how long it has been held; plus screen size and limits (8 fingers, 30 s auto-release).",
        availableIf = connected,
    ) { _, _ ->
        val r = svc().touchStatus()
        CapResult.text("Screen ${r.optInt("screenW")}x${r.optInt("screenH")} px; up to ${r.optInt("maxFingers")} fingers; " +
            "held fingers auto-release after ${r.optLong("holdTimeoutMs") / 1000} s. ${heldText(r)}", r)
    }

    private val globalActions: Map<String, Pair<Int, Int>> = linkedMapOf(
        // name → (GLOBAL_ACTION_*, min API)
        "back" to (AccessibilityService.GLOBAL_ACTION_BACK to 16),
        "home" to (AccessibilityService.GLOBAL_ACTION_HOME to 16),
        "recents" to (AccessibilityService.GLOBAL_ACTION_RECENTS to 16),
        "notifications" to (AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS to 16),
        "quick_settings" to (AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS to 17),
        "power_dialog" to (AccessibilityService.GLOBAL_ACTION_POWER_DIALOG to 21),
        "split_screen" to (AccessibilityService.GLOBAL_ACTION_TOGGLE_SPLIT_SCREEN to 24),
        "lock_screen" to (8 to 28), // GLOBAL_ACTION_LOCK_SCREEN
    )

    private val globalAction = Cap(
        name = "screen.global_action",
        description = "Press a system button on the phone: back (go to the previous screen / close the keyboard), home (launcher), " +
            "recents (app switcher), notifications (pull down the notification shade), quick_settings, power_dialog, " +
            "split_screen (toggle), lock_screen (Android 9+; locks the phone).",
        schema = schema("action" to prop("string", "which system action", required = true, enum = globalActions.keys.toList())),
        availableIf = connected,
    ) { _, a ->
        val name = a.optString("action")
        val (id, minApi) = globalActions[name] ?: return@Cap CapResult.fail("unknown action \"$name\"; one of ${globalActions.keys.joinToString()}")
        if (Build.VERSION.SDK_INT < minApi) return@Cap CapResult.fail("$name needs a newer Android (API $minApi+)")
        if (svc().global(id)) CapResult.text("Done: $name.") else CapResult.fail("the system refused $name")
    }

    private val switchesRunning = java.util.concurrent.atomic.AtomicBoolean(false)

    /**
     * Ash's own tool for the owner's tap on 「帮我打开」: turns on the keep-alive switches of Ash's three apps in the maker's
     * settings. Never listed, so no agent can call it. [ai.ash.screen.switches.SwitchFlow] does the work.
     */
    private val keepAliveSwitches = Cap(
        name = KeepAliveSwitches.CAPABILITY,
        description = "Turn on the background-running switches of Ash's own apps (ColorOS only), for Ash.",
        schema = schema("packages" to JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))),
        availableIf = connected,
    ) { _, a ->
        val asked = a.optJSONArray("packages")?.let { l -> (0 until l.length()).map { l.optString(it) } }.orEmpty().mapNotNull { KeepAliveSwitches.target(it) }
        val report = when {
            !SwitchFlow.supported(Build.MANUFACTURER) -> KeepAliveSwitches.Report(KeepAliveSwitches.Outcome.UNSUPPORTED, "", emptyList())
            !switchesRunning.compareAndSet(false, true) -> return@Cap CapResult.fail("already running")
            else -> try { val service = svc(); SwitchFlow(AccessibilityUi(service, service), asked.map { it.pkg }).run() } finally { switchesRunning.set(false) }
        }
        CapResult.text(report.summary(asked), report.toJson())
    }

    /** What the agent is offered (Ash adds screen.screenshot on top of [capture]). */
    val list: List<Capability> = listOf(read, see, tap, type, scroll, swipe, hold, touch, gesture, touchStatus, globalAction)
    /** Called by Ash itself, never listed. */
    val hidden: List<Capability> = listOf(capture, keepAliveSwitches)
}
