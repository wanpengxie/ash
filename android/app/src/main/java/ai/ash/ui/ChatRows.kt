package ai.ash.ui

import android.view.View
import androidx.recyclerview.widget.DiffUtil
import org.json.JSONObject

/**
 * One row of the conversation list. [key] stays the same across refreshes for the same thing shown (a message's client id
 * when it has one, so the owner's waiting message and the kernel's copy of it are one row; else its ledger id), [sig]
 * changes when what the row shows changes, and [make] draws it. Only rows whose [sig] changed are drawn again.
 *
 * Every kind of row is one function that returns a View ([ChatScreen.row], [ChatScreen.card], …); a new kind of card
 * (the conversation's generated cards) plugs in as one more such function: the list neither knows nor cares what is inside.
 * [id] is the message's ledger id (empty for rows that are not messages), for jumping to it.
 */
class ChatRow(val key: String, val sig: String, val id: String = "", val make: () -> View?)

object ChatRows {
    /** Item types and card types the chat draws; anything else is not a row (a newer kernel's kinds wait for a newer app). */
    private val CARDS = setOf("options", "file", "image", "link", "permission", "app", "a2ui")

    /**
     * The row key of a window item: the client id it was sent with, so the owner's message keeps the row it waited in —
     * from the item itself, or else from [sentAs] (the client id the phone sent it with, by ledger id) — else its id.
     */
    fun key(item: JSONObject, sentAs: (String) -> String? = { null }): String =
        item.optString("client_id").ifEmpty { sentAs(item.optString("id")) ?: item.optString("id") }


    /** Whether a window item is drawn at all. */
    fun shows(item: JSONObject): Boolean = when (item.optString("type")) {
        "say", "failed" -> true
        "ask" -> item.optJSONObject("ask") != null
        "card" -> item.optJSONObject("card")?.optString("type") in CARDS
        else -> false
    }

    /**
     * The rows, oldest first: the note that older messages exist, the window's items, then what waits in the outbox.
     * A key seen twice keeps its first row (an outbox entry the window already shows is that window row).
     */
    fun build(
        items: Collection<JSONObject>, outbox: List<Pending>, moreBefore: Boolean,
        more: () -> View, item: (JSONObject) -> View?, pending: (Pending) -> View?,
        sentAs: (String) -> String? = { null },
    ): List<ChatRow> {
        val out = ArrayList<ChatRow>()
        val keys = HashSet<String>()
        for (it in items) {
            if (!shows(it)) continue
            val key = key(it, sentAs).ifEmpty { "seq:" + it.optLong("seq") }
            if (keys.add(key)) out.add(ChatRow(key, it.toString(), it.optString("id")) { item(it) })
        }
        for (o in outbox) {
            val key = o.clientId
            if (key.isNotEmpty() && keys.add(key)) out.add(ChatRow(key, "out:${o.status}:${o.attachments()?.length() ?: 0}:${o.text}", o.ledgerId.orEmpty()) { pending(o) })
        }
        if (moreBefore && out.isNotEmpty()) out.add(0, ChatRow(MORE, MORE) { more() })
        return out
    }

    const val MORE = "more"

    val diff = object : DiffUtil.ItemCallback<ChatRow>() {
        override fun areItemsTheSame(a: ChatRow, b: ChatRow) = a.key == b.key
        override fun areContentsTheSame(a: ChatRow, b: ChatRow) = a.sig == b.sig
    }
}

/** Whether a text of [lineCount] lines folds to [lines]: it is long, and the owner has not opened it. */
object Fold {
    fun long(lineCount: Int, lines: Int) = lineCount > lines
    fun folded(lineCount: Int, lines: Int, open: Boolean) = !open && long(lineCount, lines)
}
