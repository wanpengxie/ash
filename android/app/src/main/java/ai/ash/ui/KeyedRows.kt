package ai.ash.ui

import android.content.Context
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView

/**
 * The list of the conversations (the chat, a Codex session, the Codex sessions; MOBILE-ARCH §2.1–2.3): rows with stable
 * keys ([ChatRow]), compared by [ChatRows.diff]; a row whose content did not change is not bound again, a changed one is
 * drawn again by its own function, and no other row is touched. A row keeps the size its view asks for.
 */
class KeyedRowsAdapter(private val ctx: Context) : ListAdapter<ChatRow, KeyedRowsAdapter.Holder>(ChatRows.diff) {
    class Holder(val box: FrameLayout) : RecyclerView.ViewHolder(box)

    override fun onCreateViewHolder(parent: ViewGroup, type: Int) = Holder(FrameLayout(ctx).apply { layoutParams = RecyclerView.LayoutParams(-1, -2) })

    override fun onBindViewHolder(h: Holder, position: Int) {
        val v = getItem(position).make()
        // The same view again (a card patched in place) stays attached: its focus, IME composing and mini app go on.
        if (v != null && h.box.childCount == 1 && h.box.getChildAt(0) === v) return
        h.box.removeAllViews()
        if (v == null) return
        (v.parent as? ViewGroup)?.removeView(v)
        val lp = when (val own = v.layoutParams) {
            null -> FrameLayout.LayoutParams(-1, -2)
            is ViewGroup.MarginLayoutParams -> FrameLayout.LayoutParams(own)
            else -> FrameLayout.LayoutParams(own)
        }
        h.box.addView(v, lp)
    }

    // Recycled rows let go of what they drew (pictures, listeners): a row is drawn again from its data when it comes back.
    override fun onViewRecycled(h: Holder) { h.box.removeAllViews() }
}

/**
 * The scroll rule of a conversation laid out from its end (MOBILE-ARCH §2.4): when the rows land, the list follows to the
 * newest row if it was at the end just before they were handed over, or when [toEnd] (the owner sent). Otherwise it stays,
 * and a new row at the end is only said ([onUnseen]).
 */
object FollowEnd {
    fun submit(list: RecyclerView, lm: LinearLayoutManager, adapter: KeyedRowsAdapter, rows: List<ChatRow>, toEnd: Boolean = false, onUnseen: () -> Unit = {}, then: () -> Unit = {}) {
        val atEnd = !list.canScrollVertically(1)
        val grew = rows.isNotEmpty() && adapter.currentList.none { it.key == rows.last().key }
        adapter.submitList(rows) {
            if (rows.isNotEmpty() && (toEnd || atEnd)) lm.scrollToPosition(rows.size - 1) else if (grew) onUnseen()
            then()
        }
    }
}

/**
 * A reading place (MOBILE-ARCH §3.4): the first row on screen and how far below the list's top it starts. Brought back when
 * the activity is made again if that row is among the rows loaded; otherwise the conversation shows its newest.
 */
data class Anchor(val key: String, val offset: Int) {
    fun indexIn(rows: List<ChatRow>): Int? = rows.indexOfFirst { it.key == key }.takeIf { it >= 0 }

    companion object {
        /** Where [list] is read now; null when it is at its end (it follows the newest). */
        fun of(list: RecyclerView, lm: LinearLayoutManager, adapter: KeyedRowsAdapter): Anchor? {
            if (!list.canScrollVertically(1)) return null
            val pos = lm.findFirstVisibleItemPosition().takeIf { it >= 0 } ?: return null
            val row = lm.findViewByPosition(pos) ?: return null
            return adapter.currentList.getOrNull(pos)?.let { Anchor(it.key, lm.getDecoratedTop(row) - list.paddingTop) }
        }
    }
}
