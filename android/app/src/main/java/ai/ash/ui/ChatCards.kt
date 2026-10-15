package ai.ash.ui

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
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
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
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
import java.math.BigDecimal
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
}

/**
 * Cards in the conversation (`person:owner/show {a2ui}`, `form`) drawn natively from the plan the hub resolved: the same component
 * language as the home-screen cards, with the widget's colours, icons, images and charts, in the chat's own card shell.
 *
 * The chat makes a row again whenever an item changes; what the owner is doing on a card is kept here, by card id: the working copy
 * of its data (inputs write into it at their `bind`), the passwords typed (never in the data, never saved; they go only to
 * `service:vault/set`), the tab shown. A card's view is one holder that stays the same view. Inside it a new plan is drawn by
 * component ([CardPatcher], MOBILE-ARCH §12.6): the components whose fields changed are updated in place, a component whose
 * structure changed gets a new view, and nothing else is touched — an input the owner is editing keeps its view, focus,
 * selection and composing text, and the hub's value for it waits until the editing ends ([CardEdits]).
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
        var inFlight = 0
        var pending: Runnable? = null
        /** The 👍 / 👎 tapped here, until the item says it. */
        var feedbackLocal: String? = null
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
        /** What the owner changed, and the hub's values kept aside while the owner edits. */
        val edits = CardEdits()
        /** The drawing now; made anew only for a card-level change (open or not, its accent, a form or not). */
        var draw: Draw? = null
        var drawKey: String? = null
        /** Mini apps, by component id. */
        val minis = HashMap<String, CardMini>()

        fun state(): String {
            local?.let { return it }
            if (card.optString("life") == "closed") return "closed"
            val s = card.optString("state").ifEmpty { "open" }
            val ends = card.optJSONObject("form")?.optLong("expires_at") ?: 0L
            return if (s == "open" && ends > 0 && ends <= System.currentTimeMillis()) "expired" else s
        }
        fun open() = state() == "open"
        fun feedback() = ChatCardModel.feedbackShown(feedbackLocal, card.optString("feedback").ifEmpty { null })
    }

    private val cards = HashMap<String, Card>()
    /** Presses counted, so a late answer or timeout finds only its own press. */
    private var presses = 0L
    /** Password boxes: card id -> the box's bind path -> what is typed. In memory only. */
    private val secrets = HashMap<String, HashMap<String, String>>()

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
        if (st.plan == null) {
            st.plan = plan; st.data = JSONObject(plan.data.toString()); st.updatedAt = updated
        } else if (updated > st.updatedAt) {
            // A newer version from the hub: taken, but an input the owner is editing (or changed, not yet confirmed) keeps its value.
            st.data = st.edits.merge(st.data, plan.data, inputsOf(plan)) { st.draw?.editing(it) == true }
            st.plan = plan; st.updatedAt = updated
        }
        if (card.optString("state").ifEmpty { "open" } != "open") st.local = null
        if (st.feedbackLocal != null && st.feedbackLocal == card.optString("feedback")) st.feedbackLocal = null
        paint(st)
        return st.holder
    }

    /** The inputs of [plan] that write the data: component id -> bind path (a password box never does). */
    private fun inputsOf(plan: ChatCardModel.Plan): Map<String, String> = plan.byId.values.asSequence()
        .filter { it.optString("component") in INPUTS && !(it.optString("component") == "TextField" && it.optString("variant") == "obscured") }
        .mapNotNull { n -> n.optString("bind").takeIf { it.isNotEmpty() }?.let { n.optString("id") to it } }.toMap()

    /** Pictures still on their way in the cards drawn last. */
    fun waitingImages(): Int = cards.values.sumOf { it.draw?.waitingImages() ?: 0 }

    /** Draws every card anew (a picture that has come in since is in it now). */
    fun redraw() { for (st in cards.values) { st.drawKey = null; paint(st) } }

    fun close() {
        for (st in cards.values) {
            st.pending?.let(main::removeCallbacks)
            st.minis.values.forEach { it.destroy() }
            st.minis.clear()
        }
        secrets.clear()
    }

    // --- drawing ---

    private fun paint(st: Card) {
        val plan = st.plan ?: return
        val state = st.state()
        val readOnly = state != "open"
        val key = "$readOnly|${CardShape.canon(plan.accent)}|${st.card.optJSONObject("form") != null}"
        var d = st.draw
        if (d == null || st.drawKey != key) {
            d = Draw(st, readOnly, plan.accent)
            st.draw = d; st.drawKey = key
            st.holder.removeAllViews()
            st.holder.addView(d.shell, FrameLayout.LayoutParams(MATCH, WRAP))
        }
        try { d.paint(plan, state) } catch (e: Exception) {
            Log.w(TAG, "card ${st.id} could not be drawn", e)
            st.draw = null; st.drawKey = null
            st.holder.removeAllViews()
            st.holder.addView(plain(st.card.optString("text")), FrameLayout.LayoutParams(MATCH, WRAP))
        }
    }

    /** A card that cannot be drawn: its plain text. */
    private fun plain(text: String): View = AshUi.card(ctx).apply {
        addView(AshUi.text(ctx, Md.render(text.ifBlank { "一张卡片" }, c.surface2, c.her), AshTokens.Type.body, c.text2))
    }

    private enum class Slot { COLUMN, ROW, STRIP, STACK }

    /** A component that could not be drawn (or a newer hub's): nothing, in its place. */
    private class Blank(ctx: Context) : View(ctx) { init { visibility = GONE } }

    /** What a view looked like before its node's style was put on it (so a style taken away is undone). */
    private class Base(val view: View) {
        var bg: android.graphics.drawable.Drawable? = view.background
        val pad = intArrayOf(view.paddingStart, view.paddingTop, view.paddingEnd, view.paddingBottom)
        val alpha = view.alpha
        val description: CharSequence? = view.contentDescription
        var tapped = false
    }

    // The parts of a component its in-place update works on.
    private class ImagePart(val box: ImageView, var url: String, var img: Img)
    private class ButtonPart(val faceKey: String, val line: TextView?)
    private class CheckPart(val box: CheckBox)
    private class SwitchPart(val label: TextView, val sw: AshUi.AshSwitch)
    private class ChoicePart(val label: TextView?, var node: JSONObject, val chosen: LinkedHashSet<String>, val fill: () -> Unit)
    private class FieldPart(val label: TextView?, val et: EditText, var node: JSONObject)
    private class DatePart(val label: TextView?, val shown: TextView, var node: JSONObject, var value: String, val show: () -> Unit)
    private class SliderPart(val label: TextView, val shown: TextView, val bar: SeekBar, val min: Double, val step: Double, val notches: Int) { var dragging = false }
    private class ProgressPart(val label: TextView?, val bar: ProgressBar)
    private class TablePart(val table: TableLayout)
    private class MiniPart(val mini: CardMini, val save: TextView?)

    /**
     * One card's drawing, kept from plan to plan while the card stays the same kind of card ([paint]): the card shell, the
     * plan's components ([patcher]) and the footer, each updated in place.
     */
    private inner class Draw(val st: Card, val readOnly: Boolean, accentRaw: Any?) : CardPatcher.Host<View> {
        val accentTint: Tint = accentRaw?.let { a -> runCatching { CardSpec.tint(a) }.getOrNull() } ?: pair { it.you }
        val accent = accentTint.pick(night)
        var plan: ChatCardModel.Plan = st.plan!!
        var state = "open"
        private val patcher = CardPatcher(this)
        private var rootView: View? = null
        /** Not drawn into the patched tree (a button's own face): nothing is kept for its components. */
        private var free = 0
        private var inButton = false
        private var binding = false
        private val styles = HashMap<String, Pair<String, CStyle>>()
        /** Where each component sits in its parent: its layout params from its node now. */
        private val places = HashMap<String, (JSONObject) -> ViewGroup.LayoutParams>()
        private val parts = HashMap<String, Any>()
        private val bases = HashMap<String, Base>()

        // --- the shell: the plan's root, the state line, the footer ---

        val shell: LinearLayout = AshUi.card(ctx).apply { setPadding(dp(14), dp(14), dp(14), dp(14)) }
        private val stateLine = AshUi.text(ctx, "", AshType(12f, 16f, 500, Role.TEXT_3)).apply { gravity = Gravity.CENTER; visibility = View.GONE }
        private val captionView = AshUi.text(ctx, "", AshType(11.5f, 15f, 400, Role.TEXT_3)).apply {
            gravity = Gravity.CENTER_VERTICAL; maxLines = 1; ellipsize = TextUtils.TruncateAt.END
        }
        /** The whole footer (a card that is not a form, not in a picture), else only the caption line. */
        private val full = !preview && st.card.optJSONObject("form") == null
        private var keepView: TextView? = null
        private var pinRow: LinearLayout? = null
        private var pinSwitch: MiniSwitch? = null
        private val thumbs = ArrayList<Triple<String, FrameLayout, ImageView>>()

        init {
            shell.addView(stateLine, LinearLayout.LayoutParams(MATCH, WRAP))
            // Its height is held from the first drawing: choosing one, live data coming, sleeping change only what it says.
            if (full) shell.addView(footer(), LinearLayout.LayoutParams(MATCH, dp(FOOTER_DP)))
            else shell.addView(captionView, LinearLayout.LayoutParams(MATCH, dp(FOOTER_DP)))
        }

        fun paint(plan: ChatCardModel.Plan, state: String) {
            this.plan = plan; this.state = state
            places[plan.root] = { n -> params(n, Slot.COLUMN, null) }
            val root = patcher.render(plan.byId, plan.root, CardPatcher.Env(null))
            if (root !== rootView) {
                rootView?.let { shell.removeView(it) }
                root?.let { detach(it); shell.addView(it, 0, params(plan.byId.getValue(plan.root), Slot.COLUMN, null)) }
                rootView = root
            }
            val line = ChatCardModel.stateLine(state)
            stateLine.text = line.orEmpty()
            stateLine.visibility = if (line != null) View.VISIBLE else View.GONE
            paintFooter()
            // What is no longer drawn lets go of what it held.
            val ids = patcher.ids()
            parts.keys.retainAll(ids); places.keys.retainAll(ids + plan.root); bases.keys.retainAll(ids)
            st.minis.keys.filter { it !in ids }.forEach { st.minis.remove(it)?.destroy() }
        }

        /** Whether the owner is at component [id] now: the cursor in its box, composing text or a selection there, its slider held. */
        fun editing(id: String): Boolean = when (val p = parts[id]) {
            is FieldPart -> p.et.hasFocus() || BaseInputConnection.getComposingSpanStart(p.et.text) >= 0 || p.et.hasSelection()
            is SliderPart -> p.dragging
            else -> false
        }

        fun waitingImages(): Int = parts.values.count { p ->
            p is ImagePart && p.box.drawable == null && p.url.startsWith("https:") && !CardImages.failed.containsKey(p.url)
        }

        private fun paintFooter() {
            val caption = if (st.pinFailedUntil > SystemClock.uptimeMillis()) ChatCardModel.PIN_FAILED else ChatCardModel.caption(st.card, pinned = st.pinned())
            captionView.text = caption.orEmpty()
            if (!full) {
                captionView.visibility = if (caption != null || (!preview && ChatCardModel.reservesCaption(st.card))) View.VISIBLE else View.GONE
                return
            }
            keepView?.visibility = if (st.card.optBoolean("temporary_app") && !st.keeping && !readOnly) View.VISIBLE else View.GONE
            pinRow?.let { row ->
                row.visibility = if (ChatCardModel.pinnable(st.card)) View.VISIBLE else View.GONE
                val on = st.pinned()
                row.contentDescription = "${ChatCardModel.PIN_LABEL}：${if (on) "开" else "关"}"
                pinSwitch?.on = on
            }
            val shown = st.feedback()
            for ((which, box, icon) in thumbs) {
                val chosen = shown == which
                box.background = if (chosen) AshUi.rounded(c.surface2, dpF(FOOTER_DP / 2f)) else null
                box.isSelected = chosen
                icon.setImageDrawable(ctx.getDrawable(if (which == "up") R.drawable.ash_ic_thumb_up else R.drawable.ash_ic_thumb_down)?.mutate()?.apply { setTint(if (chosen) c.text else c.text3) })
                icon.alpha = if (chosen) 1f else 0.7f
            }
        }

        /**
         * The card's last line: the caption at the start; at the end 「存成应用」 (a card whose app exists only for it), 「常驻」, and
         * 👍 / 👎, small and quiet — the one the owner gave last is chosen, and tapping it again does nothing. Made once; each
         * drawing changes only what it says.
         */
        private fun footer(): View = AshUi.hstack(ctx, 4).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            addView(captionView, LinearLayout.LayoutParams(0, MATCH, 1f))
            keepView = AshUi.text(ctx, "存成应用", AshType(12f, 16f, 500, null), c.youText).apply {
                gravity = Gravity.CENTER; setPadding(dp(8), 0, dp(8), 0); isClickable = true
                contentDescription = "把这张卡片的应用留下来"
                setOnClickListener { keep(st) }
            }
            addView(keepView, LinearLayout.LayoutParams(WRAP, MATCH))
            // 「常驻」: the owner keeps a card of an app running off screen; there from the first drawing, for every such card.
            val sw = MiniSwitch(ctx, st.pinned(), accent, c.surface3)
            pinSwitch = sw
            pinRow = AshUi.hstack(ctx, 4).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6), 0, dp(6), 0); isClickable = true
                addView(AshUi.text(ctx, ChatCardModel.PIN_LABEL, AshType(11.5f, 15f, 400, Role.TEXT_3)))
                addView(sw, LinearLayout.LayoutParams(dp(24), dp(14)))
                setOnClickListener { pin(st, !st.pinned()) }
            }
            addView(pinRow, LinearLayout.LayoutParams(WRAP, MATCH))
            for (which in listOf("up", "down")) {
                val icon = ImageView(ctx)
                val box = FrameLayout(ctx).apply {
                    setPadding(dp(8), 0, dp(8), 0)
                    contentDescription = if (which == "up") "有用" else "没用"
                    setOnClickListener { feedback(st, which) }
                    addView(icon, FrameLayout.LayoutParams(dp(14), dp(14), Gravity.CENTER))
                }
                thumbs.add(Triple(which, box, icon))
                addView(box, LinearLayout.LayoutParams(WRAP, MATCH))
            }
        }

        // --- the patcher's host ---

        private fun visible(n: JSONObject?) = n != null && n.optBoolean("visible", true)
        private fun kind(n: JSONObject) = n.optString("component")
        fun ids(n: JSONObject): List<String> = n.optJSONArray("children")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } } ?: emptyList()
        private fun selectedTab(n: JSONObject): Int {
            val count = n.optJSONArray("tabs")?.length() ?: 0
            return (st.tabs[n.optString("id")] ?: n.optInt("selected")).coerceIn(0, maxOf(0, count - 1))
        }

        override fun kids(n: JSONObject): List<String> = when (kind(n)) {
            "Row", "Column", "List", "Stack", "Grid" -> ids(n)
            "Card" -> listOfNotNull(n.optString("child").ifEmpty { null })
            "Tabs" -> listOfNotNull(n.optJSONArray("tabs")?.optJSONObject(selectedTab(n))?.optString("child")?.ifEmpty { null })
            else -> emptyList()
        }

        override fun shape(n: JSONObject): String {
            val k = kind(n)
            fun has(key: String) = n.optString(key).isNotEmpty()
            fun shown() = ids(n).joinToString(",") { if (visible(plan.byId[it])) "1" else "0" }
            val rest = when (k) {
                "Row", "Column" -> "${n.optString("align")}|${n.optString("justify")}|${n.opt("gap")}" +
                    (if (n.optString("justify") in SPREAD) "|" + shown() else "")
                "List" -> "${n.optString("direction")}|${n.optInt("columns", 1)}|${n.optString("align")}|${n.opt("gap")}" + (if (n.optInt("columns", 1) > 1) "|" + shown() else "")
                "Grid" -> "${n.optInt("columns", 2)}|${n.opt("gap")}|${shown()}"
                "Stack" -> n.optString("align")
                "Tabs" -> CardShape.canon(n.optJSONArray("tabs")?.let { a -> (0 until a.length()).map { a.optJSONObject(it)?.optString("title").orEmpty() } }) + "|" + selectedTab(n)
                "TextField" -> "${n.optString("bind")}|${n.optString("variant")}|${has("label")}"
                "ChoicePicker" -> "${n.optString("bind")}|${CardShape.canon(n.optJSONArray("options")?.let { a -> (0 until a.length()).map { i -> a.optJSONObject(i)?.let { it.optString("value") + "=" + it.optString("label") } } })}|" +
                    "${n.optBoolean("multiple")}|${n.optBoolean("chips")}|${has("label")}"
                "Slider" -> "${n.optString("bind")}|${n.opt("min")}|${n.opt("max")}|${n.opt("step")}"
                "DateTimeInput" -> "${n.optString("bind")}|${n.opt("enableDate")}|${n.opt("enableTime")}|${has("label")}"
                "CheckBox", "Switch" -> n.optString("bind")
                "ProgressBar" -> has("label").toString()
                "Image" -> n.optString("url").startsWith("icon:").toString()
                "Button" -> n.optJSONObject("action")?.let { ChatCardModel.hubAction(it) || it.has("copy") }.toString()
                else -> ""
            }
            return "$k|$rest"
        }

        override fun look(n: JSONObject, env: CardPatcher.Env): String {
            val base = CardShape.canon(n) + "|" + env.ink
            return when (kind(n)) {
                "Row", "Column", "List", "Stack", "Grid", "Card", "Tabs" -> base + "|" + kids(n).joinToString(",") { visible(plan.byId[it]).toString() }
                "TextField", "CheckBox", "Switch", "ChoicePicker", "DateTimeInput", "Slider" -> base + "|" + CardShape.canon(valueOf(n))
                "Button" -> buttonKey(n) + "|" + env.ink + "|" + outcomeOf(n.optString("id"))
                "Html" -> base + "|" + st.card.optString("life") + "|" + saveShown()
                else -> base
            }
        }

        override fun env(n: JSONObject, env: CardPatcher.Env) = CardPatcher.Env(style(n).color?.pick(night) ?: env.ink)

        override fun build(n: JSONObject, env: CardPatcher.Env, kids: List<Pair<JSONObject, View>>): View {
            val s = style(n)
            val ink = s.color?.pick(night) ?: env.ink
            val v = try { make(n, s, ink, kids) } catch (e: Exception) { Log.w(TAG, "card ${st.id}: ${kind(n)} ${n.optString("id")} left out", e); null }
                ?: return Blank(ctx)
            decorate(v, n, s)
            return v
        }

        override fun update(view: View, old: JSONObject, n: JSONObject, env: CardPatcher.Env, kids: List<Pair<JSONObject, View>>): Boolean {
            if (view is Blank) return false
            val s = style(n)
            val ink = s.color?.pick(night) ?: env.ink
            val done = try { change(view, n, s, ink, kids) } catch (e: Exception) { Log.w(TAG, "card ${st.id}: ${kind(n)} drawn anew", e); false }
            if (!done) return false
            decorate(view, n, s)
            if (layoutKey(old) != layoutKey(n)) places[n.optString("id")]?.let { view.layoutParams = it(n) }
            return true
        }

        override fun swap(parent: View, old: View, new: View, n: JSONObject) {
            val p = old.parent as? ViewGroup ?: return
            val i = p.indexOfChild(old)
            detach(new)
            p.removeViewAt(i)
            p.addView(new, i, places[n.optString("id")]?.invoke(n) ?: old.layoutParams)
        }

        private fun layoutKey(n: JSONObject) = CardShape.canon(n.opt("style")) + "|" + n.opt("weight") + "|" + n.opt("size") + "|" + n.opt("height")

        private fun detach(v: View): View { (v.parent as? ViewGroup)?.removeView(v); return v }

        // --- drawing a component ---

        /** Theme names are the app's own colours here (the chat's card, not a widget on the wallpaper); others as on a widget. */
        fun tint(raw: Any?): Tint? = when (raw) {
            "accent" -> accentTint
            is String -> THEME[raw] ?: runCatching { CardSpec.tint(raw) }.getOrNull()
            else -> runCatching { CardSpec.tint(raw) }.getOrNull()
        }

        fun style(n: JSONObject): CStyle {
            val raw = CardShape.canon(n.opt("style"))
            val id = n.optString("id")
            styles[id]?.takeIf { it.first == raw }?.let { return it.second }
            return runCatching { CardSpec.style(n.optJSONObject("style"), ::tint) }.getOrDefault(CStyle()).also { styles[id] = raw to it }
        }
        fun byId(id: String) = plan.byId.getValue(id)

        private fun make(n: JSONObject, s: CStyle, ink: Int?, kids: List<Pair<JSONObject, View>>): View? = when (kind(n)) {
            "Text" -> TextView(ctx).also { applyText(it, n, s, ink) }
            "Badge" -> TextView(ctx).also { applyBadge(it, n, s) }
            "Image" -> image(n, s, ink)
            "Icon" -> icon(n, s, ink)
            "Row", "Column" -> box(n, kids)
            "List" -> list(n, kids)
            "Stack" -> FrameLayout(ctx).apply {
                val align = n.optString("align").ifEmpty { null }
                for ((kn, kv) in kids) addView(detach(kv), place(kn) { params(it, Slot.STACK, align) }(kn))
            }
            "Grid" -> grid(n, n.optInt("columns", 2).coerceIn(1, 12), kids)
            "Card" -> AshUi.vstack(ctx).apply {
                background = AshUi.rounded(c.surface2, dpF(s.cornerRadius ?: 16f))
                setPadding(dp(12), dp(12), dp(12), dp(12))
                for ((kn, kv) in kids) addView(detach(kv), place(kn) { params(it, Slot.COLUMN, null) }(kn))
            }
            "Tabs" -> tabs(n, kids)
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
            "Chart" -> ChartView(ctx, AshChart.parse(n, ::tint), night)
            "TextField" -> field(n)
            "DateTimeInput" -> dateTime(n)
            "Slider" -> slider(n, ink)
            "Table" -> table(n, ink)
            "Html" -> miniApp(n)
            "Skeleton" -> skeleton()
            else -> null   // a newer hub's component: left out
        }

        /** [n]'s changed look in place on [v]; false when it is better drawn anew (a small leaf). */
        private fun change(v: View, n: JSONObject, s: CStyle, ink: Int?, kids: List<Pair<JSONObject, View>>): Boolean {
            val id = n.optString("id")
            return when (kind(n)) {
                "Text" -> { applyText(v as TextView, n, s, ink); true }
                "Badge" -> { applyBadge(v as TextView, n, s); bases[id]?.bg = v.background; true }
                "Image" -> (parts[id] as? ImagePart)?.let { changeImage(it, n, s); true } ?: false
                "Row", "Column", "List", "Stack", "Grid", "Card", "Tabs" -> {
                    if (kind(n) == "Card") { val bg = AshUi.rounded(c.surface2, dpF(s.cornerRadius ?: 16f)); bases[id]?.bg = bg; v.background = bg }
                    // A child shown or hidden: the room between them follows.
                    for ((kn, kv) in kids) places[kn.optString("id")]?.let { kv.layoutParams = it(kn) }
                    true
                }
                "Button" -> changeButton(n)
                "CheckBox" -> (parts[id] as? CheckPart)?.let { changeCheck(it, n, ink); true } ?: false
                "Switch" -> (parts[id] as? SwitchPart)?.let { changeSwitch(it, n, ink); true } ?: false
                "ChoicePicker" -> (parts[id] as? ChoicePart)?.let { changeChoice(it, n); true } ?: false
                "TextField" -> (parts[id] as? FieldPart)?.let { changeField(it, n); true } ?: false
                "DateTimeInput" -> (parts[id] as? DatePart)?.let { changeDate(it, n); true } ?: false
                "Slider" -> (parts[id] as? SliderPart)?.let { changeSlider(it, n, ink); true } ?: false
                "ProgressBar" -> (parts[id] as? ProgressPart)?.let { changeProgress(it, n, s, ink); true } ?: false
                "Chart" -> (v as? ChartView)?.let { it.set(AshChart.parse(n, ::tint)); true } ?: false
                "Table" -> (parts[id] as? TablePart)?.let { fillTable(it.table, n, ink); true } ?: false
                "Html" -> (parts[id] as? MiniPart)?.let { changeMini(it, n); true } ?: false
                else -> false   // Icon, Divider, Spacer, Clock, Timer, Skeleton: drawn anew, they hold nothing
            }
        }

        private fun place(n: JSONObject, f: (JSONObject) -> ViewGroup.LayoutParams): (JSONObject) -> ViewGroup.LayoutParams {
            if (free == 0) places[n.optString("id")] = f
            return f
        }
        private fun <T : Any> part(n: JSONObject, p: T): T { if (free == 0) parts[n.optString("id")] = p; return p }

        /** What every component takes: background, padding, opacity, a description, a tap for a non-button with an action, and whether it shows. */
        private fun decorate(v: View, n: JSONObject, s: CStyle) {
            if (v is Blank) return
            val id = n.optString("id")
            val k = kind(n)
            val base = bases[id]?.takeIf { it.view === v } ?: Base(v).also { if (free == 0) bases[id] = it }
            v.background = s.background?.let { AshUi.rounded(it.pick(night), dpF(s.cornerRadius ?: 0f)) } ?: base.bg
            if (k == "Image" || k == "Html") s.cornerRadius?.let { clip(v, dpF(it)) }
            val p = s.padding
            if (p != null) v.setPaddingRelative(dp(p[3]), dp(p[0]), dp(p[1]), dp(p[2]))
            else v.setPaddingRelative(base.pad[0], base.pad[1], base.pad[2], base.pad[3])
            v.alpha = s.opacity?.coerceIn(0f, 1f) ?: base.alpha
            v.contentDescription = n.optString("a11y").ifEmpty { null } ?: base.description
            if (k !in TAPPED_ITSELF) {
                if (n.optJSONObject("action") != null && !readOnly && !n.optBoolean("disabled")) {
                    v.isClickable = true; base.tapped = true
                    v.setOnClickListener { act(st, n) }
                } else if (base.tapped) { v.setOnClickListener(null); v.isClickable = false; base.tapped = false }
            }
            v.visibility = if (visible(n)) View.VISIBLE else View.GONE
        }

        /** [id] drawn outside the patched tree (inside a button's face): its children first, all of it new. */
        private fun drawFree(id: String, ink: Int?, depth: Int): View? {
            val n = plan.byId[id] ?: return null
            if (!visible(n) || depth > CardPatcher.MAX_DEPTH) return null
            val s = style(n)
            val color = s.color?.pick(night) ?: ink
            val kids = kids(n).mapNotNull { k -> drawFree(k, color, depth + 1)?.let { byId(k) to it } }
            val v = runCatching { make(n, s, color, kids) }.getOrElse { Log.w(TAG, "card ${st.id}: ${kind(n)} $id left out", it); null } ?: return null
            decorate(v, n, s)
            return v
        }

        // --- layout ---

        private fun px(d: Dim?): Int? = when (d) { Dim.Fill -> MATCH; Dim.Wrap -> WRAP; is Dim.Dp -> dp(d.dp); null -> null }

        /** A component's own size when its style gives none (images by variant, a chart's height, a line, a placeholder). */
        private fun pref(n: JSONObject, s: CStyle, slot: Slot): Pair<Int?, Int?> = when (kind(n)) {
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
            val kind = kind(n)
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
            s.margin?.let { m -> lp.topMargin = dp(m[0]); lp.marginEnd = dp(m[1]); lp.bottomMargin = dp(m[2]); lp.marginStart = dp(m[3]) }
            return lp
        }

        /** A container's `gap` in px: the room between its children (none when not given). */
        private fun gapOf(n: JSONObject): Int = n.optDouble("gap", 0.0).takeIf { it.isFinite() && it > 0 }?.let { dp(it) } ?: 0

        /** [lp] with [gap] px more before it (above in a column, at the start in a row), on top of its own margin. */
        private fun spaced(lp: ViewGroup.LayoutParams, slot: Slot, gap: Int): ViewGroup.LayoutParams {
            if (gap > 0 && lp is ViewGroup.MarginLayoutParams) { if (slot == Slot.COLUMN) lp.topMargin += gap else lp.marginStart += gap }
            return lp
        }

        private fun box(n: JSONObject, kids: List<Pair<JSONObject, View>>): LinearLayout {
            val column = kind(n) == "Column"
            val align = n.optString("align").ifEmpty { null }
            val justify = n.optString("justify").ifEmpty { null }
            val v = if (column) AshUi.vstack(ctx) else AshUi.hstack(ctx)
            if (!column) v.gravity = (when (justify) { "center" -> Gravity.CENTER_HORIZONTAL; "end" -> Gravity.END; else -> Gravity.START }) or
                (when (align) { "start" -> Gravity.TOP; "end" -> Gravity.BOTTOM; else -> Gravity.CENTER_VERTICAL })
            children(v, kids, if (column) Slot.COLUMN else Slot.ROW, align, justify, gapOf(n))
            return v
        }

        /**
         * [kids] into [box], each placed by its node now: the gap only after a child that shows. With a spread justify the room
         * between the children that show is shared out (which ones show is part of the layout then).
         */
        private fun children(box: LinearLayout, kids: List<Pair<JSONObject, View>>, slot: Slot, align: String?, justify: String?, gap: Int) {
            val spread = justify in SPREAD
            val shown = kids.filter { visible(it.first) }
            fun room() = box.addView(Space(ctx), if (slot == Slot.COLUMN) LinearLayout.LayoutParams(1, 0, 1f) else LinearLayout.LayoutParams(0, 1, 1f))
            if (spread && justify != "spaceBetween" && shown.isNotEmpty()) room()
            kids.forEachIndexed { i, (kn, kv) ->
                val before = kids.subList(0, i).map { it.first.optString("id") }
                val f = place(kn) { node -> spaced(params(node, slot, align, justify == "stretch"), slot, if (before.any { visible(plan.byId[it]) }) gap else 0) }
                box.addView(detach(kv), f(kn))
                if (spread && visible(kn) && kn !== shown.last().first) room()
            }
            if (spread && justify != "spaceBetween" && shown.isNotEmpty()) room()
        }

        /** The children that show, [columns] to a row. A child that does not show has no cell (which ones show is part of the layout). */
        private fun grid(n: JSONObject, columns: Int, kids: List<Pair<JSONObject, View>>): LinearLayout = AshUi.vstack(ctx).apply {
            val gap = gapOf(n)
            kids.filter { visible(it.first) }.chunked(columns).forEachIndexed { r, row ->
                addView(AshUi.hstack(ctx).apply {
                    gravity = Gravity.TOP
                    fun cell(i: Int) = LinearLayout.LayoutParams(0, WRAP, 1f).apply { if (i > 0) marginStart = gap }
                    row.forEachIndexed { i, (kn, kv) -> addView(AshUi.vstack(ctx).apply { addView(detach(kv), place(kn) { params(it, Slot.COLUMN, null) }(kn)) }, cell(i)) }
                    for (i in row.size until columns) addView(Space(ctx), cell(i).apply { height = 0 })
                }, LinearLayout.LayoutParams(MATCH, WRAP).apply { if (r > 0) topMargin = gap })
            }
        }

        private fun list(n: JSONObject, kids: List<Pair<JSONObject, View>>): View {
            val align = n.optString("align").ifEmpty { null }
            if (n.optString("direction") == "horizontal") return HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false
                addView(AshUi.hstack(ctx).apply {
                    gravity = Gravity.TOP
                    val gap = gapOf(n)
                    kids.forEachIndexed { i, (kn, kv) ->
                        val before = kids.subList(0, i).map { it.first.optString("id") }
                        val f = place(kn) { node -> spaced(params(node, Slot.STRIP, align ?: "start"), Slot.STRIP, if (before.any { visible(plan.byId[it]) }) gap else 0) }
                        addView(detach(kv), f(kn))
                    }
                })
            }
            val columns = n.optInt("columns", 1)
            if (columns > 1) return grid(n, columns.coerceAtMost(12), kids)
            return AshUi.vstack(ctx).apply { children(this, kids, Slot.COLUMN, align, null, gapOf(n)) }
        }

        private fun tabs(n: JSONObject, kids: List<Pair<JSONObject, View>>): View {
            val id = n.optString("id")
            val tabs = n.optJSONArray("tabs") ?: JSONArray()
            val titles = (0 until tabs.length()).map { tabs.optJSONObject(it)?.optString("title").orEmpty() }
            val selected = selectedTab(n)
            // Switching tabs is the owner's own business: drawn here at once, not part of the data.
            val pick = { i: Int -> st.tabs[id] = i; paint(st) }
            return AshUi.vstack(ctx, 10).apply {
                val bar = if (titles.size <= 4) AshUi.segmented(ctx, titles, selected) { pick(it) }
                else HorizontalScrollView(ctx).apply {
                    isHorizontalScrollBarEnabled = false
                    addView(AshUi.hstack(ctx, 6).apply { titles.forEachIndexed { i, t -> addView(AshUi.option(ctx, t, selected = i == selected) { pick(i) }) } })
                }
                addView(bar, LinearLayout.LayoutParams(MATCH, WRAP))
                for ((kn, kv) in kids) addView(detach(kv), place(kn) { params(it, Slot.COLUMN, null) }(kn))
            }
        }

        // --- what is shown ---

        private fun textType(s: CStyle, base: AshType): AshType {
            val size = s.fontSize ?: base.sizeSp
            return AshType(size, s.lineHeight ?: if (s.fontSize != null) size * 1.4f else base.lineSp, s.fontWeight ?: base.weight, base.role)
        }

        /** [text] on [tv] with the type's exact line height, as [AshUi.text] puts it (the type's own spacing then comes from the text). */
        private fun styled(tv: TextView, text: CharSequence, type: AshType) {
            tv.text = AshUi.text(ctx, text, type).text
            if (text.isNotEmpty()) tv.setLineSpacing(0f, 1f)
        }

        /** Everything a Text shows, put on [tv] (made now or drawn before). */
        private fun applyText(tv: TextView, n: JSONObject, s: CStyle, ink: Int?) {
            val variant = n.optString("variant").ifEmpty { "body" }
            val type = textType(s, TYPES[variant] ?: BODY)
            val body = Md.render(n.optString("text"), c.surface2, c.her)
            AshUi.style(tv, type, ink?.let { if (variant == "caption") AshUi.withAlpha(it, 0.7f) else it })
            styled(tv, body, type)
            if (s.italic == true) {
                if (Build.VERSION.SDK_INT >= 28) tv.typeface = Typeface.create(Typeface.DEFAULT, type.weight.coerceIn(1, 1000), true)
                else tv.setTypeface(tv.typeface, Typeface.ITALIC)
            }
            var flags = tv.paintFlags and (Paint.UNDERLINE_TEXT_FLAG or Paint.STRIKE_THRU_TEXT_FLAG).inv()
            if (s.underline) flags = flags or Paint.UNDERLINE_TEXT_FLAG
            if (s.strikethrough) flags = flags or Paint.STRIKE_THRU_TEXT_FLAG
            tv.paintFlags = flags
            tv.gravity = when (s.textAlign) { "center" -> Gravity.CENTER_HORIZONTAL; "end" -> Gravity.END; else -> Gravity.TOP or Gravity.START }
            tv.justificationMode = if (s.textAlign == "justify") android.text.Layout.JUSTIFICATION_MODE_INTER_WORD else android.text.Layout.JUSTIFICATION_MODE_NONE
            val max = s.maxLines
            if (max != null) { tv.maxLines = max; tv.ellipsize = when (s.ellipsize) { "start" -> TextUtils.TruncateAt.START; "middle" -> TextUtils.TruncateAt.MIDDLE; "none" -> null; else -> TextUtils.TruncateAt.END } }
            else { tv.maxLines = Int.MAX_VALUE; tv.ellipsize = null }
            tv.letterSpacing = s.letterSpacing ?: 0f
            // Links open when tapped; inside a button the whole button is the tap.
            val links = !inButton && body.getSpans(0, body.length, ClickableSpan::class.java).isNotEmpty()
            if (links) { if (tv.movementMethod !is LinkMovementMethod) tv.movementMethod = LinkMovementMethod.getInstance() }
            else if (tv.movementMethod != null) tv.movementMethod = null
        }

        private fun applyBadge(tv: TextView, n: JSONObject, s: CStyle) {
            val tone = s.color?.pick(night) ?: accent
            val type = AshType(11.5f, 14f, 600, null)
            AshUi.style(tv, type, tone)
            styled(tv, n.optString("text"), type)
            tv.gravity = Gravity.CENTER
            tv.setPadding(dp(8), dp(3), dp(8), dp(3))
            tv.background = AshUi.rounded(AshUi.withAlpha(tone, 0.14f), dpF(11f))
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

        private fun imgOf(url: String): Img {
            val avatar = url == "avatar" || url.startsWith("avatar:")
            return if (avatar) Img.Avatar(if (url.contains(':')) url.substringAfter(':') else "default") else Img.Url(url)
        }

        /** A picture in a box whose size never waits for it (style, variant, or 16:9); a soft block until it comes (a failed one stays the block). */
        private fun image(n: JSONObject, s: CStyle, ink: Int?): View {
            val url = n.optString("url")
            if (url.startsWith("icon:")) return lineIcon(url.removePrefix("icon:"), s, ink)
            val avatar = url == "avatar" || url.startsWith("avatar:")
            val p = part(n, ImagePart(ImageBox(ctx, if (avatar) Color.TRANSPARENT else c.surface2, dp(240)), url, imgOf(url)))
            changeImage(p, n, s, first = true)
            return p.box
        }

        private fun changeImage(p: ImagePart, n: JSONObject, s: CStyle, first: Boolean = false) {
            val url = n.optString("url")
            val avatar = url == "avatar" || url.startsWith("avatar:")
            val variant = n.optString("variant").ifEmpty { if (avatar) "avatar" else "mediumFeature" }
            val fit = n.optString("fit").ifEmpty { if (variant in FEATURES) "cover" else "contain" }
            p.box.scaleType = when (fit) {
                "cover" -> ImageView.ScaleType.CENTER_CROP; "fill" -> ImageView.ScaleType.FIT_XY; "none" -> ImageView.ScaleType.CENTER
                "scaleDown" -> ImageView.ScaleType.CENTER_INSIDE; else -> ImageView.ScaleType.FIT_CENTER
            }
            clip(p.box, s.cornerRadius?.let { dpF(it) } ?: if (variant == "avatar") -1f else dpF(12f))
            if (!first && url == p.url) return
            // Another picture: the box stays as it is; the new one is set when it arrives.
            p.url = url; p.img = imgOf(url)
            p.box.setImageDrawable(null)
            loadImage(p)
        }

        private fun loadImage(p: ImagePart) {
            val url = p.url
            val w = ctx.resources.displayMetrics.widthPixels
            CardImages.get(ctx, p.img, w, dp(360)) { if (p.url == url) loadImage(p) }?.let { if (p.url == url) p.box.setImageBitmap(it) }
        }

        /** The runtime look of a button: its own node and what its face draws, whether it can be pressed now. */
        private fun buttonKey(n: JSONObject): String {
            val id = n.optString("id")
            val action = n.optJSONObject("action")
            val runs = ChatCardModel.hubAction(action)
            val busy = runs && ChatCardModel.pressBusy(id in st.pressing, hubState(id), System.currentTimeMillis(), ChatCardModel.pressTimeoutMs(action))
            val sub = StringBuilder()
            fun walk(k: String, depth: Int) {
                val node = plan.byId[k] ?: return
                if (depth > CardPatcher.MAX_DEPTH) return
                sub.append(CardShape.canon(node)).append(';')
                listOfNotNull(node.optString("child").ifEmpty { null }).plus(ids(node)).forEach { walk(it, depth + 1) }
            }
            walk(id, 0)
            return "$sub|$busy|${st.busy}|$accent"
        }

        private fun outcomeOf(id: String): String =
            ChatCardModel.outcome((st.copied[id] ?: 0L) > SystemClock.uptimeMillis(), st.failedHere[id], hubState(id))?.let { "${it.first}|${it.second}" }.orEmpty()

        private fun button(n: JSONObject): View {
            val action = n.optJSONObject("action")
            val id = n.optString("id")
            val runs = ChatCardModel.hubAction(action)
            val pressBusy = runs && ChatCardModel.pressBusy(id in st.pressing, hubState(id), System.currentTimeMillis(), ChatCardModel.pressTimeoutMs(action))
            val face = buttonFace(n, if (pressBusy) "处理中…" else null)
            // A button the hub runs, or a copy, has its outcome line under it, held from the start.
            if (!runs && action?.has("copy") != true) { part(n, ButtonPart(buttonKey(n), null)); return face }
            val line = AshUi.text(ctx, "", LINE, null).apply { minLines = 1; maxLines = 3; ellipsize = TextUtils.TruncateAt.END; maxWidth = dp(280) }
            part(n, ButtonPart(buttonKey(n), line))
            setOutcome(line, id)
            return AshUi.vstack(ctx, 2).apply {
                addView(face, LinearLayout.LayoutParams(WRAP, WRAP))
                addView(line, LinearLayout.LayoutParams(WRAP, WRAP))
            }
        }

        private fun setOutcome(line: TextView, id: String) {
            val out = ChatCardModel.outcome((st.copied[id] ?: 0L) > SystemClock.uptimeMillis(), st.failedHere[id], hubState(id))
            AshUi.style(line, LINE, if (out?.second == true) c.err else null)
            line.text = out?.first.orEmpty()
        }

        /** A button whose face is as it was: only its line changes, in place. Else it is drawn anew (only it). */
        private fun changeButton(n: JSONObject): Boolean {
            val id = n.optString("id")
            val p = parts[id] as? ButtonPart ?: return false
            if (p.faceKey != buttonKey(n)) return false
            p.line?.let { setOutcome(it, id) }
            return true
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
                    inButton = true; free++
                    try { drawFree(childId, fg, 0)?.let { addView(it, params(child, Slot.ROW, null)) } } finally { inButton = false; free-- }
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
        private fun put(n: JSONObject, value: Any) { if (binding) return; val b = bindOf(n) ?: return; changed(st, b) { ChatCardModel.write(st.data, b, value) } }
        private fun fieldLabel(text: String) = AshUi.text(ctx, text, AshType(13f, 18f, 500, Role.TEXT_2))
        private fun setLabel(tv: TextView?, text: String) { if (tv != null && tv.text.toString() != text) styled(tv, text, AshType(13f, 18f, 500, Role.TEXT_2)) }
        /** An input's label sits this far above its box. */
        private fun labelled() = AshUi.vstack(ctx, LABEL_GAP)
        private fun boxBackground() = AshUi.rounded(c.surface2, dpF(12f))
        /** Sets a value on an input without it counting as the owner's change. */
        private inline fun quietly(f: () -> Unit) { binding = true; try { f() } finally { binding = false } }

        /** Editing of component [id] ended: the hub's value kept aside meanwhile is shown now, if the owner did not change the field. */
        private fun settle(id: String, n: JSONObject) {
            val b = bindOf(n) ?: return
            if (st.edits.ended(id, b, st.data)) paint(st)
        }

        private fun check(n: JSONObject, ink: Int?): View = CheckBox(ctx).also { box ->
            val p = part(n, CheckPart(box))
            AshUi.style(box, BODY, ink ?: c.text)
            box.buttonTintList = ColorStateList.valueOf(accent)
            box.setOnCheckedChangeListener { _, on -> put(n, on) }
            changeCheck(p, n, ink)
        }

        private fun changeCheck(p: CheckPart, n: JSONObject, ink: Int?) {
            p.box.setTextColor(ink ?: c.text)
            p.box.text = n.optString("label")
            val want = valueOf(n) as? Boolean ?: n.optBoolean("checked")
            if (p.box.isChecked != want) quietly { p.box.isChecked = want }
            p.box.isEnabled = enabled(n)
        }

        private fun switch(n: JSONObject, ink: Int?): View = AshUi.hstack(ctx, 10).apply {
            val label = AshUi.text(ctx, n.optString("label"), BODY, ink)
            addView(label, LinearLayout.LayoutParams(0, WRAP, 1f))
            val sw = AshUi.AshSwitch(ctx)
            sw.onChange = { on -> put(n, on) }
            addView(sw)
            changeSwitch(part(n, SwitchPart(label, sw)), n, ink)
        }

        private fun changeSwitch(p: SwitchPart, n: JSONObject, ink: Int?) {
            AshUi.style(p.label, BODY, ink)
            styled(p.label, n.optString("label"), BODY)
            val want = valueOf(n) as? Boolean ?: n.optBoolean("checked")
            if (p.sw.checked != want) p.sw.set(want)
            val on = enabled(n)
            p.sw.isEnabled = on; p.sw.alpha = if (on) 1f else 0.5f
        }

        private fun chosenOf(n: JSONObject): LinkedHashSet<String> {
            val chosen = LinkedHashSet<String>()
            val all = n.optJSONArray("options") ?: JSONArray()
            val given = valueOf(n) as? JSONArray
            if (given != null) for (i in 0 until given.length()) chosen.add(given.optString(i))
            else for (i in 0 until all.length()) all.optJSONObject(i)?.takeIf { it.optBoolean("checked") }?.let { chosen.add(it.optString("value")) }
            return chosen
        }

        private fun choice(n: JSONObject): View {
            val all = n.optJSONArray("options") ?: JSONArray()
            val options = (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            val multiple = n.optBoolean("multiple")
            val chips = n.optBoolean("chips")
            val box = labelled()
            val label = n.optString("label").takeIf { it.isNotEmpty() }?.let { fieldLabel(it).also(box::addView) }
            val holder: ViewGroup = if (chips) Flow(ctx, dp(8)) else AshUi.vstack(ctx, 8)
            lateinit var p: ChoicePart
            fun fill() {
                holder.removeAllViews()
                val on = enabled(p.node)
                val chosen = p.chosen
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
            p = part(n, ChoicePart(label, n, chosenOf(n), ::fill))
            fill()
            box.addView(holder, LinearLayout.LayoutParams(MATCH, WRAP))
            return box
        }

        private fun changeChoice(p: ChoicePart, n: JSONObject) {
            setLabel(p.label, n.optString("label"))
            val was = enabled(p.node)
            p.node = n
            val now = chosenOf(n)
            if (now != p.chosen || was != enabled(n)) { p.chosen.clear(); p.chosen.addAll(now); p.fill() }
        }

        private fun composing(et: EditText) = BaseInputConnection.getComposingSpanStart(et.text) >= 0

        private fun field(n: JSONObject): View {
            val id = n.optString("id")
            val bind = bindOf(n)
            val variant = n.optString("variant").ifEmpty { "shortText" }
            val obscured = variant == "obscured"
            // A password box keeps what is typed here only (never in the data, never in a draft); the form sends it to the vault.
            val secretKey = bind ?: "#$id"
            val box = labelled()
            val label = n.optString("label").takeIf { it.isNotEmpty() }?.let { fieldLabel(it).also(box::addView) }
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
                setText(if (obscured) secrets[st.id]?.get(secretKey).orEmpty() else asText(valueOf(n)) ?: n.optString("text"))
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun afterTextChanged(s: Editable?) {
                        if (binding) return
                        val t = s?.toString().orEmpty()
                        if (obscured) secrets.getOrPut(st.id) { HashMap() }[secretKey] = t
                        else put(n, t)
                    }
                })
            }
            val p = part(n, FieldPart(label, et, n))
            et.setOnFocusChangeListener { _, has ->
                if (has) return@setOnFocusChangeListener
                // A selection left behind does not keep the field "being edited".
                if (et.hasSelection() && !composing(et)) et.setSelection(et.selectionEnd)
                settle(id, p.node)
            }
            changeField(p, n)
            box.addView(et, LinearLayout.LayoutParams(MATCH, WRAP))
            return box
        }

        /** A text box's label, hint, state and value; the value never while the owner is in the box (cursor, composing text, selection). */
        private fun changeField(p: FieldPart, n: JSONObject) {
            p.node = n
            setLabel(p.label, n.optString("label"))
            val hint = n.optString("placeholder").ifEmpty { null }
            if (p.et.hint?.toString() != hint) p.et.hint = hint
            val on = enabled(n)
            p.et.isEnabled = on; p.et.alpha = if (on) 1f else 0.6f
            if (n.optString("variant") == "obscured") return
            val want = asText(valueOf(n)) ?: n.optString("text")
            val editing = p.et.hasFocus() || composing(p.et) || p.et.hasSelection()
            if (!editing && p.et.text.toString() != want) quietly { p.et.setText(want) }
        }

        private fun asText(v: Any?): String? = when (v) { null -> null; is String -> v; is Number -> ChatCardModel.number(v); is Boolean -> v.toString(); else -> null }

        private fun dateTime(n: JSONObject): View {
            val enableDate = n.optBoolean("enableDate", true)
            val enableTime = n.optBoolean("enableTime", false)
            val hint = when { enableDate && enableTime -> "选择日期和时间"; enableTime -> "选择时间"; else -> "选择日期" }
            val box = labelled()
            val label = n.optString("label").takeIf { it.isNotEmpty() }?.let { fieldLabel(it).also(box::addView) }
            val shown = AshUi.style(TextView(ctx), BODY, c.text).apply {
                background = boxBackground(); setPadding(dp(12), dp(10), dp(12), dp(10)); minHeight = dp(44); gravity = Gravity.CENTER_VERTICAL
            }
            lateinit var p: DatePart
            fun show() { shown.text = if (p.value.isEmpty()) hint else p.value.replace('T', ' '); shown.setTextColor(if (p.value.isEmpty()) c.text3 else c.text) }
            p = part(n, DatePart(label, shown, n, "", ::show))
            shown.setOnClickListener {
                if (!enabled(p.node)) return@setOnClickListener
                val activity = activity ?: return@setOnClickListener
                val (d0, t0) = ChatCardModel.isoParts(p.value)
                fun done(d: LocalDate?, t: LocalTime?) { p.value = ChatCardModel.iso(d, t); show(); put(n, p.value) }
                fun time(d: LocalDate?) {
                    val t = t0 ?: LocalTime.now()
                    TimePickerDialog(activity, { _, h, m -> done(d, LocalTime.of(h, m)) }, t.hour, t.minute, true).show()
                }
                if (enableDate) {
                    val d = d0 ?: LocalDate.now()
                    DatePickerDialog(activity, { _, y, mo, dd -> val picked = LocalDate.of(y, mo + 1, dd); if (enableTime) time(picked) else done(picked, null) },
                        d.year, d.monthValue - 1, d.dayOfMonth).show()
                } else time(null)
            }
            changeDate(p, n)
            box.addView(shown, LinearLayout.LayoutParams(MATCH, WRAP))
            return box
        }

        private fun changeDate(p: DatePart, n: JSONObject) {
            p.node = n
            setLabel(p.label, n.optString("label"))
            p.value = (valueOf(n) as? String) ?: n.optString("text")
            p.show()
            p.shown.alpha = if (enabled(n)) 1f else 0.6f
        }

        private fun slider(n: JSONObject, ink: Int?): View {
            val id = n.optString("id")
            val min = n.optDouble("min", 0.0)
            val max = n.optDouble("max", 100.0).let { if (it > min) it else min + 1 }
            val step = ChatCardModel.sliderStep(min, max, n.optDouble("step", Double.NaN))
            val notches = Math.round((max - min) / step).toInt().coerceIn(1, 100_000)
            val label = AshUi.text(ctx, n.optString("label"), AshType(13f, 18f, 500, Role.TEXT_2), ink)
            val shown = AshUi.text(ctx, "", AshType(13f, 18f, 600, Role.TEXT_2))
            val bar = SeekBar(ctx)
            val p = part(n, SliderPart(label, shown, bar, min, step, notches))
            bar.max = notches
            bar.progressTintList = ColorStateList.valueOf(accent); bar.thumbTintList = ColorStateList.valueOf(accent)
            bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(b: SeekBar, progress: Int, fromUser: Boolean) {
                    if (!fromUser) return
                    val v = ChatCardModel.sliderValue(min, max, step, progress)
                    shown.text = ChatCardModel.number(v)
                    put(n, v)
                }
                override fun onStartTrackingTouch(b: SeekBar) { p.dragging = true }
                override fun onStopTrackingTouch(b: SeekBar) { p.dragging = false; settle(id, n) }
            })
            changeSlider(p, n, ink)
            return AshUi.vstack(ctx, 2).apply {
                addView(AshUi.hstack(ctx, 8).apply {
                    addView(label, LinearLayout.LayoutParams(0, WRAP, 1f))
                    addView(shown)
                }, LinearLayout.LayoutParams(MATCH, WRAP))
                addView(bar, LinearLayout.LayoutParams(MATCH, WRAP))
            }
        }

        private fun changeSlider(p: SliderPart, n: JSONObject, ink: Int?) {
            AshUi.style(p.label, AshType(13f, 18f, 500, Role.TEXT_2), ink)
            styled(p.label, n.optString("label"), AshType(13f, 18f, 500, Role.TEXT_2))
            p.bar.isEnabled = enabled(n)
            if (p.dragging) return
            val value = (valueOf(n) as? Number)?.toDouble() ?: n.optDouble("value", p.min)
            p.shown.text = ChatCardModel.number(value)
            p.bar.progress = Math.round((value - p.min) / p.step).toInt().coerceIn(0, p.notches)
        }

        private fun progress(n: JSONObject, s: CStyle, ink: Int?): View = AshUi.vstack(ctx, 6).apply {
            val label = n.optString("label").takeIf { it.isNotEmpty() }?.let { AshUi.text(ctx, it, AshTokens.Type.sub, ink).also(::addView) }
            val bar = ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal).apply {
                isIndeterminate = false
                this.max = 1000
                progressBackgroundTintList = ColorStateList.valueOf(c.surface3)
            }
            addView(bar, LinearLayout.LayoutParams(MATCH, dp(6)))
            changeProgress(part(n, ProgressPart(label, bar)), n, s, ink)
        }

        private fun changeProgress(p: ProgressPart, n: JSONObject, s: CStyle, ink: Int?) {
            p.label?.let { l -> AshUi.style(l, AshTokens.Type.sub, ink); styled(l, n.optString("label"), AshTokens.Type.sub) }
            val max = n.optDouble("max", 100.0)
            p.bar.progress = if (max > 0) (n.optDouble("value", 0.0) / max * 1000).roundToInt().coerceIn(0, 1000) else 0
            p.bar.progressTintList = ColorStateList.valueOf(s.color?.pick(night) ?: accent)
        }

        private fun table(n: JSONObject, ink: Int?): View {
            val t = TableLayout(ctx).apply {
                isStretchAllColumns = true
                showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
                dividerDrawable = GradientDrawable().apply { setColor(c.line); setSize(1, maxOf(1, dp(1))) }
            }
            part(n, TablePart(t))
            fillTable(t, n, ink)
            return HorizontalScrollView(ctx).apply {
                isHorizontalScrollBarEnabled = false; isFillViewport = true
                background = AshUi.rounded(c.surface2, dpF(12f))
                clip(this, dpF(12f))
                addView(t)
            }
        }

        /** The table's rows, in the table that stays. */
        private fun fillTable(t: TableLayout, n: JSONObject, ink: Int?) {
            val header = n.optJSONArray("header") ?: JSONArray()
            val rows = n.optJSONArray("rows") ?: JSONArray()
            val width = header.length()
            t.removeAllViews()
            fun row(cells: List<String>, head: Boolean) = TableRow(ctx).apply {
                // A cell is the card's Markdown, as a Text is.
                for (cell in cells) addView(AshUi.text(ctx, Md.render(cell, c.surface2, c.her), if (head) AshType(13f, 18f, 600, Role.INK) else AshType(13.5f, 19f, 400, Role.TEXT), if (head) null else ink).apply {
                    setPadding(dp(10), dp(7), dp(10), dp(7)); maxWidth = dp(260)
                })
            }
            t.addView(row((0 until width).map { header.optString(it) }, true))
            for (i in 0 until rows.length()) {
                val r = rows.optJSONArray(i) ?: continue
                t.addView(row((0 until width).map { if (it < r.length()) r.optString(it) else "" }, false))
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

        // --- the mini app ---

        /** Whether the mini app has 「存成应用」 under it: a card an agent made, of no app (a card of an app already is one). */
        private fun saveShown(): Boolean {
            val owner = st.card.optString("owner")
            return owner.startsWith("agent:") && st.card.optString("app").isEmpty() && !st.card.optBoolean("temporary_app")
        }

        private fun themeVars(): Map<String, String> =
            mapOf("bg" to c.bg, "surface" to c.surface, "text" to c.text, "text2" to c.text2, "accent" to accent, "line" to c.line).mapValues { ChatCardModel.css(it.value) }

        /** The mini app (in its box of the node's height), and under it 「存成应用」. */
        private fun miniApp(n: JSONObject): View {
            val id = n.optString("id")
            val height = dp(n.optDouble("height", 320.0))
            // A web view off screen draws nothing: in a picture the mini app is a block of its size.
            if (preview) return AshUi.vstack(ctx).apply {
                addView(FrameLayout(ctx).apply {
                    background = AshUi.rounded(c.surface2, dpF(12f))
                    addView(AshUi.text(ctx, "小应用", AshTokens.Type.sub, c.text3), FrameLayout.LayoutParams(WRAP, WRAP, Gravity.CENTER))
                }, LinearLayout.LayoutParams(MATCH, height))
            }
            val app = st.card.optString("app").ifEmpty { null }
            val mini = st.minis[id]?.takeIf { it.gate.app == app?.takeIf { a -> ai.ash.apps.AppIds.valid(a) } }
                ?: newMini(id, app).also { st.minis.put(id, it)?.destroy() }
            detach(mini.box)
            clip(mini.box, dpF(12f))
            val owner = st.card.optString("owner")
            val save = AshUi.button(ctx, "存成应用", AshUi.Kind.GHOST, AshUi.BtnSize.SM).also { b ->
                if (readOnly) AshUi.disable(b)
                else b.setOnClickListener { post(owner, ChatCardModel.sayBody("把这个小应用存成应用", st.id, "save_app", JSONObject().put("component", id), st.data)) }
            }
            val p = part(n, MiniPart(mini, save))
            changeMini(p, n)
            return AshUi.vstack(ctx, 4).apply {
                addView(mini.box, LinearLayout.LayoutParams(MATCH, height))
                addView(save, LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.END })
            }
        }

        /** The box's height, 「存成应用」, and the page: loaded again only when its HTML changed; asleep while the card is. */
        private fun changeMini(p: MiniPart, n: JSONObject) {
            val height = dp(n.optDouble("height", 320.0))
            (p.mini.box.layoutParams as? LinearLayout.LayoutParams)?.takeIf { it.height != height }?.let { it.height = height; p.mini.box.layoutParams = it }
            p.save?.visibility = if (saveShown()) View.VISIBLE else View.GONE
            p.mini.set(n.optString("html"), themeVars(), night, if (ChatCardModel.closed(st.card)) "dormant" else st.card.optString("life").ifEmpty { "active" })
        }

        private fun newMini(component: String, app: String?) = CardMini(ctx, st.id, component, app,
            onSend = { name, context -> event(st, name, context, name) },
            onAct = { gate, request, answer -> miniAct(st, gate, request, answer) })
    }
    // --- what the owner does on a card ---

    /** A value changed: kept in the working copy at once, and told to the hub (`card.draft`) once the owner pauses. */
    private fun changed(st: Card, path: String, write: () -> Unit) {
        write()
        st.edits.changed(path)
        st.pending?.let(main::removeCallbacks)
        val r = Runnable { st.pending = null; draft(st) }
        st.pending = r
        main.postDelayed(r, DRAFT_MS)
    }

    private fun draft(st: Card) {
        if (!st.open()) return
        val port = port ?: return
        val seq = ++st.draftSeq
        val mark = st.edits.mark()
        st.inFlight++
        port.call("person:owner", "card.draft", JSONObject().put("card", st.id).put("data", JSONObject(st.data.toString()))) { data, failure ->
            st.inFlight--
            // Quietly: a draft that did not arrive is sent again with the next change, and the values are on the screen.
            if (failure != null || data == null) return@call
            // The hub has the owner's values up to here: what it sends from now on has them.
            st.edits.confirmed(mark)
            if (seq != st.draftSeq || st.pending != null) return@call
            if (st.plan?.reactive != true) return@call
            // A reactive card is drawn again from the hub's answer; the working copy stays (it may already be newer).
            ChatCardModel.plan(data.optJSONObject("plan"))?.let { st.plan = it; paint(st) }
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


    /**
     * A mini app's `ash.call / ask / tell` (already checked by its [MiniGate], at most 2 a second): `service:cards/act {request}`
     * as the card's Html component, run like a button of the card by the hub; [answer] gets `{state, text, result?}` once.
     */
    private fun miniAct(st: Card, gate: MiniGate, request: JSONObject, answer: (JSONObject) -> Unit) {
        val port = port ?: return answer(ChatCardModel.miniAnswer(null, "unavailable"))
        if (!st.open()) return answer(ChatCardModel.miniAnswer(null, "conflict"))
        var answered = false
        fun once(a: JSONObject) { if (!answered) { answered = true; answer(a) } }
        main.postDelayed({ once(ChatCardModel.miniAnswer(null, "timeout")) }, ChatCardModel.pressTimeoutMs(null))
        port.call("service:cards", "act", gate.actBody(request, st.data)) { data, failure -> once(ChatCardModel.miniAnswer(data, failure?.code)) }
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
    private class MiniSwitch(ctx: Context, on: Boolean, private val onColor: Int, private val offColor: Int) : View(ctx) {
        var on = on
            set(v) { if (field != v) { field = v; invalidate() } }
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
    private class ChartView(ctx: Context, private var chart: AshChart.Chart, private val night: Boolean) : View(ctx) {
        private var bmp: Bitmap? = null
        /** New series in the same box. */
        fun set(next: AshChart.Chart) { if (next != chart) { chart = next; bmp = null; invalidate() } }
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { bmp = null }
        override fun onDraw(canvas: Canvas) {
            if (width <= 0 || height <= 0) return
            val d = resources.displayMetrics.density
            val b = bmp ?: AshChart.render(chart, width / d, height / d, d, night).also { bmp = it }
            canvas.drawBitmap(b, 0f, 0f, null)
        }
    }

    /**
     * A picture's box: its size comes from the layout (the node's style or its variant), else 16:9 ([CardShape.boxSize]), never
     * from the picture, so the row does not move when it arrives or fails. A soft block is drawn until it comes.
     */
    private class ImageBox(ctx: Context, private val placeholder: Int, private val fallbackW: Int) : ImageView(ctx) {
        private val block = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = placeholder }
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val wm = MeasureSpec.getMode(widthMeasureSpec); val hm = MeasureSpec.getMode(heightMeasureSpec)
            val (w, h) = CardShape.boxSize(wm == MeasureSpec.EXACTLY, if (wm == MeasureSpec.UNSPECIFIED) null else MeasureSpec.getSize(widthMeasureSpec),
                hm == MeasureSpec.EXACTLY, if (hm == MeasureSpec.UNSPECIFIED) null else MeasureSpec.getSize(heightMeasureSpec), fallbackW)
            setMeasuredDimension(w, h)
        }
        override fun onDraw(canvas: Canvas) {
            if (drawable == null) { if (Color.alpha(placeholder) != 0) canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), block); return }
            super.onDraw(canvas)
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
        /** Components that write the card's data at their `bind`. */
        val INPUTS = setOf("TextField", "CheckBox", "Switch", "ChoicePicker", "DateTimeInput", "Slider")
        /** Justify values that share the room between the children that show. */
        val SPREAD = setOf("spaceBetween", "spaceAround", "spaceEvenly")
        /** The line under a button. */
        val LINE = AshType(11.5f, 15f, 400, Role.TEXT_2)
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
