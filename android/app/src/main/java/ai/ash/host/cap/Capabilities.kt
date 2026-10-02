package ai.ash.host.cap

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** The phone's capability registry: what `GET /manifest` lists and `POST /call` runs. */
object Capabilities {
    private const val TAG = "ash.cap"

    /** Every module contributes its list here (system, screen/accessibility, shell/Shizuku, virtual screen). */
    val all: List<Capability> by lazy {
        SystemCapabilities.list + ScreenCapabilities.list + ShellCapabilities.list + VScreenCapabilities.list + CalendarCapabilities.list + BrowserCapabilities.list
    }

    fun manifest(ctx: Context): JSONObject {
        val caps = JSONArray()
        for (c in all) {
            val ok = try { c.available(ctx) } catch (e: Throwable) { false }
            if (!ok) continue
            val policy = CapabilityPolicies.require(c.name)
            caps.put(JSONObject().put("name", c.name).put("description", c.description).put("input_schema", c.schema)
                .put("risk", policy.risk).put("label", policy.label).apply { if (c.confirm) put("confirm", true) })
        }
        return JSONObject().put("name", deviceName()).put("kind", "phone").put("capabilities", caps)
    }

    fun call(ctx: Context, name: String, args: JSONObject): CapResult {
        val c = all.firstOrNull { it.name == name } ?: return CapResult.fail("the phone has no capability $name")
        if (!c.available(ctx)) return CapResult.fail("$name is not available right now (a permission or service is off on the phone)")
        return try {
            c.run(ctx, args)
        } catch (e: Throwable) {
            Log.w(TAG, "$name failed", e)
            CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun deviceName(): String {
        val m = android.os.Build.MODEL ?: "Android"
        val b = android.os.Build.MANUFACTURER ?: ""
        return if (m.startsWith(b, ignoreCase = true)) "手机 · $m" else "手机 · $b $m"
    }
}
