package ai.ash.ui

import ai.ash.link.Link
import ai.ash.link.LinkClient
import ai.ash.link.SyncListener
import android.content.Context
import org.json.JSONObject

/** One follow on the app's existing link, only while a system app is visible. Never attaches a chat page. */
object LedgerFeed {
    private val subscription = LedgerSubscription(UiIo::decode, UiIo::ui)
    fun listen(ctx: Context, message: (JSONObject) -> Unit, connection: (Boolean) -> Unit) =
        subscription.listen(Link.get(ctx).client, message, connection)
    fun listen(client: LinkClient, message: (JSONObject) -> Unit, connection: (Boolean) -> Unit) =
        subscription.listen(client, message, connection)
    fun remove(message: (JSONObject) -> Unit) = subscription.remove(message)
    fun connectionChanged(open: Boolean) = UiIo.ui { subscription.connectionChanged(open) }
}

/** Owns only the existing link's sync lifetime; dispatch and work queues are explicit so the real wire can be tested. */
internal class LedgerSubscription(private val work: (() -> Unit) -> Unit, private val main: (() -> Unit) -> Unit) {
    private val listeners = LinkedHashMap<(JSONObject) -> Unit, (Boolean) -> Unit>()
    private var client: LinkClient? = null
    private var sid: String? = null
    private var generation = 0
    private var ready = false
    private var cursor: Long? = null

    /** Main queue. A connected callback means the follow is established, so the page's reread cannot precede it. */
    fun listen(link: LinkClient, message: (JSONObject) -> Unit, connection: (Boolean) -> Unit) {
        client = link
        val first = listeners.isEmpty()
        listeners[message] = connection
        connection(ready && link.channelOpen("human"))
        if (first && link.channelOpen("human")) start()
    }

    fun remove(message: (JSONObject) -> Unit) {
        listeners.remove(message)
        if (listeners.isEmpty()) { stop(); cursor = null }
    }

    fun connectionChanged(open: Boolean) {
        stop()
        listeners.values.toList().forEach { it(false) }
        if (open && listeners.isNotEmpty()) start()
    }

    private fun stop() {
        generation++
        ready = false
        sid?.let { client?.closeSync(it) }
        sid = null
    }

    private fun start() {
        val link = client ?: return
        val gen = ++generation
        val params = JSONObject().put("limit", 200).put("follow", true)
        cursor?.let { params.put("after", it) } ?: params.put("limit", 1)
        work {
            val opened = runCatching {
                link.openSync(params, object : SyncListener {
                    override fun page(frame: JSONObject) = deliver(frame)
                    override fun message(frame: JSONObject) = deliver(frame)
                    private fun deliver(frame: JSONObject) {
                        val messages = LedgerMessages.of(frame)
                        main {
                            if (gen != generation || listeners.isEmpty()) return@main
                            for (m in messages) {
                                if (m.has("seq")) cursor = maxOf(cursor ?: 0, m.optLong("seq"))
                                listeners.keys.toList().forEach { it(m) }
                            }
                            if (frame.optString("t") == "sync.page" && frame.optBoolean("end") && !ready) {
                                if (cursor == null) cursor = 0
                                ready = true
                                listeners.values.toList().forEach { it(true) }
                            }
                        }
                    }
                })
            }.getOrNull()
            main {
                if (gen == generation && listeners.isNotEmpty()) sid = opened
                else opened?.let(link::closeSync)
            }
        }
    }
}

/** Keeps the complete ledger object (from/to/word/payload…), never a summary manufactured by the UI. */
internal object LedgerMessages {
    fun of(frame: JSONObject): List<JSONObject> = when (frame.optString("t")) {
        "sync.msg" -> listOfNotNull(frame.optJSONObject("message"))
        "sync.page" -> frame.optJSONArray("messages")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
        else -> emptyList()
    }
}
