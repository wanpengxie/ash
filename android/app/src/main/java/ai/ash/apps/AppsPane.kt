package ai.ash.apps

import ai.ash.R
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshPage.AppTile
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.app.Activity
import android.graphics.Bitmap
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 「应用」: the owner's apps as Ash lists them, as a grid of icons like a phone's home screen (Apps.html). Tap one to open it in
 * its own task (in the isolated process, as before); long-press for 「添加到桌面」 and the app's own page of details (what it
 * may use, its switch, taking everything back). It lives in Ash's own process, so the list comes straight from Ash ([Ash] with
 * `inProcess`; the owner's words on an app go the way the web page's do, see [Ash.owner]) and the pages of the apps stay where they were.
 * [view] goes into the home screen's content area (which already keeps clear of the system bars and the keyboard); call
 * [refresh] whenever it is shown, [close] when the screen goes, [back] for the back key (false: nothing of its own to close,
 * go to the chat). [toChat] leaves for the chat.
 */
class AppsPane(private val activity: Activity, private val ash: Ash, private val toChat: () -> Unit) {
    val view = FrameLayout(activity)
    private val page = FrameLayout(activity)
    private val sheet = AshPage.Sheet(activity.window.decorView as FrameLayout)
    private val icons: MutableMap<String, Bitmap?> = java.util.Collections.synchronizedMap(HashMap())
    private var apps: List<AppInfo>? = null
    private var failure: String? = null
    /** The app whose page of details is showing, or null for the grid. */
    private var detail: String? = null
    /** The second tap of a two-tap button (take back, install) has been asked for. */
    private var sure = false
    /** An owner's word is on its way: the switch and the buttons wait for the answer. */
    private var busy = false
    /** What the last word did (or did not), under the buttons of the detail page. */
    private var note: String? = null
    @Volatile private var loading = false
    @Volatile private var closed = false

    init {
        view.addView(page, FrameLayout.LayoutParams(-1, -1))
        render()
    }

    fun close() { closed = true; sheet.dismiss(animate = false); ash.close() }

    /** The system switched between light and dark: what is on show is drawn again in the other colours (a drawer, built in the old ones, is closed). */
    fun themeChanged() { sheet.dismiss(animate = false); render() }

    /** The back key: closes the drawer, then the page of details; false when the grid itself is showing. */
    fun back(): Boolean {
        if (sheet.showing) { sheet.dismiss(); return true }
        if (detail != null) { detail = null; sure = false; note = null; render(); return true }
        return false
    }

    fun refresh() {
        if (loading || closed) return
        loading = true
        Thread({
            val result = runCatching { ash.apps() }
            result.getOrNull()?.forEach { a -> if (!icons.containsKey(a.id)) icons[a.id] = if (a.system) systemIcon(a) else ash.icon(a.id) }
            activity.runOnUiThread {
                loading = false
                if (closed || activity.isDestroyed) return@runOnUiThread
                result.onSuccess { apps = it; failure = null; if (detail != null && it.none { a -> a.id == detail }) detail = null }
                    .onFailure { failure = it.message ?: "连不上 Ash"; if (apps == null) detail = null }
                render()
            }
        }, "apps-list").start()
    }

    private fun d(v: Int) = AshUi.dp(activity, v)

    /** 「取消」 under a drawer's buttons: no fill, the quiet text colour (the design's own ghost button there). */
    private fun cancel(): View = AshUi.button(activity, "取消", AshUi.Kind.GHOST, block = true) { sheet.dismiss() }.apply { setTextColor(AshUi.p(activity).text2) }

    private fun render() {
        page.removeAllViews()
        val a = detail?.let { id -> apps?.firstOrNull { it.id == id } }
        page.addView(if (a != null) detailPage(a) else gridPage(), FrameLayout.LayoutParams(-1, -1))
    }

    // ---------- the grid ----------

