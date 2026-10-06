package ai.ash.senses.health

import ai.ash.senses.AshLink
import ai.ash.senses.HealthRow
import ai.ash.senses.SenseError
import ai.ash.senses.Senses
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.ParcelUuid
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The owner's Xiaomi scale, heard over Bluetooth without pairing: a background scan the system runs for this app
 * (delivered to [ScaleReceiver], even when the app is not running) picks up each weigh-in, which is stored once and
 * pushed to Ash. The scale's beacon key is a secret: it is kept encrypted under a key in the Android Keystore, never
 * logged, never returned by any capability.
 */
object XiaomiScaleSource {
    private const val TAG = "ash.senses"
    private const val PREFS = "scale"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "ash.senses.scale"
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-scale") }

    /** The scale as the owner set it up. [key] is the beacon key: never put it in any output. */
    class Scale(val mac: String, val model: String, val key: ByteArray)

    @Volatile private var cached: Scale? = null
    /** Weigh-ins already stored by this process (the frame repeats many times). */
    private val seen = LinkedHashSet<String>()
    /** Whether this process has armed the scan (or was started by its results). */
    @Volatile private var armedHere = false

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun configured(ctx: Context): Boolean = prefs(ctx).getString("mac", null) != null
    fun mac(ctx: Context): String? = prefs(ctx).getString("mac", null)
    /** Why the scale is not being heard, when known (in Chinese, for the owner). */
    fun problem(ctx: Context): String? = prefs(ctx).getString("problem", null)

    fun scale(ctx: Context): Scale? {
        cached?.let { return it }
        val p = prefs(ctx)
        val mac = p.getString("mac", null) ?: return null
        val key = runCatching { unseal(p.getString("key_iv", null)!!, p.getString("key", null)!!) }
            .onFailure { Log.w(TAG, "the scale's key could not be read: ${it.javaClass.simpleName}") }.getOrNull() ?: return null
        return Scale(mac, p.getString("model", XiaomiScale.MODEL)!!, key).also { cached = it }
    }

    /** Saves the scale (the key sealed by the Keystore) and starts listening. Returns why not listening, if so. */
    fun save(ctx: Context, mac: String, key: ByteArray): String? {
        val (iv, sealed) = seal(key)
        prefs(ctx).edit().putString("mac", mac).putString("model", XiaomiScale.MODEL).putString("key_iv", iv).putString("key", sealed)
            .remove("problem").commit()
        cached = null
        synchronized(seen) { seen.clear() }
        return arm(ctx)
    }

    /** Stops listening and forgets the scale and its key (its stored readings stay, like any other health reading). */
    fun remove(ctx: Context) {
        disarm(ctx)
        prefs(ctx).edit().clear().commit()
        runCatching { KeyStore.getInstance(KEYSTORE).apply { load(null) }.deleteEntry(ALIAS) }
        cached = null
    }

