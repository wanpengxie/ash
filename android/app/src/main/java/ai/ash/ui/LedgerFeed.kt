package ai.ash.ui

import ai.ash.link.Link
import ai.ash.link.LinkClient
import ai.ash.link.SyncListener
import android.content.Context
import org.json.JSONObject

/** One follow on the app's existing link, only while a system app is visible. Never attaches a chat page. */
object LedgerFeed {
    private val listeners = LinkedHashMap<(JSONObject) -> Unit, (Boolean) -> Unit>()
    private var client: LinkClient? = null
    private var sid: String? = null
    private var generation = 0
    private var connected = false

    /** Main thread. Initial connection state is delivered immediately, including for a cold application entry. */
    fun listen(ctx: Context, message: (JSONObject) -> Unit, connection: (Boolean) -> Unit) {
        client = Link.get(ctx).client
        listeners[message] = connection
        connected = client?.channelOpen("human") == true
        connection(connected)
        if (listeners.size == 1 && connected) start()
    }

    fun remove(message: (JSONObject) -> Unit) {
        listeners.remove(message)
        if (listeners.isEmpty()) stop()
    }

    /** Called by the shared link, including reconnects. Dispatch to the UI before touching page listeners. */
    fun connectionChanged(open: Boolean) = UiIo.ui {
        connected = open
        stop()
        listeners.values.toList().forEach { it(open) }
        if (open && listeners.isNotEmpty()) start()
    }

    private fun stop() {
        generation++
        sid?.let { client?.closeSync(it) }
        sid = null
    }

    private fun start() {
        val link = client ?: return
        val gen = ++generation
        // openSync waits for the link loop. Neither that loop nor the UI may block on it.
        UiIo.decode {
            val opened = runCatching {
                link.openSync(JSONObject().put("limit", 1).put("follow", true), object : SyncListener {
                    override fun page(frame: JSONObject) = deliver(frame)
                    override fun message(frame: JSONObject) = deliver(frame)
                    private fun deliver(frame: JSONObject) {
                        val messages = LedgerMessages.of(frame)
                        UiIo.ui {
                            if (gen == generation && connected)
                                messages.forEach { m -> listeners.keys.toList().forEach { it(m) } }
                        }
                    }
                })
            }.getOrNull()
            UiIo.ui {
                if (gen == generation && connected && listeners.isNotEmpty()) sid = opened
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
