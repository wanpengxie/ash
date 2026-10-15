package ai.ash.human

import ai.ash.caps.ERROR_CODES
import ai.ash.link.LinkClient
import ai.ash.link.PresentOutcome
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * The chat screen's end of the human channel (SPEC-05 §4.1). The screen ([ai.ash.ui.HumanPort], the "page" below) has no connection
 * of its own: it hands the frames it would send over a WebSocket to this bridge, which puts them on the app's one connection
 * unchanged, and what comes back on the human channel for the screen is handed to it unchanged. The messages between them are:
 *
 *  - page to native `{type:"frame", frame}`: a `send`, `sync`, `sync.close`, `presence` or `stream` frame of the human channel,
 *    or the `present.result` of a `chat` present it was given. A frame the link cannot send (no connection, or one that breaks
 *    the protocol) is answered with an `error` frame carrying the frame's `id` (or its `sid`).
 *  - native to page `{type:"frame", frame}`: `send.result`, `sync.page`, `sync.msg`, `stream`, and the `chat` presents.
 *  - native to page `{type:"link", open, client?, local?}`: the human channel opened or closed. Its syncs end with it, so the
 *    page opens them again when it opens; the same message is sent when a page attaches (the bridge keeps the last state).
 *
 * Nothing in a frame is looked at, except to find the `chat` presents and to end the page's syncs when the page goes.
 */
