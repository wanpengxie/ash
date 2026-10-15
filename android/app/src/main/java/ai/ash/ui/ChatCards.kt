package ai.ash.ui

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextUtils
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.CheckBox
import android.widget.Chronometer
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.SeekBar
import android.widget.Space
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextClock
import android.widget.TextView
import ai.ash.R
import ai.ash.apps.AppIds
import ai.ash.apps.Csp
import ai.ash.apps.HostPage
import ai.ash.host.PresentRoutes
import ai.ash.ui.design.AshPalette
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import ai.ash.widget.AshChart
import ai.ash.widget.CAction
import ai.ash.widget.CStyle
import ai.ash.widget.CardImages
import ai.ash.widget.CardSpec
import ai.ash.widget.Dim
import ai.ash.widget.Img
import ai.ash.widget.Markdown
import ai.ash.widget.Tint
import ai.ash.widget.WidgetActions
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.math.BigDecimal
import java.security.SecureRandom
import java.time.LocalDate
import java.time.LocalTime
import java.util.Locale
import kotlin.math.roundToInt

/**
 * The plain part of a card in the conversation (docs/GENUI.md), with no Android views: reading the plan the hub resolved,
 * writing the owner's values into the card's data at a JSON pointer, and the messages a card sends. Unit tested on the JVM.
 */
object ChatCardModel {
    private val DIGITS = Regex("^\\d+$")

    /** A card's plan: its literal components by id, its root, its data model, and whether something shown reads what an input writes. */
    class Plan(val raw: String, val root: String, val byId: Map<String, JSONObject>, val data: JSONObject, val reactive: Boolean, val accent: Any?)

    /** The `plan` of a card item, or null when there is nothing to draw (no components, or no root among them). */
    fun plan(raw: JSONObject?): Plan? {
        val list = raw?.optJSONArray("components") ?: return null
        val byId = LinkedHashMap<String, JSONObject>()
        for (i in 0 until list.length()) list.optJSONObject(i)?.let { c -> c.optString("id").takeIf { it.isNotEmpty() }?.let { byId[it] = c } }
        val root = raw.optString("root").ifEmpty { "root" }
        if (root !in byId) return null
        return Plan(raw.toString(), root, byId, JSONObject((raw.optJSONObject("data") ?: JSONObject()).toString()), raw.optBoolean("reactive"),
            raw.optJSONObject("theme")?.opt("accent"))
    }

    /** The JSON pointer of a form field: `"/" + field`, with `~` and `/` escaped. */
    fun pathOf(field: String) = "/" + field.replace("~", "~0").replace("/", "~1")
    private fun unescape(raw: String) = raw.replace("~1", "/").replace("~0", "~")

    /** The value at [path] in [data], or null. */
    fun read(data: Any?, path: String): Any? {
        if (path == "" || path == "/") return data
        if (!path.startsWith("/")) return null
        var at: Any? = data
        for (raw in path.substring(1).split("/")) {
            val key = unescape(raw)
            val here = at
            at = when {
                here is JSONArray && DIGITS.matches(key) -> key.toIntOrNull()?.takeIf { it < here.length() }?.let { here.opt(it) } ?: return null
                here is JSONObject && here.has(key) -> here.opt(key)
                else -> return null
            }
        }
        return if (at == JSONObject.NULL) null else at
    }

    /** Writes [value] at [path] in [data], making objects on the way; an array only by an index it already has (as the hub does). */
    fun write(data: JSONObject, path: String, value: Any?): Boolean {
        if (!path.startsWith("/") || path == "/") return false
        val keys = path.substring(1).split("/").map(::unescape)
        var at: Any = data
        for ((i, key) in keys.withIndex()) {
            val last = i == keys.lastIndex
            val here = at
            when (here) {
                is JSONArray -> {
                    val n = key.takeIf { DIGITS.matches(it) }?.toIntOrNull()?.takeIf { it < here.length() } ?: return false
                    if (last) { here.put(n, value ?: JSONObject.NULL); return true }
                    at = here.opt(n) ?: return false
                }
                is JSONObject -> {
                    if (key in setOf("__proto__", "constructor", "prototype")) return false
                    if (last) { here.put(key, value ?: JSONObject.NULL); return true }
                    val next = here.opt(key)
                    if (next !is JSONObject && next !is JSONArray) here.put(key, JSONObject())
                    at = here.get(key)
                }
                else -> return false
            }
        }
        return false
    }

    /** What the agent learns of a password: `****` and its last four characters when it has eight or more, else just `****`. */
    fun masked(text: String): String {
        val points = text.codePoints().toArray()
        return if (points.size >= 8) "****" + String(points, points.size - 4, 4) else "****"
    }

    /** The first password box of a form that is still empty, as the line shown to the owner; null when every one is filled. */
    fun missingSecret(secret: JSONObject, titles: JSONObject, typed: Map<String, String>): String? {
        for (field in secret.keys()) if (typed[pathOf(field)].isNullOrEmpty()) return "请先填写${titles.optString(field).ifEmpty { field }}"
        return null
    }

    /** The answer to a form: the values (never a password) and, per password field, its vault name and its masked form. */
    fun formAnswer(data: JSONObject, secret: JSONObject, typed: Map<String, String>): JSONObject {
        val values = JSONObject(data.toString())
        val refs = JSONObject()
        for (field in secret.keys()) {
            values.remove(field)
            refs.put(field, JSONObject().put("ref", secret.optString(field)).put("masked", masked(typed[pathOf(field)].orEmpty())))
        }
        return JSONObject().put("ok", true).put("result", JSONObject().put("data", JSONObject().put("values", values).put("secret", refs)))
    }

    /** The owner declined to fill in the form. */
    fun cancelAnswer(): JSONObject = JSONObject().put("ok", false).put("error", JSONObject().put("code", "cancelled").put("message", "主人取消了"))

    /** The response to form [card] from [owner] (its creator), sent like an ask's answer: one client id per form, so a retry never answers twice. */
    fun formMessage(owner: String, card: String, body: JSONObject): JSONObject = JSONObject().put("to", owner).put("kind", "response").put("word", "form")
        .put("reply_to", card).put("client_id", PresentRoutes.answerClientId(card)).put("body", body)

    /** The owner's `say` for an action on a card: the button's label as the text, and which card, which action, its context and the card's data. */
    fun sayBody(text: String, card: String, action: String, context: JSONObject?, data: JSONObject): JSONObject =
        JSONObject().put("text", text).put("card", JSONObject().put("id", card).put("action", action).apply { if (context != null) put("context", context) }
            .put("data", JSONObject(data.toString())))

    /** The owner's 👍 / 👎 on a card ([which] is `up` or `down`): a `say` like an action's, named `feedback`. */
    fun feedbackBody(which: String, card: String, data: JSONObject): JSONObject =
        sayBody(if (which == "up") "👍" else "👎", card, "feedback", JSONObject().put("feedback", which), data)

    /** The 👍 / 👎 shown as chosen: the one just tapped here, else the one the item says the owner gave last. */
    fun feedbackShown(local: String?, given: String?): String? = local ?: given?.takeIf { it == "up" || it == "down" }

    /**
     * The card language's icon names (the hub's CARD_ICONS) as Ash's own line icons; null is the neutral outline (a small
     * circle), as is any name not here. The one table of the phone.
     */
    val ICONS: Map<String, Int?> = linkedMapOf(
        "accountCircle" to R.drawable.ash_ic_account, "add" to R.drawable.ash_ic_plus, "arrowBack" to R.drawable.ash_ic_back, "arrowForward" to R.drawable.ash_ic_chev,
        "attachFile" to R.drawable.ash_ic_link, "calendarToday" to R.drawable.ash_ic_clock, "call" to R.drawable.ash_ic_phone, "camera" to R.drawable.ash_ic_camera,
        "check" to R.drawable.ash_ic_check, "close" to R.drawable.ash_ic_x, "delete" to R.drawable.ash_ic_trash, "download" to R.drawable.ash_ic_down,
        "edit" to R.drawable.ash_ic_pen, "event" to R.drawable.ash_ic_clock, "error" to R.drawable.ash_ic_alert, "fastForward" to R.drawable.ash_ic_chev,
        "favorite" to R.drawable.ash_ic_heart, "favoriteOff" to R.drawable.ash_ic_heart, "folder" to R.drawable.ash_ic_folder, "help" to R.drawable.ash_ic_ask,
        "home" to R.drawable.ash_ic_grid, "info" to R.drawable.ash_ic_alert, "locationOn" to R.drawable.ash_ic_pin, "lock" to R.drawable.ash_ic_lock,
        "lockOpen" to R.drawable.ash_ic_key, "mail" to R.drawable.ash_ic_msg, "menu" to R.drawable.ash_ic_list, "moreVert" to R.drawable.ash_ic_more,
        "moreHoriz" to R.drawable.ash_ic_more, "notificationsOff" to R.drawable.ash_ic_bell, "notifications" to R.drawable.ash_ic_bell,
        "pause" to R.drawable.ash_ic_pause, "payment" to R.drawable.ash_ic_wallet, "person" to R.drawable.ash_ic_person, "phone" to R.drawable.ash_ic_phone,
        "photo" to R.drawable.ash_ic_image, "play" to R.drawable.ash_ic_chev, "print" to R.drawable.ash_ic_file, "refresh" to R.drawable.ash_ic_refresh,
        "rewind" to R.drawable.ash_ic_back, "search" to R.drawable.ash_ic_eye, "send" to R.drawable.ash_ic_up, "settings" to R.drawable.ash_ic_slider,
        "share" to R.drawable.ash_ic_link, "shoppingCart" to R.drawable.ash_ic_box, "skipNext" to R.drawable.ash_ic_chev, "skipPrevious" to R.drawable.ash_ic_back,
        "star" to R.drawable.ash_ic_star, "starHalf" to R.drawable.ash_ic_star_half, "starOff" to R.drawable.ash_ic_star_off, "stop" to R.drawable.ash_ic_stop, "upload" to R.drawable.ash_ic_up,
        "visibility" to R.drawable.ash_ic_eye, "visibilityOff" to R.drawable.ash_ic_eye, "volumeDown" to R.drawable.ash_ic_volume_down, "volumeMute" to R.drawable.ash_ic_volume_mute, "volumeOff" to R.drawable.ash_ic_volume_off,
        "volumeUp" to R.drawable.ash_ic_volume_up, "warning" to R.drawable.ash_ic_alert,
        "sun" to R.drawable.ash_ic_sun, "cloud" to R.drawable.ash_ic_cloud, "rain" to R.drawable.ash_ic_rain, "snow" to R.drawable.ash_ic_snow, "wind" to R.drawable.ash_ic_wind, "moon" to R.drawable.ash_ic_moon, "heart" to R.drawable.ash_ic_heart,
        "steps" to R.drawable.ash_ic_pulse, "weight" to R.drawable.ash_ic_weight, "sleep" to R.drawable.ash_ic_moon, "water" to R.drawable.ash_ic_water, "fire" to R.drawable.ash_ic_bolt,
        "calendar" to R.drawable.ash_ic_clock, "clock" to R.drawable.ash_ic_clock, "alert" to R.drawable.ash_ic_alert, "bell" to R.drawable.ash_ic_bell,
        "car" to R.drawable.ash_ic_car, "money" to R.drawable.ash_ic_coin, "chart" to R.drawable.ash_ic_pulse)

    // --- a card's picture (`chat` present `card.preview`) ---

    /** The card is drawn this wide, as in the chat. */
    const val PREVIEW_DP = 330
    /** The longer side of the picture, in pixels. */
    const val PREVIEW_SIDE = 900
    /** The PNG must stay under this; it is drawn smaller until it does. */
    const val PREVIEW_BYTES = 300 * 1024
    /** Scales tried in turn when the PNG is too large. */
    val PREVIEW_SHRINK = floatArrayOf(1f, 0.8f, 0.64f, 0.5f, 0.4f, 0.32f, 0.25f)

    /** The picture's size at shrink step [i] for a card [wPx] x [hPx] px (the longer side at most [PREVIEW_SIDE]); null when the steps are used up. */
    fun previewSize(wPx: Int, hPx: Int, i: Int): Pair<Int, Int>? {
        val shrink = PREVIEW_SHRINK.getOrNull(i) ?: return null
        val s = minOf(1f, PREVIEW_SIDE.toFloat() / maxOf(wPx, hPx, 1)) * shrink
        return maxOf(1, Math.round(wPx * s)) to maxOf(1, Math.round(hPx * s))
    }

    /** The answer to `card.preview`: an image part. [encode] is base64 without wraps. */
    fun previewPart(png: ByteArray, width: Int, height: Int, encode: (ByteArray) -> String): JSONObject =
        JSONObject().put("type", "image").put("data", encode(png)).put("mimeType", "image/png").put("width", width).put("height", height)

