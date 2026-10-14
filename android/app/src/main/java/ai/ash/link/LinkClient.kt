package ai.ash.link

import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

// --- what a handler returns -------------------------------------------------------------------------------------------------

/** One piece of a call's result: text, or an image (base64). Pieces too big for a frame travel as a `stream`. */
sealed class Part {
    class Text(val text: String) : Part()
    class Image(val mime: String, val b64: String) : Part()
}

sealed class CallOutcome {
    class Ok(val content: List<Part>, val data: Any? = null) : CallOutcome()
    /** [code] is one of the unified error codes (SPEC-02 §7). */
    class Err(val code: String, val message: String, val detail: Any? = null, val recoveryHint: String? = null) : CallOutcome()
}

class CallRequest(val id: String, val capability: String, val args: JSONObject, val member: String, val label: String, val turn: String?, val deadline: Long)

/** Given to a running call: [isCancelled] turns true on `cancel` or when the connection drops; [progress] tells the kernel how it goes. */
interface CallContext {
    fun isCancelled(): Boolean
    fun progress(text: String)
}

class Assessment(val risk: String, val why: String? = null)

class PresentOutcome(val ok: Boolean, val data: Any? = null, val errorCode: String = "failed", val errorMessage: String = "")

class CloseInfo(val code: Int, val reason: String, val willReconnect: Boolean)

/** What the hand does with what the kernel asks. `call`, `assess` and `present` run on worker threads, never on the link's own thread. */
interface HandHandlers {
    /** Runs a capability. Throwing is a `failed` result. */
    fun call(call: CallRequest, ctx: CallContext): CallOutcome = CallOutcome.Err("unavailable", "this hand serves no calls")
    /** The risk of one call, for a capability that declared `per_call_risk`. */
    fun assess(capability: String, args: JSONObject): Assessment? = null
    /** The kernel shows something on this hand's human channel; null = this hand does not show that. */
    fun present(frame: JSONObject): PresentOutcome? = null
    /** Connected and welcomed (also after every reconnect). */
    fun welcome(welcome: JSONObject) {}
    fun manifestAck(ack: JSONObject) {}
    fun closed(info: CloseInfo) {}
    fun log(message: String, error: Throwable? = null) {}

    companion object { val NONE = object : HandHandlers {} }
}

class LinkException(val kind: String, message: String) : Exception(message)

interface SyncListener {
    fun page(frame: JSONObject)
    fun message(frame: JSONObject)
}

/** The wait before reconnect attempt number [attempt] (0 is the first): 1, 2, 4, 8, 16, 30 s, then 30 s, each ±20%. */
fun reconnectDelay(attempt: Int, random: () -> Double = Math::random): Long {
    val base = BACKOFF_MS[minOf(attempt, BACKOFF_MS.size - 1)]
    return Math.round(base * (1 + (random() * 2 - 1) * 0.2))
}
private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 16_000, 30_000)

class HandInfo(val kind: String, val name: String, val version: String, val platform: String, val publicKey: String?)

class LinkOptions(
    /** Where to connect; asked again on every attempt (the port changes when the kernel host attaches again). */
    val url: () -> String,
    /** Request headers per attempt, e.g. `Authorization: Bearer ...` for a local connection. */
    val headers: () -> Map<String, String> = { emptyMap() },
    val hand: HandInfo,
    /** The channels asked for in `hello`. */
    val device: Boolean = true,
    val human: Boolean = true,
    val humanLabel: String? = null,
    val surfaces: List<String> = emptyList(),
    /** Signs the challenge nonce (base64url DER); needed when [hand] has a public key. */
    val sign: ((String) -> String)? = null,
    val connector: SocketConnector,
    val codec: FrameCodec,
    val outbox: EventOutbox,
    val handlers: HandHandlers = HandHandlers.NONE,
    /**
     * Where the human channel's frames go that the client does not answer itself: a `send.result`, `sync.page`, `sync.msg`
     * or human `stream` frame nobody on this side asked for by [LinkClient.send] / [LinkClient.openSync]. The chat page asked
     * for them through [LinkClient.sendHumanFrame], so they are handed over unchanged (SPEC-05 §4.1). Runs on the link's thread.
     */
    val humanFrames: ((JSONObject) -> Unit)? = null,
    val clock: Clock = SystemClock,
    val random: () -> Double = Math::random,
    /** A text or image part longer than this many characters travels as a stream instead of inside the result. */
    val inlineLimit: Int = 256 * 1024,
)