class ChatBridge(
    private val link: Uplink,
    private val ui: ChatUi,
    private val log: (String) -> Unit = {},
    /** Progress lines for the `ash.chat` log: the page coming and going, the link state it was told, frame counts. */
    private val trace: (String) -> Unit = {},
) {
    /** The app's connection, human channel side. */
    interface Uplink {
        /** Sends one frame as it is; null when it was sent, otherwise why not. */
        fun send(frame: JSONObject): LinkClient.Refusal?
    }

    /** The app's [LinkClient] as the page's way up; [client] is asked each time, so it may be made after the bridge. */
    class LinkUplink(private val client: () -> LinkClient) : Uplink {
        override fun send(frame: JSONObject) = client().sendHumanFrame(frame)
    }

    /** What the chat needs from the app's screen. */
    interface ChatUi {
        /** Brings the chat screen to the front (starts it if need be). False when it cannot be started now. */
        fun bringToFront(): Boolean
    }

    /** Where messages for the chat screen go; one while a page is attached. */
    fun interface Page { fun post(message: String) }

    private val lock = Any()
    private var page: Page? = null
    private var linkMessage: JSONObject = JSONObject().put("type", "link").put("open", false)
    /** Syncs the page opened on this connection, ended when the page goes. */
    private val syncs = LinkedHashSet<String>()
    /** `chat` presents forwarded to the page, by present id, waiting for the page's `present.result`. */
    private val asked = ConcurrentHashMap<String, CompletableFuture<PresentOutcome>>()
    /** `chat` presents that came while no page was attached; the page gets them when it attaches. */
    private val waiting = ArrayList<JSONObject>()
    private var toPageCount = 0L
    private var fromPageCount = 0L

    // --- the page ---

    /** A page is ready to talk (it said `hello`): tell it the state of the link, and give it what waited. */
    fun attach(page: Page) {
        val queued: List<JSONObject>
        val message: String
        synchronized(lock) {
            this.page = page
            queued = ArrayList(waiting)
            waiting.clear()
            message = linkMessage.toString()
            toPageCount = 0; fromPageCount = 0
        }
        trace("page attached; link state told: $message; ${queued.size} present(s) waited")
        page.post(message)
        queued.forEach { toPage(it) }
    }

    /**
     * The page is gone (the screen closed): its syncs end, and the presents it never answered fail. With [only],
     * nothing happens unless that is the page attached now: a screen that is closing must not drop the page of the one that
     * replaced it.
     */
    fun detach(only: Page? = null) {
        val open: List<String>
        synchronized(lock) {
            if (only != null && page !== only) return
            trace("page detached after $fromPageCount frame(s) from it and $toPageCount to it")
            page = null
            open = ArrayList(syncs)
            syncs.clear()
            waiting.clear()
        }
        for (sid in open) link.send(JSONObject().put("t", "sync.close").put("sid", sid))
        asked.values.forEach { it.complete(PresentOutcome(false, null, "unavailable", "the chat screen went away")) }
    }

    /** A frame from the page. */
    fun fromPage(frame: JSONObject) {
        val type = frame.optString("t")
        val n = synchronized(lock) { ++fromPageCount }
        if (n == 1L || n % 100 == 0L) trace("frames from the page: $n (latest: $type)")
        if (type == "present.result") {
            asked[frame.optString("id")]?.complete(outcomeOf(frame))
            return
        }
        val refused = link.send(frame)
        if (refused != null) {
            val reason = refused.message.take(200).ifEmpty { "not sent" }
            log("a $type frame from the chat screen was not sent: $reason")
            val error = JSONObject().put("t", "error").put("code", refused.code).put("message", reason)
            (frame.opt("id") ?: frame.opt("sid")).let { if (it is String && it.isNotEmpty() && it.length <= 128) error.put("id", it) }
            toPage(error)
            return
        }
        val sid = frame.optString("sid")
        if (type == "sync") synchronized(lock) { syncs.add(sid) }
        if (type == "sync.close") synchronized(lock) { syncs.remove(sid) }
    }

    // --- the kernel ---

    /** A frame of the human channel for the page, as it came. */
    fun fromKernel(frame: JSONObject) = toPage(frame)

    /** The human channel opened ([client] is this channel's `client:<sid>`) or closed. */
    fun linkChanged(open: Boolean, client: String? = null, local: Boolean = false) {
        val message = JSONObject().put("type", "link").put("open", open)
        if (open && client != null) message.put("client", client).put("local", local)
        val sink: Page?
        synchronized(lock) {
            linkMessage = message
            sink = page
            // The kernel dropped these syncs with the connection.
            if (!open) syncs.clear()
        }
        trace("human channel ${if (open) "opened as $client" else "closed"}; " + if (sink == null) "no page attached, kept for it" else "page told")
        sink?.post(message.toString())
    }

    /**
     * A present of the `chat` surface. `focus` brings the page to the front; `open {target}` brings it up and has the page open
     * the target: the page gets a `present` frame of its own and answers it with a `present.result`, which is this call's outcome.
     * Blocks up to [timeoutMs] (a worker thread; never the main thread).
     */
    fun present(op: String, body: JSONObject, timeoutMs: Long = PAGE_ANSWER_MS): PresentOutcome {
        val brought = ui.bringToFront()
        if (op == "focus") return if (brought) PresentOutcome(true) else PresentOutcome(false, null, "unavailable", "the chat page could not be brought up now")
        val id = "c_" + UUID.randomUUID()
        val frame = JSONObject().put("t", "present").put("ch", "human").put("id", id).put("surface", "chat").put("op", op).put("body", body)
        val answer = CompletableFuture<PresentOutcome>()
        asked[id] = answer
        try {
            val sink = synchronized(lock) { page.also { if (it == null) waiting.add(frame) } }
            if (sink != null) toPage(frame)
            return answer.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: TimeoutException) {
            return PresentOutcome(false, null, "timeout", "the chat screen did not answer")
        } finally {
            asked.remove(id)
            synchronized(lock) { waiting.remove(frame) }
        }
    }

    /**
     * A `chat` present the page takes as it comes, without bringing the chat up and without waiting for it (`card.patch`: a card
     * shown in the conversation changed). With no page attached it is dropped: the page reads the conversation again when it comes.
     */
    fun deliver(op: String, body: JSONObject): PresentOutcome {
        toPage(JSONObject().put("t", "present").put("ch", "human").put("id", "p_" + UUID.randomUUID()).put("surface", "chat").put("op", op).put("body", body))
        return PresentOutcome(true)
    }

    private fun toPage(frame: JSONObject) {
        val sink: Page
        val n: Long
        synchronized(lock) { sink = page ?: return; n = ++toPageCount }
        if (n == 1L || n % 100 == 0L) trace("frames to the page: $n (latest: ${frame.optString("t")})")
        sink.post(JSONObject().put("type", "frame").put("frame", frame).toString())
    }

    private fun outcomeOf(result: JSONObject): PresentOutcome {
        if (result.optBoolean("ok")) return PresentOutcome(true, result.opt("data"))
        val error = result.optJSONObject("error")
        val code = error?.optString("code").orEmpty().let { if (it in ERROR_CODES) it else "failed" }
        return PresentOutcome(false, null, code, error?.optString("message").orEmpty())
    }

    companion object {
        /** How long a `chat open` waits for the page (it may have to be started first). */
        const val PAGE_ANSWER_MS = 10_000L
    }
}