    /** What a button says: the first Text in it (without its Markdown marks), else its action's name. */
    fun label(byId: Map<String, JSONObject>, node: JSONObject): String {
        fun find(n: JSONObject?, depth: Int): String? {
            if (n == null || depth > 24) return null
            if (n.optString("component") == "Text") return Markdown.parse(n.optString("text")).text.trim().ifEmpty { null }
            val kids = ArrayList<String>()
            n.optString("child").takeIf { it.isNotEmpty() }?.let(kids::add)
            n.optJSONArray("children")?.let { a -> for (i in 0 until a.length()) a.optString(i).takeIf { it.isNotEmpty() }?.let(kids::add) }
            n.optJSONArray("tabs")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.optString("child")?.takeIf { it.isNotEmpty() }?.let(kids::add) }
            return kids.firstNotNullOfOrNull { find(byId[it], depth + 1) }
        }
        return find(node, 0) ?: node.optJSONObject("action")?.optJSONObject("event")?.optString("name").orEmpty()
    }

    /** The line under a card that is no longer open. */
    fun stateLine(state: String): String? = when (state) {
        "sent" -> "已提交"; "cancelled" -> "已取消"; "expired" -> "已过期"; "closed" -> "已结束"; else -> null
    }

    // --- the card runtime (docs/CARD-RUNTIME.md): buttons the hub runs, lifecycle, what is on screen ---

    /** Whether a button's action is run by the hub (`service:cards/act`): a call, an ask or a tell. */
    fun hubAction(action: JSONObject?): Boolean = action != null && (action.has("call") || action.has("ask") || action.has("tell"))

    /** How long a press waits for the hub's answer: the action's `timeout_s` + 5 s (the hub's own default is 30 s). */
    fun pressTimeoutMs(action: JSONObject?): Long {
        val t = (action?.optJSONObject("call") ?: action?.optJSONObject("ask"))?.optInt("timeout_s", 0) ?: 0
        return ((if (t > 0) t else 30) + 5) * 1000L
    }

    /** `service:cards/act`: which card, which component, the values on the card now, and (only from a mini app) its own request. */
    fun actBody(card: String, component: String, data: JSONObject, request: JSONObject? = null): JSONObject =
        JSONObject().put("card", card).put("component", component).put("data", JSONObject(data.toString())).apply { if (request != null) put("request", request) }

    /**
     * Whether a button does nothing when pressed now: a press from here is still waiting, or the card says it runs ([hub] is
     * `actions[component]`) and has not run past [timeoutMs] since it started (after that it may be pressed again).
     */
    fun pressBusy(inFlight: Boolean, hub: JSONObject?, now: Long, timeoutMs: Long): Boolean {
        if (inFlight) return true
        if (hub?.optString("state") != "running") return false
        val at = hub.optLong("at")
        return at <= 0 || now - at < timeoutMs
    }

    /** The line under a button: the copy note, what failed here, else the card's own outcome; true when it is a failure. Null while it runs or before. */
    fun outcome(copied: Boolean, localFailure: String?, hub: JSONObject?): Pair<String, Boolean>? = when {
        copied -> "已复制" to false
        localFailure != null -> localFailure to true
        hub == null || hub.optString("state") == "running" -> null
        else -> hub.optString("text").takeIf { it.isNotBlank() }?.let { it to (hub.optString("state") == "failed") }
    }

    /** What the owner reads when a press did not reach the hub or was refused. */
    fun failureText(code: String): String = when (code) {
        "conflict" -> "这张卡片已经结束了"
        "not_found" -> "这张卡片找不到了"
        "offline", "unavailable", "result_unknown" -> "没有连上，再点一次试试"
        "timeout" -> "等太久了，可以再点一次"
        "forbidden", "denied" -> "没有得到允许"
        else -> "没有成功，再点一次试试"
    }

    /** A mini app's answer: the act's `{state, text, result?}`, or a failure in the same shape. */
    fun miniAnswer(data: JSONObject?, failureCode: String?): JSONObject =
        if (failureCode != null || data == null) JSONObject().put("state", "failed").put("text", failureText(failureCode ?: "failed"))
        else JSONObject(data.toString()).apply { if (!has("state")) put("state", "ok"); if (!has("text")) put("text", "") }

    /** A mini app's `ash.call / ask / tell` as the act's `request`, or null when it is not one of them. */
    fun miniRequest(raw: String?): JSONObject? {
        val r = runCatching { JSONObject(raw ?: return null) }.getOrNull() ?: return null
        if (r.length() != 1) return null
        fun text(o: JSONObject?, key: String, max: Int) = o?.opt(key).let { it as? String }?.trim()?.takeIf { it.isNotEmpty() && it.length <= max }
        r.optJSONObject("call")?.let { c ->
            val member = text(c, "member", 128) ?: return null
            val word = text(c, "word", 128) ?: return null
            val body = when (val b = c.opt("body")) { null, JSONObject.NULL -> JSONObject(); is JSONObject -> b; else -> return null }
            return JSONObject().put("call", JSONObject().put("member", member).put("word", word).put("body", body))
        }
        for (kind in listOf("ask", "tell")) r.optJSONObject(kind)?.let { a ->
            return JSONObject().put(kind, JSONObject().put("text", text(a, "text", 4000) ?: return null))
        }
        return null
    }

    /** At most [max] in any [windowMs] (a mini app's calls). */
    class Rate(private val max: Int, private val windowMs: Long) {
        private val times = ArrayDeque<Long>()
        fun take(now: Long): Boolean {
            while (times.isNotEmpty() && now - times.first() >= windowMs) times.removeFirst()
            if (times.size >= max) return false
            times.addLast(now); return true
        }
    }

    /** Whether the card is closed: its state, or its lifecycle. */
    fun closed(card: JSONObject): Boolean = card.optString("state") == "closed" || card.optString("life") == "closed"

    /** HH:MM of [ms] in [zone]. */
    fun clock(ms: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String =
        java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalTime().let { String.format(Locale.US, "%02d:%02d", it.hour, it.minute) }

    /**
     * The quiet line at the card's bottom: 「已休眠 · HH:MM 的数据」 for a sleeping card, 「常驻中」 for an active card kept running
     * ([pinned]: as shown, the owner's switch included), 「HH:MM 更新」 when live data came; else null.
     */
    fun caption(card: JSONObject, zone: java.time.ZoneId = java.time.ZoneId.systemDefault(), pinned: Boolean = card.optBoolean("pinned")): String? {
        val fed = card.optLong("fed_at")
        if (card.optString("life") == "dormant") return "已休眠 · ${clock(if (fed > 0) fed else card.optLong("updated_at"), zone)} 的数据"
        if (pinned && !closed(card) && card.optString("life").ifEmpty { "active" } == "active") return "常驻中"
        return if (fed > 0) "${clock(fed, zone)} 更新" else null
    }

    /** The 「常驻」 switch's label. */
    const val PIN_LABEL = "常驻"
    /** What the line says when the switch could not be changed. */
    const val PIN_FAILED = "没能改成，再试一次"

    /** Whether the card has the 「常驻」 switch: a card of an app that is not closed (every other card stops by itself). */
    fun pinnable(card: JSONObject): Boolean = card.optString("app").isNotEmpty() && !closed(card)

    /** `service:cards/pin`: keep card [id] running off screen, or let it stop by itself again. */
    fun pinBody(id: String, pinned: Boolean): JSONObject = JSONObject().put("id", id).put("pinned", pinned)

    /** Whether the card keeps a line for [caption] from its first drawing: a card of an app whose runtime is reported (live data may come). */
    fun reservesCaption(card: JSONObject): Boolean =
        (card.optLong("fed_at") > 0 || card.has("life")) && (card.optBoolean("temporary_app") || card.optString("app").isNotEmpty())

    /** The cards to report as seen (`service:cards/seen`): the a2ui cards among [items] that are not closed, each once, at most 50. */
    fun seenIds(items: Iterable<JSONObject>): List<String> = items.asSequence()
        .filter { it.optString("type") == "card" }
        .mapNotNull { it.optJSONObject("card") }
        .filter { it.optString("type") == "a2ui" && !closed(it) }
        .mapNotNull { it.optString("id").ifEmpty { null } }
        .distinct().take(50).toList()

    /** A slider's step: the given one, else 1 over a whole-number range of up to 1000, else a hundredth of the range. */
    fun sliderStep(min: Double, max: Double, step: Double): Double = when {
        step.isFinite() && step > 0 -> step
        min == Math.floor(min) && max == Math.floor(max) && max - min <= 1000 -> 1.0
        else -> (max - min) / 100
    }

    /** The value at notch [progress] (whole numbers stay whole). */
    fun sliderValue(min: Double, max: Double, step: Double, progress: Int): Number {
        val v = minOf(max, min + progress * step)
        return if (min == Math.floor(min) && step == Math.floor(step)) Math.round(v) else BigDecimal(v).setScale(6, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toDouble()
    }

    fun number(v: Number): String = if (v is Long || v is Int) v.toString() else BigDecimal(v.toDouble()).setScale(6, java.math.RoundingMode.HALF_UP).stripTrailingZeros().toPlainString()

    private val ISO = Regex("^(\\d{4}-\\d{2}-\\d{2})?[T ]?(\\d{2}:\\d{2})?")

    /** The date and the time in an ISO text ("2026-10-15", "09:30", "2026-10-15T09:30…"); the zone is not looked at. */
    fun isoParts(text: String): Pair<LocalDate?, LocalTime?> {
        val m = ISO.find(text.trim()) ?: return null to null
        return m.groupValues[1].takeIf { it.isNotEmpty() }?.let { runCatching { LocalDate.parse(it) }.getOrNull() } to
            m.groupValues[2].takeIf { it.isNotEmpty() }?.let { runCatching { LocalTime.parse(it) }.getOrNull() }
    }

    fun iso(date: LocalDate?, time: LocalTime?): String = when {
        date != null && time != null -> "${date}T${String.format(Locale.US, "%02d:%02d", time.hour, time.minute)}"
        date != null -> date.toString()
        time != null -> String.format(Locale.US, "%02d:%02d", time.hour, time.minute)
        else -> ""
    }

    /** A colour as CSS. */
    fun css(argb: Int): String = String.format(Locale.US, "rgba(%d,%d,%d,%.3f)", (argb shr 16) and 0xFF, (argb shr 8) and 0xFF, argb and 0xFF, ((argb ushr 24) and 0xFF) / 255f)

    // --- a push drawn in place (MOBILE-ARCH §12.6) ---

    /** A JSON value as text with its keys in order, so two equal values always read the same. */
    fun canon(v: Any?): String = StringBuilder().also { canon(it, v) }.toString()

    private fun canon(b: StringBuilder, v: Any?) {
        when (v) {
            null, JSONObject.NULL -> b.append("null")
            is JSONObject -> {
                b.append('{')
                v.keys().asSequence().sorted().forEachIndexed { i, k -> if (i > 0) b.append(','); b.append(JSONObject.quote(k)).append(':'); canon(b, v.opt(k)) }
                b.append('}')
            }
            is JSONArray -> { b.append('['); for (i in 0 until v.length()) { if (i > 0) b.append(','); canon(b, v.opt(i)) }; b.append(']') }
            is String -> b.append(JSONObject.quote(v))
            is Number -> b.append(number(v))
            else -> b.append(v.toString())
        }
    }

    /** A node's value fields: what a push may change on its control in place. */
    private val VALUES = listOf("text", "value", "checked", "rows", "visible", "disabled")

    /** A node without its value fields (a progress's label, options' checked, series' values, a picture's url too). */
    fun layoutOf(n: JSONObject): String {
        val o = JSONObject(n.toString())
        VALUES.forEach { o.remove(it) }
        val kind = n.optString("component")
        val url = n.optString("url")
        if (kind == "ProgressBar") o.remove("label")
        if (kind == "Image" && !url.startsWith("icon:") && url != "avatar" && !url.startsWith("avatar:")) o.remove("url")
        for ((list, key) in listOf("options" to "checked", "series" to "values")) o.optJSONArray(list)?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.remove(key) }
        return canon(o)
    }

    /**
     * What a push changed since the card was drawn: null when it must be drawn anew (another layout: the plan around its
     * components, the component ids or their order, or a node apart from its value fields); else the components to write in
     * place — the ones whose node, bound value or hub button state changed.
     */
    fun changes(was: Plan, wasData: JSONObject, wasCard: JSONObject, now: Plan, data: JSONObject, card: JSONObject): List<String>? {
        fun around(p: Plan) = canon(JSONObject(p.raw).apply { remove("components"); remove("data") })
        if (around(was) != around(now) || was.byId.keys.toList() != now.byId.keys.toList()) return null
        val out = ArrayList<String>()
        for ((id, n) in now.byId) {
            val old = was.byId.getValue(id)
            if (layoutOf(old) != layoutOf(n)) return null
            val bind = n.optString("bind")
            if (canon(old) != canon(n) || (bind.isNotEmpty() && canon(read(wasData, bind)) != canon(read(data, bind))) ||
                canon(wasCard.optJSONObject("actions")?.opt(id)) != canon(card.optJSONObject("actions")?.opt(id))) out.add(id)
        }
        return out
    }

    /** A drawn component's control: whether the owner is at it right now, and writing a node's values on it (false: it cannot). */
    class Control(val editing: () -> Boolean = { false }, val write: (JSONObject) -> Boolean)

    /** The new values of [ids] written on their controls, leaving alone one the owner is at; false when the card must be drawn anew. */
    fun write(ids: List<String>, byId: Map<String, JSONObject>, controls: Map<String, Control>): Boolean {
        for (id in ids) {
            val c = controls[id] ?: return false
            if (!c.editing() && !c.write(byId.getValue(id))) return false
        }
        return true
    }

    // --- a card's mini app (MOBILE-ARCH §12.4) ---

    /** Where the mini apps of cards without an app run (.invalid never resolves); a card of an app runs at its app's origin. */
    const val CARD_ORIGIN = "https://card.ash-card.invalid"
    const val MINI_MAX = 64 * 1024
    private val MINI_METHODS = setOf("ash/send", "ash/call", "ash/ask", "ash/tell")

    /**
     * What goes after the page's CSP and port shim ([HostPage]): the theme as CSS variables (`--ash-bg` …) and `window.ash` —
     * `send(action, context)`, and for a card of an app ([full]) `call(member, word, body)`, `ask(text)`, `tell(text)`, each a
     * Promise of the hub's answer `{state, text, result?}`. Each is a JSON-RPC message the shim sends on the port.
     */
    fun miniHead(vars: Map<String, String>, dark: Boolean, full: Boolean): String {
        val css = vars.entries.joinToString(";") { "--ash-${it.key}:${it.value}" }
        return "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>:root{$css;color-scheme:${if (dark) "dark" else "light"}}</style><script>" + """
(function(){
  var post = window.postMessage, seq = 0, wait = {};
  function rpc(method, params, ok){ var id = "a" + (++seq); if (ok) wait[id] = ok; post.call(window, {jsonrpc: "2.0", id: id, method: method, params: params}, "*"); }
  window.addEventListener("message", function(e){
    var m = e.data; if (!m || m.jsonrpc !== "2.0" || !wait.hasOwnProperty(m.id)) return;
    var ok = wait[m.id]; delete wait[m.id]; ok(m.result || {state: "failed", text: ""});
  });
  function req(method, params){ return new Promise(function(ok){ rpc(method, params, ok); }); }
  var api = {send: function(a, c){ rpc("ash/send", {action: String(a), context: c === undefined ? {} : c}); }};
  if ($full) {
    api.call = function(m, w, body){ return req("ash/call", {member: String(m), word: String(w), body: body === undefined ? {} : body}); };
    api.ask = function(t){ return req("ash/ask", {text: String(t)}); };
    api.tell = function(t){ return req("ash/tell", {text: String(t)}); };
  }
  Object.defineProperty(window, "ash", {value: Object.freeze(api), writable: false, configurable: false});
})();
""".trim() + "</script>"
    }

    /**
     * A message that came on a mini app's port, read: null when refused (over [MINI_MAX], not JSON-RPC 2.0, not one of the four
     * methods, or a call / ask / tell from a card without an [app]); else its id and what it asks — `{send: {action, context}}`
     * or the act's `request` ([miniRequest]), null when not in shape. Who it is from is the host's, never read from it.
     */
    fun miniMessage(raw: String?, app: Boolean): Pair<Any?, JSONObject?>? {
        if (raw == null || raw.length > MINI_MAX || raw.toByteArray(Charsets.UTF_8).size > MINI_MAX) return null
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val method = m.opt("method") as? String
        if (m.opt("jsonrpc") != "2.0" || method !in MINI_METHODS || (!app && method != "ash/send")) return null
        val id = m.opt("id")
        val p = m.optJSONObject("params") ?: JSONObject()
        if (method == "ash/send") {
            val action = (p.opt("action") as? String)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return id to null
            return id to JSONObject().put("send", JSONObject().put("action", action).put("context", p.optJSONObject("context") ?: JSONObject()))
        }
        return id to miniRequest(JSONObject().put(method!!.removePrefix("ash/"), p).toString())
    }
}

