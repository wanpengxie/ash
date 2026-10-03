package ai.ash

import android.app.Application
import ai.ash.host.Notifications

class AshApp : Application() {
    override fun onCreate() {
        // First, before any token is loaded: the agent container runs as this app's Linux user, and a dumpable
        // process's memory is readable to it through /proc. The library's constructor makes this process non-dumpable.
        runCatching { System.loadLibrary("ashnodump") }
        super.onCreate()
        Notifications.createChannels(this)
    }
}
