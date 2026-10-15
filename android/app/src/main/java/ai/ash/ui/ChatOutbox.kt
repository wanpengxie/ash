package ai.ash.ui

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * One message the owner wrote that the kernel has not taken yet. It never changes: a new status is a new copy (the list
 * hands these to the conversation's rows, MOBILE-ARCH §2.2). [to] null means "the primary agent", decided when it is sent,
 * so a message written before the link knew the primary is kept, not lost (§3.5). [clientId] is made before it is stored and
 * goes with every try, so the hub takes it once however often it is sent (§6.2).
 */
data class Pending(val clientId: String, val to: String?, val body: JSONObject, val status: String = SENDING, val ledgerId: String? = null, val at: Long = 0) {
    val text: String get() = body.optString("text")

    /** The `say` request, or null while there is nobody to send it to. */
    fun request(primary: String?): JSONObject? {
        val target = to ?: primary ?: return null
        return JSONObject().put("to", target).put("kind", "request").put("word", "say").put("body", JSONObject(body.toString())).put("client_id", clientId)
    }

    /** What is stored apart from the attachments' bytes. */
    fun meta(): JSONObject = JSONObject().put("client_id", clientId).put("status", status).put("at", at).apply {
        to?.let { put("to", it) }; ledgerId?.let { put("id", it) }
        put("body", JSONObject(body.toString()).apply { remove("attachments") })
    }

    fun attachments(): JSONArray? = body.optJSONArray("attachments")

    companion object {
        const val SENDING = "sending"
        const val UNSENT = "unsent"
        const val FAILED = "failed"
        const val SENT = "sent"

        fun fromStored(meta: JSONObject, attachments: JSONArray?): Pending? {
            val id = meta.optString("client_id").ifEmpty { return null }
            val body = meta.optJSONObject("body") ?: JSONObject()
            if (attachments != null && attachments.length() > 0) body.put("attachments", attachments)
            return Pending(id, meta.optString("to").ifEmpty { null }, body, meta.optString("status").ifEmpty { SENDING }, meta.optString("id").ifEmpty { null }, meta.optLong("at"))
        }
    }
}

/** The outbox as plain data: what waits, in order, and what each became. No I/O; [ChatOutbox] stores it. */
class OutboxModel {
    private val list = ArrayList<Pending>()
    /** Ledger id → the client id it was sent with: the window's copy of a sent message stays in the row it waited in. */
    private val sent = HashMap<String, String>()

    fun items(): List<Pending> = list.toList()
    fun sentAs(id: String): String? = sent[id]

    fun put(p: Pending) {
        val at = list.indexOfFirst { it.clientId == p.clientId }
        if (at >= 0) list[at] = p else list.add(p)
        p.ledgerId?.let { sent[it] = p.clientId }
    }

    /** The oldest one still to send: not failed, not yet taken. */
    fun next(): Pending? = list.firstOrNull { it.status != Pending.FAILED && it.ledgerId == null }

    fun mark(clientId: String, status: String): Pending? = list.firstOrNull { it.clientId == clientId }?.copy(status = status)?.also(::put)

    /** The kernel took it: kept (as sent) until the window shows it, so the row never blinks away and back. */
    fun taken(clientId: String, ledgerId: String?): Pending? {
        val p = list.firstOrNull { it.clientId == clientId } ?: return null
        if (ledgerId.isNullOrEmpty()) { list.remove(p); return null }
        return p.copy(status = Pending.SENT, ledgerId = ledgerId).also(::put)
    }

    fun remove(clientId: String): Boolean = list.removeAll { it.clientId == clientId }

    /** Drops what the window now shows (by its client id or its ledger id); returns what was dropped. */
    fun drop(clientIds: Set<String>, ids: Set<String>): List<Pending> {
        val gone = list.filter { it.clientId in clientIds || (it.ledgerId != null && it.ledgerId in ids) }
        list.removeAll(gone.toSet())
        return gone
    }
}

/**
 * The outbox kept on the phone (MOBILE-ARCH §3.5, §7.2): each message is a small file `<client_id>.json` and, once, its
 * attachments `<client_id>.att`, written whole (temporary file, renamed) on the disk queue, never on the main thread. A
 * message is shown and sent only after it is stored, so the owner's text leaves the box only once it cannot be lost; a
 * crash leaves either the whole message or nothing, and files with no message are swept at the next start.
 */
class ChatOutbox(ctx: Context) {
    private val dir = File(ctx.filesDir, "chat-outbox")
    private val model = OutboxModel()
    var ready = false; private set
    private var onReady: (() -> Unit)? = null

    init {
        UiIo.disk {
            val loaded = load()
            UiIo.ui { loaded.forEach(model::put); ready = true; onReady?.invoke() }
        }
        // The outbox of earlier builds (a list in the preferences and files in outbox/) is not carried over (not released yet).
        val old = File(ctx.filesDir, "outbox")
        val prefs = ctx.getSharedPreferences("ash.chat.outbox", Context.MODE_PRIVATE)
        UiIo.disk { old.deleteRecursively(); prefs.edit().clear().apply() }
    }

    /** Runs [then] once what was stored is loaded (at once when it is). */
    fun whenReady(then: () -> Unit) { if (ready) then() else onReady = then }

    fun items(): List<Pending> = model.items()
    fun next(): Pending? = model.next()
    fun sentAs(id: String): String? = model.sentAs(id)

    /** Stores [p] (its attachments first), then shows it: [done] says whether it is kept. */
    fun add(p: Pending, done: (Boolean) -> Unit) {
        UiIo.disk {
            val atts = p.attachments()
            val ok = (atts == null || atts.length() == 0 || UiIo.writeAtomically(attFile(p.clientId), atts.toString())) &&
                UiIo.writeAtomically(metaFile(p.clientId), p.meta().toString())
            if (!ok) forgetFiles(p.clientId)
            UiIo.ui { if (ok) model.put(p); done(ok) }
        }
    }

    fun mark(clientId: String, status: String) { model.mark(clientId, status)?.let(::store) }

    fun taken(clientId: String, ledgerId: String?) {
        val p = model.taken(clientId, ledgerId)
        if (p != null) store(p) else UiIo.disk { forgetFiles(clientId) }
    }

    fun remove(clientId: String) { if (model.remove(clientId)) UiIo.disk { forgetFiles(clientId) } }

    fun drop(clientIds: Set<String>, ids: Set<String>) {
        val gone = model.drop(clientIds, ids)
        if (gone.isNotEmpty()) UiIo.disk { gone.forEach { forgetFiles(it.clientId) } }
    }

    private fun store(p: Pending) { val meta = p.meta().toString(); UiIo.disk { UiIo.writeAtomically(metaFile(p.clientId), meta) } }

    private fun metaFile(id: String) = File(dir, "$id.json")
    private fun attFile(id: String) = File(dir, "$id.att")
    private fun forgetFiles(id: String) { metaFile(id).delete(); attFile(id).delete() }

    /** Disk thread: every stored message, oldest first; leftovers of an interrupted write are removed. */
    private fun load(): List<Pending> {
        val files = dir.listFiles() ?: return emptyList()
        val out = ArrayList<Pending>()
        val kept = HashSet<String>()
        for (f in files) {
            if (!f.name.endsWith(".json")) continue
            val meta = runCatching { JSONObject(f.readText()) }.getOrNull() ?: continue
            val id = meta.optString("client_id")
            val att = attFile(id).takeIf { it.isFile }?.let { runCatching { JSONArray(it.readText()) }.getOrNull() }
            Pending.fromStored(meta, att)?.let { out.add(it); kept.add(id) }
        }
        for (f in files) if (f.name.substringBeforeLast('.') !in kept) f.delete()
        return out.sortedBy { it.at }
    }
}
