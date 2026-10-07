package ai.ash.screen.island

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.util.TypedValue
import android.widget.TextView

/**
 * Geometry and colours the reference states only in its CSS (docs/island/island.html), each under the selector it
 * comes from. Everything the designer put in tokens comes from [IslandTokens]. CSS px are dp.
 */
internal object IslandSpec {
    // .isl-label { letter-spacing: .02em }  .isl-ind { 18px }
    const val LABEL_LETTER_SPACING = 0.02f; const val INDICATOR = 18f
    // .isl-av { background: #2A2A2D; object-position: 50% 20% }  .card-head .isl-av { object-position: 50% 15% }
    const val AVATAR_BACKGROUND = 0xFF2A2A2D.toInt(); const val AVATAR_FOCUS_COMPACT = 0.20f; const val AVATAR_FOCUS_CARD = 0.15f
    // .card-head { gap: 12px }  .card-titles { gap: 1px }  .card-title { gap: 7px }  .card-title .dot { 8px }
    const val HEAD_GAP = 12f; const val TITLES_GAP = 1f; const val TITLE_GAP = 7f; const val TITLE_DOT = 8f
    // .icon-btn { 44px; radius 22; color #C9C9CE }
    const val ICON_BUTTON = 44f; const val ICON_BUTTON_INK = 0xFFC9C9CE.toInt()
    // .activity { gap: 12px; padding: 14px; border-radius: 16px }  b { 15px/600 }  span { 12.5px; line-height: 1.5 }
    const val ACTIVITY_GAP = 12f; const val ACTIVITY_PAD = 14f; const val ACTIVITY_RADIUS = 16f
    const val ACTIVITY_TITLE_SIZE = 15f; const val ACTIVITY_NOTE_SIZE = 12.5f; const val ACTIVITY_NOTE_LINE_HEIGHT = 1.5f
    // middle text column { gap: 8px }  .more { height: 32px; font-size: 13px }
    const val TEXT_GAP = 8f; const val MORE_HEIGHT = 32f; const val MORE_SIZE = 13f
    // .foot { gap: 2px; border-top: 1px; padding-top: 12px }  .foot-input { gap: 8px }
    const val FOOT_GAP = 2f; const val FOOT_PAD_TOP = 12f; const val FOOT_INPUT_GAP = 8f
    // .foot-input input { height: 44px; radius: 22px; font-size: 14px; padding: 0 16px }  .send { 44px; #2A2A2D }
    const val INPUT_HEIGHT = 44f; const val INPUT_SIZE = 14f; const val INPUT_PAD = 16f; const val SEND_BACKGROUND = 0xFF2A2A2D.toInt()
    // .foot-links button { height: 44px; padding: 0 12px; font-size: 13.5px }  .stop { padding-left: 4px; gap: 6px }  i { 9px; radius 2 }
    const val LINK_HEIGHT = 44f; const val LINK_PAD = 12f; const val STOP_PAD_LEFT = 4f; const val STOP_GAP = 6f; const val STOP_MARK = 9f
    // last link: padding-right: 4px
    const val CLOSE_PAD_RIGHT = 4f
    // .btn-primary { height: 46px; radius: 23px }
    const val PRIMARY_RADIUS = 23f
    // .quote { padding: 12px 14px; border-radius: 14px; box-shadow: inset 0 0 0 1px #2A2A2D; font-size: 14px; line-height: 1.55 }
    const val QUOTE_PAD_V = 12f; const val QUOTE_PAD_H = 14f; const val QUOTE_RADIUS = 14f; const val QUOTE_STROKE = 0xFF2A2A2D.toInt()
    const val QUOTE_SIZE = 14f; const val QUOTE_LINE_HEIGHT = 1.55f
    // .options { gap: 8px }  .opt { height: 44px; padding: 0 16px; radius 22; border: 1.5px; background: rgba(245,166,35,.10) }
    const val OPTIONS_GAP = 8f; const val OPTION_HEIGHT = 44f; const val OPTION_PAD = 16f; const val OPTION_BORDER = 1.5f; const val OPTION_BACKGROUND = 0x1AF5A623
    // .ap-row { gap: 8px }  allow { flex: 1.4 }  deny { flex: 1 }  .btn-neutral { color: #ECECEE; 600 }
    const val APPROVAL_GAP = 8f; const val ALLOW_FLEX = 1.4f; const val DENY_FLEX = 1f; const val NEUTRAL_INK = 0xFFECECEE.toInt()
    // .ap-approved { background: rgba(43,182,115,.14); gap: 8px }  tick 16px
    const val APPROVED_BACKGROUND = 0x242BB673; const val APPROVED_GAP = 8f; const val TICK = 16f
    // .ap-final { height: 46px; background: surface; color: #B4B4BA; font-size: 14px }
    const val FINAL_INK = 0xFFB4B4BA.toInt(); const val FINAL_SIZE = 14f
    // host.css .original { font: 12px/1.55 monospace; padding: 12px; border-radius: 14px }
    const val ORIGINAL_SIZE = 12f; const val ORIGINAL_LINE_HEIGHT = 1.55f; const val ORIGINAL_PAD = 12f; const val ORIGINAL_RADIUS = 14f
    // host.css .island-nav { font-size: 12px }  .send-notice { font-size: 12px; color: needs-text }
    const val NAV_SIZE = 12f; const val NOTICE_SIZE = 12f
    // host.css .isl button:disabled { opacity: .5 }
    const val DISABLED_ALPHA = 0.5f
    // host: the card is at most as tall as the screen below it less 32px, and never limited below 220px; and the island
    // is a glance, not a reader: never taller than half the screen
    const val CARD_BOTTOM_ROOM = 32f; const val CARD_MIN_LIMIT = 220f; const val CARD_MAX_SCREEN_SHARE = 0.5f
    // A press that moves up more than 8px (host.js's drag slop) is a swipe up
    const val SWIPE_SLOP = 8f
    // .isl-in { from: blur(3px) }
    const val CONTENT_IN_FROM_BLUR = 3f
    // Text changed in place fades in (host.css .isl-fade)
    const val TEXT_FADE_MS = 240L

