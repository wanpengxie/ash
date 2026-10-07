package ai.ash.bridge

import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import java.io.InputStreamReader

/** The two ends of the bridges between Ash and its helper apps (the screen helper, the senses helper, the apps shell). */
object Bridge {
    /** Raised when either side changes what a call means; both refuse a peer that speaks another. */
    const val PROTOCOL = 1
    const val SCREEN_PACKAGE = "ai.ash.screen"
    const val SCREEN_SERVICE = "ai.ash.screen.BridgeService"
    const val SENSES_PACKAGE = "ai.ash.senses"
    const val SENSES_SERVICE = "ai.ash.senses.BridgeService"
    const val SENSES_SETUP = "ai.ash.senses.SetupActivity"
    /** The apps shell: draws the owner's apps; reaches Ash's core only through [APPS_HOST_SERVICE]. */
    const val APPS_PACKAGE = "ai.ash.apps"
    const val APPS_LAUNCHER = "ai.ash.apps.MainActivity"
    const val ASH_PACKAGE = "ai.ash.agent"
    const val APPS_HOST_SERVICE = "ai.ash.host.apps.AppsHostService"
    /** Every tool the senses helper offers: Ash keeps a policy for each (a tool without one is never offered). */
    val SENSES_TOOLS = listOf(
        "location.get", "location.track", "location.history", "activity.current", "activity.history", "sensors.steps",
        "health.sources", "health.read", "health.summary", "health.sync", "sense.status", "sense.configure", "sense.delete",
    )

    /** The peer is signed with this app's own key: the only app either side talks to. */
    fun sameSigner(ctx: Context, uid: Int): Boolean =
        ctx.packageManager.checkSignatures(uid, android.os.Process.myUid()) == PackageManager.SIGNATURE_MATCH

    /** A pipe that hands [text] over in full, written on its own thread. */
    fun pipe(text: String): ParcelFileDescriptor {
        val (read, write) = ParcelFileDescriptor.createPipe()
        Thread({ ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(text.toByteArray(Charsets.UTF_8)) } }, "ash-bridge-pipe").start()
        return read
    }

    fun read(pipe: ParcelFileDescriptor): String =
        InputStreamReader(ParcelFileDescriptor.AutoCloseInputStream(pipe), Charsets.UTF_8).use { it.readText() }
}
