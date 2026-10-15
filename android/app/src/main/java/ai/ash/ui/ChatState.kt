package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import java.util.TreeMap

/**
 * The conversation as the phone last read it (MOBILE-ARCH §3.2): the items by seq, and whether older ones exist. Only a
 * successful read changes it; a read that failed leaves it as it was and is said apart ([failedAt]). A read is accepted only
 * for the generation it was asked in ([begin]): one asked before the link went down and came back, or before the conversation
 * was read anew, is dropped whether it succeeded or failed. Plain data, no Android.
 */
class ChatWindow(
    /** What an item becomes as it is taken from a read (the chat puts a card's newer patch over an older read of it). */
    private val adjust: (JSONObject) -> JSONObject = { it },
) {
    val items = TreeMap<Long, JSONObject>()
    var moreBefore = false; private set
    /** When the last read failed (0: the last read worked); the screen says the conversation may be behind. */
    var failedAt = 0L; private set
    var generation = 0; private set
    /** A newest window has been read successfully at least once (before that the rows are only what waits to be sent). */
    var read = false; private set

    /** A new read of the newest window starts: what an older one answers no longer counts. */
    fun begin(): Int = ++generation
    /** The link went down or came back: nothing asked before counts. */
    fun invalidate() { generation++ }

    /** The newest window, read in generation [gen]: [window] null is a failed read. False when it no longer counts. */
    fun newest(gen: Int, window: JSONObject?, now: Long): Boolean {
        if (gen != generation) return false
        if (window == null) { failedAt = now; return true }
        failedAt = 0
        read = true
        val got = window.optJSONArray("items") ?: JSONArray()
        val from = (0 until got.length()).mapNotNull { got.optJSONObject(it)?.optLong("seq") }.minOrNull()
        // A successful window replaces what it covers; a successful empty one means the conversation is empty.
        if (from != null) items.tailMap(from, true).clear() else items.clear()
        if (items.isEmpty()) moreBefore = window.optBoolean("has_more_before")
        put(got)
        return true
    }

    /** A page further back (older messages, or the window around a message); a failed one changes nothing. Only a page reaching further back says whether there is more. */
    fun older(window: JSONObject?) {
        window ?: return
        val oldest = items.firstEntry()?.key ?: Long.MAX_VALUE
        val got = window.optJSONArray("items") ?: JSONArray()
        put(got)
        if (got.length() == 0 || items.firstKey() < oldest) moreBefore = window.optBoolean("has_more_before")
    }

    private fun put(got: JSONArray) { for (i in 0 until got.length()) got.optJSONObject(i)?.let { items[it.optLong("seq")] = adjust(it) } }

    fun clientIds(): Set<String> = items.values.mapNotNull { it.optString("client_id").ifEmpty { null } }.toSet()
    fun ids(): Set<String> = items.values.map { it.optString("id") }.toSet()
}

/**
 * What the owner has typed and not sent, per conversation (MOBILE-ARCH §3.4, §11.1): the chat with each agent, each Codex
 * session and each new Codex session has its own. Kept in [store] as it is typed, so a theme change, a rotation or the
 * process being reclaimed brings it back; switching conversations never carries one into another. No secret is ever typed here.
 */
class Drafts(private val store: Store) {
    interface Store { fun get(key: String): String?; fun put(key: String, value: String?) }

    fun text(key: String): String = store.get(key).orEmpty()
    fun keep(key: String, text: String) { store.put(key, text.ifEmpty { null }) }
    fun clear(key: String) { store.put(key, null) }

    companion object {
        fun chat(agent: String?) = "chat:" + (agent ?: "primary")
        fun codex(device: String, thread: String) = "codex:$device:$thread"
        fun codexNew(device: String, cwd: String) = "codex-new:$device:$cwd"
    }
}
