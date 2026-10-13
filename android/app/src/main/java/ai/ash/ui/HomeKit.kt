package ai.ash.ui

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshPalette
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.AshUi.Tone
import ai.ash.ui.design.Role
import org.json.JSONObject
import java.util.UUID

/** The shell's side, as a page sees it. */
interface HomeNav {
    fun go(id: String, arg: String? = null)
    fun pop()
    fun close()
    /** Drops everything above the home page and draws it again. */
    fun home()
    /** Puts words in the conversation's box (and closes the home pages). [turn]: the turn the words are about. */
    fun compose(text: String, turn: String? = null)
    /** Shows the message [id] in the conversation (and closes the home pages). */
    fun jump(id: String)
    /** Opens the owner's apps (the native grid). */
    fun apps()
}

/** The name of the agent whose home it is, read from IDENTITY.md; everything that shows it follows a change. */
class HomeNames(private val port: HumanPort) {
    var name = HomeModel.DEFAULT_NAME; private set
    private val listeners = ArrayList<(String) -> Unit>()
    fun listen(l: (String) -> Unit): () -> Unit { listeners.add(l); return { listeners.remove(l) } }
    private fun set(n: String) { if (n != name) { name = n; listeners.toList().forEach { it(n) } } }
    fun reset() = set(HomeModel.DEFAULT_NAME)
    fun refresh() = port.ask("service:persona", "get", JSONObject().put("file", "IDENTITY.md")) { r ->
        if (!r.ok) { if (!r.retryable) reset(); return@ask }
        val content = r.data.list("files").firstOrNull { it.str("file") == "IDENTITY.md" }?.str("content")
        if (content == null) reset() else set(HomeModel.nameFromIdentity(content) ?: HomeModel.DEFAULT_NAME)
    }
}

/** Ids that make a retried request the same request: kept until the answer is definite. */
class HomeIntents {
    /** The owner's answer to an ask: kept until the ask is gone, so a retry is the same answer under the same id. */
    class Answer(val choice: String, val text: String?, val clientId: String, var status: String)
    val answers = HashMap<String, Answer>()
    private val ids = HashMap<String, String>()
    fun id(key: String): String = ids.getOrPut(key) { UUID.randomUUID().toString() }
    fun drop(key: String) { ids.remove(key) }
}

class HomeEnv(val activity: Activity, val port: HumanPort, val nav: HomeNav, val names: HomeNames, val intents: HomeIntents, val agent: String?, val files: ChatFiles? = null)

/** An answer to a word: its data, the whole `result` (for files), or why not. */
class Reply(val ok: Boolean, val data: JSONObject, val result: JSONObject?, val failure: HumanPort.Failure?) {
    val code: String? get() = failure?.code
    /** The answer is unknown (the word may or may not have run): asking again with the same id is safe. */
    val retryable get() = code in setOf("offline", "unavailable", "timeout", "result_unknown", "internal")
}

/** Sends one word as the owner and waits for its answer (HumanPort.call, but with the request id and the whole result). */
fun HumanPort.ask(to: String, word: String, body: JSONObject = JSONObject(), clientId: String? = null, done: (Reply) -> Unit) {
    val request = JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true)
    clientId?.let { request.put("client_id", it) }
    send(request) { r ->
        val reply = r.optJSONObject("response")
        fun failed(e: JSONObject?) = Reply(false, JSONObject(), null, HumanPort.Failure(e?.str("code").orEmpty().ifEmpty { "failed" }, e?.str("message").orEmpty().ifEmpty { "没有成功" }))
        done(when {
            !r.optBoolean("ok") -> failed(r.optJSONObject("error"))
            reply == null -> Reply(false, JSONObject(), null, HumanPort.Failure("result_unknown", "还没有收到结果"))
            reply.optBoolean("ok") -> reply.optJSONObject("result").let { Reply(true, it?.optJSONObject("data") ?: JSONObject(), it, null) }
            else -> failed(reply.optJSONObject("error"))
        })
    }
}

/**
 * One page of 她的主页. The shell gives it its [env] and draws [title], [trailing] and [body] (or [content]); the page reads and draws
 * itself, and everything it asks or schedules stops when it is [dispose]d (an answer that comes after is dropped).
 */
