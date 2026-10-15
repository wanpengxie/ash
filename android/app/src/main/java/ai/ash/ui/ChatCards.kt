package ai.ash.ui

import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
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
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
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
        "accountCircle" to null, "add" to R.drawable.ash_ic_plus, "arrowBack" to R.drawable.ash_ic_back, "arrowForward" to R.drawable.ash_ic_chev,
        "attachFile" to R.drawable.ash_ic_link, "calendarToday" to R.drawable.ash_ic_clock, "call" to R.drawable.ash_ic_phone, "camera" to R.drawable.ash_ic_camera,
        "check" to R.drawable.ash_ic_check, "close" to R.drawable.ash_ic_x, "delete" to R.drawable.ash_ic_trash, "download" to R.drawable.ash_ic_down,
        "edit" to R.drawable.ash_ic_pen, "event" to R.drawable.ash_ic_clock, "error" to R.drawable.ash_ic_alert, "fastForward" to R.drawable.ash_ic_chev,
        "favorite" to R.drawable.ash_ic_heart, "favoriteOff" to R.drawable.ash_ic_heart, "folder" to R.drawable.ash_ic_folder, "help" to R.drawable.ash_ic_ask,
        "home" to R.drawable.ash_ic_grid, "info" to R.drawable.ash_ic_alert, "locationOn" to R.drawable.ash_ic_pin, "lock" to R.drawable.ash_ic_lock,
        "lockOpen" to R.drawable.ash_ic_key, "mail" to R.drawable.ash_ic_msg, "menu" to R.drawable.ash_ic_list, "moreVert" to R.drawable.ash_ic_more,
        "moreHoriz" to R.drawable.ash_ic_more, "notificationsOff" to R.drawable.ash_ic_bell, "notifications" to R.drawable.ash_ic_bell,
        "pause" to R.drawable.ash_ic_pause, "payment" to R.drawable.ash_ic_wallet, "person" to null, "phone" to R.drawable.ash_ic_phone,
        "photo" to R.drawable.ash_ic_image, "play" to R.drawable.ash_ic_chev, "print" to R.drawable.ash_ic_file, "refresh" to R.drawable.ash_ic_refresh,
        "rewind" to R.drawable.ash_ic_back, "search" to R.drawable.ash_ic_eye, "send" to R.drawable.ash_ic_up, "settings" to R.drawable.ash_ic_slider,
        "share" to R.drawable.ash_ic_link, "shoppingCart" to R.drawable.ash_ic_box, "skipNext" to R.drawable.ash_ic_chev, "skipPrevious" to R.drawable.ash_ic_back,
        "star" to null, "starHalf" to null, "starOff" to null, "stop" to R.drawable.ash_ic_stop, "upload" to R.drawable.ash_ic_up,
        "visibility" to R.drawable.ash_ic_eye, "visibilityOff" to R.drawable.ash_ic_eye, "volumeDown" to null, "volumeMute" to null, "volumeOff" to null,
        "volumeUp" to null, "warning" to R.drawable.ash_ic_alert,
        "sun" to null, "cloud" to null, "rain" to null, "snow" to null, "wind" to null, "moon" to R.drawable.ash_ic_moon, "heart" to R.drawable.ash_ic_heart,
        "steps" to R.drawable.ash_ic_pulse, "weight" to null, "sleep" to R.drawable.ash_ic_moon, "water" to null, "fire" to R.drawable.ash_ic_bolt,
        "calendar" to R.drawable.ash_ic_clock, "clock" to R.drawable.ash_ic_clock, "alert" to R.drawable.ash_ic_alert, "bell" to R.drawable.ash_ic_bell,
        "car" to null, "money" to R.drawable.ash_ic_coin, "chart" to R.drawable.ash_ic_pulse)

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

    /** The mini app's only rules: its own inline code and styles, pictures and fonts given inline; nothing else, no network. */
    const val MINI_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"
    private val DOCTYPE = Regex("^\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE)

    /**
     * The document a mini app's sandbox loads: first thing, its CSP, the theme as CSS variables (`--ash-bg` …) and `ash.send(action,
     * context)`, which hands the action to the phone's bridge ([bridge] is the injected object's name); then the agent's HTML.
     */
    fun miniAppDocument(html: String, vars: Map<String, String>, dark: Boolean, bridge: String = "__ashCard"): String {
        val css = vars.entries.joinToString(";") { "--ash-${it.key}:${it.value}" }
        val head = "<meta http-equiv=\"Content-Security-Policy\" content=\"$MINI_CSP\">" +
            "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<style>:root{$css;color-scheme:${if (dark) "dark" else "light"}}</style>" +
            "<script>(function(){var b=window.$bridge;var send=function(a,c){try{b.send(String(a),JSON.stringify(c===undefined?{}:c))}catch(e){}};" +
            "Object.defineProperty(window,\"ash\",{value:Object.freeze({send:send}),writable:false,configurable:false});})();</script>"
        val body = html.removePrefix("﻿")
        val doctype = DOCTYPE.find(body)
        return if (doctype != null) doctype.value + head + body.substring(doctype.range.last + 1) else head + body
    }
}