/**
 * A hand's side of `ash-link/2` (SPEC-03): opens the WebSocket, answers the challenge, keeps the connection
 * (reconnecting with backoff), serves the kernel's calls on worker threads, and keeps the manifest and the unacked
 * events across reconnects. Port of `packages/link/src/hand.ts`.
 *
 * Everything that changes the client's state runs on one thread of its own ("ash-link"), so no lock guards it; the
 * calls themselves run on a worker pool. Public methods may be called from any thread.
 */
class LinkClient(private val o: LinkOptions) {
    enum class State { IDLE, CONNECTING, READY, WAITING, STOPPED }

    @Volatile var state: State = State.IDLE
        private set
    /** The `welcome` of the current connection, null when not connected. */
    @Volatile var welcome: JSONObject? = null
        private set
    /** The close code that ended the client for good (4003, 4008, 4009), if any. */
    @Volatile var stoppedBy: Int? = null
        private set
    /** How the last connection ended. */
    @Volatile var lastClose: CloseInfo? = null
        private set

    private val codec = o.codec
    private val handlers = o.handlers
    private val loop: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-link").apply { isDaemon = true } }
    private val workers: ExecutorService = Executors.newCachedThreadPool { r -> Thread(r, "ash-link-call").apply { isDaemon = true } }

    // Confined to the loop thread:
    private var conn: Conn? = null
    private var failures = 0
    private var retry: Cancelable? = null
    /** Bumped by every attempt, so a retry timer that fires after a newer attempt began does nothing. */
    private var attempts = 0
    private var reconnecting = false
    private var manifest: JSONObject? = null
    private var manifestRev = 0
    private val running = HashMap<String, Running>()
    private val requests = HashMap<String, CompletableFuture<JSONObject>>()
    private val syncs = HashMap<String, SyncListener>()

    // --- control (any thread) ---

    /** Starts connecting; it keeps trying until [stop] or a close code that forbids reconnecting. */
    fun start() = post { if (state == State.IDLE) attempt() }

    /** Ends the client; no reconnecting. */
    fun stop() = post {
        retry?.cancel()
        state = State.STOPPED
        conn?.close(CloseCodes.NORMAL, "stopped")
        abortAll()
    }

    /** Ends the client and its threads (tests, process end). */
    fun shutdown() {
        stop()
        loop.shutdown()
        workers.shutdownNow()
    }

    /**
     * Connects now, dropping the current connection and any waiting or stopped state (the kernel host handed over a new
     * port or token). Also how a client that was never started starts.
     */
    fun reconnectNow() = post {
        retry?.cancel()
        stoppedBy = null
        failures = 0
        val c = conn
        if (c != null && !c.closed) {
            reconnecting = true
            c.close(CloseCodes.NORMAL, "reconnecting")
        } else attempt()
    }

    // --- device channel ---

    /**
     * Declares what this hand can do. The manifest is kept and sent again after every reconnect; calling this again
     * with a changed list sends a new `rev`. [capabilities] are CapabilitySpec objects; [events] `{word, description, schema?}`.
     */
    fun setManifest(capabilities: List<JSONObject>, events: List<JSONObject>) = post {
        manifestRev++
        manifest = JSONObject().put("t", "manifest").put("ch", "device").put("rev", manifestRev)
            .put("capabilities", JSONArray(capabilities)).put("events", JSONArray(events))
        if (state == State.READY && deviceOpen()) sendManifest()
    }