abstract class HomePage(val env: HomeEnv, val arg: String?) {
    protected val ctx: Activity get() = env.activity
    protected val c: AshPalette = AshUi.p(env.activity)
    private val main = Handler(Looper.getMainLooper())
    var alive = true; private set
    abstract val title: String
    /** What the bar shows on its right (44 x 44), if anything. */
    open val trailing: View? get() = null
    /** The column the page draws into: left and right 16 are the shell's. */
    val body: LinearLayout = AshUi.vstack(env.activity, 20)
    open fun content(): View = body
    /** Reads what the page shows (again). Called when it opens, when it comes back to the front and when the link is back. */
    open fun refresh() {}
    /** The ledger moved: pages that show it read it again. */
    open fun changed() {}
    protected open fun onDispose() {}
    fun dispose() { alive = false; main.removeCallbacksAndMessages(null); onDispose() }

    protected fun dp(v: Int) = AshUi.dp(ctx, v)
    /** A word as the owner; [done] is not called once the page is gone. */
    protected fun call(to: String, word: String, args: JSONObject = JSONObject(), clientId: String? = null, done: (Reply) -> Unit) =
        env.port.ask(to, word, args, clientId) { if (alive) done(it) }
    /** [fn] every [ms] while the page is alive and the window is on screen (a page does not read for nobody). */
    protected fun every(ms: Long, fn: () -> Unit) { val t = object : Runnable { override fun run() { if (!alive) return; if (body.windowVisibility == View.VISIBLE) fn(); main.postDelayed(this, ms) } }; main.postDelayed(t, ms) }
    protected fun later(ms: Long, fn: () -> Unit) { main.postDelayed({ if (alive) fn() }, ms) }
    /** One timer by [key]: [fn] runs at [ts]; calling again moves it. */
    private val wakes = HashMap<String, Runnable>()
    protected fun wake(key: String, ts: Long?, fn: () -> Unit) {
        wakes.remove(key)?.let { main.removeCallbacks(it) }
        if (ts == null) return
        val r = Runnable { if (alive) fn() }
        wakes[key] = r
        main.postDelayed(r, (ts - System.currentTimeMillis()).coerceIn(0, 2_000_000_000L) + 50)
    }
    /** A text file of the main body's work folder: [FileRead.ok] with a null text is a file that is not there; not ok is a read that failed. */
    protected fun readFile(path: String, body: String = "body:main", done: (FileRead) -> Unit) =
        call(body, "workspace.read", JSONObject().put("path", path).put("limit", 100_000)) { r ->
            val t = r.data.str("text")
            done(when { r.ok -> FileRead(t != null, t, r.data.optBoolean("truncated"), r); r.code == "not_found" -> FileRead(true, null, false, r); else -> FileRead(false, null, false, r) })
        }
    protected fun redraw(into: LinearLayout = body, draw: LinearLayout.() -> Unit) { into.removeAllViews(); into.draw() }
}

class FileRead(val ok: Boolean, val text: String?, val truncated: Boolean, val reply: Reply)

/** A word of a sentence in the accent colour (the changeable part of a promise). */
class Hl(val s: String)
fun words(c: AshPalette, vararg parts: Any): CharSequence {
    val out = android.text.SpannableStringBuilder()
    for (p in parts) {
        val start = out.length
        if (p is Hl) {
            out.append(p.s)
            out.setSpan(android.text.style.ForegroundColorSpan(c.youText), start, out.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            out.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), start, out.length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        } else out.append(p.toString())
    }
    return out
}

