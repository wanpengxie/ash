package ai.ash.kernel

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/** One package of a release: which app, where its APK is (an https address) and its SHA-256 (hex). */
data class UpdatePackage(val pkg: String, val url: String, val sha256: String)

/** How the packages are put on the phone: the debug identity (`pm install`), or the system installer with the owner's tap. */
interface PackageSetInstaller {
    /** "shell" or "installer". */
    val via: String
    /** Installs the checked APKs in this order (the kernel last: installing it ends this process). [report] is the state as it goes. */
    fun install(files: List<Pair<String, File>>, report: (state: String, message: String) -> Unit)
}

/** What the host offers the core for its own updates (capability `update`). */
interface UpdatePort {
    /** Starts a job in the background; returns how it will install. Throws [IllegalStateException] when one is running. */
    fun start(version: String, packages: List<UpdatePackage>, token: String?): String
    /** The running or last job. */
    fun status(): JSONObject
}

/**
 * Downloads a release of Ash's packages, checks each against its SHA-256, and only then installs them, the app before the
 * kernel. Downloading comes from GitHub's release pages: a private repository's assets are read through the API with a
 * read-only token, which is sent to github.com only (never to the storage host it redirects to) and never logged.
 */
class Updater(
    private val dir: File,
    private val installer: PackageSetInstaller,
    private val log: (String) -> Unit = {},
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) : UpdatePort {
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-update").apply { isDaemon = true } }
    @Volatile private var job = JSONObject().put("state", "idle")
    @Volatile private var running = false

    override fun status(): JSONObject = JSONObject(job.toString())

    override fun start(version: String, packages: List<UpdatePackage>, token: String?): String {
        synchronized(this) {
            check(!running) { "an update is already running" }
            running = true
        }
        set("downloading", version, "")
        worker.execute {
            try {
                run(version, packages, token)
            } catch (e: Exception) {
                log("update $version failed: ${e.message}")
                set("failed", version, e.message ?: e.javaClass.simpleName)
            } finally {
                running = false
            }
        }
        return installer.via
    }

    private fun run(version: String, packages: List<UpdatePackage>, token: String?) {
        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        val files = packages.map { p ->
            set("downloading", version, p.pkg)
            val file = File(dir, "${p.pkg}.apk")
            download(p.url, token, file, p.sha256)
            p.pkg to file
        }
        set("installing", version, "")
        installer.install(files) { state, message -> set(state, version, message) }
        set("done", version, "")
    }

    private fun set(state: String, version: String, message: String) {
        job = JSONObject().put("state", state).put("version", version).put("message", message.take(300)).put("at", System.currentTimeMillis())
    }

    /** Downloads [url] to [file], hashing as it goes; a wrong checksum leaves no file. */
    fun download(url: String, token: String?, file: File, sha256: String) {
        var address = URL(url)
        var auth = token != null && address.host == "api.github.com"
        for (hop in 0..5) {
            val conn = open(address)
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 30_000
            conn.readTimeout = 60_000
            conn.setRequestProperty("User-Agent", "ash-kernel")
            if (auth) {
                conn.setRequestProperty("Authorization", "Bearer $token")
                conn.setRequestProperty("Accept", "application/octet-stream")
            }
            val code = conn.responseCode
            if (code in 300..399) {
                val next = conn.getHeaderField("Location") ?: throw IOException("redirect without a location")
                conn.disconnect()
                address = URL(address, next)
                if (address.protocol != "https") throw IOException("refusing a redirect to ${address.protocol}")
                // The storage host is signed by the address itself; the token stays with GitHub.
                auth = false
                continue
            }
            if (code != 200) { conn.disconnect(); throw IOException("download failed: HTTP $code") }
            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            try {
                conn.inputStream.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > MAX_BYTES) throw IOException("the package is larger than $MAX_BYTES bytes")
                            digest.update(buf, 0, n)
                            out.write(buf, 0, n)
                        }
                    }
                }
            } catch (e: Exception) { file.delete(); throw e } finally { conn.disconnect() }
            val got = digest.digest().joinToString("") { "%02x".format(it) }
            if (!got.equals(sha256, ignoreCase = true)) {
                file.delete()
                throw IOException("${file.name}: checksum mismatch, nothing installed")
            }
            return
        }
        throw IOException("too many redirects")
    }

    companion object {
        /** The kernel APK carries the container: a few hundred MB. */
        const val MAX_BYTES = 1024L * 1024 * 1024
        /** The packages a release may carry, in the order they are installed. */
        val PACKAGES = listOf("ai.ash.agent", "ai.ash.kernel")
    }
}

/** The debug identity's way: `pm install -r` (same signature only, Android checks it), one package after the other. */
class ShellInstaller(private val log: (String) -> Unit = {}) : PackageSetInstaller {
    override val via = "shell"
    override fun install(files: List<Pair<String, File>>, report: (state: String, message: String) -> Unit) {
        for ((pkg, file) in files) {
            report("installing", pkg)
            log("pm install $pkg")
            val p = ProcessBuilder("pm", "install", "-r", file.path).redirectErrorStream(true).start()
            val out = p.inputStream.bufferedReader().readText().trim()
            val code = p.waitFor()
            if (code != 0 || !out.contains("Success")) throw IOException("installing $pkg failed: ${out.take(200)}")
        }
    }
}