    /**
     * Queues an event and sends it; until the kernel acks it, it is sent again after every reconnect, with the same id.
     * With [durable] false the event is only sent if the device channel is open right now, and dropped otherwise (for
     * what must not outlive a revoked permission). Returns false when a non-durable event was dropped; true means it was handed to the link.
     */
    fun emit(word: String, body: JSONObject, id: String = newId("e_"), at: Long = o.clock.now(), durable: Boolean = true): Boolean {
        val event = QueuedEvent(id, word, body, at)
        if (durable) {
            o.outbox.add(event)
            post { sendEvent(event) }
            return true
        }
        // Not queued: sent now if the device channel is open, otherwise dropped. The caller does not wait for the loop thread.
        if (state != State.READY || !deviceOpen()) return false
        post { sendEvent(event, durable = false) }
        return true
    }

    // --- human channel ---

    /**
     * Sends a word as the person (SPEC-03 §5.1); completes with the `send.result` frame, fails with [LinkException]: `closed` when
     * it never went out (no connection), `lost` when it went out and the connection closed before the answer.
     */
    fun send(request: JSONObject): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        post {
            val c = liveConn()
            if (c == null || !humanOpen()) { future.completeExceptionally(LinkException("closed", "not connected")); return@post }
            val id = newId("s_")
            requests[id] = future
            try {
                if (!c.send(JSONObject().put("t", "send").put("ch", "human").put("id", id).put("request", request))) {
                    requests.remove(id)
                    future.completeExceptionally(LinkException("closed", "not connected")) // it never went out
                }
            } catch (e: IllegalArgumentException) {
                requests.remove(id)
                future.completeExceptionally(LinkException("bad_request", e.message ?: "the request breaks the protocol"))
            }
        }
        return future
    }

    /** Opens a sync (SPEC-03 §5.2); pages and pushed messages go to [listener]. Returns the sync id, or null when not connected. */
    fun openSync(params: JSONObject, listener: SyncListener): String? {
        val sid = newId("y_")
        val opened = CompletableFuture<Boolean>()
        post {
            val c = liveConn()
            if (c == null || !humanOpen()) { opened.complete(false); return@post }
            syncs[sid] = listener
            val frame = JSONObject(params.toString()).put("t", "sync").put("ch", "human").put("sid", sid)
            opened.complete(c.send(frame))
        }
        return if (opened.get()) sid else null
    }

    fun closeSync(sid: String) = post { if (syncs.remove(sid) != null) liveConn()?.send(JSONObject().put("t", "sync.close").put("sid", sid)) }

    /** Why a frame was not sent: an error code of SPEC-02 §7 (`offline`, `bad_request`, `too_large`) and the reason. */
    class Refusal(val code: String, val message: String)

    /**
     * Sends one human-channel frame as it is (the chat page's `send`, `sync`, `sync.close`, `presence` and `stream`, SPEC-05 §4.1),
     * after checking it against the protocol like every frame. Null when it was handed to the link; otherwise the reason it was
     * not: the human channel is not open now, or the frame breaks the protocol. The page is then told with an `error` frame.
     */
    fun sendHumanFrame(frame: JSONObject): Refusal? {
        val type = codec.typeOf(frame)
        val text = try {
            when {
                type == null || type !in HUMAN_FRAMES -> throw IllegalArgumentException("not a human channel frame")
                type == "stream" && frame.optString("op") == "open" && frame.optString("ch") != "human" ->
                    throw IllegalArgumentException("a stream from the chat page must be on the human channel")
                state != State.READY || !humanOpen() -> return Refusal("offline", "the human channel is not open")
            }
            codec.encode(frame)
        } catch (e: IllegalArgumentException) {
            return Refusal("bad_request", e.message.orEmpty())
        } catch (e: FrameCodec.FrameTooLarge) {
            return Refusal("too_large", e.message.orEmpty())
        }
        post { liveConn()?.sendText(text) }
        return null
    }

    /** `{visible?, typing?, agent?}` (SPEC-03 §5.3). */
    fun presence(state: JSONObject) = post { if (humanOpen()) liveConn()?.send(JSONObject(state.toString()).put("t", "presence").put("ch", "human")) }

    /** Whether the kernel accepted the channel in `welcome` (false while not connected). */
    fun channelOpen(channel: String): Boolean = channelOpen(welcome, channel)

    // --- internals: loop thread ---

    private fun post(task: () -> Unit) {
        try { loop.execute { try { task() } catch (e: Throwable) { handlers.log("link task failed", e) } } } catch (_: RejectedExecutionException) {}
    }

    private fun liveConn(): Conn? = conn?.takeIf { state == State.READY && !it.closed }
    private fun deviceOpen() = channelOpen(welcome, "device")
    private fun humanOpen() = channelOpen(welcome, "human")

    private fun channelOpen(w: JSONObject?, channel: String): Boolean {
        val grant = w?.optJSONObject("channels")?.optJSONObject(channel) ?: return false
        return if (channel == "human") grant.has("client") else grant.optBoolean("accepted")
    }

    private fun attempt() {
        attempts++
        state = State.CONNECTING
        val url: String
        val headers: Map<String, String>
        try {
            url = o.url()
            headers = o.headers()
        } catch (e: Throwable) {
            handlers.log("could not prepare the connection", e)
            return scheduleRetry()
        }
        var fresh: Conn? = null
        val listener = object : SocketListener {
            override fun onMessage(text: String?) = post { fresh?.receive(text) }
            override fun onClosed(code: Int, reason: String) = post { fresh?.remoteClosed(code, reason) }
        }
        val socket = try { o.connector.connect(url, headers, listener) } catch (e: Throwable) {
            handlers.log("could not open the socket", e)
            return scheduleRetry()
        }
        fresh = Conn(socket)
        conn = fresh
    }

    private fun scheduleRetry() {
        if (state == State.STOPPED) return
        state = State.WAITING
        val generation = attempts
        retry = o.clock.after(reconnectDelay(failures++, o.random)) { post { if (attempts == generation && state == State.WAITING) attempt() } }
    }

    private fun onClosed(c: Conn, code: Int, reason: String) {
        if (conn === c) conn = null
        welcome = null
        abortAll()
        val requestsLeft = ArrayList(requests.values)
        requests.clear()
        // Every request in the map went out: the kernel may have done it. (One that never went out fails at once as "closed".)
        requestsLeft.forEach { it.completeExceptionally(LinkException("lost", "connection closed")) }
        syncs.clear()
        humanStreams.clear()
        val final = state == State.STOPPED || code in CloseCodes.NO_RECONNECT
        if (final && state != State.STOPPED) { stoppedBy = code; state = State.STOPPED }
        val info = CloseInfo(code, reason, !final)
        lastClose = info
        handlers.closed(info)
        if (final) return
        if (reconnecting) { reconnecting = false; attempt() } else scheduleRetry()
    }

    private fun abortAll() {
        for (r in running.values) { r.cancelled = true; r.claim(); r.future?.cancel(true) }
        running.clear()
    }

    private fun onWelcome(c: Conn, frame: JSONObject) {
        welcome = frame
        state = State.READY
        failures = 0
        c.startHeartbeat(frame.optLong("heartbeat_ms", LinkProtocol.HEARTBEAT_MS))
        if (deviceOpen()) {
            sendManifest()
            resendEvents(c)
        }
        handlers.welcome(frame)
    }

    private fun sendManifest() { manifest?.let { conn?.send(it) } }

    /** Sends the events nobody acked, oldest first; only ever on an open device channel. */
    private fun resendEvents(c: Conn) {
        try {
            for (event in o.outbox.pending()) if (!sendEvent(event)) break
        } catch (e: Throwable) {
            handlers.log("could not resend queued events", e)
        }
    }

    /** True when the event was sent now or needs nothing more (already sent on this connection, or dropped as unsendable). */
    private fun sendEvent(event: QueuedEvent, durable: Boolean = true): Boolean {
        val c = liveConn() ?: return false
        if (!deviceOpen()) return false
        if (durable && !c.sentEvents.add(event.id)) return true
        val frame = JSONObject().put("t", "event").put("ch", "device").put("id", event.id).put("word", event.word).put("body", event.body).put("at", event.at)
        return try {
            c.send(frame)
        } catch (e: IllegalArgumentException) {
            // This event can never be sent (a word the protocol refuses, a body that is too big): keeping it would block the queue.
            handlers.log("dropped an unsendable event ${event.word}: ${e.message?.take(120)}")
            o.outbox.ack(event.id)
            true
        } catch (e: FrameCodec.FrameTooLarge) {
            handlers.log("dropped an event too large for a frame: ${event.word}")
            o.outbox.ack(event.id)
            true
        }
    }

    // --- one connection ---

    private enum class Phase { CHALLENGE, WELCOME, READY }

    private inner class Conn(private val socket: LinkSocket) {
        @Volatile var closed = false
        private var phase = Phase.CHALLENGE
        private var silence: Cancelable? = null
        private var beat: Cancelable? = null
        private var silenceGeneration = 0
        /** Ids of the events sent on this connection (loop thread). */
        val sentEvents = HashSet<String>()

        init { armSilence() }

        /** Sends a frame; false when the connection is closed. A frame that breaks the protocol throws, so a bug is found where it is made. */
        fun send(frame: JSONObject): Boolean {
            if (closed) return false
            return socket.send(codec.encode(frame))
        }

        /** Sends a frame already encoded by [FrameCodec.encode]. */
        fun sendText(text: String): Boolean = !closed && socket.send(text)

        fun queued(): Long = socket.queueSize()

        fun receive(text: String?) {
            if (closed) return
            armSilence()
            val decoded = if (text == null) Decoded.Bad("frames are UTF-8 text messages", null, null) else codec.decode(text)
            if (decoded is Decoded.Bad) return protocolError(decoded.id, decoded.error)
            decoded as Decoded.Ok
            if (codec.senderOf(decoded.type) == "hand") return protocolError(null, "${decoded.type} sent by the wrong end")
            when (decoded.type) {
                "ping" -> send(JSONObject().put("t", "pong").put("at", decoded.frame.getLong("at")))
                "pong" -> Unit
                else -> onFrame(decoded.type, decoded.frame)
            }
        }

        private fun protocolError(id: String?, message: String) {
            val error = JSONObject().put("t", "error").put("code", "bad_request").put("message", message.take(200))
            if (id != null && id.isNotEmpty() && id.length <= 128) error.put("id", id)
            runCatching { send(error) }
            close(CloseCodes.BAD_FRAME, message)
        }

        private fun onFrame(type: String, frame: JSONObject) {
            when (phase) {
                Phase.CHALLENGE ->
                    if (type == "challenge") answerChallenge(frame) else close(CloseCodes.BAD_FRAME, "unexpected $type during the handshake")
                Phase.WELCOME ->
                    if (type == "welcome") { phase = Phase.READY; onWelcome(this, frame) } else close(CloseCodes.BAD_FRAME, "unexpected $type during the handshake")
                Phase.READY -> dispatch(this, type, frame)
            }
        }

        private fun answerChallenge(frame: JSONObject) {
            val protocol = frame.getJSONObject("kernel").getString("protocol")
            if (protocol != LinkProtocol.NAME) return close(CloseCodes.UNSUPPORTED, "kernel speaks ${protocol.take(40)}")
            try {
                val hand = JSONObject().put("kind", o.hand.kind).put("name", o.hand.name).put("version", o.hand.version).put("platform", o.hand.platform)
                if (o.hand.publicKey != null) hand.put("public_key", o.hand.publicKey)
                val channels = JSONObject()
                if (o.device) channels.put("device", JSONObject())
                if (o.human) channels.put("human", JSONObject().apply {
                    o.humanLabel?.let { put("label", it) }
                    put("surfaces", JSONArray(o.surfaces))
                })
                val hello = JSONObject().put("t", "hello").put("protocol", LinkProtocol.NAME).put("hand", hand)
                o.sign?.let { hello.put("sig", it(frame.getString("nonce"))) }
                hello.put("features", JSONArray()).put("channels", channels)
                send(hello)
                phase = Phase.WELCOME
            } catch (e: Throwable) {
                handlers.log("could not answer the challenge", e)
                close(CloseCodes.INTERNAL, "could not sign")
            }
        }

        fun startHeartbeat(ms: Long) {
            beat?.cancel()
            lateinit var tick: () -> Unit
            tick = {
                post {
                    if (!closed) {
                        runCatching { send(JSONObject().put("t", "ping").put("at", o.clock.now())) }
                        beat = o.clock.after(ms, tick)
                    }
                }
            }
            beat = o.clock.after(ms, tick)
        }

        /** Closes from this end. */
        fun close(code: Int, reason: String = "") {
            if (closed) return
            finish(code, reason)
            try { socket.close(code, reason.take(100)) } catch (_: Exception) {}
        }

        /** The socket's close: the peer (or the network) ended it. */
        fun remoteClosed(code: Int, reason: String) { if (!closed) finish(code, reason) }

        private fun finish(code: Int, reason: String) {
            closed = true
            silence?.cancel()
            beat?.cancel()
            onClosed(this, code, reason)
        }

        private fun armSilence() {
            silence?.cancel()
            val generation = ++silenceGeneration
            silence = o.clock.after(LinkProtocol.SILENCE_MS) {
                post {
                    if (generation == silenceGeneration && !closed) {
                        close(CloseCodes.NORMAL, "no frame within the silence limit")
                        socket.cancel()
                    }
                }
            }
        }
    }

    // --- frames after the handshake ---

    private fun dispatch(c: Conn, type: String, frame: JSONObject) {
        when (type) {
            "stream" -> onStream(c, frame)
            "manifest.ack" -> handlers.manifestAck(frame)
            "event.ack" -> {
                val id = frame.getString("id")
                c.sentEvents.remove(id)
                o.outbox.ack(id)
            }
            "call" -> runCall(c, frame)
            "cancel" -> cancelCall(c, frame.getString("id"))
            "assess" -> runAssess(c, frame)
            "send.result" -> requests.remove(frame.getString("id"))?.complete(frame) ?: toHuman(frame)
            "sync.page" -> syncs[frame.getString("sid")]?.page(frame) ?: toHuman(frame)
            "sync.msg" -> syncs[frame.getString("sid")]?.message(frame) ?: toHuman(frame)
            "present" -> runPresent(c, frame)
            "agent" -> handlers.log("ignored an agent frame: this hand has no agent channel")
            "error" -> handlers.log("kernel reports ${frame.getString("code")}: ${frame.getString("message").take(200)}")
            else -> c.close(CloseCodes.BAD_FRAME, "unexpected $type")
        }
    }

    /** What the kernel streams to the human channel (the chat page's attachments and images): the sids being passed on. Loop thread. */
    private val humanStreams = HashSet<String>()

    private fun toHuman(frame: JSONObject) { o.humanFrames?.let { sink -> try { sink(frame) } catch (e: Throwable) { handlers.log("human frame sink failed", e) } } }

    /** A stream of the human channel goes to the page unchanged; this hand takes no other inbound stream. */
    private fun onStream(c: Conn, frame: JSONObject) {
        val sid = frame.getString("sid")
        when (frame.getString("op")) {
            "open" -> if (frame.getString("ch") == "human" && o.humanFrames != null) { humanStreams.add(sid); toHuman(frame) }
                else c.send(JSONObject().put("t", "stream").put("sid", sid).put("op", "error").put("code", "unavailable").put("message", "this hand takes no inbound streams"))
            "data" -> if (sid in humanStreams) toHuman(frame)
            else -> if (humanStreams.remove(sid)) toHuman(frame)
        }
    }

    /** A call in flight. Whoever claims it first (the worker, `cancel`, or the connection dropping) answers it; the others stay silent. */
    private class Running(val id: String) : CallContext {
        /** Guarded by `synchronized(this)` together with [started]: a cancel and the worker's start never miss each other. */
        @Volatile var cancelled = false
        var started = false
        @Volatile var future: Future<*>? = null
        @Volatile var conn: Conn? = null
        private val answered = AtomicBoolean(false)
        fun claim(): Boolean = answered.compareAndSet(false, true)
        fun isAnswered(): Boolean = answered.get()
        override fun isCancelled() = cancelled
        override fun progress(text: String) {
            if (!answered.get()) conn?.let { c -> runCatching { c.send(JSONObject().put("t", "progress").put("id", id).put("text", text)) } }
        }
    }

    private fun errorResult(id: String, code: String, message: String, detail: Any? = null, recoveryHint: String? = null): JSONObject {
        val error = JSONObject().put("code", code).put("message", message)
        if (detail != null) error.put("detail", detail)
        if (!recoveryHint.isNullOrEmpty()) error.put("recovery_hint", recoveryHint)
        return JSONObject().put("t", "result").put("id", id).put("ok", false).put("error", error)
    }

    private fun runCall(c: Conn, frame: JSONObject) {
        val id = frame.getString("id")
        if (running.containsKey(id)) {
            c.send(errorResult(id, "conflict", "a call with this id is already running"))
            return
        }
        if (running.size >= LinkProtocol.INFLIGHT_CALLS) {
            c.send(errorResult(id, "unavailable", "more than ${LinkProtocol.INFLIGHT_CALLS} calls in flight"))
            return
        }
        val caller = frame.getJSONObject("caller")
        val request = CallRequest(id, frame.getString("capability"), frame.getJSONObject("args"), caller.getString("member"), caller.getString("label"),
            caller.optString("turn").ifEmpty { null }, frame.getLong("deadline"))
        val entry = Running(id).also { it.conn = c }
        running[id] = entry
        entry.future = workers.submit { execute(c, entry, request) }
    }

    /** Worker thread: runs the call and answers it. */
    private fun execute(c: Conn, entry: Running, request: CallRequest) {
        // A cancel that came before this worker began is not an interrupt (there was nothing to interrupt): the call is not run.
        val cancelledFirst = synchronized(entry) { entry.started = true; entry.cancelled }
        val outcome = if (cancelledFirst) CallOutcome.Err("cancelled", "the call was cancelled") else try {
            handlers.call(request, entry)
        } catch (e: Throwable) {
            if (entry.cancelled) CallOutcome.Err("cancelled", "the call was cancelled")
            else CallOutcome.Err("failed", e.message ?: e.javaClass.simpleName)
        }
        // The slot is freed before the answer goes out, so a call the kernel sends after seeing it finds the slot free.
        post { if (running[request.id] === entry) running.remove(request.id) }
        if (!synchronized(entry) { entry.claim() }) return // dropped with the connection: nobody is listening
        // A late interrupt (or one the handler ignored) must not make sending the result, e.g. a stream, fail.
        Thread.interrupted()
        reply(c, request.id, outcome)
    }

    private fun reply(c: Conn, id: String, outcome: CallOutcome) {
        if (c.closed) return
        try {
            val frame = when (outcome) {
                is CallOutcome.Err -> errorResult(id, outcome.code, outcome.message, outcome.detail, outcome.recoveryHint)
                is CallOutcome.Ok -> {
                    val content = JSONArray()
                    for (part in outcome.content) content.put(partFrame(c, id, part))
                    JSONObject().put("t", "result").put("id", id).put("ok", true).put("content", content).apply { if (outcome.data != null) put("data", outcome.data) }
                }
            }
            c.send(frame)
        } catch (e: FrameCodec.FrameTooLarge) {
            runCatching { c.send(errorResult(id, "too_large", "the result is too large for one frame")) }
        } catch (e: Throwable) {
            handlers.log("could not answer call", e)
            runCatching { c.send(errorResult(id, "internal", "the result could not be sent")) }
        }
    }

    /** One content part; a big one goes out as a whole stream first, and the part becomes a reference to it. */
    private fun partFrame(c: Conn, callId: String, part: Part): JSONObject = when (part) {
        is Part.Text ->
            if (part.text.length <= o.inlineLimit) JSONObject().put("type", "text").put("text", part.text)
            else resource(c, callId, part.text.toByteArray(Charsets.UTF_8), "text/plain; charset=utf-8")
        is Part.Image ->
            if (part.b64.length <= o.inlineLimit) JSONObject().put("type", "image").put("mime", part.mime).put("b64", part.b64)
            else resource(c, callId, Base64.getDecoder().decode(part.b64), part.mime)
    }

    private fun resource(c: Conn, callId: String, bytes: ByteArray, mime: String): JSONObject {
        val sid = sendStream(c, "device", bytes, callId, mime)
        return JSONObject().put("type", "resource").put("stream", sid).put("mime", mime).put("size", bytes.size)
    }

    /** `open`, `data` chunks of at most 256 KiB, `end`; waits when the socket's queue is full so a big stream cannot overflow it. */
    private fun sendStream(c: Conn, channel: String, bytes: ByteArray, ref: String?, mime: String?): String {
        val sid = newId("st_")
        val open = JSONObject().put("t", "stream").put("sid", sid).put("op", "open").put("ch", channel).put("size", bytes.size)
        if (ref != null) open.put("ref", ref)
        if (mime != null) open.put("mime", mime)
        check(c.send(open)) { "connection closed" }
        var seq = 0
        var at = 0
        val encoder = Base64.getEncoder()
        while (at < bytes.size) {
            while (c.queued() > QUEUE_HIGH_WATER && !c.closed) Thread.sleep(2)
            val end = minOf(at + LinkProtocol.STREAM_CHUNK_BYTES, bytes.size)
            val chunk = encoder.encodeToString(bytes.copyOfRange(at, end))
            check(c.send(JSONObject().put("t", "stream").put("sid", sid).put("op", "data").put("seq", seq++).put("b64", chunk))) { "connection closed" }
            at = end
        }
        check(c.send(JSONObject().put("t", "stream").put("sid", sid).put("op", "end"))) { "connection closed" }
        return sid
    }

    private fun cancelCall(c: Conn, id: String) {
        val entry = running[id] ?: return
        // Best effort only: raise the flag and interrupt the worker. The worker answers: `cancelled` if the interrupt made
        // the handler throw, the real result if the work finished anyway (an action that happened must not be reported as cancelled).
        // A worker that has not begun yet sees the flag when it does, and answers `cancelled` without running the call.
        synchronized(entry) {
            entry.cancelled = true
            if (entry.started && !entry.isAnswered()) entry.future?.cancel(true)
        }
    }

    private fun runAssess(c: Conn, frame: JSONObject) {
        val id = frame.getString("id")
        val capability = frame.getString("capability")
        val args = frame.getJSONObject("args")
        workers.execute {
            try {
                val answer = handlers.assess(capability, args) ?: return@execute // no answer: the kernel uses the declared risk after 10 s
                val out = JSONObject().put("t", "assessed").put("id", id).put("risk", answer.risk)
                if (!answer.why.isNullOrEmpty()) out.put("why", answer.why)
                c.send(out)
            } catch (e: Throwable) {
                handlers.log("assess failed", e)
            }
        }
    }

    private fun runPresent(c: Conn, frame: JSONObject) {
        val id = frame.getString("id")
        val surface = frame.getString("surface")
        workers.execute {
            val outcome = try {
                handlers.present(frame) ?: PresentOutcome(false, null, "unavailable", "$surface is not shown on this hand")
            } catch (e: Throwable) {
                PresentOutcome(false, null, "failed", e.message ?: e.javaClass.simpleName)
            }
            val out = JSONObject().put("t", "present.result").put("id", id).put("ok", outcome.ok)
            if (outcome.ok) { if (outcome.data != null) out.put("data", outcome.data) }
            else out.put("error", JSONObject().put("code", outcome.errorCode).put("message", outcome.errorMessage))
            runCatching { c.send(out) }
        }
    }

    companion object {
        /** A stream sender waits while more than this many bytes sit in the socket's queue (OkHttp closes the socket at 16 MiB). */
        private const val QUEUE_HIGH_WATER = 1L shl 20
        /** What the chat page may send up (SPEC-03 §5, §3.4). */
        private val HUMAN_FRAMES = setOf("send", "sync", "sync.close", "presence", "stream")

        fun newId(prefix: String): String = prefix + UUID.randomUUID()
    }
}