/** A wrapping row of views (chips, the words of a sentence). */
class Flow(ctx: Context, private val hGap: Int, private val vGap: Int, private val align: Int = Gravity.CENTER_VERTICAL) : ViewGroup(ctx) {
    override fun onMeasure(wSpec: Int, hSpec: Int) {
        val maxW = MeasureSpec.getSize(wSpec)
        var x = 0; var y = 0; var rowH = 0; var widest = 0
        for (i in 0 until childCount) {
            val v = getChildAt(i); if (v.visibility == GONE) continue
            v.measure(MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST), MeasureSpec.UNSPECIFIED)
            if (x > 0 && x + v.measuredWidth > maxW) { y += rowH + vGap; x = 0; rowH = 0 }
            x += v.measuredWidth + hGap; rowH = maxOf(rowH, v.measuredHeight); widest = maxOf(widest, x - hGap)
        }
        setMeasuredDimension(if (MeasureSpec.getMode(wSpec) == MeasureSpec.EXACTLY) maxW else widest, y + rowH)
    }
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val maxW = r - l
        var x = 0; var y = 0; var rowH = 0
        val row = ArrayList<View>()
        fun place() { var px = 0; row.forEach { v -> val dy = if (align == Gravity.CENTER_VERTICAL) (rowH - v.measuredHeight) / 2 else 0; v.layout(px, y + dy, px + v.measuredWidth, y + dy + v.measuredHeight); px += v.measuredWidth + hGap }; row.clear() }
        for (i in 0 until childCount) {
            val v = getChildAt(i); if (v.visibility == GONE) continue
            if (x > 0 && x + v.measuredWidth > maxW) { place(); y += rowH + vGap; x = 0; rowH = 0 }
            row.add(v); x += v.measuredWidth + hGap; rowH = maxOf(rowH, v.measuredHeight)
        }
        place()
    }
}

/** The pale ring of light behind her face on her home page: a still radial gradient, 420 x 320 (DESIGN-DECISIONS 3). */
class Glow(ctx: Context) : View(ctx) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val soft = AshUi.p(ctx).herSoft
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        paint.shader = RadialGradient(w / 2, h / 2, w / 2, soft, soft and 0x00FFFFFF, Shader.TileMode.CLAMP)
        canvas.save(); canvas.scale(1f, h / w, w / 2, h / 2); canvas.drawRect(0f, h / 2 - w / 2, w, h / 2 + w / 2, paint); canvas.restore()
    }
}

/** The small pieces the home pages are made of, over [AshUi]. */
internal object Hk {
    fun icon(ctx: Context, name: String): Drawable =
        ctx.getDrawable(ctx.resources.getIdentifier("ash_ic_$name", "drawable", ctx.packageName))?.mutate() ?: ctx.getDrawable(ai.ash.R.drawable.ash_ic_box)!!.mutate()

    fun tint(ctx: Context, name: String, color: Int, sizeDp: Int): View = View(ctx).apply {
        background = icon(ctx, name).apply { setTint(color) }
        layoutParams = LinearLayout.LayoutParams(AshUi.dp(ctx, sizeDp), AshUi.dp(ctx, sizeDp))
    }
    fun chev(ctx: Context): View = tint(ctx, "chev", AshUi.p(ctx).text3, AshTokens.Size.iconXs)

    fun strong(c: AshPalette, tone: String?): Int = when (tone) { "ok" -> c.ok; "warn" -> c.warn; "err" -> c.err; "her" -> c.her; "you" -> c.youText; "mute" -> c.text2; "3" -> c.text3; else -> c.text }
    fun soft(c: AshPalette, tone: String?): Int = when (tone) { "ok" -> c.okSoft; "warn" -> c.warnSoft; "err" -> c.errSoft; "her" -> c.herSoft; "you" -> c.youSoft; else -> c.surface2 }
    fun tone(t: String?): Tone = when (t) { "ok" -> Tone.OK; "warn" -> Tone.WARN; "err" -> Tone.ERR; "her" -> Tone.HER; "you" -> Tone.YOU; else -> Tone.MUTE }

    fun lp(ctx: Context, w: Int = -1, h: Int = -2, top: Int = 0) = LinearLayout.LayoutParams(w, h).apply { topMargin = AshUi.dp(ctx, top) }

    fun text(ctx: Context, s: CharSequence, type: AshType, color: Int? = null) = AshUi.text(ctx, s, type, color)

    /** The small grey line under a page's block: 13 / 19 secondary text (a status, a hint). */
    fun note(ctx: Context, s: CharSequence, tone: String? = null): TextView =
        AshUi.text(ctx, s, AshType(13f, 19f, 400, Role.TEXT_2), tone?.let { strong(AshUi.p(ctx), it) }).apply { setPadding(AshUi.dp(ctx, 6), 0, AshUi.dp(ctx, 6), 0) }

