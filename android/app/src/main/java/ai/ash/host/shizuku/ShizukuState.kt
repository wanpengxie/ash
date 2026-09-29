package ai.ash.host.shizuku

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import moe.shizuku.server.IShizukuService
import rikka.shizuku.Shizuku
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Shizuku state for the app process (installed / binder alive / permission granted).
 *
 * Real-device lessons kept from the old app:
 *  - the binder arrives asynchronously (ShizukuProvider, usually a few seconds after a cold start):
 *    "binder not there yet" is not "not granted", so callers that are about to use it wait a little;
 *  - Shizuku callbacks arrive on binder threads unless given a Handler: ours go to a dedicated
 *    HandlerThread and only signal latches (never do I/O or network in them);
 *  - some ROMs (ColorOS…) swallow the permission dialog: when the request times out we say how to
 *    grant it by hand in the Shizuku app.
 */
object ShizukuState {
    private const val TAG = "ash.shizuku"
    const val MANAGER_PACKAGE = "moe.shizuku.privileged.api"
    private const val REQUEST_CODE = 0x5a5c

    private val callbackThread: Handler by lazy {
        val t = HandlerThread("ash-shizuku-cb").apply { start() }
        Handler(t.looper)
    }

    fun installed(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(MANAGER_PACKAGE, 0); true
    } catch (e: Throwable) { false }

    /** The Shizuku server is running and its binder has reached this process. */
    fun running(): Boolean = try { Shizuku.pingBinder() } catch (e: Throwable) { false }

    /** Running, v11+ and this app is authorized: newProcess can be used. Cheap (cached by the library). */
    fun ready(): Boolean = try {
        Shizuku.pingBinder() && !Shizuku.isPreV11() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) { false }

    /** Waits (bounded) for the binder to arrive, for calls made right after the app started. */
    fun awaitBinder(timeoutMs: Long): Boolean {
        if (running()) return true
        val latch = CountDownLatch(1)
        val l = Shizuku.OnBinderReceivedListener { latch.countDown() }
        try {
            Shizuku.addBinderReceivedListenerSticky(l, callbackThread)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Throwable) {
        } finally {
            try { Shizuku.removeBinderReceivedListener(l) } catch (e: Throwable) {}
        }
        return running()
    }

    /** Waits for the binder when Shizuku is installed, then reports readiness. */
    fun awaitReady(ctx: Context, timeoutMs: Long = 4000): Boolean {
        if (ready()) return true
        if (!installed(ctx)) return false
        awaitBinder(timeoutMs)
        return ready()
    }

    fun serverUid(): Int = try { Shizuku.getUid() } catch (e: Throwable) { -1 }
    fun serverVersion(): Int = try { Shizuku.getVersion() } catch (e: Throwable) { -1 }

    fun service(): IShizukuService {
        val b = Shizuku.getBinder() ?: throw IllegalStateException("Shizuku is not running (no binder)")
        return IShizukuService.Stub.asInterface(b) ?: throw IllegalStateException("Shizuku binder is not usable")
    }

    /**
     * Asks Shizuku to show its permission dialog and waits for the answer.
     * @return true granted, false denied, null no answer within the timeout (dialog blocked or ignored)
     */
    fun requestPermission(timeoutMs: Long): Boolean? {
        if (ready()) return true
        if (!running()) return false
        val latch = CountDownLatch(1)
        var result: Boolean? = null
        val l = Shizuku.OnRequestPermissionResultListener { code, grant ->
            if (code == REQUEST_CODE) { result = grant == PackageManager.PERMISSION_GRANTED; latch.countDown() }
        }
        try {
            Shizuku.addRequestPermissionResultListener(l, callbackThread)
            Shizuku.requestPermission(REQUEST_CODE)
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: Throwable) {
            Log.w(TAG, "requestPermission failed", e)
        } finally {
            try { Shizuku.removeRequestPermissionResultListener(l) } catch (e: Throwable) {}
        }
        return if (ready()) true else result
    }

    /** One-line reason Shizuku cannot be used right now (for error messages), or null when ready. */
    fun whyNot(ctx: Context): String? = when {
        ready() -> null
        !installed(ctx) -> "Shizuku is not installed"
        !running() -> "the Shizuku service is not running (open the Shizuku app and start it)"
        isPreV11() -> "the Shizuku version is too old (v11+ needed)"
        else -> "ash is not authorized in Shizuku (call shell.status with request_permission=true, or allow ash in the Shizuku app)"
    }

    private fun isPreV11(): Boolean = try { Shizuku.isPreV11() } catch (e: Throwable) { false }
}
