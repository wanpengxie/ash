package ai.ash.kernel

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Without the debug identity: the system installer. Each package is a [PackageInstaller] session; the system asks the owner
 * to confirm it, and that question is put in a notification the owner taps (a service may not open the system's screen by
 * itself). The first time, Android also asks the owner to let the kernel install apps. Same signature only: Android checks it.
 */
class SessionInstaller(private val ctx: Context, private val log: (String) -> Unit = {}) : PackageSetInstaller {
    override val via = "installer"

    override fun install(files: List<Pair<String, File>>, report: (state: String, message: String) -> Unit) {
        for ((pkg, file) in files) {
            report("installing", pkg)
            val installer = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(pkg) }
            val id = installer.createSession(params)
            val done = CountDownLatch(1)
            var failure: String? = null
            val action = "$ACTION.$id"
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(c: Context, intent: Intent) {
                    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                        PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                            @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                            report("waiting_user", pkg)
                            ask(id, pkg, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        }
                        PackageInstaller.STATUS_SUCCESS -> { clear(id); done.countDown() }
                        else -> {
                            clear(id)
                            failure = "${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "status $status"}"
                            done.countDown()
                        }
                    }
                }
            }
            ctx.registerReceiver(receiver, IntentFilter(action))
            try {
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out, 64 * 1024) }
                        session.fsync(out)
                    }
                    val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                    val status = PendingIntent.getBroadcast(ctx, id, Intent(action).setPackage(ctx.packageName), PendingIntent.FLAG_UPDATE_CURRENT or mutable)
                    log("installer session $id for $pkg")
                    // Installing this very package (the kernel, last) ends this process once it is done.
                    session.commit(status.intentSender)
                }
                if (!done.await(OWNER_WAIT_MIN, TimeUnit.MINUTES)) throw IOException("$pkg was not confirmed within $OWNER_WAIT_MIN minutes")
                failure?.let { throw IOException("installing $pkg failed: $it") }
            } finally {
                runCatching { ctx.unregisterReceiver(receiver) }
            }
        }
    }

    /** The system's confirmation, one tap away. */
    private fun ask(id: Int, pkg: String, confirm: Intent) {
        val tap = PendingIntent.getActivity(ctx, id, confirm, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val what = if (pkg == "ai.ash.kernel") "Ash 内核" else "Ash"
        val n = Notifications.builder(ctx, Notifications.CH_URGENT)
            .setContentTitle("安装 $what 的新版本")
            .setContentText("点一下，在系统的安装确认里点「安装」。")
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(NOTIFY_BASE + id % 1000, n)
    }

    private fun clear(id: Int) = runCatching { ctx.getSystemService(NotificationManager::class.java).cancel(NOTIFY_BASE + id % 1000) }

    companion object {
        private const val ACTION = "ai.ash.kernel.UPDATE_STATUS"
        private const val NOTIFY_BASE = 7000
        private const val OWNER_WAIT_MIN = 30L
    }
}