    /** A section of the home page: a headline, something small on its right (a count, 「全部 ›」), and the content. */
    fun section(ctx: Context, title: String, right: CharSequence? = null, onOpen: (() -> Unit)? = null, vararg content: View, rightView: View? = null): LinearLayout = AshUi.vstack(ctx, 10).apply {
        val head = AshUi.hstack(ctx, 4).apply {
            minimumHeight = AshUi.dp(ctx, 24); setPadding(AshUi.dp(ctx, 4), 0, AshUi.dp(ctx, 4), 0)
            addView(AshUi.text(ctx, title, AshTokens.Type.headline), LinearLayout.LayoutParams(0, -2, 1f))
            if (right != null) addView(AshUi.text(ctx, right, AshTokens.Type.sub))
            if (rightView != null) addView(rightView)
            if (onOpen != null) addView(chev(ctx))
        }
        if (onOpen != null) { head.isClickable = true; head.setOnClickListener { onOpen() } }
        addView(head)
        content.forEach { addView(it) }
    }

    fun list(ctx: Context, rows: List<View>, inset: Boolean = true) = AshUi.group(ctx, rows = rows, iconInset = inset)

    /** One row of a list: icon tile (by name), title, a line under it, then a value or control; a chevron when it opens something. */
    fun row(ctx: Context, icon: String?, title: CharSequence, sub: CharSequence? = null, tone: String? = null, subTone: String? = null, trailing: View? = null,
            chev: Boolean? = null, tall: Boolean = false, titleTone: String? = null, onClick: (() -> Unit)? = null): LinearLayout {
        val c = AshUi.p(ctx)
        val tail = trailing ?: if (chev ?: (onClick != null)) chev(ctx) else null
        return AshUi.row(ctx, title, sub, icon?.let { icon(ctx, it) }, tone(tone), tail, subTone?.let { strong(c, it) }, onClick).apply {
            if (tall) minimumHeight = AshUi.dp(ctx, 64)
            if (titleTone != null) (0 until childCount).map { getChildAt(it) }.firstOrNull { it is LinearLayout }?.let { ((it as LinearLayout).getChildAt(0) as? TextView)?.setTextColor(strong(c, titleTone)) }
        }
    }
    fun value(ctx: Context, s: String, tone: String? = null) = AshUi.text(ctx, s, AshType(14f, 20f, 400, Role.TEXT_2), tone?.let { strong(AshUi.p(ctx), it) })

