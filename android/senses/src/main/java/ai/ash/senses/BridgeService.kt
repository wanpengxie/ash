package ai.ash.senses

import ai.ash.bridge.Bridge
import ai.ash.bridge.ISensesBridge
import ai.ash.bridge.ISensesHost
import ai.ash.host.cap.CapResult
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** Where Ash connects. Every call is refused unless the caller is signed like this app. */
class BridgeService : Service() {
    override fun onCreate() { super.onCreate(); Senses.init(this) }
    override fun onBind(intent: Intent): IBinder = binder

    private val binder = object : ISensesBridge.Stub() {
        private fun check() { if (!Bridge.sameSigner(this@BridgeService, Binder.getCallingUid())) throw SecurityException("only Ash may use the senses helper") }
        override fun protocol(): Int { check(); return Bridge.PROTOCOL }
        override fun status(): String { check(); return AshLink.status(this@BridgeService).toString() }
        override fun manifest(): String {
            check()
            val caps = JSONArray()
            for (c in SenseCapabilities.list)
                caps.put(JSONObject().put("name", c.name).put("description", c.description).put("input_schema", c.schema).apply { if (c.confirm) put("confirm", true) })
            return caps.toString()
        }
        override fun call(capability: String, args: String): ParcelFileDescriptor {
            check()
            return Bridge.pipe(run(this@BridgeService, capability, runCatching { JSONObject(args) }.getOrDefault(JSONObject())).toJson().toString())
        }
        override fun attach(host: ISensesHost) { check(); AshLink.attach(host) }
        override fun ack(batchId: String) { check(); AshLink.ack(batchId) }
        override fun pull() { check(); AshLink.flush(resendAll = true) }
    }

    companion object {
        fun run(ctx: Context, name: String, args: JSONObject): CapResult {
            val c = SenseCapabilities.list.firstOrNull { it.name == name } ?: return CapResult.fail("the senses helper has no capability $name")
            return try { c.run(ctx, args) }
            catch (e: SenseError) { e.result() }
            catch (e: Throwable) {
                Log.w("ash.senses", "$name failed", e)
                CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
            }
        }
    }
}

/**
 * The one Ash attached: batches of newly recorded rows go to it, each kept until Ash acknowledges it. A batch Ash
 * did not acknowledge is offered again later (Ash's core may have been down), so nothing recorded is lost to a
 * restart on either side. At most a few batches are in flight at once.
 */
object AshLink {
    @Volatile private var host: ISensesHost? = null
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-ash-link") }
    const val IN_FLIGHT = 4
    const val RESEND_MS = 5 * 60_000L

    fun attached() = host != null

    fun attach(next: ISensesHost) {
        host = next
        runCatching { next.asBinder().linkToDeath({ if (host === next) host = null }, 0) }
        changed()
        flush(resendAll = true)
    }

    fun ack(id: String) { executor.execute { runCatching { Senses.store.ack(id) }; send(resendAll = false) } }

    /** New rows (or Ash asking): batch them and offer what is due. */
    fun flush(resendAll: Boolean = false) { runCatching { executor.execute { send(resendAll) } } }

    private const val WAKE_GAP_MS = 60_000L
    @Volatile private var lastWake = 0L

    /** Ash is not attached (the system cleared it) and facts are waiting: ask Ash to come back, at most once a minute. */
    private fun wakeAsh() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (lastWake != 0L && now - lastWake < WAKE_GAP_MS) return
        if (runCatching { Senses.store.pendingBatches() }.getOrDefault(0L) == 0L) return
        lastWake = now
        runCatching {
            Senses.ctx().sendBroadcast(Intent().setClassName(ASH_PACKAGE, "ai.ash.host.senses.SensesWakeReceiver"))
        }.onFailure { Log.w("ash.senses", "could not wake Ash: ${it.javaClass.simpleName}") }
    }
    private const val ASH_PACKAGE = "ai.ash.agent"

    private fun send(resendAll: Boolean) {
        val h = host ?: return wakeAsh()
        try {
            val store = Senses.store
            val now = System.currentTimeMillis()
            store.collect(now)
            val batches = store.outbox()
            val inFlight = if (resendAll) 0 else batches.count { it.sentAt > 0 && now - it.sentAt < RESEND_MS }
            var budget = IN_FLIGHT - inFlight
            for (b in batches) {
                if (budget <= 0) break
                if (!resendAll && b.sentAt > 0 && now - b.sentAt < RESEND_MS) continue
                h.senseBatch(Batches.envelope(b.id, b.word, b.body).toString())
                store.markSent(b.id, now)
                budget--
            }
        } catch (e: Exception) {
            Log.w("ash.senses", "batches not delivered: ${e.javaClass.simpleName}")
            if (e is android.os.DeadObjectException && host === h) host = null
        }
    }

    fun status(ctx: Context): JSONObject {
        val config = Senses.config(ctx)
        return JSONObject().put("version", BuildConfig.VERSION_CODE).put("recording", config.recording).put("recorder_running", Recorder.running())
            .put("config", config.toJson()).put("permissions", Senses.permissions(ctx)).put("location_on", Senses.locationOn(ctx))
            .put("step_counter", StepReader.available(ctx)).put("pending_batches", runCatching { Senses.store.pendingBatches() }.getOrDefault(0L))
            .put("location", runCatching { LocationReader.status(ctx) }.getOrElse { JSONObject().put("error", it.toString()) })
            .apply { Recorder.lastProblem?.let { put("problem", it) } }
    }

    /** Tell Ash: recording started or stopped, settings changed. */
    fun changed() {
        val h = host ?: return
        val ctx = runCatching { Senses.ctx() }.getOrNull() ?: return
        runCatching { h.changed(status(ctx).toString()) }
    }
}