/**
 * Cards in the conversation (`person:owner/show {a2ui}`, `form`) drawn natively from the plan the hub resolved: the same component
 * language as the home-screen cards, with the widget's colours, icons, images and charts, in the chat's own card shell.
 *
 * The chat makes a row again whenever an item changes; what the owner is doing on a card is kept here, by card id: the working copy
 * of its data (inputs write into it at their `bind`), the passwords typed (never in the data, never saved; they go only to
 * `service:vault/set`), the tab shown, the field with the cursor. A card's view is one holder that stays the same view, so the chat
 * keeps it where it is. A push that changes only values is written on the controls in place ([ChatCardModel.changes]), never
 * on a control the owner is at right now; anything else draws the card anew.
 */
class ChatCards(
    /** The chat's activity; for a picture ([preview]), a context in the theme asked for. */
    private val ctx: Context,
    private val port: HumanPort?,
    /** The owner's `say` to an agent, through the chat's outbox (so it shows as the owner's message). */
    private val post: (String, JSONObject) -> Unit,
    private val toast: (String) -> Unit,
    /** Drawn for a picture (`card.preview`): no 👍 / 👎 footer, a mini app as a block of its size, the clock's time now. */
    private val preview: Boolean = false,
    private val refresh: () -> Unit,
) {
    private val activity: Activity? = ctx as? Activity
    private val c = AshUi.p(ctx)
    private val night = AshUi.night(ctx)
    private val main = Handler(Looper.getMainLooper())
    private fun dp(v: Number) = AshUi.dp(ctx, v.toFloat())
    private fun dpF(v: Number) = AshUi.dpF(ctx, v.toFloat())

    private inner class Card(val id: String) {
        var card = JSONObject()
        var plan: ChatCardModel.Plan? = null
        /** The working copy of the card's data. */
        var data = JSONObject()
        var updatedAt = Long.MIN_VALUE
        val tabs = HashMap<String, Int>()
        /** Sent or cancelled from here, until the window says so. */
        var local: String? = null
        var busy = false
        var draftSeq = 0
        var pending: Runnable? = null
        /** What was drawn last (in place or anew): the plan, the data, the card, and the rest of what is drawn ([frame]). */
        var drawn: Drawn? = null
        /** The 👍 / 👎 tapped here, until the item says it. */
        var feedbackLocal: String? = null
        /** Pictures still on their way in the last drawing. */
        var waitingImages = 0
        /** Presses of buttons the hub runs, waiting for its answer here: component id -> the press. */
        val pressing = HashMap<String, Long>()
        /** A press that did not reach the hub (or got no answer in time), by component, until the card says more. */
        val failedHere = HashMap<String, String>()
        /** 「已复制」 under a copy button until this (uptime ms), by component. */
        val copied = HashMap<String, Long>()
        /** 「存成应用」 was pressed here (hidden from then on). */
        var keeping = false
        /** The 「常驻」 switch as turned here, until the card says the same; and the line after it could not be changed (until uptime ms). */
        var pinLocal: Boolean? = null
        var pinFailedUntil = 0L
        fun pinned() = pinLocal ?: card.optBoolean("pinned")
        /** The chat's card shell takes the conversation's width; a picture of it is 330 dp wide. */
        val holder: FrameLayout = if (preview) Capped(ctx, dp(AshTokens.Size.cardMaxW)) else FrameLayout(ctx)
        /** The text boxes drawn, by component id (to put the cursor back after drawing again). */
        val fields = HashMap<String, EditText>()
        /** The controls drawn, by component id, and the footer's writer (false: it cannot show the card now in place). */
        val controls = HashMap<String, ChatCardModel.Control>()
        var footer: (() -> Boolean)? = null
        /** Mini apps, by component id. */
        val minis = HashMap<String, Mini>()
        /** The row is on screen (its mini apps live only then). */
        var onScreen = false

        init {
            if (!preview) holder.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                override fun onViewAttachedToWindow(v: View) { onScreen = true; minis.values.forEach { it.sync() } }
                override fun onViewDetachedFromWindow(v: View) { onScreen = false; minis.values.forEach { it.sync() } }
            })
        }

        fun state(): String {
            local?.let { return it }
            if (card.optString("life") == "closed") return "closed"
            val s = card.optString("state").ifEmpty { "open" }
            val ends = card.optJSONObject("form")?.optLong("expires_at") ?: 0L
            return if (s == "open" && ends > 0 && ends <= System.currentTimeMillis()) "expired" else s
        }
        fun open() = state() == "open"
        fun feedback() = ChatCardModel.feedbackShown(feedbackLocal, card.optString("feedback").ifEmpty { null })
        /** All a drawing shows but the plan, the data and the values a push writes in place (life, fed_at, pinned, feedback, actions). */
        fun frame(): String {
            val now = SystemClock.uptimeMillis()
            return listOf("app", "temporary_app", "owner").joinToString("|") { card.opt(it)?.toString().orEmpty() } +
                "|${state()}|${card.has("form")}|$busy|$tabs|$keeping|${pressing.keys}|$failedHere|${copied.filterValues { it > now }.keys}|${pinFailedUntil > now}"
        }
    }

    private class Drawn(val plan: ChatCardModel.Plan, val data: JSONObject, val card: JSONObject, val frame: String)

    private val cards = HashMap<String, Card>()
    /** Presses counted, so a late answer or timeout finds only its own press. */
    private var presses = 0L
    /** Password boxes: card id -> the box's bind path -> what is typed. In memory only. */
    private val secrets = HashMap<String, HashMap<String, String>>()
    /** A push is being written on the controls: what they report back is not the owner's change. */
    private var writing = false

    /** The view of a card item (`type: "card"`, `card.type: "a2ui"`); the same view each time for the same card. */
    fun view(item: JSONObject): View {
        val card = item.optJSONObject("card") ?: JSONObject()
        val plan = ChatCardModel.plan(card.optJSONObject("plan")) ?: return plain(card.optString("text"))
        val id = card.optString("id").ifEmpty { item.optString("id") }
        val st = cards.getOrPut(id) { Card(id) }
        // What the hub now says about a button replaces what failed here.
        val was = st.card.optJSONObject("actions")
        val now = card.optJSONObject("actions")
        st.failedHere.keys.removeAll { k -> was?.optJSONObject(k)?.toString() != now?.optJSONObject(k)?.toString() }
        st.card = card
        if (st.pinLocal == card.optBoolean("pinned")) st.pinLocal = null
        val updated = card.optLong("updated_at")
        // A newer version from the hub (the creator changed it, or another screen did) is taken; what the owner is putting in a
        // control right now stays theirs (the next draft carries it).
        if (st.plan == null || updated > st.updatedAt) {
            val data = JSONObject(plan.data.toString())
            for ((cid, ctl) in st.controls) if (ctl.editing()) st.plan?.byId?.get(cid)?.optString("bind")?.takeIf { it.isNotEmpty() }?.let { b ->
                ChatCardModel.read(st.data, b)?.let { ChatCardModel.write(data, b, it) }
            }
            st.plan = plan; st.data = data; st.updatedAt = updated
        }
        if (card.optString("state").ifEmpty { "open" } != "open") st.local = null
        if (st.feedbackLocal != null && st.feedbackLocal == card.optString("feedback")) st.feedbackLocal = null
        show(st)
        return st.holder
    }

    /** Pictures still on their way in the cards drawn last. */
    fun waitingImages(): Int = cards.values.sumOf { it.waitingImages }

    /** Draws every card again (a picture that has come in since is in it now). */
    fun redraw() { for (st in cards.values) paint(st) }

    fun close() {
        for (st in cards.values) {
            st.pending?.let(main::removeCallbacks)
            st.minis.values.forEach { it.drop() }
            st.minis.clear()
        }
        secrets.clear()
    }

    // --- drawing ---

    /** [st] as it is now: written in place when only values changed since it was drawn, else drawn anew. */
    private fun show(st: Card) {
        val plan = st.plan ?: return
        val d = st.drawn
        val ids = if (d != null && d.frame == st.frame()) ChatCardModel.changes(d.plan, d.data, d.card, plan, st.data, st.card) else null
        if (ids == null) return paint(st)
        writing = true
        val done = try { ChatCardModel.write(ids, plan.byId, st.controls) && st.footer?.invoke() != false }
            catch (e: Exception) { Log.w(TAG, "card ${st.id} could not be written in place", e); false }
            finally { writing = false }
        if (!done) return paint(st)
        st.drawn = Drawn(plan, JSONObject(st.data.toString()), st.card, st.frame())
        st.minis.values.forEach { it.sync() }
    }

    /** Draws [st] anew (the cursor stays in its box). */
    private fun paint(st: Card) {
        val plan = st.plan ?: return
        val state = st.state()
        val focused = st.holder.findFocus() as? EditText
        val focusId = st.fields.entries.firstOrNull { it.value === focused }?.key
        val selection = focused?.let { it.selectionStart to it.selectionEnd }
        st.fields.clear(); st.controls.clear(); st.footer = null
        st.waitingImages = 0
        val draw = Draw(st, plan, state)
        val drawn = runCatching { draw.card() }.getOrElse { Log.w(TAG, "card ${st.id} could not be drawn", it); null }
        st.holder.removeAllViews()
        st.holder.addView(drawn ?: plain(st.card.optString("text")), FrameLayout.LayoutParams(MATCH, WRAP))
        st.drawn = if (drawn == null) null else Drawn(plan, JSONObject(st.data.toString()), st.card, st.frame())
        for (gone in st.minis.keys - draw.webs) st.minis.remove(gone)?.drop()
        st.minis.values.forEach { it.sync() }
        if (focusId != null) st.fields[focusId]?.let { f ->
            f.requestFocus()
            selection?.let { (a, b) -> val n = f.text.length; f.setSelection(a.coerceIn(0, n), b.coerceIn(0, n)) }
        }
    }

    /** A card that cannot be drawn: its plain text. */
    private fun plain(text: String): View = AshUi.card(ctx).apply {
        addView(AshUi.text(ctx, Md.render(text.ifBlank { "一张卡片" }, c.surface2, c.her), AshTokens.Type.body, c.text2))
    }

    private enum class Slot { COLUMN, ROW, STRIP, STACK }

    /** One drawing of one card. */
    private inner class Draw(val st: Card, val plan: ChatCardModel.Plan, val state: String) {
        val readOnly = state != "open"
        val accentTint: Tint = plan.accent?.let { a -> runCatching { CardSpec.tint(a) }.getOrNull() } ?: pair { it.you }
        val accent = accentTint.pick(night)
        val webs = HashSet<String>()
        private var inButton = false
        private val styles = HashMap<String, CStyle>()

        /** Theme names are the app's own colours here (the chat's card, not a widget on the wallpaper); others as on a widget. */
        fun tint(raw: Any?): Tint? = when (raw) {
            "accent" -> accentTint
            is String -> THEME[raw] ?: runCatching { CardSpec.tint(raw) }.getOrNull()
            else -> runCatching { CardSpec.tint(raw) }.getOrNull()
        }

        fun style(n: JSONObject): CStyle = styles.getOrPut(n.optString("id")) { runCatching { CardSpec.style(n.optJSONObject("style"), ::tint) }.getOrDefault(CStyle()) }
        fun byId(id: String) = plan.byId.getValue(id)

        /** The chat's card shell (surface, rounded, 14 dp in from every side); the card's root draws inside it. */
        fun card(): View = AshUi.card(ctx).apply {
            setPadding(dp(14), dp(14), dp(14), dp(14))
            node(plan.root, null)?.let { addView(it, params(byId(plan.root), Slot.COLUMN, null)) }
            ChatCardModel.stateLine(state)?.let { line ->
                addView(AshUi.text(ctx, line, AshType(12f, 16f, 500, Role.TEXT_3)).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(MATCH, WRAP))
            }
            // Its height is held from the first drawing: choosing one, live data coming, sleeping change only what it says.
            if (!preview && st.card.optJSONObject("form") == null) addView(footer(), LinearLayout.LayoutParams(MATCH, dp(FOOTER_DP)))
            else {
                fun shown() = caption() != null || (!preview && ChatCardModel.reservesCaption(st.card))
                val had = shown()
                val line = captionView("")
                if (had) addView(line, LinearLayout.LayoutParams(MATCH, dp(FOOTER_DP)))
                st.footer = { if (shown() != had) false else { line.text = caption().orEmpty(); true } }
            }
            st.footer?.invoke()
        }

        private fun caption() = if (st.pinFailedUntil > SystemClock.uptimeMillis()) ChatCardModel.PIN_FAILED else ChatCardModel.caption(st.card, pinned = st.pinned())

        /** 「HH:MM 更新」 or 「已休眠 · HH:MM 的数据」: small and quiet. */
        private fun captionView(text: String): TextView = AshUi.text(ctx, text, AshType(11.5f, 15f, 400, Role.TEXT_3)).apply {
            gravity = Gravity.CENTER_VERTICAL; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }

        /**
         * The card's last line: the caption at the start; at the end 「存成应用」 (a card whose app exists only for it), and 👍 / 👎,
         * small and quiet — the one the owner gave last is chosen, and tapping it again does nothing. A push changes what it says
         * in place ([Card.footer]).
         */
        private fun footer(): View = AshUi.hstack(ctx, 4).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            val line = captionView("")
            addView(line, LinearLayout.LayoutParams(0, MATCH, 1f))
            if (st.card.optBoolean("temporary_app") && !st.keeping && !readOnly) addView(AshUi.text(ctx, "存成应用", AshType(12f, 16f, 500, null), c.youText).apply {
                gravity = Gravity.CENTER; setPadding(dp(8), 0, dp(8), 0); isClickable = true
                contentDescription = "把这张卡片的应用留下来"
                setOnClickListener { keep(st) }
            }, LinearLayout.LayoutParams(WRAP, MATCH))
            // 「常驻」: the owner keeps a card of an app running off screen; there from the first drawing, for every such card.
            val sw = MiniSwitch(ctx, accent, c.surface3)
            val pinRow = AshUi.hstack(ctx, 4).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6), 0, dp(6), 0); isClickable = true
                addView(AshUi.text(ctx, ChatCardModel.PIN_LABEL, AshType(11.5f, 15f, 400, Role.TEXT_3)))
                addView(sw, LinearLayout.LayoutParams(dp(24), dp(14)))
                setOnClickListener { pin(st, !st.pinned()) }
            }
            if (ChatCardModel.pinnable(st.card) && !preview) addView(pinRow, LinearLayout.LayoutParams(WRAP, MATCH))
            val thumbs = listOf("up" to R.drawable.ash_ic_thumb_up, "down" to R.drawable.ash_ic_thumb_down).map { (which, icon) ->
                val iv = ImageView(ctx)
                val box = FrameLayout(ctx).apply {
                    setPadding(dp(8), 0, dp(8), 0)
                    contentDescription = if (which == "up") "有用" else "没用"
                    setOnClickListener { feedback(st, which) }
                    addView(iv, FrameLayout.LayoutParams(dp(14), dp(14), Gravity.CENTER))
                }
                addView(box, LinearLayout.LayoutParams(WRAP, MATCH))
                Triple(which, box, iv to icon)
            }
            st.footer = {
                line.text = caption().orEmpty()
                val on = st.pinned()
                pinRow.contentDescription = "${ChatCardModel.PIN_LABEL}：${if (on) "开" else "关"}"
                sw.on = on
                val shown = st.feedback()
                for ((which, box, pair) in thumbs) {
                    val chosen = shown == which
                    box.background = if (chosen) AshUi.rounded(c.surface2, dpF(FOOTER_DP / 2f)) else null
                    box.isSelected = chosen
                    pair.first.setImageDrawable(ctx.getDrawable(pair.second)?.mutate()?.apply { setTint(if (chosen) c.text else c.text3) })
                    pair.first.alpha = if (chosen) 1f else 0.7f
                }
                true
            }
        }

        /** Writers of the components drawn, by id, as [build] leaves them for [node]. */
        private val own = HashMap<String, ChatCardModel.Control>()

        /** [n]'s control: [write] puts a new node's values on what was drawn (false: it cannot); [editing] is the owner at it now. */
        private fun control(n: JSONObject, editing: () -> Boolean = { false }, write: (JSONObject) -> Boolean) {
            own[n.optString("id")] = ChatCardModel.Control(editing, write)
        }

        fun node(id: String, ink: Int?): View? {
            val n = plan.byId[id] ?: return null
            val s = style(n)
            val color = s.color?.pick(night) ?: ink
            val v = runCatching { build(n, s, color) }.getOrElse { Log.w(TAG, "card ${st.id}: ${n.optString("component")} $id left out", it); null } ?: return null
            decorate(v, n, s)
            // Hidden is a value: the view is there, gone until it shows.
            fun show(m: JSONObject) { v.visibility = if (m.optBoolean("visible", true)) View.VISIBLE else View.GONE }
            show(n)
            val w = own.remove(id)
            st.controls[id] = ChatCardModel.Control(w?.editing ?: { false }) { m ->
                show(m)
                // Without a writer of its own, only being shown can change in place (a tap's disabled draws it anew).
                w?.write?.invoke(m) ?: (m.optBoolean("disabled") == n.optBoolean("disabled"))
            }
            return v
        }

        private fun build(n: JSONObject, s: CStyle, ink: Int?): View? = when (n.optString("component")) {
            "Text" -> text(n, s, ink)
            "Badge" -> badge(n, s)
            "Image" -> image(n, s, ink)
            "Icon" -> icon(n, s, ink)
            "Row", "Column" -> box(n, ink)
            "List" -> list(n, ink)
            "Stack" -> FrameLayout(ctx).apply {
                val align = n.optString("align").ifEmpty { null }
                for (id in ids(n)) node(id, ink)?.let { addView(it, params(byId(id), Slot.STACK, align)) }
            }
            "Grid" -> grid(n, n.optInt("columns", 2).coerceIn(1, 12), ink)
            "Card" -> AshUi.vstack(ctx).apply {
                background = AshUi.rounded(c.surface2, dpF(s.cornerRadius ?: 16f))
                setPadding(dp(12), dp(12), dp(12), dp(12))
                n.optString("child").takeIf { it.isNotEmpty() }?.let { id -> node(id, ink)?.let { addView(it, params(byId(id), Slot.COLUMN, null)) } }
            }
            "Tabs" -> tabs(n, ink)
            "Divider" -> View(ctx).apply { setBackgroundColor(s.color?.pick(night) ?: c.line) }
            "Spacer" -> Space(ctx)
            "Button" -> button(n)
            "CheckBox" -> check(n, ink)
            "Switch" -> switch(n, ink)
            "ChoicePicker" -> choice(n)
            "ProgressBar" -> progress(n, s, ink)
            "Clock" -> if (preview) {
                // A TextClock off screen never sets its text: the time now, as it would show it.
                val zone = n.optString("timeZone").takeIf { it.isNotEmpty() }?.let { java.util.TimeZone.getTimeZone(it) } ?: java.util.TimeZone.getDefault()
                AshUi.style(TextView(ctx), textType(s, BODY), ink).apply {
                    text = android.text.format.DateFormat.format(n.optString("format").ifEmpty { "HH:mm" }, java.util.Calendar.getInstance(zone))
                }
            } else TextClock(ctx).apply {
                AshUi.style(this, textType(s, BODY), ink)
                val f = n.optString("format").ifEmpty { "HH:mm" }
                format12Hour = f; format24Hour = f
                n.optString("timeZone").takeIf { it.isNotEmpty() }?.let { timeZone = it }
            }
            "Timer" -> Chronometer(ctx).apply {
                AshUi.style(this, textType(s, BODY), ink)
                val now = System.currentTimeMillis()
                if (n.has("until")) { base = SystemClock.elapsedRealtime() + (n.optLong("until") - now); isCountDown = true }
                else base = SystemClock.elapsedRealtime() - (now - n.optLong("since"))
                start()
            }
            "Chart" -> ChartView(ctx, AshChart.parse(n, ::tint), night).also { v ->
                control(n) { m -> val chart = runCatching { AshChart.parse(m, ::tint) }.getOrNull(); if (chart != null) v.chart = chart; chart != null }
            }
            "TextField" -> field(n)
            "DateTimeInput" -> dateTime(n)
            "Slider" -> slider(n, ink)
            "Table" -> table(n, ink)
            "Html" -> miniApp(n)
            "Skeleton" -> skeleton()
            else -> null   // a newer hub's component: left out
        }

        /** What every component takes: background, padding, opacity, a description, and a tap for a non-button with an action. */
        private fun decorate(v: View, n: JSONObject, s: CStyle) {
            val kind = n.optString("component")
            s.background?.let { v.background = AshUi.rounded(it.pick(night), dpF(s.cornerRadius ?: 0f)) }
            if (kind == "Image" || kind == "Html") s.cornerRadius?.let { clip(v, dpF(it)) }
            s.padding?.let { p -> v.setPaddingRelative(dp(p[3]), dp(p[0]), dp(p[1]), dp(p[2])) }
            s.opacity?.let { v.alpha = it.coerceIn(0f, 1f) }
            n.optString("a11y").takeIf { it.isNotEmpty() }?.let { v.contentDescription = it }
            if (kind !in TAPPED_ITSELF && n.optJSONObject("action") != null && !readOnly && !n.optBoolean("disabled")) {
                v.isClickable = true
                v.setOnClickListener { act(st, n) }
            }
        }

        // --- layout ---

        fun ids(n: JSONObject): List<String> = n.optJSONArray("children")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } } ?: emptyList()

        private fun px(d: Dim?): Int? = when (d) { Dim.Fill -> MATCH; Dim.Wrap -> WRAP; is Dim.Dp -> dp(d.dp); null -> null }

        /** A component's own size when its style gives none (images by variant, a chart's height, a line, a placeholder). */
        private fun pref(n: JSONObject, s: CStyle, slot: Slot): Pair<Int?, Int?> = when (n.optString("component")) {
            "Image" -> {
                val url = n.optString("url")
                val avatar = url == "avatar" || url.startsWith("avatar:")
                if (url.startsWith("icon:")) dp(s.fontSize ?: 24f).let { it to it }
                else when (n.optString("variant").ifEmpty { if (avatar) "avatar" else "mediumFeature" }) {
                    "icon" -> dp(24) to dp(24)
                    "avatar" -> dp(if (n.has("variant")) 40 else 36) to dp(if (n.has("variant")) 40 else 36)
                    "smallFeature" -> dp(64) to dp(64)
                    "largeFeature" -> (if (slot == Slot.COLUMN || slot == Slot.STACK) MATCH else dp(180)) to dp(180)
                    "header" -> (if (slot == Slot.COLUMN || slot == Slot.STACK) MATCH else dp(160)) to dp(100)
                    else -> (if (slot == Slot.COLUMN || slot == Slot.STACK) MATCH else dp(120)) to dp(120)
                }
            }
            "Icon" -> dp(s.fontSize ?: ICON_DP).let { it to it }
            "Chart" -> MATCH to (px(s.height) ?: dp(120))
            "Divider" -> if (n.optString("axis") == "vertical") dp(1) to MATCH else MATCH to dp(1)
            "Spacer" -> if (n.has("size")) dp(n.optDouble("size")).let { it to it } else null to null
            "Skeleton" -> MATCH to dp(16)
            else -> null to null
        }

        /** How a child sits in its parent: A2UI's align (a Column stretches by default), weights, sizes, margins. */
        fun params(n: JSONObject, slot: Slot, align: String?, stretchAll: Boolean = false): ViewGroup.LayoutParams {
            val s = style(n)
            val kind = n.optString("component")
            val (pw, ph) = pref(n, s, slot)
            var weight = n.optDouble("weight", 0.0).toFloat().takeIf { it > 0f } ?: if (stretchAll || (kind == "Spacer" && !n.has("size"))) 1f else 0f
            val lp: ViewGroup.MarginLayoutParams = when (slot) {
                Slot.COLUMN -> {
                    val w = px(s.width) ?: pw ?: if ((align ?: "stretch") == "stretch" && kind in STRETCHY) MATCH else WRAP
                    val h = if (weight > 0f) 0 else px(s.height) ?: ph ?: WRAP
                    LinearLayout.LayoutParams(w, h, weight).apply { gravity = when (align) { "center" -> Gravity.CENTER_HORIZONTAL; "end" -> Gravity.END; else -> Gravity.START } }
                }
                Slot.ROW, Slot.STRIP -> {
                    var w = if (weight > 0f && slot == Slot.ROW) 0 else px(s.width) ?: pw ?: WRAP
                    if (w == MATCH) { if (slot == Slot.ROW) { w = 0; weight = maxOf(weight, 1f) } else w = dp(240) }
                    if (slot == Slot.STRIP) weight = 0f
                    val h = px(s.height) ?: ph ?: if (align == "stretch") MATCH else WRAP
                    LinearLayout.LayoutParams(w, h, weight).apply {
                        gravity = when (align) { "start" -> Gravity.TOP; "end" -> Gravity.BOTTOM; "stretch" -> Gravity.FILL_VERTICAL; else -> Gravity.CENTER_VERTICAL }
                    }
                }
                Slot.STACK -> FrameLayout.LayoutParams(px(s.width) ?: pw ?: WRAP, px(s.height) ?: ph ?: WRAP, PLACES[s.place ?: align ?: "topStart"] ?: (Gravity.TOP or Gravity.START))
            }
            // A picture's box never waits for it: a side its style leaves to wrap is 16:9 of the other.
            if (kind == "Image") {
                if (lp.height == WRAP) lp.height = if (lp.width > 0) lp.width * 9 / 16 else ph ?: dp(120)
                if (lp.width == WRAP && lp.height > 0) lp.width = lp.height * 16 / 9
            }
            s.margin?.let { m -> lp.topMargin = dp(m[0]); lp.marginEnd = dp(m[1]); lp.bottomMargin = dp(m[2]); lp.marginStart = dp(m[3]) }
            return lp
        }

        private fun box(n: JSONObject, ink: Int?): LinearLayout {
            val column = n.optString("component") == "Column"
            val align = n.optString("align").ifEmpty { null }
            val justify = n.optString("justify").ifEmpty { null }
            val v = if (column) AshUi.vstack(ctx) else AshUi.hstack(ctx)
            if (!column) v.gravity = (when (justify) { "center" -> Gravity.CENTER_HORIZONTAL; "end" -> Gravity.END; else -> Gravity.START }) or
                (when (align) { "start" -> Gravity.TOP; "end" -> Gravity.BOTTOM; else -> Gravity.CENTER_VERTICAL })
            children(v, ids(n), if (column) Slot.COLUMN else Slot.ROW, align, justify, ink, gapOf(n))
            return v
        }

        /** A container's `gap` in px: the room between its children (none when not given). */
        private fun gapOf(n: JSONObject): Int = n.optDouble("gap", 0.0).takeIf { it.isFinite() && it > 0 }?.let { dp(it) } ?: 0

        /** [lp] with [gap] px more before it (above in a column, at the start in a row), on top of its own margin. */
        private fun spaced(lp: ViewGroup.LayoutParams, slot: Slot, gap: Int): ViewGroup.LayoutParams {
            if (gap > 0 && lp is ViewGroup.MarginLayoutParams) { if (slot == Slot.COLUMN) lp.topMargin += gap else lp.marginStart += gap }
            return lp
        }

        private fun children(box: LinearLayout, ids: List<String>, slot: Slot, align: String?, justify: String?, ink: Int?, gap: Int) {
            val drawn = ids.mapNotNull { id -> node(id, ink)?.let { byId(id) to it } }
            val spread = justify == "spaceBetween" || justify == "spaceAround" || justify == "spaceEvenly"
            fun gap() = box.addView(Space(ctx), if (slot == Slot.COLUMN) LinearLayout.LayoutParams(1, 0, 1f) else LinearLayout.LayoutParams(0, 1, 1f))
            if (spread && justify != "spaceBetween") gap()
            drawn.forEachIndexed { i, (n, v) ->
                box.addView(v, spaced(params(n, slot, align, justify == "stretch"), slot, if (i > 0) gap else 0))
                if (spread && i < drawn.lastIndex) gap()
            }
            if (spread && justify != "spaceBetween" && drawn.isNotEmpty()) gap()
        }

        private fun grid(n: JSONObject, columns: Int, ink: Int?): LinearLayout = AshUi.vstack(ctx).apply {
            val gap = gapOf(n)
            val drawn = ids(n).mapNotNull { id -> node(id, ink)?.let { id to it } }
            drawn.chunked(columns).forEachIndexed { r, row ->
                addView(AshUi.hstack(ctx).apply {
                    gravity = Gravity.TOP
                    fun cell(i: Int) = LinearLayout.LayoutParams(0, WRAP, 1f).apply { if (i > 0) marginStart = gap }
                    row.forEachIndexed { i, (id, v) -> addView(AshUi.vstack(ctx).apply { addView(v, params(byId(id), Slot.COLUMN, null)) }, cell(i)) }
                    for (i in row.size until columns) addView(Space(ctx), cell(i).apply { height = 0 })
                }, LinearLayout.LayoutParams(MATCH, WRAP).apply { if (r > 0) topMargin = gap })
            }
        }

        private fun list(n: JSONObject, ink: Int?): View {
            val align = n.optString("align").ifEmpty { null }
            if (n.optString("direction") == "horizontal") return HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(AshUi.hstack(ctx).apply {
                    gravity = Gravity.TOP
                    val gap = gapOf(n)
                    for (id in ids(n)) node(id, ink)?.let { addView(it, spaced(params(byId(id), Slot.STRIP, align ?: "start"), Slot.STRIP, if (childCount > 0) gap else 0)) }
                })
            }
            val columns = n.optInt("columns", 1)
            if (columns > 1) return grid(n, columns.coerceAtMost(12), ink)
            return AshUi.vstack(ctx).apply { children(this, ids(n), Slot.COLUMN, align, null, ink, gapOf(n)) }
        }

        private fun tabs(n: JSONObject, ink: Int?): View {
            val id = n.optString("id")
            val tabs = n.optJSONArray("tabs") ?: JSONArray()
            val titles = (0 until tabs.length()).map { tabs.optJSONObject(it)?.optString("title").orEmpty() }
            val selected = (st.tabs[id] ?: n.optInt("selected")).coerceIn(0, maxOf(0, titles.lastIndex))
            // Switching tabs is the owner's own business: drawn here at once, not part of the data.
            val pick = { i: Int -> st.tabs[id] = i; paint(st) }
            return AshUi.vstack(ctx, 10).apply {
                val bar = if (titles.size <= 4) AshUi.segmented(ctx, titles, selected) { pick(it) }
                else HorizontalScrollView(ctx).apply {
                    isHorizontalScrollBarEnabled = false
                    addView(AshUi.hstack(ctx, 6).apply { titles.forEachIndexed { i, t -> addView(AshUi.option(ctx, t, selected = i == selected) { pick(i) }) } })
                }
                addView(bar, LinearLayout.LayoutParams(MATCH, WRAP))
                tabs.optJSONObject(selected)?.optString("child")?.takeIf { it.isNotEmpty() }?.let { child -> node(child, ink)?.let { addView(it, params(byId(child), Slot.COLUMN, null)) } }
            }
        }

        // --- what is shown ---

        private fun textType(s: CStyle, base: AshType): AshType {
            val size = s.fontSize ?: base.sizeSp
            return AshType(size, s.lineHeight ?: if (s.fontSize != null) size * 1.4f else base.lineSp, s.fontWeight ?: base.weight, base.role)
        }

        private fun text(n: JSONObject, s: CStyle, ink: Int?): TextView {
            val variant = n.optString("variant").ifEmpty { "body" }
            val type = textType(s, TYPES[variant] ?: BODY)
            val tv = AshUi.text(ctx, "", type, ink?.let { if (variant == "caption") AshUi.withAlpha(it, 0.7f) else it })
            if (s.italic == true) {
                if (Build.VERSION.SDK_INT >= 28) tv.typeface = Typeface.create(Typeface.DEFAULT, type.weight.coerceIn(1, 1000), true)
                else tv.setTypeface(tv.typeface, Typeface.ITALIC)
            }
            var flags = tv.paintFlags
            if (s.underline) flags = flags or Paint.UNDERLINE_TEXT_FLAG
            if (s.strikethrough) flags = flags or Paint.STRIKE_THRU_TEXT_FLAG
            tv.paintFlags = flags
            when (s.textAlign) {
                "center" -> tv.gravity = Gravity.CENTER_HORIZONTAL
                "end" -> tv.gravity = Gravity.END
                "justify" -> tv.justificationMode = android.text.Layout.JUSTIFICATION_MODE_INTER_WORD
            }
            s.maxLines?.let { tv.maxLines = it; tv.ellipsize = when (s.ellipsize) { "start" -> TextUtils.TruncateAt.START; "middle" -> TextUtils.TruncateAt.MIDDLE; "none" -> null; else -> TextUtils.TruncateAt.END } }
            s.letterSpacing?.let { tv.letterSpacing = it }
            val linkable = !inButton
            fun fill(m: JSONObject): Boolean {
                val body = Md.render(m.optString("text"), c.surface2, c.her)
                tv.text = body
                // Links open when tapped; inside a button the whole button is the tap.
                if (linkable && body.getSpans(0, body.length, ClickableSpan::class.java).isNotEmpty()) tv.movementMethod = LinkMovementMethod.getInstance()
                return true
            }
            fill(n)
            control(n, write = ::fill)
            return tv
        }

        private fun badge(n: JSONObject, s: CStyle): TextView {
            val tone = s.color?.pick(night) ?: accent
            return AshUi.text(ctx, n.optString("text"), AshType(11.5f, 14f, 600, null), tone).apply {
                gravity = Gravity.CENTER; setPadding(dp(8), dp(3), dp(8), dp(3))
                background = AshUi.rounded(AshUi.withAlpha(tone, 0.14f), dpF(11f))
                control(n) { m -> text = m.optString("text"); true }
            }
        }

        /** A built-in icon by name: Ash's own line icon, tinted with the node's colour (a name with none near it: a small circle). */
        private fun lineIcon(name: String, s: CStyle, ink: Int?): View {
            val color = s.color?.pick(night) ?: ink ?: c.text
            val size = dp(s.fontSize ?: ICON_DP)
            val res = ChatCardModel.ICONS[name]
            return ImageView(ctx).apply {
                val d = res?.let { ctx.getDrawable(it)?.mutate() }
                if (d != null) { d.setTint(color); scaleType = ImageView.ScaleType.FIT_CENTER; setImageDrawable(d) }
                else {
                    // The icons are drawn on a 24 grid with a 1.8 line: a ring of 10 in the middle of the box.
                    val ring = Math.round(size * 10f / 24f); val line = maxOf(1, Math.round(size * 1.8f / 24f))
                    scaleType = ImageView.ScaleType.CENTER
                    setImageDrawable(GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(line, color); setSize(ring, ring) })
                }
            }
        }

        private fun icon(n: JSONObject, s: CStyle, ink: Int?): View {
            val d = n.optString("svgPath")
            if (d.isEmpty()) return lineIcon(n.optString("name"), s, ink)
            val size = dp(s.fontSize ?: ICON_DP)
            return ImageView(ctx).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                CardImages.get(ctx, Img.Path(d, Tint(Color.WHITE, Color.WHITE)), size, size) {}?.let { setImageBitmap(it) }
                setColorFilter(s.color?.pick(night) ?: ink ?: c.text)
            }
        }

        private fun image(n: JSONObject, s: CStyle, ink: Int?): View {
            val url = n.optString("url")
            if (url.startsWith("icon:")) return lineIcon(url.removePrefix("icon:"), s, ink)
            val avatar = url == "avatar" || url.startsWith("avatar:")
            val variant = n.optString("variant").ifEmpty { if (avatar) "avatar" else "mediumFeature" }
            val fit = n.optString("fit").ifEmpty { if (variant in FEATURES) "cover" else "contain" }
            val iv = ImageView(ctx)
            iv.scaleType = when (fit) {
                "cover" -> ImageView.ScaleType.CENTER_CROP; "fill" -> ImageView.ScaleType.FIT_XY; "none" -> ImageView.ScaleType.CENTER
                "scaleDown" -> ImageView.ScaleType.CENTER_INSIDE; else -> ImageView.ScaleType.FIT_CENTER
            }
            var img = if (avatar) Img.Avatar(if (url.contains(':')) url.substringAfter(':') else "default") else Img.Url(url)
            val w = ctx.resources.displayMetrics.widthPixels
            // A picture still on its way is a soft block in its box; it is set when it arrives (a failed one stays the block).
            if (!avatar) iv.background = AshUi.rounded(c.surface2, 0f)
            fun load() { val want = img; CardImages.get(ctx, want, w, dp(360)) { if (img === want) load() }?.let { iv.setImageBitmap(it); iv.background = null } }
            load()
            if (iv.drawable == null && url.startsWith("https:") && !CardImages.failed.containsKey(url)) st.waitingImages++
            // Another picture (an avatar or an icon is drawn anew): the box stays, the new one is set when it arrives.
            var shown = url
            control(n) { m ->
                val u = m.optString("url")
                if (u != shown) { shown = u; img = Img.Url(u); iv.setImageDrawable(null); iv.background = AshUi.rounded(c.surface2, 0f); load() }
                true
            }
            clip(iv, s.cornerRadius?.let { dpF(it) } ?: if (variant == "avatar") -1f else dpF(12f))
            return iv
        }

        private fun button(n: JSONObject): View {
            val action = n.optJSONObject("action")
            val id = n.optString("id")
            val runs = ChatCardModel.hubAction(action)
            fun face(m: JSONObject) = (runs && ChatCardModel.pressBusy(id in st.pressing, hubState(id), System.currentTimeMillis(), ChatCardModel.pressTimeoutMs(action))) to m.optBoolean("disabled")
            val drawnFace = face(n)
            val face = buttonFace(n, if (drawnFace.first) "处理中…" else null)
            // A button the hub runs, or a copy, has its outcome line under it, held from the start.
            val line = if (!runs && action?.has("copy") != true) null else AshUi.text(ctx, "", AshType(11.5f, 15f, 400, Role.TEXT_2)).apply {
                minLines = 1; maxLines = 3; ellipsize = TextUtils.TruncateAt.END; maxWidth = dp(280)
            }
            fun fill() {
                val out = ChatCardModel.outcome((st.copied[id] ?: 0L) > SystemClock.uptimeMillis(), st.failedHere[id], hubState(id)) ?: return
                line?.text = out.first; line?.setTextColor(if (out.second) c.err else c.text2)
            }
            fill()
            // The hub's state of it: its line in place; running or not, pressable or not: the card is drawn anew.
            control(n) { m -> if (face(m) != drawnFace) false else { line?.text = ""; fill(); true } }
            if (line == null) return face
            return AshUi.vstack(ctx, 2).apply {
                addView(face, LinearLayout.LayoutParams(WRAP, WRAP))
                addView(line, LinearLayout.LayoutParams(WRAP, WRAP))
            }
        }

        private fun hubState(component: String): JSONObject? = st.card.optJSONObject("actions")?.optJSONObject(component)

        /** The button itself; [busyLabel] while a press runs (it cannot be pressed then). */
        private fun buttonFace(n: JSONObject, busyLabel: String?): View {
            val kind = when (n.optString("variant")) { "primary" -> AshUi.Kind.PRIMARY; "borderless" -> AshUi.Kind.GHOST; else -> AshUi.Kind.SECONDARY }
            val enabled = !readOnly && !st.busy && busyLabel == null && !n.optBoolean("disabled") && n.optJSONObject("action") != null
            // A button that cannot be pressed is plainly neutral (surface-2 and text-2), not a faded accent.
            val (bg, fg) = when {
                !enabled -> (if (kind == AshUi.Kind.GHOST) Color.TRANSPARENT else c.surface2) to c.text2
                kind == AshUi.Kind.PRIMARY -> accent to c.onYou
                kind == AshUi.Kind.SECONDARY -> c.youSoft to c.youText
                else -> Color.TRANSPARENT to c.youText
            }
            val radius = dp(AshTokens.Size.buttonSm) / 2f
            val childId = n.optString("child")
            val child = plan.byId[childId]
            val v: View = if (busyLabel != null || child == null || (child.optString("component") == "Text" && child.optJSONObject("style") == null)) {
                AshUi.button(ctx, busyLabel ?: ChatCardModel.label(plan.byId, n), kind, AshUi.BtnSize.SM).also { b ->
                    if (!enabled) { b.background = AshUi.rounded(bg, radius); b.setTextColor(fg) }
                    else if (kind == AshUi.Kind.PRIMARY && accent != c.you) b.background = AshUi.rounded(accent, radius)
                }
            } else {
                AshUi.hstack(ctx, 6).apply {
                    gravity = Gravity.CENTER; minimumHeight = dp(AshTokens.Size.buttonSm); setPadding(dp(14), dp(4), dp(14), dp(4))
                    background = AshUi.rounded(bg, radius)
                    inButton = true
                    try { node(childId, fg)?.let { addView(it, params(child, Slot.ROW, null)) } } finally { inButton = false }
                }
            }
            if (enabled) { v.isClickable = true; v.setOnClickListener { act(st, n) } }
            else { v.isEnabled = false; v.isClickable = false }
            return v
        }

        // --- inputs: each shows the working copy at its bind and writes the owner's change there ---

        private fun bindOf(n: JSONObject): String? = n.optString("bind").ifEmpty { null }
        private fun valueOf(n: JSONObject): Any? = bindOf(n)?.let { ChatCardModel.read(st.data, it) }
        private fun enabled(n: JSONObject) = !readOnly && !n.optBoolean("disabled")
        private fun put(n: JSONObject, value: Any) { val b = bindOf(n) ?: return; if (!writing) changed(st) { ChatCardModel.write(st.data, b, value) } }
        private fun fieldLabel(text: String) = AshUi.text(ctx, text, AshType(13f, 18f, 500, Role.TEXT_2))
        /** An input's label sits this far above its box. */
        private fun labelled() = AshUi.vstack(ctx, LABEL_GAP)
        private fun boxBackground() = AshUi.rounded(c.surface2, dpF(12f))

        private fun check(n: JSONObject, ink: Int?): View = CheckBox(ctx).apply {
            AshUi.style(this, BODY, ink ?: c.text)
            text = n.optString("label")
            buttonTintList = ColorStateList.valueOf(accent)
            fun fill(m: JSONObject): Boolean { isChecked = valueOf(m) as? Boolean ?: m.optBoolean("checked"); isEnabled = enabled(m); return true }
            fill(n)
            setOnCheckedChangeListener { _, on -> put(n, on) }
            control(n, write = ::fill)
        }

        private fun switch(n: JSONObject, ink: Int?): View = AshUi.hstack(ctx, 10).apply {
            addView(AshUi.text(ctx, n.optString("label"), BODY, ink), LinearLayout.LayoutParams(0, WRAP, 1f))
            val sw = AshUi.AshSwitch(ctx)
            fun fill(m: JSONObject): Boolean {
                sw.set(valueOf(m) as? Boolean ?: m.optBoolean("checked"))
                sw.isEnabled = enabled(m); sw.alpha = if (sw.isEnabled) 1f else 0.5f
                return true
            }
            fill(n)
            sw.onChange = { on -> put(n, on) }
            addView(sw)
            control(n, write = ::fill)
        }

        private fun choice(n: JSONObject): View {
            val all = n.optJSONArray("options") ?: JSONArray()
            val options = (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            val chosen = LinkedHashSet<String>()
            fun choose(m: JSONObject) {
                chosen.clear()
                val given = valueOf(m) as? JSONArray
                if (given != null) for (i in 0 until given.length()) chosen.add(given.optString(i))
                else m.optJSONArray("options")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.takeIf { it.optBoolean("checked") }?.let { chosen.add(it.optString("value")) } }
            }
            choose(n)
            val multiple = n.optBoolean("multiple")
            val chips = n.optBoolean("chips")
            val on = enabled(n)
            val box = labelled()
            n.optString("label").takeIf { it.isNotEmpty() }?.let { box.addView(fieldLabel(it)) }
            val holder: ViewGroup = if (chips) Flow(ctx, dp(8)) else AshUi.vstack(ctx, 8)
            fun fill() {
                holder.removeAllViews()
                for (o in options) {
                    val value = o.optString("value")
                    val selected = value in chosen
                    val tap: (() -> Unit)? = if (!on) null else ({
                        when {
                            multiple -> if (!chosen.remove(value)) chosen.add(value)
                            selected && chips -> chosen.clear()
                            else -> { chosen.clear(); chosen.add(value) }
                        }
                        fill()
                        // The data value of a ChoicePicker is the array of chosen values, in the options' order.
                        put(n, JSONArray(options.map { it.optString("value") }.filter { it in chosen }))
                    })
                    val v = AshUi.option(ctx, o.optString("label"), selected = selected, onClick = tap)
                    if (!on) v.alpha = if (selected) 0.7f else 0.4f
                    holder.addView(v, if (chips) ViewGroup.LayoutParams(WRAP, WRAP) else LinearLayout.LayoutParams(MATCH, WRAP))
                }
            }
            fill()
            box.addView(holder, LinearLayout.LayoutParams(MATCH, WRAP))
            control(n) { m -> if (enabled(m) != on) false else { choose(m); fill(); true } }
            return box
        }

        private fun field(n: JSONObject): View {
            val id = n.optString("id")
            val bind = bindOf(n)
            val variant = n.optString("variant").ifEmpty { "shortText" }
            val obscured = variant == "obscured"
            // A password box keeps what is typed here only (never in the data, never in a draft); the form sends it to the vault.
            val secretKey = bind ?: "#$id"
            val box = labelled()
            n.optString("label").takeIf { it.isNotEmpty() }?.let { box.addView(fieldLabel(it)) }
            val et = EditText(ctx).apply {
                AshUi.style(this, BODY, c.text)
                setHintTextColor(c.text3)
                background = boxBackground()
                setPadding(dp(12), dp(10), dp(12), dp(10))
                minHeight = dp(44)
                imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
                inputType = when (variant) {
                    "number" -> InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
                    "obscured" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                    "longText" -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                    else -> InputType.TYPE_CLASS_TEXT
                }
                if (variant == "longText") { minLines = 3; gravity = Gravity.TOP or Gravity.START }
                if (obscured) { setAutofillHints(View.AUTOFILL_HINT_PASSWORD); typeface = Typeface.DEFAULT }
                n.optString("placeholder").takeIf { it.isNotEmpty() }?.let { hint = it }
                setText(if (obscured) secrets[st.id]?.get(secretKey).orEmpty() else asText(valueOf(n)) ?: n.optString("text"))
                isEnabled = enabled(n)
                if (!isEnabled) alpha = 0.6f
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun afterTextChanged(s: Editable?) {
                        val t = s?.toString().orEmpty()
                        if (obscured) secrets.getOrPut(st.id) { HashMap() }[secretKey] = t
                        else put(n, t)
                    }
                })
            }
            st.fields[id] = et
            box.addView(et, LinearLayout.LayoutParams(MATCH, WRAP))
            // The owner is at it while it has the cursor or text is being composed; a password box is never written from data.
            control(n, editing = { et.hasFocus() || BaseInputConnection.getComposingSpanStart(et.text) >= 0 }) { m ->
                val t = asText(valueOf(m)) ?: m.optString("text")
                if (!obscured && et.text.toString() != t) et.setText(t)
                et.isEnabled = enabled(m); et.alpha = if (et.isEnabled) 1f else 0.6f
                true
            }
            return box
        }

        private fun asText(v: Any?): String? = when (v) { null -> null; is String -> v; is Number -> ChatCardModel.number(v); is Boolean -> v.toString(); else -> null }

        private fun dateTime(n: JSONObject): View {
            val enableDate = n.optBoolean("enableDate", true)
            val enableTime = n.optBoolean("enableTime", false)
            var value = (valueOf(n) as? String) ?: n.optString("text")
            val hint = when { enableDate && enableTime -> "选择日期和时间"; enableTime -> "选择时间"; else -> "选择日期" }
            val box = labelled()
            n.optString("label").takeIf { it.isNotEmpty() }?.let { box.addView(fieldLabel(it)) }
            val shown = AshUi.style(TextView(ctx), BODY, c.text).apply {
                background = boxBackground(); setPadding(dp(12), dp(10), dp(12), dp(10)); minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL
            }
            fun show() { shown.text = if (value.isEmpty()) hint else value.replace('T', ' '); shown.setTextColor(if (value.isEmpty()) c.text3 else c.text) }
            show()
            if (enabled(n)) shown.setOnClickListener {
                val activity = activity ?: return@setOnClickListener
                val (d0, t0) = ChatCardModel.isoParts(value)
                fun done(d: LocalDate?, t: LocalTime?) { value = ChatCardModel.iso(d, t); show(); put(n, value) }
                fun time(d: LocalDate?) {
                    val t = t0 ?: LocalTime.now()
                    TimePickerDialog(activity, { _, h, m -> done(d, LocalTime.of(h, m)) }, t.hour, t.minute, true).show()
                }
                if (enableDate) {
                    val d = d0 ?: LocalDate.now()
                    DatePickerDialog(activity, { _, y, mo, dd -> val picked = LocalDate.of(y, mo + 1, dd); if (enableTime) time(picked) else done(picked, null) },
                        d.year, d.monthValue - 1, d.dayOfMonth).show()
                } else time(null)
            } else shown.alpha = 0.6f
            box.addView(shown, LinearLayout.LayoutParams(MATCH, WRAP))
            control(n) { m -> if (enabled(m) != enabled(n)) false else { value = (valueOf(m) as? String) ?: m.optString("text"); show(); true } }
            return box
        }

        private fun slider(n: JSONObject, ink: Int?): View {
            val min = n.optDouble("min", 0.0)
            val max = n.optDouble("max", 100.0).let { if (it > min) it else min + 1 }
            val step = ChatCardModel.sliderStep(min, max, n.optDouble("step", Double.NaN))
            val notches = Math.round((max - min) / step).toInt().coerceIn(1, 100_000)
            fun at(m: JSONObject) = (valueOf(m) as? Number)?.toDouble() ?: m.optDouble("value", min)
            val start = at(n)
            val shown = AshUi.text(ctx, ChatCardModel.number(start), AshType(13f, 18f, 600, Role.TEXT_2))
            var dragging = false
            return AshUi.vstack(ctx, 2).apply {
                addView(AshUi.hstack(ctx, 8).apply {
                    addView(AshUi.text(ctx, n.optString("label"), AshType(13f, 18f, 500, Role.TEXT_2), ink), LinearLayout.LayoutParams(0, WRAP, 1f))
                    addView(shown)
                }, LinearLayout.LayoutParams(MATCH, WRAP))
                val bar = SeekBar(ctx).apply {
                    this.max = notches
                    progress = Math.round((start - min) / step).toInt().coerceIn(0, notches)
                    progressTintList = ColorStateList.valueOf(accent); thumbTintList = ColorStateList.valueOf(accent)
                    isEnabled = enabled(n)
                    setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                        override fun onProgressChanged(bar: SeekBar, p: Int, fromUser: Boolean) {
                            if (!fromUser) return
                            val v = ChatCardModel.sliderValue(min, max, step, p)
                            shown.text = ChatCardModel.number(v)
                            put(n, v)
                        }
                        override fun onStartTrackingTouch(bar: SeekBar) { dragging = true }
                        override fun onStopTrackingTouch(bar: SeekBar) { dragging = false }
                    })
                }
                addView(bar, LinearLayout.LayoutParams(MATCH, WRAP))
                control(n, editing = { dragging }) { m ->
                    val v = at(m)
                    shown.text = ChatCardModel.number(v)
                    bar.progress = Math.round((v - min) / step).toInt().coerceIn(0, notches)
                    bar.isEnabled = enabled(m)
                    true
                }
            }
        }

        private fun progress(n: JSONObject, s: CStyle, ink: Int?): View = AshUi.vstack(ctx, 6).apply {
            val label = n.optString("label").takeIf { it.isNotEmpty() }?.let { AshUi.text(ctx, it, AshTokens.Type.sub, ink).also(::addView) }
            val max = n.optDouble("max", 100.0)
            val bar = ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal).apply {
                isIndeterminate = false
                this.max = 1000
                progressTintList = ColorStateList.valueOf(s.color?.pick(night) ?: accent)
                progressBackgroundTintList = ColorStateList.valueOf(c.surface3)
            }
            addView(bar, LinearLayout.LayoutParams(MATCH, dp(6)))
            fun fill(m: JSONObject): Boolean {
                if (m.optString("label").isNotEmpty() != (label != null)) return false
                label?.text = m.optString("label")
                bar.progress = if (max > 0) (m.optDouble("value", 0.0) / max * 1000).roundToInt().coerceIn(0, 1000) else 0
                return true
            }
            fill(n)
            control(n, write = ::fill)
        }

        private fun table(n: JSONObject, ink: Int?): View {
            val header = n.optJSONArray("header") ?: JSONArray()
            val width = header.length()
            val t = TableLayout(ctx).apply {
                isStretchAllColumns = true
                showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
                dividerDrawable = GradientDrawable().apply { setColor(c.line); setSize(1, maxOf(1, dp(1))) }
            }
            fun row(cells: List<String>, head: Boolean) = TableRow(ctx).apply {
                // A cell is the card's Markdown, as a Text is.
                for (cell in cells) addView(AshUi.text(ctx, Md.render(cell, c.surface2, c.her), if (head) AshType(13f, 18f, 600, Role.INK) else AshType(13.5f, 19f, 400, Role.TEXT), if (head) null else ink).apply {
                    setPadding(dp(10), dp(7), dp(10), dp(7)); maxWidth = dp(260)
                })
            }
            t.addView(row((0 until width).map { header.optString(it) }, true))
            fun fill(m: JSONObject): Boolean {
                if (t.childCount > 1) t.removeViews(1, t.childCount - 1)
                val rows = m.optJSONArray("rows") ?: JSONArray()
                for (i in 0 until rows.length()) {
                    val r = rows.optJSONArray(i) ?: continue
                    t.addView(row((0 until width).map { if (it < r.length()) r.optString(it) else "" }, false))
                }
                return true
            }
            fill(n)
            control(n, write = ::fill)
            return HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false; isFillViewport = true
                background = AshUi.rounded(c.surface2, dpF(12f))
                clip(this, dpF(12f))
                addView(t)
            }
        }

        private fun skeleton(): View = View(ctx).apply {
            background = AshUi.rounded(c.surface2, dpF(8f))
            if (AshUi.motionOn(ctx)) {
                val pulse = ObjectAnimator.ofFloat(this, "alpha", 1f, 0.45f).apply { duration = 900; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE }
                addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                    override fun onViewAttachedToWindow(v: View) { pulse.start() }
                    override fun onViewDetachedFromWindow(v: View) { pulse.cancel() }
                })
            }
        }

        /** The sandboxed mini app, its height in dp, and under it 「存成应用」. */
        private fun miniApp(n: JSONObject): View {
            val id = n.optString("id")
            // A web view off screen draws nothing: in a picture the mini app is a block of its size.
            if (preview) return FrameLayout(ctx).apply {
                background = AshUi.rounded(c.surface2, dpF(12f))
                addView(AshUi.text(ctx, "小应用", AshTokens.Type.sub, c.text3), FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER))
                layoutParams = LinearLayout.LayoutParams(MATCH, dp(n.optDouble("height", 320.0)))
            }.let { block -> AshUi.vstack(ctx).apply { addView(block) } }
            webs.add(id)
            val vars = mapOf("bg" to c.bg, "surface" to c.surface, "text" to c.text, "text2" to c.text2, "accent" to accent, "line" to c.line)
                .mapValues { ChatCardModel.css(it.value) }
            val app = st.card.optString("app").takeIf { AppIds.valid(it) }
            val html = n.optString("html")
            val head = ChatCardModel.miniHead(vars, night, app != null)
            // The same page goes on across drawings; another page (or theme) is a new one.
            val mini = st.minis[id]?.takeIf { it.html == html && it.head == head && it.app == app }
                ?: Mini(st, id, app, html, head).also { st.minis.put(id, it)?.drop() }
            (mini.box.parent as? ViewGroup)?.removeView(mini.box)
            clip(mini.box, dpF(12f))
            return AshUi.vstack(ctx, 4).apply {
                addView(mini.box, LinearLayout.LayoutParams(MATCH, dp(n.optDouble("height", 320.0))))
                val owner = st.card.optString("owner")
                // A card of an app already is one; a card whose app exists only for it keeps it with the footer's 「存成应用」.
                if (owner.startsWith("agent:") && st.card.optString("app").isEmpty() && !st.card.optBoolean("temporary_app")) addView(AshUi.button(ctx, "存成应用", AshUi.Kind.GHOST, AshUi.BtnSize.SM).also { b ->
                    if (readOnly) AshUi.disable(b)
                    else b.setOnClickListener { post(owner, ChatCardModel.sayBody("把这个小应用存成应用", st.id, "save_app", JSONObject().put("component", id), st.data)) }
                }, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.END })
            }
        }
    }

    // --- what the owner does on a card ---

    /** A value changed: kept in the working copy at once, and told to the hub (`card.draft`) once the owner pauses. */
    private fun changed(st: Card, write: () -> Unit) {
        write()
        st.pending?.let(main::removeCallbacks)
        val r = Runnable { st.pending = null; draft(st) }
        st.pending = r
        main.postDelayed(r, DRAFT_MS)
    }

    private fun draft(st: Card) {
        if (!st.open()) return
        val port = port ?: return
        val seq = ++st.draftSeq
        port.call("person:owner", "card.draft", JSONObject().put("card", st.id).put("data", JSONObject(st.data.toString()))) { data, failure ->
            // Quietly: a draft that did not arrive is sent again with the next change, and the values are on the screen.
            if (failure != null || data == null || seq != st.draftSeq || st.pending != null) return@call
            if (st.plan?.reactive != true) return@call
            // A reactive card shows the hub's answer (in place when only values changed); the working copy stays (it may already be newer).
            ChatCardModel.plan(data.optJSONObject("plan"))?.let { st.plan = it; show(st) }
        }
    }

    private fun act(st: Card, n: JSONObject) {
        val a = n.optJSONObject("action") ?: return
        a.optJSONObject("copy")?.let { c -> copy(st, n.optString("id"), c.optString("text")); return }
        if (ChatCardModel.hubAction(a)) { press(st, n.optString("id"), a); return }
        // A press wakes a sleeping card (the hub's own presses wake it there).
        if (st.card.optString("life") == "dormant") port?.call("service:cards", "seen", JSONObject().put("cards", JSONArray().put(st.id))) { _, _ -> }
        a.optJSONObject("event")?.let { e -> event(st, e.optString("name"), e.optJSONObject("context"), ChatCardModel.label(st.plan?.byId.orEmpty(), n)); return }
        val target = when {
            a.has("openUrl") -> CAction.OpenUrl(a.optJSONObject("openUrl")?.optString("url").orEmpty())
            a.has("openApp") -> a.optJSONObject("openApp")?.let { CAction.OpenApp(it.optString("app"), it.optString("surface").ifEmpty { null }) } ?: return
            a.has("openAsh") -> CAction.OpenAsh
            else -> return
        }
        val activity = activity ?: return
        runCatching { activity.startActivity(WidgetActions.openIntent(activity, target)) }.onFailure { toast("打不开") }
    }

    /** A short haptic tick for a press that was taken. */
    private fun tick(st: Card) { st.holder.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP) }

    /**
     * A button the hub runs (`call`, `ask`, `tell`): 「处理中…」 and disabled at once, a tick, then `service:cards/act` with the
     * values on the card now. The outcome is written on the card by the hub (a `card.patch`); after the answer, or after the
     * action's time, it may be pressed again. Pressing while it runs does nothing.
     */
    private fun press(st: Card, component: String, action: JSONObject) {
        val port = port ?: return
        val timeout = ChatCardModel.pressTimeoutMs(action)
        if (preview || !st.open() || ChatCardModel.pressBusy(component in st.pressing, st.card.optJSONObject("actions")?.optJSONObject(component), System.currentTimeMillis(), timeout)) return
        val press = ++presses
        st.pressing[component] = press
        st.failedHere.remove(component)
        tick(st)
        paint(st)
        fun done(failure: String?) {
            if (st.pressing[component] != press) return
            st.pressing.remove(component)
            if (failure != null) st.failedHere[component] = failure
            paint(st)
        }
        main.postDelayed({ done(ChatCardModel.failureText("timeout")) }, timeout)
        port.call("service:cards", "act", ChatCardModel.actBody(st.id, component, st.data)) { data, failure ->
            if (failure != null) { done(ChatCardModel.failureText(failure.code)); return@call }
            // Until the card's own change comes, the answer is what the line says.
            val state = data?.optString("state")
            if (state == "ok" || state == "failed") {
                val card = JSONObject(st.card.toString())
                val actions = card.optJSONObject("actions") ?: JSONObject().also { card.put("actions", it) }
                actions.put(component, JSONObject().put("state", state).put("text", data.optString("text")).put("at", System.currentTimeMillis()))
                st.card = card
            }
            done(null)
        }
    }

    /** `{copy: {text}}`: on the phone's clipboard, a tick, 「已复制」 under the button for 2 s. Nothing is sent. */
    private fun copy(st: Card, component: String, text: String) {
        if (preview) return
        val cm = ctx.getSystemService(ClipboardManager::class.java) ?: return
        runCatching { cm.setPrimaryClip(ClipData.newPlainText("Ash", text)) }.onFailure { return }
        tick(st)
        st.copied[component] = SystemClock.uptimeMillis() + COPIED_MS
        paint(st)
        main.postDelayed({ paint(st) }, COPIED_MS + 50)
    }

    /** 「存成应用」: the card's app stays (`service:cards/keep`); hidden from then on, back if it did not work. */
    private fun keep(st: Card) {
        val port = port ?: return
        if (st.keeping) return
        st.keeping = true; paint(st)
        port.call("service:cards", "keep", JSONObject().put("id", st.id)) { _, failure -> if (failure != null) { st.keeping = false; paint(st) } }
    }

    /** 「常驻」 turned: shown at once, then `service:cards/pin` as the owner; if that fails it turns back and the line says so for a moment. */
    private fun pin(st: Card, pinned: Boolean) {
        val port = port ?: return
        if (preview || !ChatCardModel.pinnable(st.card)) return
        st.pinLocal = pinned; st.pinFailedUntil = 0L
        tick(st); paint(st)
        port.call("service:cards", "pin", ChatCardModel.pinBody(st.id, pinned)) { _, failure ->
            if (failure == null || st.pinLocal != pinned) return@call
            st.pinLocal = null
            st.pinFailedUntil = SystemClock.uptimeMillis() + PIN_FAILED_MS
            paint(st)
            main.postDelayed({ paint(st) }, PIN_FAILED_MS + 50)
        }
    }

    /** A Button's event (or the mini app's `ash.send`): a form's 提交 / 取消, otherwise the owner's message to the card's creator. */
    private fun event(st: Card, name: String, context: JSONObject?, label: String) {
        if (name.isEmpty() || !st.open()) return
        val form = st.card.optJSONObject("form")
        if (form != null && name == "submit") return submit(st, form)
        if (form != null && name == "cancel") return cancel(st)
        val owner = st.card.optString("owner")
        if (!owner.startsWith("agent:")) return
        post(owner, ChatCardModel.sayBody(label.ifEmpty { name }, st.id, name, context, st.data))
    }

    /** 👍 / 👎: the owner's `say` to the card's creator (an agent); the same one again does nothing. */
    private fun feedback(st: Card, which: String) {
        if (preview || st.feedback() == which) return
        val owner = st.card.optString("owner")
        if (!owner.startsWith("agent:")) return
        st.feedbackLocal = which
        post(owner, ChatCardModel.feedbackBody(which, st.id, st.data))
        paint(st)
    }

    /** 提交: every password box filled, each saved in the vault, then the form answered with the rest of the values and the masked passwords. */
    private fun submit(st: Card, form: JSONObject) {
        val port = port ?: return
        if (st.busy) return
        val owner = st.card.optString("owner")
        val secret = form.optJSONObject("secret") ?: JSONObject()
        val titles = form.optJSONObject("titles") ?: JSONObject()
        val typed = HashMap(secrets[st.id].orEmpty())
        ChatCardModel.missingSecret(secret, titles, typed)?.let { toast(it); return }
        st.busy = true; paint(st)
        fun fail(message: String) { st.busy = false; paint(st); toast(message) }
        fun answer() = port.send(ChatCardModel.formMessage(owner, st.id, ChatCardModel.formAnswer(st.data, secret, typed))) { r ->
            if (r.optBoolean("ok")) { secrets.remove(st.id); st.local = "sent"; st.busy = false; paint(st); refresh() }
            else fail(problem(r))
        }
        val fields = secret.keys().asSequence().toList()
        if (fields.isEmpty()) { answer(); return }
        var left = fields.size
        var failed: String? = null
        for (field in fields) {
            val title = titles.optString(field).ifEmpty { field }
            val body = JSONObject().put("ref", secret.optString(field)).put("value", typed[ChatCardModel.pathOf(field)].orEmpty()).put("label", title).put("kind", "password")
            port.call("service:vault", "set", body) { _, failure ->
                if (failure != null && failed == null) failed = title
                if (--left == 0) failed?.let { fail("没能把「$it」存进保险箱，再点一次提交试试") } ?: answer()
            }
        }
    }

    private fun cancel(st: Card) {
        val port = port ?: return
        if (st.busy) return
        st.busy = true; paint(st)
        port.send(ChatCardModel.formMessage(st.card.optString("owner"), st.id, ChatCardModel.cancelAnswer())) { r ->
            st.busy = false
            if (r.optBoolean("ok")) { secrets.remove(st.id); st.local = "cancelled" } else toast(problem(r))
            paint(st); refresh()
        }
    }

    private fun problem(r: JSONObject): String = when (r.optJSONObject("error")?.optString("code")) {
        "conflict", "not_found" -> "这张卡片已经结束了"
        "bad_request" -> "还有没填好的地方"
        else -> "没有送到，再点一次试试"
    }

    // --- a card's mini app ---

    /**
     * A card's mini app (its Html component, MOBILE-ARCH §12.4): a WebView that lives while the card's row is on screen and the
     * card is awake — made when the row is drawn or attached, destroyed when it is recycled or detached, or the card sleeps or
     * closes; each load is a new page with a new port. The page is the one an app's own pages get ([HostPage]: the CSP, the
     * port shim) at its app's origin (cards without an app: [ChatCardModel.CARD_ORIGIN]). It reaches nothing — no network, no
     * files, no navigation, no permissions; its only way out is the port, where the host knows who it is.
     */
    private inner class Mini(val st: Card, val component: String, val app: String?, val html: String, val head: String) {
        val box = FrameLayout(ctx)
        /** In the box while there is no page: a soft block, with a line when it sleeps, has ended or crashed. */
        private val note = AshUi.text(ctx, "", AshType(13f, 18f, 400, Role.TEXT_3)).apply { gravity = Gravity.CENTER; background = AshUi.rounded(c.surface2, dpF(12f)) }
        private val origin = app?.let { AppIds.origin(it) } ?: ChatCardModel.CARD_ORIGIN
        private var web: WebView? = null
        private val ports = ArrayList<WebMessagePort>()
        private var lastSend = 0L
        private val calls = ChatCardModel.Rate(2, 1000)

        init { box.addView(note, FrameLayout.LayoutParams(MATCH, MATCH)) }

        /** Alive or not, as the row and the card are now. */
        fun sync() {
            val life = st.card.optString("life")
            val closed = ChatCardModel.closed(st.card)
            note.text = when { closed -> "小应用已结束"; life == "dormant" -> "小应用休眠中"; else -> "" }
            if (st.onScreen && !closed && life != "dormant") { if (web == null) load() } else drop()
        }

        fun drop() {
            ports.forEach { runCatching { it.close() } }
            ports.clear()
            web?.let { w -> box.removeView(w); runCatching { w.destroy() } }
            web = null
            note.visibility = View.VISIBLE
        }

        @SuppressLint("SetJavaScriptEnabled")
        private fun load() {
            val token = Base64.encodeToString(ByteArray(18).also { SecureRandom().nextBytes(it) }, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            val w = WebView(ctx)
            web = w
            var offered = 0
            w.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
                setGeolocationEnabled(false)
                setSupportMultipleWindows(false)
                javaScriptCanOpenWindowsAutomatically = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                @Suppress("DEPRECATION") saveFormData = false
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
            w.setBackgroundColor(Color.TRANSPARENT)
            w.isVerticalScrollBarEnabled = false
            w.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                // The page itself, data: and blob:; nothing else.
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (request.url.scheme in setOf("data", "blob", "about") || (request.isForMainFrame && request.url.toString() == "$origin/")) null
                    else WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                override fun onPageCommitVisible(view: WebView, url: String?) = offer()
                override fun onPageFinished(view: WebView, url: String?) = offer()
                fun offer() {
                    // As an app's page: its end of a new channel, under the token (the shim keeps the first, closes a later one).
                    if (web !== w || offered >= 2) return
                    offered++
                    runCatching {
                        val (mine, theirs) = w.createWebMessageChannel()
                        ports.add(mine)
                        mine.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                            override fun onMessage(p: WebMessagePort, message: WebMessage) { if (web === w) heard(p, message.data) }
                        }, main)
                        w.postWebMessage(WebMessage(token, arrayOf(theirs)), Uri.parse(origin))
                    }.onFailure { Log.w(TAG, "could not connect the mini app", it) }
                }
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (view === web) { drop(); note.text = "这个小应用停了" } else runCatching { view.destroy() }
                    return true
                }
            }
            w.webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
                override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { cb?.onReceiveValue(null); return true }
            }
            note.visibility = View.GONE
            box.addView(w, FrameLayout.LayoutParams(MATCH, MATCH))
            w.loadDataWithBaseURL("$origin/", HostPage.build(html, Csp(emptyList(), emptyList()), token, head), "text/html", "utf-8", null)
        }

        /**
         * What the page said on our port: `ash.send` at most every 0.8 s, as if a Button with that event was tapped; `ash.call /
         * ask / tell` at most 2 a second, each `service:cards/act {request}` as this card's component, the answer back on the port.
         */
        private fun heard(p: WebMessagePort, raw: String?) {
            val (id, what) = ChatCardModel.miniMessage(raw, app != null) ?: return
            fun reply(answer: JSONObject) {
                if (web != null) runCatching { p.postMessage(WebMessage(JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("result", answer).toString())) }
            }
            fun failed(text: String) = JSONObject().put("state", "failed").put("text", text)
            if (what == null) return reply(failed("这个请求看不懂"))
            val now = SystemClock.uptimeMillis()
            what.optJSONObject("send")?.let { s ->
                if (now - lastSend < 800) return
                lastSend = now
                return event(st, s.getString("action"), s.getJSONObject("context"), s.getString("action"))
            }
            if (!calls.take(now)) return reply(failed("太快了，稍后再试"))
            val port = port ?: return reply(ChatCardModel.miniAnswer(null, "unavailable"))
            if (!st.open()) return reply(ChatCardModel.miniAnswer(null, "conflict"))
            var answered = false
            fun once(answer: JSONObject) { if (!answered) { answered = true; reply(answer) } }
            main.postDelayed({ once(ChatCardModel.miniAnswer(null, "timeout")) }, ChatCardModel.pressTimeoutMs(null))
            port.call("service:cards", "act", ChatCardModel.actBody(st.id, component, st.data, what)) { data, failure -> once(ChatCardModel.miniAnswer(data, failure?.code)) }
        }
    }

    private fun clip(v: View, radius: Float) {
        v.outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, o: Outline) {
                o.setRoundRect(0, 0, view.width, view.height, if (radius < 0) minOf(view.width, view.height) / 2f else radius)
            }
        }
        v.clipToOutline = true
    }

    /** The footer's small switch: a pill with its knob at the end when on. Drawn only; the row around it takes the tap. */
    private class MiniSwitch(ctx: Context, private val onColor: Int, private val offColor: Int) : View(ctx) {
        var on = false
            set(v) { field = v; invalidate() }
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: Canvas) {
            val w = width.toFloat(); val h = height.toFloat(); val r = h / 2
            paint.color = if (on) onColor else offColor
            canvas.drawRoundRect(0f, 0f, w, h, r, r, paint)
            paint.color = Color.WHITE
            val k = r - h * 0.14f
            canvas.drawCircle(if (on) w - r else r, r, k, paint)
        }
    }

    /** A Chart: drawn by [AshChart] at the size it is given, in the current theme. */
    private class ChartView(ctx: Context, chart: AshChart.Chart, private val night: Boolean) : View(ctx) {
        var chart = chart
            set(v) { field = v; bmp = null; invalidate() }
        private var bmp: Bitmap? = null
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { bmp = null }
        override fun onDraw(canvas: Canvas) {
            if (width <= 0 || height <= 0) return
            val d = resources.displayMetrics.density
            val b = bmp ?: AshChart.render(chart, width / d, height / d, d, night).also { bmp = it }
            canvas.drawBitmap(b, 0f, 0f, null)
        }
    }

    /** The width it is given, but at most [maxPx] (the card shell's `width: 100%; max-width: 330`). */
    private class Capped(ctx: Context, private val maxPx: Int) : FrameLayout(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val given = if (MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.UNSPECIFIED) maxPx else minOf(MeasureSpec.getSize(widthMeasureSpec), maxPx)
            super.onMeasure(MeasureSpec.makeMeasureSpec(given, MeasureSpec.EXACTLY), heightMeasureSpec)
        }
    }

    /** Chips that wrap onto the next line. */
    private class Flow(ctx: Context, private val gap: Int) : ViewGroup(ctx) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val mode = MeasureSpec.getMode(widthMeasureSpec)
            val maxW = if (mode == MeasureSpec.UNSPECIFIED) Int.MAX_VALUE else MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight
            var x = 0; var y = 0; var rowH = 0; var widest = 0
            for (i in 0 until childCount) {
                val ch = getChildAt(i)
                if (ch.visibility == GONE) continue
                measureChild(ch, MeasureSpec.makeMeasureSpec(maxOf(0, maxW), if (mode == MeasureSpec.UNSPECIFIED) MeasureSpec.UNSPECIFIED else MeasureSpec.AT_MOST),
                    MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
                if (x > 0 && x + ch.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
                x += ch.measuredWidth + gap
                rowH = maxOf(rowH, ch.measuredHeight)
                widest = maxOf(widest, x - gap)
            }
            setMeasuredDimension(resolveSize(widest + paddingLeft + paddingRight, widthMeasureSpec), resolveSize(y + rowH + paddingTop + paddingBottom, heightMeasureSpec))
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val maxW = r - l - paddingLeft - paddingRight
            var x = 0; var y = 0; var rowH = 0
            for (i in 0 until childCount) {
                val ch = getChildAt(i)
                if (ch.visibility == GONE) continue
                if (x > 0 && x + ch.measuredWidth > maxW) { x = 0; y += rowH + gap; rowH = 0 }
                ch.layout(paddingLeft + x, paddingTop + y, paddingLeft + x + ch.measuredWidth, paddingTop + y + ch.measuredHeight)
                x += ch.measuredWidth + gap
                rowH = maxOf(rowH, ch.measuredHeight)
            }
        }
    }

    private companion object {
        const val TAG = "ash.cards"
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
        /** The 👍 / 👎 footer's height, held from the start. */
        const val FOOTER_DP = 22
        /** An input's label above its box. */
        const val LABEL_GAP = 4
        /** A built-in icon's size when the style gives none. */
        const val ICON_DP = 22f
        const val DRAFT_MS = 400L
        /** 「已复制」 stays this long. */
        const val COPIED_MS = 2000L
        /** The line after 「常驻」 could not be changed stays this long. */
        const val PIN_FAILED_MS = 3000L
        /** What fills the width of a Column that stretches (A2UI's default align). */
        val STRETCHY = setOf("Row", "Column", "Stack", "Grid", "Card", "List", "Tabs", "ChoicePicker", "Divider", "ProgressBar", "Text", "Clock", "Timer",
            "TextField", "DateTimeInput", "Slider", "Table", "Html", "Chart", "Skeleton", "Switch", "CheckBox")
        val FEATURES = setOf("header", "mediumFeature", "largeFeature")
        /** Components whose own taps are what they do. */
        val TAPPED_ITSELF = setOf("Button", "CheckBox", "Switch", "ChoicePicker", "TextField", "DateTimeInput", "Slider", "Tabs", "Html")
        val PLACES = mapOf("topStart" to (Gravity.TOP or Gravity.START), "top" to (Gravity.TOP or Gravity.CENTER_HORIZONTAL), "topEnd" to (Gravity.TOP or Gravity.END),
            "start" to (Gravity.CENTER_VERTICAL or Gravity.START), "center" to Gravity.CENTER, "end" to (Gravity.CENTER_VERTICAL or Gravity.END),
            "bottomStart" to (Gravity.BOTTOM or Gravity.START), "bottom" to (Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL), "bottomEnd" to (Gravity.BOTTOM or Gravity.END))
        /** Text variants in the chat's type scale. */
        val TYPES = mapOf("h1" to AshType(24f, 32f, 700, Role.INK), "h2" to AshType(20f, 28f, 650, Role.INK), "h3" to AshType(17f, 24f, 650, Role.INK),
            "h4" to AshType(15f, 21f, 600, Role.INK), "h5" to AshType(13f, 18f, 600, Role.INK), "body" to AshType(15f, 21f, 400, Role.TEXT),
            "caption" to AshType(13f, 18f, 400, Role.TEXT_2))
        /** A card's running text (and its inputs): 15 on 21. */
        val BODY = TYPES.getValue("body")
        fun pair(f: (AshPalette) -> Int) = Tint(f(AshTokens.light), f(AshTokens.dark))
        /** The card language's theme colours as the app's own (light, dark). */
        val THEME = mapOf("text" to pair { it.text }, "textSecondary" to pair { it.text2 }, "onAccent" to pair { it.onYou }, "background" to pair { it.bg },
            "surface" to pair { it.surface }, "surfaceVariant" to pair { it.surface2 }, "line" to pair { it.line })
    }
}
