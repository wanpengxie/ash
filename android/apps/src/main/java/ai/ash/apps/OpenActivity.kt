package ai.ash.apps

import android.app.Activity
import android.os.Bundle
import android.widget.Toast

/** ash-app://open?app=<id> (a link or a home-screen icon): opens that app's own task, or says the link is wrong. */
class OpenActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val id = AppIds.fromLink(intent?.dataString)
        if (id == null) Toast.makeText(this, "这个应用链接无效", Toast.LENGTH_LONG).show()
        else runCatching { startActivity(Ui.appIntent(this, id)) }
        finish()
    }
}
