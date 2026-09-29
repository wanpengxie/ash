package ai.ash.host.system

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Runs [block] on the main thread and waits for it (bounded); rethrows its exception. */
fun <T> onMain(timeoutMs: Long = 5000, block: () -> T): T {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    val done = CountDownLatch(1)
    var value: Result<T>? = null
    Handler(Looper.getMainLooper()).post {
        value = try { Result.success(block()) } catch (e: Throwable) { Result.failure(e) }
        done.countDown()
    }
    if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw IllegalStateException("the main thread did not answer in ${timeoutMs}ms")
    return value!!.getOrThrow()
}

/** Clipboard access (on the main thread, where ClipboardManager lives). */
object Clip {
    /** Clipboard text, or null when empty or not readable (Android 10+ hides it from background apps). */
    fun get(ctx: Context): String? = onMain {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = cm.primaryClip
        if (clip == null || clip.itemCount == 0) null else clip.getItemAt(0).coerceToText(ctx)?.toString()
    }

    fun set(ctx: Context, text: String, label: String = "ash") = onMain {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
    }
}