    fun field(ctx: Context, hint: String, text: String = "", password: Boolean = false, multiline: Boolean = false, url: Boolean = false): EditText = EditText(ctx).apply {
        val c = AshUi.p(ctx)
        AshUi.style(this, AshTokens.Type.body, c.ink)
        setHint(hint); setHintTextColor(c.text3)
        setText(text)
        background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, AshTokens.Radius.sm.toFloat()), c.line, AshUi.dp(ctx, 1))
        setPadding(AshUi.dp(ctx, 12), AshUi.dp(ctx, 10), AshUi.dp(ctx, 12), AshUi.dp(ctx, 10))
        minHeight = AshUi.dp(ctx, AshTokens.Size.touch)
        inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            else if (multiline) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            else if (url) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            else InputType.TYPE_CLASS_TEXT
        typeface = android.graphics.Typeface.DEFAULT   // a password box turns its hint monospaced
        if (multiline) { minLines = 5; gravity = Gravity.TOP or Gravity.START } else { setSingleLine() }
        imeOptions = android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI
    }

    /** A button that takes something away asks twice: the first tap says what will happen, the second does it. */
    fun twoTap(ctx: Context, label: String, confirm: String, warn: String? = null, onWarn: (String) -> Unit = {}, size: AshUi.BtnSize = AshUi.BtnSize.MD, block: Boolean = true, run: () -> Unit): FrameLayout {
        val box = FrameLayout(ctx)
        lateinit var first: TextView
        lateinit var second: TextView
        fun reset() { first.visibility = View.VISIBLE; second.visibility = View.GONE; onWarn("") }
        first = AshUi.button(ctx, label, Kind.NEUTRAL, size, block) { first.visibility = View.GONE; second.visibility = View.VISIBLE; warn?.let { onWarn(it) } }
        second = AshUi.button(ctx, confirm, Kind.DANGER, size, block) { reset(); run() }.apply { visibility = View.GONE }
        box.addView(first); box.addView(second)
        return box
    }

    /** A tag-shaped state pill, 28 high, with a small spinner while she is busy. */
    fun statePill(ctx: Context, text: String, tone: String, busy: Boolean): LinearLayout = AshUi.hstack(ctx, 6).apply {
        val c = AshUi.p(ctx)
        background = AshUi.rounded(soft(c, tone), AshUi.dpF(ctx, 11f)); setPadding(AshUi.dp(ctx, 12), 0, AshUi.dp(ctx, 12), 0); minimumHeight = AshUi.dp(ctx, 28)
        if (busy) addView(AshUi.Spinner(ctx), LinearLayout.LayoutParams(AshUi.dp(ctx, 15), AshUi.dp(ctx, 15)))
        addView(AshUi.text(ctx, text, AshType(13f, 18f, 600, null), strong(c, tone)))
    }

    /** A button-like cell on the surface (the three numbers, the four hands, the timers). */
    fun cell(ctx: Context, radius: Int, onClick: (() -> Unit)?): LinearLayout = AshUi.vstack(ctx).apply {
        val c = AshUi.p(ctx)
        background = AshUi.rounded(c.surface, AshUi.dpF(ctx, radius.toFloat())); AshUi.cardShadow(this)
        onClick?.let { f -> isClickable = true; setOnClickListener { f() } }
    }

    fun grid(ctx: Context, cols: Int, gap: Int, cells: List<View>): LinearLayout = AshUi.vstack(ctx, gap).apply {
        cells.chunked(cols).forEach { rowCells ->
            addView(AshUi.hstack(ctx, gap).apply {
                gravity = Gravity.TOP
                rowCells.forEach { addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
                repeat(cols - rowCells.size) { addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f)) }
            })
        }
    }

    fun strip(ctx: Context, gap: Int, views: List<View>): HorizontalScrollView = HorizontalScrollView(ctx).apply {
        isHorizontalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER; clipToPadding = false
        setPadding(0, AshUi.dp(ctx, 4), AshUi.dp(ctx, 16), AshUi.dp(ctx, 8))
        addView(AshUi.hstack(ctx, gap).apply { gravity = Gravity.TOP; views.forEach { addView(it) } })
    }

    fun spacer(ctx: Context, h: Int) = View(ctx).apply { layoutParams = LinearLayout.LayoutParams(1, AshUi.dp(ctx, h)) }

    /** A small coloured chip (the memory labels). */
    fun chip(ctx: Context, text: String, fg: Int, bg: Int): TextView = AshUi.text(ctx, text, AshType(14f, 20f, 400, null), fg, maxLines = 1).apply {
        gravity = Gravity.CENTER_VERTICAL; setPadding(AshUi.dp(ctx, 13), 0, AshUi.dp(ctx, 13), 0); minHeight = AshUi.dp(ctx, 34)
        background = AshUi.rounded(bg, AshUi.dpF(ctx, 17f))
    }

    /** A block of monospaced text (an original request, a call and its result). */
    fun pre(ctx: Context, s: CharSequence): TextView = AshUi.text(ctx, s, AshType(12.5f, 19f, 400, Role.TEXT)).apply {
        typeface = android.graphics.Typeface.MONOSPACE; setTextIsSelectable(true)
        background = AshUi.rounded(AshUi.p(ctx).codeBg, AshUi.dpF(ctx, 14f)); setPadding(AshUi.dp(ctx, 14), AshUi.dp(ctx, 12), AshUi.dp(ctx, 14), AshUi.dp(ctx, 12))
    }

    /** A small tappable line of accent text (「查看完整原文 ›」). */
    fun link(ctx: Context, s: String, onClick: () -> Unit): TextView = AshUi.text(ctx, s, AshType(13f, 18f, 400, null), AshUi.p(ctx).youText).apply {
        minHeight = AshUi.dp(ctx, 28); gravity = Gravity.CENTER_VERTICAL; isClickable = true; setOnClickListener { onClick() }
    }

    fun divider(ctx: Context) = View(ctx).apply { setBackgroundColor(AshUi.p(ctx).line); layoutParams = LinearLayout.LayoutParams(-1, maxOf(1, AshUi.dp(ctx, 0.5f))) }

    fun clickable(v: View, onClick: () -> Unit): View = v.apply { isClickable = true; setOnClickListener { onClick() } }

    fun transparent() = Color.TRANSPARENT
}