    private fun gridPage(): View {
        val screen = AshPage.screen(activity)
        screen.addView(AshPage.navbar(activity, null, "返回对话") { toChat() })
        val list = apps
        when {
            list == null && failure == null -> screen.addView(AshPage.largeTitle(activity, "应用"))
            list == null -> {
                screen.addView(AshPage.largeTitle(activity, "应用"))
                screen.addView(AshPage.empty(activity, "暂时读不到应用", "$failure。读不到不代表没有，再试一次。",
                    AshUi.button(activity, "重试", AshUi.Kind.PRIMARY) { refresh() }), LinearLayout.LayoutParams(-1, 0, 1f))
            }
            list.isEmpty() -> {
                screen.addView(AshPage.largeTitle(activity, "应用"))
                screen.addView(AshPage.empty(activity, "这里还空着", "想要什么小工具，跟 Ash 说一句，比如「帮我做个记账的小应用」。她做好、你点头之后，就会出现在这里。"),
                    LinearLayout.LayoutParams(-1, 0, 1f))
            }
            else -> {
                screen.addView(AshPage.largeTitle(activity, "应用"))
                val blocks = mutableListOf<View>()
                // Waiting for the owner's say: a strip above the grid, one per app.
                list.filter { !it.granted && !it.broken }.forEach { blocks += banner(it) }
                // A broken app (its app.json is wrong) is not one that wants in: it shows here with the error badge, and its page says what to do.
                val installed = list.filter { it.granted || it.broken }
                if (installed.isNotEmpty()) {
                    blocks += grid(installed)
                    blocks += AshPage.foot(activity, "长按图标，可以放到手机桌面", center = true)
                }
                screen.addView(AshPage.scroll(activity, 22, blocks, topDp = 6).also { noClip(it) }, LinearLayout.LayoutParams(-1, 0, 1f))
            }
        }
        return screen
    }

    private fun noClip(v: View) {
        (v as? ViewGroup)?.let { g -> g.clipChildren = false; g.clipToPadding = false; for (i in 0 until g.childCount) noClip(g.getChildAt(i)) }
    }

