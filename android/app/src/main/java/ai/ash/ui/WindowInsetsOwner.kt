package ai.ash.ui

import ai.ash.apps.Ui
import ai.ash.apps.Ui.Edges
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

/**
 * A conversation that stands on the keyboard (MOBILE-ARCH §4.4): its deck (messages, floating bits, the input) keeps its
 * measured size and is only moved up by [keyboard] px — a move of the drawing, at every frame of the keyboard's animation
 * and where it stops. The header stays and the stage under it clips the deck.
 */
interface KeyboardDeck { fun keyboard(px: Int) }

/**
 * The one owner of a window's insets (MOBILE-ARCH §1.3, §4.5): installed once on the window's root, by every screen of the
 * app (the home screen, the app pages, the guide, the viewers…). The root keeps clear of the system bars and the cutout (the
 * union, side by side) by padding added to its own initial padding — the same insets give the same padding, nothing adds
 * up. The keyboard either pads the root too (it covers the navigation bar, it does not stack on it), or, when [front] names
 * a [KeyboardDeck], moves that deck instead and lays nothing out. Only the insets used here are consumed; the rest goes on
 * to the views inside. While the keyboard animates only the deck's drawing moves; the end state comes through the normal
 * insets pass (also on API 26–29, where there is no animation to follow).
 */
object WindowInsetsOwner {
    fun install(root: View, front: () -> KeyboardDeck? = { null }, onKeyboard: ((Boolean) -> Unit)? = null) {
        val base = Edges(root.paddingLeft, root.paddingTop, root.paddingRight, root.paddingBottom)
        val ime = WindowInsetsCompat.Type.ime()
        var animating = 0
        var last: KeyboardDeck? = null
        fun edges(i: androidx.core.graphics.Insets) = Edges(i.left, i.top, i.right, i.bottom)
        fun safe(insets: WindowInsetsCompat) = Ui.fit(edges(insets.getInsets(WindowInsetsCompat.Type.systemBars())),
            edges(insets.getInsets(WindowInsetsCompat.Type.displayCutout())), Edges.NONE)
        fun overSafe(insets: WindowInsetsCompat) = Ui.keyboardOver(safe(insets).bottom, insets.getInsets(ime).bottom)

        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val deck = front()
            // The page in front changed: the one before is put back down.
            if (last !== deck) { last?.keyboard(0); last = deck }
            val s = safe(insets)
            val e = if (deck != null) s else Ui.fit(s, Edges.NONE, edges(insets.getInsets(ime)))
            // While the keyboard moves, the deck follows it in onProgress; this pass already says where it will end.
            if (animating == 0) deck?.keyboard(overSafe(insets))
            v.setPadding(base.left + e.left, base.top + e.top, base.right + e.right, base.bottom + e.bottom)
            onKeyboard?.invoke(insets.isVisible(ime))
            insets.inset(e.left, e.top, e.right, e.bottom)
        }
        ViewCompat.setWindowInsetsAnimationCallback(root, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            override fun onPrepare(animation: WindowInsetsAnimationCompat) { if (animation.typeMask and ime != 0) animating++ }
            override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
                if (animating > 0) front()?.keyboard(overSafe(insets))
                return insets
            }
            override fun onEnd(animation: WindowInsetsAnimationCompat) {
                if (animation.typeMask and ime == 0) return
                // A reversed or cancelled animation ends too: the last one to end puts the deck where the keyboard is now.
                animating = (animating - 1).coerceAtLeast(0)
                if (animating == 0) ViewCompat.requestApplyInsets(root)
            }
        })
        ViewCompat.requestApplyInsets(root)
    }
}