/**
 * Cards in the conversation (`person:owner/show {a2ui}`, `form`) drawn natively from the plan the hub resolved: the same component
 * language as the home-screen cards, with the widget's colours, icons, images and charts, in the chat's own card shell.
 *
 * The chat makes a row again whenever an item changes; what the owner is doing on a card is kept here, by card id: the working copy
 * of its data (inputs write into it at their `bind`), the passwords typed (never in the data, never saved; they go only to
 * `service:vault/set`), the tab shown, the field with the cursor. A card's view is one holder that stays the same view, so the chat
 * keeps it where it is; it is drawn again inside only when what it shows changed.
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
        var lastEdit = 0L
        var draftSeq = 0
        var inFlight = 0
        var pending: Runnable? = null
        var paintedRaw: String? = null
        var paintedRest: String? = null
        /** The 👍 / 👎 tapped here, until the item says it. */
        var feedbackLocal: String? = null
        /** Pictures still on their way in the last drawing. */
        var waitingImages = 0
        /** The chat's card shell is at most 330 dp wide. */
        val holder: FrameLayout = Capped(ctx, dp(AshTokens.Size.cardMaxW))
        /** The text boxes drawn, by component id (to put the cursor back after drawing again). */
        val fields = HashMap<String, EditText>()
        /** Mini apps, by component id, with the document they run. */
        val webs = HashMap<String, Pair<String, WebView>>()

        fun state(): String {
            local?.let { return it }
            val s = card.optString("state").ifEmpty { "open" }
            val ends = card.optJSONObject("form")?.optLong("expires_at") ?: 0L
            return if (s == "open" && ends > 0 && ends <= System.currentTimeMillis()) "expired" else s
        }
        fun open() = state() == "open"
        fun feedback() = ChatCardModel.feedbackShown(feedbackLocal, card.optString("feedback").ifEmpty { null })
        /** The owner is at it: a box has the cursor, or a change has not reached the hub yet. */
        fun editing() = holder.findFocus() != null || pending != null || inFlight > 0 || SystemClock.uptimeMillis() - lastEdit < 1500
    }

    private val cards = HashMap<String, Card>()
    /** Password boxes: card id -> the box's bind path -> what is typed. In memory only. */
    private val secrets = HashMap<String, HashMap<String, String>>()

    /** The view of a card item (`type: "card"`, `card.type: "a2ui"`); the same view each time for the same card. */
    fun view(item: JSONObject): View {
        val card = item.optJSONObject("card") ?: JSONObject()
        val plan = ChatCardModel.plan(card.optJSONObject("plan")) ?: return plain(card.optString("text"))
        val id = card.optString("id").ifEmpty { item.optString("id") }
        val st = cards.getOrPut(id) { Card(id) }
        st.card = card
        val updated = card.optLong("updated_at")
        // A newer version from the hub (the creator changed it, or another screen did): taken unless the owner is editing here.
        if (st.plan == null || (updated > st.updatedAt && !st.editing())) {
            st.plan = plan; st.data = JSONObject(plan.data.toString()); st.updatedAt = updated
        }
        if (card.optString("state").ifEmpty { "open" } != "open") st.local = null
        if (st.feedbackLocal != null && st.feedbackLocal == card.optString("feedback")) st.feedbackLocal = null
        paint(st)
        return st.holder
    }

    /** Pictures still on their way in the cards drawn last. */
    fun waitingImages(): Int = cards.values.sumOf { it.waitingImages }

    /** Draws every card again (a picture that has come in since is in it now). */
    fun redraw() { for (st in cards.values) { st.paintedRaw = null; paint(st) } }

    fun close() {
        for (st in cards.values) {
            st.pending?.let(main::removeCallbacks)
            st.webs.values.forEach { runCatching { it.second.destroy() } }
            st.webs.clear()
        }
        secrets.clear()
    }

    // --- drawing ---

    private fun paint(st: Card) {
        val plan = st.plan ?: return
        val state = st.state()
        val rest = "$state|${st.busy}|${st.tabs}|${st.feedback()}"
        if (st.paintedRaw == plan.raw && st.paintedRest == rest) return
        val focused = st.holder.findFocus() as? EditText
        val focusId = st.fields.entries.firstOrNull { it.value === focused }?.key
        val selection = focused?.let { it.selectionStart to it.selectionEnd }
        st.fields.clear()
        st.waitingImages = 0
        val draw = Draw(st, plan, state)
        val drawn = runCatching { draw.card() }.getOrElse { Log.w(TAG, "card ${st.id} could not be drawn", it); plain(st.card.optString("text")) }
        st.holder.removeAllViews()
        st.holder.addView(drawn, FrameLayout.LayoutParams(MATCH, WRAP))
        st.paintedRaw = plan.raw; st.paintedRest = rest
        for (gone in st.webs.keys - draw.webs) st.webs.remove(gone)?.let { runCatching { it.second.destroy() } }
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
            // Its height is held from the first drawing: choosing one changes only how they look.
            if (!preview && st.card.optJSONObject("form") == null) addView(footer(), LinearLayout.LayoutParams(MATCH, dp(FOOTER_DP)))
        }

        /** 👍 / 👎, small and quiet at the end; the one the owner gave last is chosen, and tapping it again does nothing. */
        private fun footer(): View = AshUi.hstack(ctx, 4).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            val shown = st.feedback()
            for ((which, emoji) in listOf("up" to "👍", "down" to "👎")) {
                val chosen = shown == which
                addView(AshUi.text(ctx, emoji, AshType(12f, 16f, 400, Role.TEXT_3)).apply {
                    gravity = Gravity.CENTER
                    setPadding(dp(8), 0, dp(8), 0)
                    alpha = if (chosen) 1f else 0.5f
                    if (chosen) background = AshUi.rounded(c.surface2, dpF(FOOTER_DP / 2f))
                    contentDescription = if (which == "up") "有用" else "没用"
                    isSelected = chosen
                    setOnClickListener { feedback(st, which) }
                }, LinearLayout.LayoutParams(WRAP, MATCH))
            }
        }

        fun node(id: String, ink: Int?): View? {
            val n = plan.byId[id] ?: return null
            if (!n.optBoolean("visible", true)) return null
            val s = style(n)
            val color = s.color?.pick(night) ?: ink
            val v = runCatching { build(n, s, color) }.getOrElse { Log.w(TAG, "card ${st.id}: ${n.optString("component")} $id left out", it); null } ?: return null
            decorate(v, n, s)
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
            "Chart" -> ChartView(ctx, AshChart.parse(n, ::tint), night)
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
            val body = Md.render(n.optString("text"), c.surface2, c.her)
            val tv = AshUi.text(ctx, body, type, ink?.let { if (variant == "caption") AshUi.withAlpha(it, 0.7f) else it })
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
            // Links open when tapped; inside a button the whole button is the tap.
            if (!inButton && body.getSpans(0, body.length, ClickableSpan::class.java).isNotEmpty()) tv.movementMethod = LinkMovementMethod.getInstance()
            return tv
        }

        private fun badge(n: JSONObject, s: CStyle): TextView {
            val tone = s.color?.pick(night) ?: accent
            return AshUi.text(ctx, n.optString("text"), AshType(11.5f, 14f, 600, null), tone).apply {
                gravity = Gravity.CENTER; setPadding(dp(8), dp(3), dp(8), dp(3))
                background = AshUi.rounded(AshUi.withAlpha(tone, 0.14f), dpF(11f))
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
            val img = if (avatar) Img.Avatar(if (url.contains(':')) url.substringAfter(':') else "default") else Img.Url(url)
            val w = ctx.resources.displayMetrics.widthPixels
            // A picture still on its way is a soft block; it is set when it arrives (a failed one stays the block).
            if (!avatar) iv.background = AshUi.rounded(c.surface2, 0f)
            fun load() { CardImages.get(ctx, img, w, dp(360)) { load() }?.let { iv.setImageBitmap(it); iv.background = null } }
            load()
            if (iv.drawable == null && url.startsWith("https:") && !CardImages.failed.containsKey(url)) st.waitingImages++
            clip(iv, s.cornerRadius?.let { dpF(it) } ?: if (variant == "avatar") -1f else dpF(12f))
            return iv
        }

        private fun button(n: JSONObject): View {
            val kind = when (n.optString("variant")) { "primary" -> AshUi.Kind.PRIMARY; "borderless" -> AshUi.Kind.GHOST; else -> AshUi.Kind.SECONDARY }
            val enabled = !readOnly && !st.busy && !n.optBoolean("disabled") && n.optJSONObject("action") != null
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
            val v: View = if (child == null || (child.optString("component") == "Text" && child.optJSONObject("style") == null)) {
                AshUi.button(ctx, ChatCardModel.label(plan.byId, n), kind, AshUi.BtnSize.SM).also { b ->
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
        private fun put(n: JSONObject, value: Any) { val b = bindOf(n) ?: return; changed(st) { ChatCardModel.write(st.data, b, value) } }
        private fun fieldLabel(text: String) = AshUi.text(ctx, text, AshType(13f, 18f, 500, Role.TEXT_2))
        /** An input's label sits this far above its box. */
        private fun labelled() = AshUi.vstack(ctx, LABEL_GAP)
        private fun boxBackground() = AshUi.rounded(c.surface2, dpF(12f))

        private fun check(n: JSONObject, ink: Int?): View = CheckBox(ctx).apply {
            AshUi.style(this, BODY, ink ?: c.text)
            text = n.optString("label")
            buttonTintList = ColorStateList.valueOf(accent)
            isChecked = valueOf(n) as? Boolean ?: n.optBoolean("checked")
            isEnabled = enabled(n)
            setOnCheckedChangeListener { _, on -> put(n, on) }
        }

        private fun switch(n: JSONObject, ink: Int?): View = AshUi.hstack(ctx, 10).apply {
            addView(AshUi.text(ctx, n.optString("label"), BODY, ink), LinearLayout.LayoutParams(0, WRAP, 1f))
            val sw = AshUi.AshSwitch(ctx)
            sw.set(valueOf(n) as? Boolean ?: n.optBoolean("checked"))
            sw.onChange = { on -> put(n, on) }
            if (!enabled(n)) { sw.isEnabled = false; sw.alpha = 0.5f }
            addView(sw)
        }

        private fun choice(n: JSONObject): View {
            val all = n.optJSONArray("options") ?: JSONArray()
            val options = (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            val chosen = LinkedHashSet<String>()
            val given = valueOf(n) as? JSONArray
            if (given != null) for (i in 0 until given.length()) chosen.add(given.optString(i))
            else options.filter { it.optBoolean("checked") }.forEach { chosen.add(it.optString("value")) }
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
                val value = if (obscured) secrets[st.id]?.get(secretKey).orEmpty() else asText(valueOf(n)) ?: n.optString("text")
                setText(value)
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
            return box
        }

        private fun slider(n: JSONObject, ink: Int?): View {
            val min = n.optDouble("min", 0.0)
            val max = n.optDouble("max", 100.0).let { if (it > min) it else min + 1 }
            val step = ChatCardModel.sliderStep(min, max, n.optDouble("step", Double.NaN))
            val notches = Math.round((max - min) / step).toInt().coerceIn(1, 100_000)
            val start = (valueOf(n) as? Number)?.toDouble() ?: n.optDouble("value", min)
            val shown = AshUi.text(ctx, ChatCardModel.number(start), AshType(13f, 18f, 600, Role.TEXT_2))
            return AshUi.vstack(ctx, 2).apply {
                addView(AshUi.hstack(ctx, 8).apply {
                    addView(AshUi.text(ctx, n.optString("label"), AshType(13f, 18f, 500, Role.TEXT_2), ink), LinearLayout.LayoutParams(0, WRAP, 1f))
                    addView(shown)
                }, LinearLayout.LayoutParams(MATCH, WRAP))
                addView(SeekBar(ctx).apply {
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
                        override fun onStartTrackingTouch(bar: SeekBar) {}
                        override fun onStopTrackingTouch(bar: SeekBar) {}
                    })
                }, LinearLayout.LayoutParams(MATCH, WRAP))
            }
        }

        private fun progress(n: JSONObject, s: CStyle, ink: Int?): View = AshUi.vstack(ctx, 6).apply {
            n.optString("label").takeIf { it.isNotEmpty() }?.let { addView(AshUi.text(ctx, it, AshTokens.Type.sub, ink)) }
            val max = n.optDouble("max", 100.0)
            addView(ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal).apply {
                isIndeterminate = false
                this.max = 1000
                progress = if (max > 0) (n.optDouble("value", 0.0) / max * 1000).roundToInt().coerceIn(0, 1000) else 0
                progressTintList = ColorStateList.valueOf(s.color?.pick(night) ?: accent)
                progressBackgroundTintList = ColorStateList.valueOf(c.surface3)
            }, LinearLayout.LayoutParams(MATCH, dp(6)))
        }

        private fun table(n: JSONObject, ink: Int?): View {
            val header = n.optJSONArray("header") ?: JSONArray()
            val rows = n.optJSONArray("rows") ?: JSONArray()
            val width = header.length()
            val t = TableLayout(ctx).apply {
                isStretchAllColumns = true
                showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
                dividerDrawable = GradientDrawable().apply { setColor(c.line); setSize(1, maxOf(1, dp(1))) }
            }
            fun row(cells: List<String>, head: Boolean) = TableRow(ctx).apply {
                for (cell in cells) addView(AshUi.text(ctx, cell, if (head) AshType(13f, 18f, 600, Role.INK) else AshType(13.5f, 19f, 400, Role.TEXT), if (head) null else ink).apply {
                    setPadding(dp(10), dp(7), dp(10), dp(7)); maxWidth = dp(260)
                })
            }
            t.addView(row((0 until width).map { header.optString(it) }, true))
            for (i in 0 until rows.length()) {
                val r = rows.optJSONArray(i) ?: continue
                t.addView(row((0 until width).map { if (it < r.length()) r.optString(it) else "" }, false))
            }
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
            val doc = ChatCardModel.miniAppDocument(n.optString("html"), vars, night, BRIDGE)
            val key = "${doc.length}:${doc.hashCode()}"
            val web = st.webs[id]?.takeIf { it.first == key }?.second ?: sandbox(st, doc).also { w ->
                st.webs.put(id, key to w)?.second?.let { old -> runCatching { old.destroy() } }
            }
            (web.parent as? ViewGroup)?.removeView(web)
            clip(web, dpF(12f))
            return AshUi.vstack(ctx, 4).apply {
                addView(web, LinearLayout.LayoutParams(MATCH, dp(n.optDouble("height", 320.0))))
                val owner = st.card.optString("owner")
                if (owner.startsWith("agent:")) addView(AshUi.button(ctx, "存成应用", AshUi.Kind.GHOST, AshUi.BtnSize.SM).also { b ->
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
        st.lastEdit = SystemClock.uptimeMillis()
        st.pending?.let(main::removeCallbacks)
        val r = Runnable { st.pending = null; draft(st) }
        st.pending = r
        main.postDelayed(r, DRAFT_MS)
    }

    private fun draft(st: Card) {
        if (!st.open()) return
        val port = port ?: return
        val seq = ++st.draftSeq
        st.inFlight++
        port.call("person:owner", "card.draft", JSONObject().put("card", st.id).put("data", JSONObject(st.data.toString()))) { data, failure ->
            st.inFlight--
            // Quietly: a draft that did not arrive is sent again with the next change, and the values are on the screen.
            if (failure != null || data == null || seq != st.draftSeq || st.pending != null) return@call
            if (st.plan?.reactive != true) return@call
            // A reactive card is drawn again from the hub's answer; the working copy stays (it may already be newer).
            ChatCardModel.plan(data.optJSONObject("plan"))?.let { st.plan = it; paint(st) }
        }
    }

    private fun act(st: Card, n: JSONObject) {
        val a = n.optJSONObject("action") ?: return
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

    // --- the mini app's sandbox ---

    /**
     * A WebView that can reach nothing: no network (every request refused, and network loads blocked), no files, no storage, no
     * cookies (the document is a data: URL, an opaque origin), no navigation, no pop-ups, no permissions. Its only way out is
     * `ash.send`, which does what a Button does.
     */
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface", "AddJavascriptInterface")
    private fun sandbox(st: Card, doc: String): WebView = WebView(ctx).apply {
        settings.apply {
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
            blockNetworkLoads = true
            blockNetworkImage = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            @Suppress("DEPRECATION") saveFormData = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
        setBackgroundColor(Color.TRANSPARENT)
        isVerticalScrollBarEnabled = false
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.scheme in setOf("data", "about")) null
                else WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                (view.parent as? ViewGroup)?.removeView(view)
                st.webs.entries.removeAll { it.value.second === view }
                runCatching { view.destroy() }
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
            override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { cb?.onReceiveValue(null); return true }
        }
        addJavascriptInterface(Bridge(st), BRIDGE)
        loadData(Base64.encodeToString(doc.toByteArray(Charsets.UTF_8), Base64.NO_WRAP), "text/html; charset=utf-8", "base64")
    }

    /** `ash.send(action, context)` from a mini app: one action at most every 0.8 s, as if a Button with that event was tapped. */
    private inner class Bridge(private val st: Card) {
        private var last = 0L
        @JavascriptInterface fun send(action: String?, context: String?) {
            main.post {
                val now = SystemClock.uptimeMillis()
                if (now - last < 800) return@post
                last = now
                val name = action?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return@post
                val ctxObj = runCatching { JSONObject(context ?: "{}") }.getOrNull()
                event(st, name, ctxObj, name)
            }
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

    /** A Chart: drawn by [AshChart] at the size it is given, in the current theme. */
    private class ChartView(ctx: Context, private val chart: AshChart.Chart, private val night: Boolean) : View(ctx) {
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
        const val BRIDGE = "__ashCard"
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