    /** 「露营清单想装进来」: the app has not been approved yet; 「看看」 opens its page, where the owner reads what it asks for. */
    private fun banner(a: AppInfo): View {
        val c = AshUi.p(activity)
        return AshPage.panel(activity, ring = c.warnFill).apply {
            addView(AshUi.hstack(activity, 12).apply {
                setPadding(d(AshTokens.Space.rowX), d(AshTokens.Space.sm), d(AshTokens.Space.rowX), d(AshTokens.Space.sm))
                addView(AshPage.appIcon(activity, icons[a.id], AppTile.BANNER, shadow = false))
                addView(AshUi.vstack(activity).apply {
                    addView(AshUi.text(activity, "${a.name}想装进来", AshType(15f, 20f, 600, Role.INK), maxLines = 1))
                    addView(AshUi.text(activity, "先看看它要用什么，再决定", AshTokens.Type.caption))
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                addView(AshPage.smallButton(activity, "看看", AshUi.Kind.PRIMARY) { detail = a.id; sure = false; note = null; render() })
            })
        }
    }

    /** Four to a row, 62dp icons with 8dp between the columns and 22dp between the rows. */
    private fun grid(list: List<AppInfo>): View = AshUi.vstack(activity, 22).apply {
        list.chunked(4).forEach { rowApps ->
            addView(AshUi.hstack(activity, 8).apply {
                gravity = Gravity.TOP
                for (i in 0 until 4) {
                    val cell = rowApps.getOrNull(i)?.let { cell(it) } ?: View(activity)
                    addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
                }
            })
        }
    }

    private fun cell(a: AppInfo): View {
        val c = AshUi.p(activity)
        val stopped = a.granted && !a.enabled && !a.broken
        return AshUi.vstack(activity, 8).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            isClickable = true
            addView(FrameLayout(activity).apply {
                addView(AshPage.appIcon(activity, icons[a.id], AppTile.GRID, shadow = !stopped, dimmed = stopped),
                    FrameLayout.LayoutParams(d(AppTile.GRID.sizeDp), d(AppTile.GRID.sizeDp), Gravity.CENTER_HORIZONTAL))
                // Only trouble gets a badge: a quiet app has none.
                if (a.hasTrouble && !stopped) addView(AshPage.errorBadge(activity).apply {
                    (layoutParams as FrameLayout.LayoutParams).apply { gravity = Gravity.TOP or Gravity.END; marginEnd = d(6); topMargin = -d(5) }
                })
                // An app that keeps its own state (her status): a dot of its colour, the badge's size, when it is not simply fine.
                else if (!stopped) when (a.badge) { "warn" -> c.warnFill; "err" -> c.errFill; "paused" -> c.text3; else -> null }?.let { fill ->
                    addView(AshPage.statusDot(activity, fill).apply { (layoutParams as FrameLayout.LayoutParams).apply { gravity = Gravity.TOP or Gravity.END; marginEnd = d(6); topMargin = -d(5) } })
                }
            })
            addView(AshUi.text(activity, if (stopped) "${a.name} · 停用" else a.name, AshType(12.5f, 17f, 400, if (stopped) Role.TEXT_3 else Role.TEXT), maxLines = 2)
                .apply { gravity = Gravity.CENTER; if (stopped) setTextColor(c.text3) })
            setOnClickListener { open(a) }
            setOnLongClickListener { if (a.system) false else { actions(a); true } }
        }
    }

    /** A system app's tile: its line icon on the app colour (drawn here; the hub has no picture of it). */
    private fun systemIcon(a: AppInfo): android.graphics.Bitmap? {
        val res = ai.ash.sysapps.SystemApps.icon(a.icon) ?: return null
        val size = d(AppTile.GRID.sizeDp)
        val bitmap = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(bitmap)
        canvas.drawColor(AshUi.p(activity).youSoft)
        activity.getDrawable(res)?.mutate()?.apply { setTint(AshUi.p(activity).youText); val m = size / 4; setBounds(m, m, size - m, size - m); draw(canvas) }
        return bitmap
    }

    private fun open(a: AppInfo) {
        if (a.system) { activity.startActivity(ai.ash.sysapps.SystemApps.intent(activity, a.id)); return }
        if (a.usable) { activity.startActivity(Ui.appIntent(activity, a.id)); return }
        if (a.broken) { detail = a.id; sure = false; note = null; render(); return }
        stopped(a)
    }

    /** 「每日复盘」现在停着: says where to switch it on again. */
    private fun stopped(a: AppInfo) {
        sheet.show { s ->
            s.gravity = Gravity.CENTER_HORIZONTAL
            s.addView(AshPage.appIcon(activity, icons[a.id], AppTile.GRID, shadow = false), LinearLayout.LayoutParams(d(AppTile.GRID.sizeDp), d(AppTile.GRID.sizeDp)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            s.addView(AshUi.text(activity, "「${a.name}」现在停着", AshTokens.Type.headline).apply { gravity = Gravity.CENTER })
            s.addView(AshUi.text(activity, "在 Ash 主页的「她的手和眼 · 应用」里重新打开就能用。", AshTokens.Type.callout).apply { gravity = Gravity.CENTER; setPadding(d(10), 0, d(10), 0) })
            s.addView(AshUi.button(activity, "回到 Ash", AshUi.Kind.PRIMARY, AshUi.BtnSize.LG, block = true) { sheet.dismiss(); toChat() })
            s.addView(cancel())
        }
    }

    /** Long-press: put it on the phone's home screen, or read about it. */
    private fun actions(a: AppInfo) {
        sheet.show { s ->
            s.addView(AshUi.text(activity, a.name, AshTokens.Type.headline).apply { gravity = Gravity.CENTER })
            if (a.usable) s.addView(AshUi.button(activity, "添加到桌面", AshUi.Kind.PRIMARY, block = true) { sheet.dismiss(); Pin.request(activity, a.id, a.name, icons[a.id]) })
            s.addView(AshUi.button(activity, "看看它的详情", if (a.usable) AshUi.Kind.NEUTRAL else AshUi.Kind.PRIMARY, block = true) { sheet.dismiss(); detail = a.id; sure = false; note = null; render() })
            s.addView(cancel())
        }
    }

    // ---------- one app ----------

    private fun detailPage(a: AppInfo): View {
        val c = AshUi.p(activity)
        val screen = AshPage.screen(activity)
        screen.addView(AshPage.navbar(activity, null, "返回应用") { detail = null; sure = false; note = null; render() })
        val blocks = mutableListOf<View>()

        // The icon, the name, one line of how it is, and the one thing to do: open it.
        val state = when {
            a.broken -> "出错了" to c.err
            !a.granted -> "等你批准" to c.warn
            !a.enabled -> "已停用" to c.text3
            a.hasTrouble -> "出错了" to c.err
            else -> "在用" to c.ok
        }
        blocks += AshUi.vstack(activity, 8).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(0, 0, 0, d(6))
            addView(AshPage.appIcon(activity, icons[a.id], AppTile.DETAIL), LinearLayout.LayoutParams(d(AppTile.DETAIL.sizeDp), d(AppTile.DETAIL.sizeDp)).apply { bottomMargin = d(AshTokens.Space.xxs) })
            addView(AshUi.text(activity, a.name, AshTokens.Type.title).apply { gravity = Gravity.CENTER })
            addView(AshUi.hstack(activity).apply {
                gravity = Gravity.CENTER
                if (a.version.isNotBlank()) addView(AshUi.text(activity, "${a.version} 版 · ", AshTokens.Type.sub))
                addView(AshUi.text(activity, state.first, AshTokens.Type.sub, state.second))
            })
            if (a.summary.isNotBlank()) addView(AshUi.text(activity, a.summary, AshTokens.Type.callout).apply { gravity = Gravity.CENTER; setPadding(d(AshTokens.Space.lg), 0, d(AshTokens.Space.lg), 0) })
            if (a.usable) addView(AshUi.button(activity, "打开", AshUi.Kind.PRIMARY) { activity.startActivity(Ui.appIntent(activity, a.id)) },
                LinearLayout.LayoutParams(d(160), d(AshTokens.Size.button)).apply { topMargin = d(AshTokens.Space.xs) })
        }

        // What went wrong, in words for the owner (never the kernel's line: it names files and parser errors).
        a.troubleText?.let { text ->
            blocks += AshUi.card(activity).apply {
                addView(AshUi.cardHeader(activity, AshUi.Tone.ERR, AshPage.icon(activity, R.drawable.ash_ic_alert), "出错了"))
                addView(AshUi.text(activity, text, AshTokens.Type.callout))
            }
        }

        // What it asks of Ash, and (once it is allowed) the switch. A broken app has told nothing that can be read: neither is shown.
        if (!a.broken) {
            val rows = if (a.needs.isEmpty()) listOf(AshUi.row(activity, "不需要用 Ash 的其他东西"))
                else a.needs.map { n -> AshUi.row(activity, n.text, null, AshPage.icon(activity, needIcon(n.kind))) }
            blocks += AshUi.group(activity, if (a.granted) "你允许它用的" else "它想用的", rows = rows, iconInset = a.needs.isNotEmpty())
        }
        if (a.granted && !a.broken) blocks += AshUi.group(activity, rows = listOf(
            AshUi.AshSwitch(activity).let { sw ->
                sw.set(a.enabled)
                if (busy) AshUi.disable(sw)
                sw.onChange = { on -> if (on) owner("apps.enable", a, "已启用「${a.name}」。") else owner("apps.disable", a, "已停用「${a.name}」，它的权限还留着。") }
                // The whole row is the switch's to tap (the switch itself is only 28dp high).
                AshUi.row(activity, "在用", "关掉后先停着，它用的东西还留着", trailing = sw, onClick = if (busy) null else ({ sw.performClick() }))
            }), iconInset = false)

        if (!a.granted && a.broken) {
            // nothing to install and nothing to take back: the card above says what to do
        } else if (!a.granted) {
            blocks += twoTap(if (sure) "确认安装" else "安装", AshUi.Kind.PRIMARY,
                if (sure) "安装后「${a.name}」可以用上面列出的这些；你随时可以停用或收回。" else null) {
                if (!sure) { sure = true; render() } else { sure = false; owner("apps.install", a, "已安装「${a.name}」。") }
            }
        } else {
            blocks += twoTap(if (sure) "再点一次，确认收回" else "收回全部权限", AshUi.Kind.DANGER,
                if (sure) "收回后「${a.name}」会停止运行，再用要重新安装。" else null) {
                if (!sure) { sure = true; render() } else { sure = false; owner("apps.revoke", a, "已收回「${a.name}」的全部权限。") }
            }
        }
        note?.let { blocks += AshPage.foot(activity, it) }
        screen.addView(AshPage.scroll(activity, 16, blocks), LinearLayout.LayoutParams(-1, 0, 1f))
        return screen
    }

    private fun needIcon(kind: String) = when (kind) {
        "notify" -> R.drawable.ash_ic_bell
        "widgets" -> R.drawable.ash_ic_widget
        "card" -> R.drawable.ash_ic_msg
        else -> R.drawable.ash_ic_link
    }

    /** A block button (the second tap says what will happen, under it) — the pattern for taking something away or giving reach. */
    private fun twoTap(label: String, kind: AshUi.Kind, consequence: String?, onTap: () -> Unit): View = AshUi.vstack(activity, 8).apply {
        addView(AshUi.button(activity, label, kind, block = true, onClick = { if (!busy) onTap() }).also { if (busy) AshUi.disable(it) })
        consequence?.let { addView(AshPage.foot(activity, it)) }
    }

    /**
     * One of the owner's words on an app, then the list again. While it is on its way the switch and the buttons wait; what it did is
     * said under the buttons, in the web page's words (an enable that finds the app's folder gone says so and points at taking it back).
     */
    private fun owner(word: String, app: AppInfo, done: String) {
        if (busy) return
        busy = true; note = "正在处理…"; render()
        Thread({
            val reply = ash.owner(word, app.id)
            activity.runOnUiThread {
                busy = false
                if (closed || activity.isDestroyed) return@runOnUiThread
                note = when {
                    reply.optBoolean("ok") -> done
                    word == "apps.enable" && reply.optJSONObject("error")?.optString("code") == "not_found" ->
                        "「${app.name}」的文件夹已经不在了，启用不了；可以点「收回全部权限」把它卸掉。"
                    else -> "「${app.name}」没有确认完成；上面是现在的状态，可以再试一次。"
                }
                render()
                refresh()
            }
        }, "apps-owner").start()
    }
}