    // ---- the key, sealed ----

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return gen.generateKey()
    }

    private fun seal(plain: ByteArray): Pair<String, String> {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, keystoreKey()) }
        return Base64.encodeToString(c.iv, Base64.NO_WRAP) to Base64.encodeToString(c.doFinal(plain), Base64.NO_WRAP)
    }

    private fun unseal(iv: String, sealed: String): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        return c.doFinal(Base64.decode(sealed, Base64.NO_WRAP))
    }

    // ---- the background scan ----

    private fun scanner(ctx: Context): BluetoothLeScanner? {
        val adapter: BluetoothAdapter = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return null
        return if (adapter.isEnabled) adapter.bluetoothLeScanner else null
    }

    private fun scanIntent(ctx: Context): PendingIntent {
        // The system fills the results into this intent, so it must be mutable (it names this app's own receiver).
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(ctx, 7, Intent(ctx, ScaleReceiver::class.java).setAction(ScaleReceiver.ACTION), flags)
    }

    /**
     * (Re)starts the system's scan for the scale: low power, matching only its address and Xiaomi's service data. The
     * system keeps it running while this app is not, until Bluetooth goes off or the phone restarts. Returns the
     * problem, if any (also kept for the setup page and health.sources).
     */
    @Synchronized fun arm(ctx: Context): String? {
        val mac = mac(ctx) ?: return null
        armedHere = true
        val problem = try {
            when {
                !Senses.bluetooth(ctx) -> "蓝牙（附近的设备）未授权"
                else -> when (val s = scanner(ctx)) {
                    null -> "蓝牙未打开"
                    else -> {
                        val pi = scanIntent(ctx)
                        runCatching { s.stopScan(pi) }
                        val filter = ScanFilter.Builder().setDeviceAddress(mac)
                            .setServiceData(ParcelUuid.fromString(XiaomiScale.SERVICE_UUID), ByteArray(0)).build()
                        val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                            .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES).build()
                        val code = s.startScan(listOf(filter), settings, pi)
                        if (code == 0) null else "蓝牙扫描没能开始（错误 $code）"
                    }
                }
            }
        } catch (e: SecurityException) { "蓝牙扫描被系统拒绝（${e.javaClass.simpleName}）" }
        catch (e: Exception) { Log.w(TAG, "scale scan", e); "蓝牙扫描没能开始（${e.javaClass.simpleName}）" }
        prefs(ctx).edit().apply { if (problem == null) remove("problem") else putString("problem", problem) }.apply()
        if (problem != null) Log.i(TAG, "scale scan not armed: $problem")
        return problem
    }

    /** Arms the scan once per process: the system may have dropped it (Bluetooth toggled, the app updated). */
    fun rearm(ctx: Context) {
        if (armedHere || !configured(ctx)) return
        executor.execute { if (!armedHere) runCatching { arm(ctx) } }
    }

    fun disarm(ctx: Context) {
        runCatching { scanner(ctx)?.stopScan(scanIntent(ctx)) }
        scanIntent(ctx).cancel()
        armedHere = false
    }

    /** Scan results from the system: each new weigh-in stored, and on to Ash. */
    internal fun received(ctx: Context, intent: Intent, done: () -> Unit) {
        // The scan is evidently running: starting this process must not restart it.
        armedHere = true
        Senses.init(ctx)
        executor.execute {
            try { handle(ctx, intent) } catch (e: Exception) { Log.w(TAG, "scale results: ${e.javaClass.simpleName}") } finally { done() }
        }
    }

    private fun handle(ctx: Context, intent: Intent) {
        val error = intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, 0)
        if (error != 0) { prefs(ctx).edit().putString("problem", "蓝牙扫描出错（错误 $error）").apply(); return }
        val scale = scale(ctx) ?: return
        @Suppress("DEPRECATION")
        val results: List<ScanResult> = intent.getParcelableArrayListExtra(BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT) ?: return
        val uuid = ParcelUuid.fromString(XiaomiScale.SERVICE_UUID)
        val now = System.currentTimeMillis()
        val rows = mutableListOf<HealthRow>()
        for (r in results) {
            if (!r.device.address.equals(scale.mac, ignoreCase = true)) continue
            val data = r.scanRecord?.getServiceData(uuid) ?: continue
            val reading = XiaomiScale.parse(data, scale.mac, scale.key) ?: continue
            val fresh = synchronized(seen) { seen.add(reading.key).also { if (seen.size > 64) seen.remove(seen.first()) } }
            if (!fresh) continue
            rows += row(reading, now)
        }
        if (rows.isEmpty()) return
        val added = Senses.store.addHealth(rows)
        prefs(ctx).edit().remove("problem").apply()
        if (added > 0) { Log.i(TAG, "scale: $added weigh-in(s)"); AshLink.flush() }
    }

    /**
     * The stored form of a weigh-in. The scale's own clock gives the moment; a clock that is clearly wrong (reset after
     * a battery change) gives way to when the phone heard it.
     */
    fun row(reading: ScaleReading, now: Long): HealthRow {
        val ts = if (reading.ts in EARLIEST..(now + 86_400_000L)) reading.ts else now
        return HealthRow(ts, "weight", Math.round(reading.weightKg * 100) / 100.0, XiaomiScale.SOURCE)
    }
    private const val EARLIEST = 1_577_836_800_000L // 2020-01-01

    // ---- health.sources and health.read ----

    fun status(ctx: Context): JSONObject {
        val p = prefs(ctx)
        val mac = p.getString("mac", null)
        val o = JSONObject().put("id", "xiaomi_scale").put("configured", mac != null)
        if (mac == null) return o
        o.put("model", p.getString("model", XiaomiScale.MODEL)).put("mac", mac).put("metrics", org.json.JSONArray().put("weight"))
            .put("bluetooth_permission", Senses.bluetooth(ctx))
        last(ctx)?.let { o.put("last_reading", JSONObject().put("ts", it.ts).put("value", it.value).put("unit", it.unit)) }
        problem(ctx)?.let { o.put("problem", it) }
        return o
    }

    /** The scale's stored weigh-ins in [range]. Throws [SenseError] when no scale is set up, or for other metrics. */
    fun read(ctx: Context, metrics: List<String>, range: LongRange, max: Int): List<HealthRow> {
        if (!configured(ctx)) throw SenseError("source_unavailable", "no Xiaomi scale is set up (the owner adds it on Ash 感知's setup page)")
        if ("weight" !in metrics) throw SenseError("source_unavailable", "the Xiaomi scale only measures weight")
        return Senses.store.health(range, "weight", XiaomiScale.SOURCE, max)
    }

    /** The newest stored weigh-in. */
    fun last(ctx: Context): HealthRow? = Senses.store.health(0L..Long.MAX_VALUE, "weight", XiaomiScale.SOURCE, 1, newestFirst = true).firstOrNull()
}

/** Where the system delivers the scale scan's results (the PendingIntent scan), whether or not the app was running. */
class ScaleReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val pending = goAsync()
        XiaomiScaleSource.received(ctx.applicationContext, intent) { pending.finish() }
    }

    companion object { const val ACTION = "ai.ash.senses.SCALE" }
}
