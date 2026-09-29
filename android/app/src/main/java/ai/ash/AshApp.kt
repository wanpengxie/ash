package ai.ash

import android.app.Application
import ai.ash.host.Notifications

class AshApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifications.createChannels(this)
    }
}
