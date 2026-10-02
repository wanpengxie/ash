package ai.ash.host

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/** One notification presentation and its durable owner actions. Stored in app-private preferences. */
object Present {
    private const val TAG = "ash.present"
    private const val PREFS = "ash.present.v2"
    private const val ITEM = "item:"
    private const val ACTION = "action:"
    private const val CONSUMED = "consumed:"
    private const val RETIRED = "retired:"
    private const val AT = "at:"
    private val kinds = setOf("reply", "approval", "due", "offer", "heads_up")
    private val choices = setOf("once", "always", "deny")
    private val serial = PresentSerialGate()
    @Volatile private var flushing = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun item(ctx: Context, id: String): JSONObject? = prefs(ctx).getString(ITEM + id, null)?.let(::JSONObject)
    private fun expired(record: JSONObject) = record.has("expires_at") && record.optLong("expires_at") <= System.currentTimeMillis()
    private fun positiveSafeInteger(value: Any?): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (!number.isFinite() || number < 1 || number > 9_007_199_254_740_991.0 || number % 1.0 != 0.0) return null
        return number.toLong()
    }

    /** `to` identifies the original ask sender; required to route an approval answer correctly. */
    fun show(ctx: Context, input: JSONObject): Pair<Int, JSONObject> {
        val id = (input.opt("id") as? String)?.trim() ?: ""
        val kind = input.opt("kind") as? String ?: ""
        if (id.isEmpty() || id.length > 128 || kind !in kinds) return 400 to JSONObject().put("error", "invalid_presentation")
        val allowed = setOf("id", "kind", "title", "text", "options", "expires_at", "reply_to", "reply_target")
        if (input.keys().asSequence().any { it !in allowed }) return 400 to JSONObject().put("error", "unsupported_field")
        if (!input.has("title") || !input.has("text") || input.opt("title") !is String || input.opt("text") !is String)
            return 400 to JSONObject().put("error", "invalid_text")
        val record = JSONObject(input.toString())
        record.put("id", id).put("kind", kind)
        if (kind == "approval") {
            val opts = record.optJSONArray("options") ?: return 400 to JSONObject().put("error", "approval_options_required")
            if (opts.length() == 0) return 400 to JSONObject().put("error", "approval_options_required")
            val ids = mutableSetOf<String>()
            for (i in 0 until opts.length()) {
                val option = opts.optJSONObject(i) ?: return 400 to JSONObject().put("error", "invalid_option")
                val choice = option.opt("id") as? String ?: return 400 to JSONObject().put("error", "invalid_option")
                val label = option.opt("label") as? String ?: return 400 to JSONObject().put("error", "invalid_option")
                if (option.length() != 2 || choice !in choices || !ids.add(choice) || label.isBlank()) return 400 to JSONObject().put("error", "invalid_option")
            }
            if (!PresentRoutes.notificationOptionsValid(ids.toList())) return 400 to JSONObject().put("error", "deny_option_required")
            if ((record.opt("reply_to") as? String).isNullOrBlank() || !record.has("expires_at")) return 400 to JSONObject().put("error", "reply_route_required")
            // The target comes from the delivery service, never from a notification intent.
            if (!PresentRoutes.member.matches(record.opt("reply_target") as? String ?: "")) return 400 to JSONObject().put("error", "ask_sender_required")
        } else if (record.has("options") || record.has("reply_target")) return 400 to JSONObject().put("error", "unexpected_reply_route")
        if (record.has("reply_to") && (record.opt("reply_to") as? String).isNullOrBlank()) return 400 to JSONObject().put("error", "invalid_reply_to")
        if (record.has("expires_at") && positiveSafeInteger(record.opt("expires_at")) == null) return 400 to JSONObject().put("error", "invalid_expiry")
        return serial.run {
            val prior = item(ctx, id)
            var duplicate = false
            when (PresentLifecycle.admission(prior?.toString(), record.toString(), prefs(ctx).getBoolean(RETIRED + id, false))) {
                PresentAdmission.RETIRED -> return 409 to JSONObject().put("error", "presentation_id_retired")
                PresentAdmission.CONFLICT -> return 409 to JSONObject().put("error", "presentation_id_reused")
                PresentAdmission.DUPLICATE -> duplicate = true
                PresentAdmission.NEW -> {
                    if (prefs(ctx).getBoolean(CONSUMED + id, false))
                        return 409 to JSONObject().put("error", "presentation_id_consumed")
                }
            }
            if (!duplicate && !prefs(ctx).edit().putString(ITEM + id, record.toString()).putLong(AT + id, System.currentTimeMillis()).commit())
                return 500 to JSONObject().put("error", "store_failed")
            if (expired(record)) {
                if (!retireLocked(ctx, id)) return 500 to JSONObject().put("error", "store_failed")
                return 200 to JSONObject().put("ok", true).put("expired", true)
            }
            if (PresentChat.isChat(kind)) refreshChatLocked(ctx)
            else if (PresentLifecycle.restore(prefs(ctx).getBoolean(RETIRED + id, false), prefs(ctx).getBoolean(CONSUMED + id, false)))
                Notifications.present(ctx, record)
            if (record.has("expires_at")) scheduleExpiry(ctx, id, record.optLong("expires_at"))
            200 to JSONObject().put("ok", true).apply { if (duplicate) put("duplicate", true) }
        }
    }

    /** Caller holds serial so a later render cannot overtake the cancellation. */
    private fun retireLocked(ctx: Context, id: String): Boolean {
        val chat = item(ctx, id)?.optString("kind")?.let(PresentChat::isChat) == true
        val stored = prefs(ctx).edit().remove(ITEM + id).remove(AT + id).putBoolean(RETIRED + id, true).commit()
        if (!stored) return false
        Notifications.hidePresent(ctx, id)
        cancelExpiry(ctx, id)
        if (chat) refreshChatLocked(ctx)
        return true
    }

    fun hide(ctx: Context, id: String): Boolean = serial.run { retireLocked(ctx, id) }

    /** Swiping the conversation away, or opening the app, clears every chat message at once. */
    fun dismiss(ctx: Context, id: String) {
        if (item(ctx, id)?.optString("kind")?.let(PresentChat::isChat) == true) clearChat(ctx) else hide(ctx, id)
    }

    fun clearChat(ctx: Context) = serial.run { clearChatLocked(ctx) }

    private fun chatIds(ctx: Context): List<String> = prefs(ctx).all.keys.filter { it.startsWith(ITEM) }.map { it.removePrefix(ITEM) }
        .filter { id -> item(ctx, id)?.optString("kind")?.let(PresentChat::isChat) == true }

    private fun clearChatLocked(ctx: Context) {
        val edit = prefs(ctx).edit()
        for (id in chatIds(ctx)) edit.remove(ITEM + id).remove(AT + id).putBoolean(RETIRED + id, true)
        edit.commit()
        Notifications.presentChat(ctx, emptyList())
    }

    /** Caller holds serial. Renders the newest chat messages as one notification and retires older ones. */
    private fun refreshChatLocked(ctx: Context) {
        val live = chatIds(ctx).mapNotNull { id ->
            val record = try { item(ctx, id) } catch (_: Exception) { null } ?: return@mapNotNull null
            if (expired(record) || !PresentLifecycle.restore(prefs(ctx).getBoolean(RETIRED + id, false), prefs(ctx).getBoolean(CONSUMED + id, false))) null
            else Triple(id, record, prefs(ctx).getLong(AT + id, 0))
        }
        val (keep, drop) = PresentChat.split(live.map { it.first to it.third })
        if (drop.isNotEmpty()) {
            val edit = prefs(ctx).edit()
            for (id in drop) edit.remove(ITEM + id).remove(AT + id).putBoolean(RETIRED + id, true)
            edit.commit()
        }
        val byId = live.associateBy { it.first }
        Notifications.presentChat(ctx, keep.map { byId.getValue(it).second to byId.getValue(it).third })
    }

    fun restore(ctx: Context) {
        for (key in prefs(ctx).all.keys) {
            if (!key.startsWith(ITEM)) continue
            val id = key.removePrefix(ITEM)
            serial.run {
                val record = try { item(ctx, id) } catch (_: Exception) { null } ?: return@run
                // Earlier builds gave every chat message its own notification.
                if (PresentChat.isChat(record.optString("kind"))) Notifications.hidePresent(ctx, id)
                else if (expired(record)) retireLocked(ctx, id)
                else if (!PresentLifecycle.restore(prefs(ctx).getBoolean(RETIRED + id, false), prefs(ctx).getBoolean(CONSUMED + id, false)))
                    Notifications.hidePresent(ctx, id)
                else {
                    Notifications.present(ctx, record)
                    if (record.has("expires_at")) scheduleExpiry(ctx, id, record.optLong("expires_at"))
                }
            }
        }
        serial.run { refreshChatLocked(ctx) }
        flushAsync(ctx)
    }

    /** Persist before network I/O. The same client_id is reused on every offline retry. */
    fun act(ctx: Context, id: String, choice: String?, replyText: String?) {
        serial.run {
            val record = item(ctx, id) ?: return
            if (expired(record) || prefs(ctx).getBoolean(CONSUMED + id, false)) return
            val route = try { when (record.optString("kind")) {
                "approval" -> {
                    if (choice == null || !offered(record, choice)) return
                    PresentRoutes.approval(record.getString("reply_to"), record.getString("reply_target"),
                        offeredSet(record), choice, record.getLong("expires_at"), System.currentTimeMillis())
                }
                "reply", "offer", "heads_up" -> {
                    PresentRoutes.reply(replyText ?: return)
                }
                else -> return
            } } catch (_: IllegalArgumentException) { return }
            val outbound = JSONObject().put("to", route.to).put("kind", route.kind).put("word", route.word)
                .put("body", if (route.choice != null) JSONObject().put("ok", true).put("result", JSONObject().put("choice", route.choice))
                    else JSONObject().put("text", route.text))
            if (route.replyTo != null) outbound.put("reply_to", route.replyTo)
            val actionId = UUID.randomUUID().toString()
            outbound.put("client_id", actionId)
            val entry = JSONObject().put("id", actionId).put("presentation", id).put("payload", outbound).put("state", "queued")
            if (!prefs(ctx).edit().putString(ACTION + actionId, entry.toString()).putBoolean(CONSUMED + id, true).commit()) return
        }
        // Answering the conversation reads it, as opening the app would.
        if (PresentChat.isChat(item(ctx, id)?.optString("kind") ?: "")) clearChat(ctx) else Notifications.hidePresent(ctx, id)
        cancelExpiry(ctx, id)
        CoreService.start(ctx)
        flushAsync(ctx)
    }

    private fun offered(record: JSONObject, choice: String): Boolean {
        val options = record.optJSONArray("options") ?: return false
        return (0 until options.length()).any { options.optJSONObject(it)?.optString("id") == choice }
    }

    private fun offeredSet(record: JSONObject): Set<String> {
        val options = record.optJSONArray("options") ?: return emptySet()
        return (0 until options.length()).mapNotNull { options.optJSONObject(it)?.optString("id") }.toSet()
    }

    fun flushAsync(ctx: Context) {
        if (flushing) return
        serial.run { if (flushing) return; flushing = true }
        Thread({
            try { flush(ctx.applicationContext) }
            finally { flushing = false }
        }, "ash-present-outbox").start()
    }

    private fun flush(ctx: Context) {
        val store = object : PresentActionStore {
            override fun queued(): List<QueuedPresentAction> = prefs(ctx).all.filterKeys { it.startsWith(ACTION) }.values
                .filterIsInstance<String>().mapNotNull { raw ->
                    val entry = try { JSONObject(raw) } catch (_: Exception) { return@mapNotNull null }
                    if (entry.optString("state") != "queued") null else QueuedPresentAction(entry.optString("id"),
                        entry.optString("presentation"), entry.optJSONObject("payload")?.toString() ?: return@mapNotNull null)
                }
            override fun remove(id: String) { serial.run { prefs(ctx).edit().remove(ACTION + id).commit() } }
            override fun reject(id: String, reason: String) {
                serial.run {
                    val entry = prefs(ctx).getString(ACTION + id, null)?.let(::JSONObject) ?: return
                    entry.put("state", "rejected").put("error", reason)
                    prefs(ctx).edit().putString(ACTION + id, entry.toString()).commit()
                }
            }
        }
        PresentOutbox(store, { raw ->
            try { CoreClient(ctx).sendPresentAction(JSONObject(raw)); PresentDelivery.Accepted }
            catch (e: CoreClient.HttpError) {
                if (e.status in 400..499) PresentDelivery.Rejected("core rejected action (${e.status})")
                else { Log.w(TAG, "core temporarily unavailable", e); PresentDelivery.Retry }
            } catch (e: Exception) { Log.w(TAG, "will retry action after core returns", e); PresentDelivery.Retry }
        }, { Notifications.presentFailure(ctx, it.presentation) }).flush()
    }

    private fun expiryIntent(ctx: Context, id: String): PendingIntent = PendingIntent.getBroadcast(
        ctx, 0, Intent(ctx, PresentExpiryReceiver::class.java).setData(Uri.Builder().scheme("ash").authority("present-expiry").appendPath(id).build())
            .putExtra("id", id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    private fun scheduleExpiry(ctx: Context, id: String, at: Long) {
        val alarm = ctx.getSystemService(AlarmManager::class.java)
        val intent = expiryIntent(ctx, id)
        try {
            if (Build.VERSION.SDK_INT >= 23) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            else alarm.setExact(AlarmManager.RTC_WAKEUP, at, intent)
        } catch (_: SecurityException) {
            if (Build.VERSION.SDK_INT >= 23) alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            else alarm.set(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    private fun cancelExpiry(ctx: Context, id: String) = ctx.getSystemService(AlarmManager::class.java).cancel(expiryIntent(ctx, id))
}

class PresentActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        // RemoteInput needs a mutable PendingIntent. Its fill-in extras are not authority.
        val uri = intent.data ?: return
        val action = PresentActionIdentity.fromUriParts(uri.scheme, uri.authority, uri.pathSegments) ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence("reply")?.toString()
        val pending = goAsync()
        Thread {
            try {
                if (action.choice == "dismiss") Present.dismiss(ctx.applicationContext, action.id)
                else Present.act(ctx.applicationContext, action.id, action.choice, text)
            } finally { pending.finish() }
        }.start()
    }
}

class PresentExpiryReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        Present.hide(ctx, id)
    }
}