    fun weight(weight: Float): Typeface =
        if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight.toInt(), false)
        else if (weight >= 600f) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

    fun dp(ctx: Context, v: Float) = v * ctx.resources.displayMetrics.density

    // Font metrics the reference's lines are built from (Android WebView: Roboto first, Noto Sans CJK for Chinese).
    // Roboto hhea 1900/500 of 2048; Noto Sans CJK hhea 1160/288 of 1000.
    private const val LATIN_ASCENT = 0.9277f; private const val LATIN_DESCENT = 0.2441f
    private const val CJK_ASCENT = 1.16f; private const val CJK_DESCENT = 0.288f

    /**
     * CSS-like text: px sizes (no font scaling, as the reference), and CSS line boxes. `line-height: normal` takes the
     * line's font metrics (the CJK font's when the text has Chinese); a numeric line height splits its leading above
     * and below each line around the first font's (Roboto's) ascent and descent. Android puts a line's spacing below
     * it and sizes lines by the first font alone, so the line height and both outer baselines are set explicitly.
     */
    fun text(view: TextView, size: Float, color: Int, weight: Float = 400f, lineHeight: Float? = null, cjk: Boolean = true) {
        view.setTextSize(TypedValue.COMPLEX_UNIT_DIP, size)
        view.setTextColor(color); view.typeface = weight(weight); view.includeFontPadding = false
        val px = dp(view.context, size)
        val (line, first, last) = if (lineHeight == null) {
            val a = if (cjk) CJK_ASCENT else LATIN_ASCENT; val d = if (cjk) CJK_DESCENT else LATIN_DESCENT
            Triple((a + d) * px, a * px, d * px)
        } else {
            val l = lineHeight * px; val half = (l - (LATIN_ASCENT + LATIN_DESCENT) * px) / 2
            Triple(l, half + LATIN_ASCENT * px, half + LATIN_DESCENT * px)
        }
        if (Build.VERSION.SDK_INT >= 28) {
            view.isFallbackLineSpacing = false
            view.setLineHeight(Math.round(line))
            view.firstBaselineToTopHeight = Math.round(first)
            view.lastBaselineToBottomHeight = Math.round(last)
        } else if (lineHeight != null) {
            val metrics = view.paint.fontMetricsInt
            val extra = Math.round(line) - (metrics.descent - metrics.ascent)
            view.setLineSpacing(extra.toFloat(), 1f)
            view.setPadding(view.paddingLeft, extra / 2, view.paddingRight, 0)
        }
    }
}
