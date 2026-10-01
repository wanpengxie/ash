package ai.ash.host

import android.content.Context
import android.os.StatFs
import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * Installs the payload shipped in the APK (assets/payload.zip + payload-index.json, built by
 * payload/assemble.mjs) into files/payload.
 *
 * The zip carries no symlinks, modes or absolute paths; the index says what to restore:
 * symlinks (Os.symlink — SELinux refuses hard links in app storage, symlinks are fine),
 * executable bits, and the `@PAYLOAD@` placeholder in shebangs/wrappers, replaced by the real
 * install path. The installed build is recorded in payload/.build; a mismatch (app update)
 * triggers a fresh install into payload.new, then an atomic directory swap — a half-extracted
 * payload is never started.
 */
object PayloadInstaller {
    private const val TAG = "ash.payload"

    fun shippedBuild(ctx: Context): String? = try {
        ctx.assets.open("payload-index.json").use { JSONObject(it.readBytes().toString(Charsets.UTF_8)).getString("build") }
    } catch (e: Exception) {
        null
    }

    fun installedBuild(p: Paths): String? = if (p.buildMarker.exists()) p.buildMarker.readText().trim() else null

    fun upToDate(ctx: Context, p: Paths): Boolean {
        val shipped = shippedBuild(ctx) ?: return p.node.exists() // dev builds without a payload keep whatever is there
        return installedBuild(p) == shipped && p.node.exists() && p.coreBundle.exists()
    }

    /** Extract and activate the shipped payload. `progress(done, total)` counts zip entries. */
    fun install(ctx: Context, p: Paths, progress: (Int, Int) -> Unit = { _, _ -> }) {
        val index = ctx.assets.open("payload-index.json").use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
        val build = index.getString("build")
        val free = StatFs(p.files.path).availableBytes
        require(free > 700L * 1024 * 1024) { "存储空间不足：安装需要约 700 MB，当前可用 ${free / 1024 / 1024} MB" }

        p.payloadStaging.deleteRecursively()
        p.payloadStaging.mkdirs()
        val total = index.optInt("entries", 0)
        var n = 0
        val buf = ByteArray(256 * 1024)
        ZipInputStream(ctx.assets.open("payload.zip").buffered(1 shl 20)).use { zip ->
            while (true) {
                val e = zip.nextEntry ?: break
                val out = File(p.payloadStaging, e.name)
                require(out.canonicalPath.startsWith(p.payloadStaging.canonicalPath)) { "bad entry ${e.name}" }
                if (e.isDirectory) out.mkdirs()
                else {
                    out.parentFile?.mkdirs()
                    FileOutputStream(out).use { o ->
                        while (true) {
                            val r = zip.read(buf)
                            if (r < 0) break
                            o.write(buf, 0, r)
                        }
                    }
                }
                if (++n % 500 == 0) progress(n, total)
            }
        }
        // The placeholder is the FINAL path (payload/, not payload.new/): the tree is renamed below.
        val placeholder = index.getString("placeholder")
        val finalPath = p.payload.absolutePath
        val ph = index.getJSONArray("placeholders")
        for (i in 0 until ph.length()) {
            val f = File(p.payloadStaging, ph.getString(i))
            if (f.exists()) f.writeText(f.readText(Charsets.ISO_8859_1).replace(placeholder, finalPath), Charsets.ISO_8859_1)
        }
        val links = index.getJSONArray("links")
        for (i in 0 until links.length()) {
            val l = links.getJSONArray(i)
            val f = File(p.payloadStaging, l.getString(0))
            f.parentFile?.mkdirs()
            f.delete()
            Os.symlink(l.getString(1), f.path)
        }
        val exec = index.getJSONArray("exec")
        for (i in 0 until exec.length()) {
            val f = File(p.payloadStaging, exec.getString(i))
            if (f.exists()) Os.chmod(f.path, 493 /* 0755 */)
        }
        File(p.payloadStaging, ".build").writeText(build)

        p.payloadOld.deleteRecursively()
        if (p.payload.exists() && !p.payload.renameTo(p.payloadOld)) error("cannot move the old payload aside")
        if (!p.payloadStaging.renameTo(p.payload)) error("cannot activate the new payload")
        Thread { p.payloadOld.deleteRecursively() }.start()
        Log.i(TAG, "payload $build installed ($n entries)")
    }

}
