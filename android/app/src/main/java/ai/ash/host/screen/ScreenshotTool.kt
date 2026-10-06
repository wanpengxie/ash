package ai.ash.host.screen

import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.host.cap.prop
import ai.ash.host.cap.schema
import android.content.Context
import android.os.Environment
import android.util.Base64
import org.json.JSONObject
import java.io.File

/** screen.screenshot: the helper captures (screen.capture), Ash writes the file, with its own storage access. */
internal object ScreenshotTool : Capability {
    override val name = "screen.screenshot"
    override val description = "Save a full-resolution PNG screenshot of the phone's screen to a file and return its path (the image itself is " +
        "not shown to you — use screen.see to look at the screen). Default location: /sdcard/Ash/screenshots/screen-<time>.png " +
        "(app-private storage if shared storage isn't writable). Needs Android 11+."
    override val schema: JSONObject = schema(
        "path" to prop("string", "optional absolute file path to write (parent directories are created)"),
        "display" to prop("integer", "display id to capture (default 0 = the main screen)"),
    )
    override fun available(ctx: Context) = ScreenBridge.connected()

    override fun run(ctx: Context, args: JSONObject): CapResult {
        val captured = ScreenBridge.call("screen.capture", JSONObject().put("display", args.optInt("display", 0)))
        val data = captured.data as? JSONObject ?: return captured
        val png = Base64.decode(data.optString("png"), Base64.NO_WRAP)
        val p = args.optString("path").trim()
        val out = if (p.isNotEmpty()) File(p) else File(dir(ctx), "screen-${System.currentTimeMillis()}.png")
        out.parentFile?.mkdirs()
        out.writeBytes(png)
        val w = data.optInt("width"); val h = data.optInt("height")
        return CapResult.text("Screenshot saved: ${out.absolutePath} (${w}x$h px, ${out.length()} bytes)",
            JSONObject().put("path", out.absolutePath).put("width", w).put("height", h).put("bytes", out.length()))
    }

    /** Shared <sdcard>/Ash/screenshots/ (readable by anyone the file is handed to), else app-private files/screenshots/. */
    @Suppress("DEPRECATION")
    private fun dir(ctx: Context): File {
        runCatching {
            val d = File(File(Environment.getExternalStorageDirectory(), "Ash"), "screenshots")
            if ((d.exists() || d.mkdirs()) && d.canWrite()) return d
        }
        return File(ctx.filesDir, "screenshots").apply { mkdirs() }
    }
}
