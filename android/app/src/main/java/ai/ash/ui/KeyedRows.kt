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
        h.box.removeAllViews()
        val v = getItem(position).make() ?: return
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
 * The scroll rule of a conversation laid out from its end (MOBILE-ARCH §2.4): it moves only when asked ([toEnd]: the owner
 * sent, or 「回到最新」), on its first fill, or when a new row comes at the end while the end is in sight — judged when
 * the rows are handed over, against what the owner sees then. Everything else (pages above, a row growing, the keyboard)
 * keeps the bottom row where it is. [onUnseen] hears that a new row came while the owner reads further up.
 */
object FollowEnd {
    fun submit(
        list: RecyclerView, lm: LinearLayoutManager, adapter: KeyedRowsAdapter, rows: List<ChatRow>,
        toEnd: Boolean = false, placeholder: String? = null, onUnseen: () -> Unit = {}, then: (first: Boolean) -> Unit = {},
    ) {
        val before = adapter.currentList
        val first = before.none { it.key != placeholder } && rows.firstOrNull()?.key != placeholder
        val atEnd = !list.canScrollVertically(1)
        val newAtEnd = !first && rows.isNotEmpty() && before.none { it.key == rows.last().key }
        if (newAtEnd && !atEnd && !toEnd) onUnseen()
        adapter.submitList(rows) {
            if (rows.isNotEmpty() && (toEnd || first || (newAtEnd && atEnd))) lm.scrollToPosition(rows.size - 1)
            then(first)
        }
    }
}
