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
 * The scroll intent of a conversation laid out from its end (MOBILE-ARCH §2.4), as plain data. Rows are handed over
 * ([submit]) and land later ([commit], after the diff); what to do is decided when they land, from where the owner is then
 * — not from where they were when the rows were handed over, so someone who scrolled up meanwhile is not pulled back.
 * The list moves only on its first fill, for a [submit] asked with toEnd (sending, 回到最新) unless the owner dragged
 * since, or for a new row at the end while the end is in sight; a new row at the end while reading further up is "unseen".
 * While [hold] is set (a reading place is being restored) it does not move by itself at all.
 */
class FollowIntent(private val placeholder: String? = null) {
    data class Ticket(val toEnd: Boolean, val drags: Int)
    data class Decision(val scrollToEnd: Boolean, val unseen: Boolean, val first: Boolean)

    private var drags = 0
    private var committed: List<String> = emptyList()

    /** The owner put a finger on the list and moved it. */
    fun dragged() { drags++ }

    fun submit(toEnd: Boolean) = Ticket(toEnd, drags)

    fun commit(t: Ticket, keys: List<String>, atEndNow: Boolean, hold: Boolean = false): Decision {
        val before = committed
        committed = keys
        val first = before.none { it != placeholder } && keys.firstOrNull()?.let { it != placeholder } == true
        val asked = t.toEnd && t.drags == drags
        val newAtEnd = !first && keys.isNotEmpty() && keys.last() !in before
        if (hold && !asked) return Decision(false, newAtEnd && !atEndNow, first)
        val scroll = keys.isNotEmpty() && (asked || first || (newAtEnd && atEndNow))
        return Decision(scroll, newAtEnd && !atEndNow && !asked, first)
    }
}

/**
 * A reading place to come back to (MOBILE-ARCH §3.4, §2.6): a row's key, its message id when it has one, and how far below
 * the list's top it started. It is kept until the row is there to go to, or it is clearly not coming (then the list stays at
 * the oldest row it has, never jumps to the newest): rows that arrive before the conversation was read do not count, and a
 * row that is not among them may be fetched once by its id.
 */
class AnchorRestore(private var want: Anchor?) {
    data class Anchor(val key: String, val id: String?, val offset: Int)
    sealed class Step {
        object None : Step()
        object Wait : Step()
        data class Go(val index: Int, val offset: Int) : Step()
        data class Fetch(val id: String) : Step()
        /** Not coming: stay at the oldest row there is. */
        object Oldest : Step()
    }

    private var fetched = false
    val pending get() = want != null

    /** The owner took over (dragged, sent, jumped): the place is no longer wanted. */
    fun cancel() { want = null }

    fun onRows(keys: List<String>, read: Boolean, canFetch: Boolean): Step {
        val w = want ?: return Step.None
        if (!read) return Step.Wait
        val at = keys.indexOf(w.key)
        if (at >= 0) { want = null; return Step.Go(at, w.offset) }
        if (!fetched && canFetch && w.id != null) { fetched = true; return Step.Fetch(w.id) }
        want = null
        return Step.Oldest
    }
}

/**
 * A keyed list laid out from its end with its [FollowIntent]: rows are handed over with [submit]; the decision is taken in
 * the commit callback, against where the list is then. A drag tells the intent (and calls [onDrag]).
 */
class FollowEnd(private val list: RecyclerView, private val lm: LinearLayoutManager, private val adapter: KeyedRowsAdapter, placeholder: String? = null, onDrag: () -> Unit = {}) {
    val intent = FollowIntent(placeholder)

    init {
        list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, state: Int) { if (state == RecyclerView.SCROLL_STATE_DRAGGING) { intent.dragged(); onDrag() } }
        })
    }

    fun submit(rows: List<ChatRow>, toEnd: Boolean = false, hold: () -> Boolean = { false }, onUnseen: () -> Unit = {}, then: (first: Boolean) -> Unit = {}) {
        val ticket = intent.submit(toEnd)
        adapter.submitList(rows) {
            val d = intent.commit(ticket, rows.map { it.key }, !list.canScrollVertically(1), hold())
            if (d.scrollToEnd) lm.scrollToPosition(rows.size - 1)
            if (d.unseen) onUnseen()
            then(d.first)
        }
    }
}
