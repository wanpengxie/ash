package ai.ash.bridge

import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import java.io.InputStreamReader

/** The two ends of the bridge between Ash and its screen helper. */
object Bridge {
    /** Raised when either side changes what a call means; both refuse a peer that speaks another. */
    const val PROTOCOL = 1
    const val SCREEN_PACKAGE = "ai.ash.screen"
    const val SCREEN_SERVICE = "ai.ash.screen.BridgeService"

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
