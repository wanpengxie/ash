package ai.ash.host

import android.content.Context
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import ai.ash.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom

/** Tokens shared between the host and ash core; generated once, kept in private prefs. */
class Secrets(ctx: Context) {
    private val prefs = ctx.getSharedPreferences("ash.host", Context.MODE_PRIVATE)
    val hostToken: String get() = token("host_token")
    val coreToken: String get() = token("core_token")
    var stopped: Boolean
        get() = prefs.getBoolean("stopped", false)
        set(v) { prefs.edit().putBoolean("stopped", v).apply() }

    @Synchronized
    private fun token(key: String): String {
        prefs.getString(key, null)?.let { return it }
        val b = ByteArray(24).also { SecureRandom().nextBytes(it) }
        val t = Keys.b64u(b)
        prefs.edit().putString(key, t).commit()
        return t
    }
}

/**
 * ash core as a child process: config, environment, start, find, stop. One instance only —
 * under load a port probe can time out while the core is alive, and a second core fighting
 * over the same event log and DSH sessions hangs both; so liveness is decided by /proc, not by
 * the port (0.1.x lesson).
 */
class CoreProcess(private val ctx: Context) {
    private val p = Paths(ctx)
    private val secrets = Secrets(ctx)

    /** Writes ash.json for this start (paths may change across app updates; tokens do not). */
    fun writeConfig(hostPort: Int) {
        p.ash.mkdirs()
        p.home.mkdirs()
        val agents = JSONArray().put(
            JSONObject().put("id", "agent:main").put("name", "Ash").put("runtime", "dsh").put("workspace", "home")
                .put("grants", JSONArray().put("*")).put("instructions", DEFAULT_BRIEF),
        )
        val cfg = JSONObject()
            .put("space", "me")
            .put("owner", "主人")
            .put("name", "手机 · ${Build.MODEL}")
            .put("listen", "127.0.0.1:$PORT")
            .put("stateDir", p.state.path)
            .put("workspaces", JSONObject().put("home", p.home.path))
            .put(
                "dsh",
                JSONObject()
                    .put("root", p.dshRoot.path)
                    .put("home", p.dshHome.path)
                    .put("patchFiles", JSONArray().put(p.hostPatch.path))
                    // No DSH sandbox runner exists on Android; the app sandbox is the boundary and
                    // ash's own gates decide what untrusted requests may do.
                    .put("env", JSONObject().put("DSH_PERMISSION_MODE", "danger-full-access").put("DSH_TELEMETRY_DISABLED", "1")),
            )
            .put("agents", agents)
            .put("host", JSONObject().put("url", "http://127.0.0.1:$hostPort").put("token", secrets.hostToken).put("coreToken", secrets.coreToken))
            .put("policy", JSONObject().put("quietHours", "23:30-07:30"))
        // The owner may override anything (more agents, policy …) in ash/config.override.json.
        if (p.configOverride.exists()) {
            runCatching { JSONObject(p.configOverride.readText()) }.getOrNull()?.let { o -> o.keys().forEach { k -> cfg.put(k, o.get(k)) } }
        }
        // The isolated test package must never be redirected to the installed app's ports
        // or files by a stale override from an earlier test run.
        if (BuildConfig.ISOLATED_PROBE) {
            cfg.put("listen", "127.0.0.1:$PORT")
            cfg.put("stateDir", p.state.path)
            cfg.put("workspaces", JSONObject().put("home", p.home.path))
            cfg.put("host", JSONObject().put("url", "http://127.0.0.1:$hostPort")
                .put("token", secrets.hostToken).put("coreToken", secrets.coreToken))
        }
        p.config.writeText(cfg.toString(1))
    }

    /**
     * The phone's HTTP proxy (Wi-Fi proxy setting, or what a proxy app published), as host:port.
     * VPN-style proxies need nothing (traffic is tunneled below us); this covers the rest, e.g. a
     * network where overseas names only resolve through a proxy.
     */
    fun systemProxy(): String? {
        try {
            val cm = ctx.getSystemService(android.net.ConnectivityManager::class.java)
            val pi = if (Build.VERSION.SDK_INT >= 23) cm.defaultProxy else null
            if (pi != null && !pi.host.isNullOrBlank() && pi.port > 0) return "${pi.host}:${pi.port}"
        } catch (_: Exception) {
        }
        val h = System.getProperty("http.proxyHost")
        val port = System.getProperty("http.proxyPort")
        return if (!h.isNullOrBlank() && !port.isNullOrBlank()) "$h:$port" else null
    }

    /** Proxy variables understood by node (NODE_USE_ENV_PROXY), npm, git, curl, pip — and inherited by MCP servers. */
    private fun proxyEnv(proxy: String?): Map<String, String> {
        if (proxy == null) return emptyMap()
        val u = "http://$proxy"
        val direct = "127.0.0.1,localhost,::1"
        return mapOf(
            "HTTP_PROXY" to u, "HTTPS_PROXY" to u, "http_proxy" to u, "https_proxy" to u,
            "NO_PROXY" to direct, "no_proxy" to direct,
            "NODE_USE_ENV_PROXY" to "1",
            "npm_config_proxy" to u, "npm_config_https_proxy" to u,
        )
    }

    /** The proxy the running core was started with (the supervisor restarts it when this changes). */
    @Volatile var startedWithProxy: String? = null
        private set

    fun environment(): Map<String, String> {
        val pl = p.payload.path
        p.tmp.mkdirs()
        val cert = "$pl/runtime/etc/tls/cert.pem"
        val proxy = systemProxy()
        startedWithProxy = proxy
        return proxyEnv(proxy) + mapOf(
            "HOME" to p.files.path,
            "PATH" to "$pl/bin:$pl/runtime/bin:${p.files.path}/.npm-global/bin:/system/bin:/system/xbin",
            "TMPDIR" to p.tmp.path,
            "TMP" to p.tmp.path,
            "LANG" to "C.UTF-8",
            "TERM" to "xterm-256color",
            // Termux-built OpenSSL looks under Termux's prefix otherwise (EACCES when Termux is installed).
            "OPENSSL_CONF" to "$pl/runtime/etc/tls/openssl.cnf",
            "SSL_CERT_FILE" to cert,
            "CURL_CA_BUNDLE" to cert,
            "GIT_SSL_CAINFO" to cert,
            "NODE_EXTRA_CA_CERTS" to cert,
            "GIT_EXEC_PATH" to "$pl/runtime/libexec/git-core",
            "GIT_TEMPLATE_DIR" to "$pl/runtime/share/git-core/templates",
            "GIT_CONFIG_NOSYSTEM" to "1",
            // DSH scrubs variables whose names contain KEY/TOKEN/SECRET before spawning tools, so
            // git settings go through a config file instead of GIT_CONFIG_KEY_n.
            "GIT_CONFIG_GLOBAL" to "${p.files.path}/.gitconfig",
            "GIT_PAGER" to "cat",
            "PAGER" to "cat",
            "npm_config_prefix" to "${p.files.path}/.npm-global",
            "npm_config_cache" to "${p.cache.path}/npm",
            "ANDROID_DATA" to (System.getenv("ANDROID_DATA") ?: "/data"),
            "ANDROID_ROOT" to (System.getenv("ANDROID_ROOT") ?: "/system"),
        )
    }

    fun command(): List<String> = listOf(
        p.node.path,
        // DSH's module interception needs node internals; the preload adapts hard links and flock.
        "--expose-internals",
        "--require", p.compatPreload.path,
        p.coreBundle.path,
        "--config", p.config.path,
    )

    fun start(hostPort: Int): Int {
        writeConfig(hostPort)
        ensureGitConfig()
        rotateLog()
        val pb = ProcessBuilder(command()).directory(p.home)
        pb.environment().clear()
        pb.environment().putAll(environment())
        pb.redirectErrorStream(true)
        // A daemon: no stdin (an open pipe nobody writes could stall anything that reads it).
        pb.redirectInput(File("/dev/null"))
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(p.coreLog))
        val proc = pb.start()
        val pid = pidOf(proc)
        Log.i(TAG, "ash core started (pid $pid)")
        return pid
    }

    /** The running ash core, found in /proc (our uid, our bundle on the command line). */
    fun pid(): Int? = scan { it.contains(p.coreBundle.path) || it.contains("ash-core.mjs --config ${p.config.path}") }.firstOrNull()

    /** 0.1.x left a DSH web engine and a gateway link running; they hold the old payload and the gateway identity. */
    fun killLegacy() {
        for (pid in scan { (it.contains("/dshroot/") && it.contains(" web ")) || it.contains("ash-link.mjs") || it.contains("/ash-core/ash-core.mjs") }) {
            Log.i(TAG, "stopping a 0.1.x process $pid")
            kill(pid)
        }
    }

    fun stop() {
        pid()?.let { kill(it) }
    }

    /** Supervisor decisions go into core.log too, so one file tells the whole story. */
    fun note(msg: String) {
        Log.i(TAG, msg)
        val now = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date())
        try { p.coreLog.appendText("$now [host] $msg\n") } catch (_: Exception) {}
    }

    fun portOpen(timeoutMs: Int = 3000): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", PORT), timeoutMs); true }
    } catch (e: Exception) {
        false
    }

    private fun kill(pid: Int) {
        try {
            Os.kill(pid, OsConstants.SIGTERM)
            for (i in 0 until 30) {
                Thread.sleep(100)
                if (!File("/proc/$pid").exists()) return
            }
            Os.kill(pid, OsConstants.SIGKILL)
        } catch (e: Exception) {
            Log.w(TAG, "kill $pid", e)
        }
    }

    private fun scan(match: (String) -> Boolean): List<Int> {
        val uid = android.os.Process.myUid()
        val out = ArrayList<Int>()
        for (d in File("/proc").listFiles() ?: return out) {
            val pid = d.name.toIntOrNull() ?: continue
            try {
                val status = File(d, "status").readText()
                val u = Regex("Uid:\\s+(\\d+)").find(status)?.groupValues?.get(1)?.toInt() ?: continue
                if (u != uid) continue
                val cmd = File(d, "cmdline").readBytes().toString(Charsets.UTF_8).replace('\u0000', ' ')
                if (cmd.contains("node") && match(cmd)) out.add(pid)
            } catch (_: Exception) {
            }
        }
        return out
    }

    private fun pidOf(proc: Process): Int = try {
        proc.javaClass.getDeclaredField("pid").apply { isAccessible = true }.getInt(proc)
    } catch (e: Exception) {
        pid() ?: -1
    }

    private fun rotateLog() {
        if (p.coreLog.length() > 5L * 1024 * 1024) {
            val old = File(p.ash, "core.log.1")
            old.delete()
            p.coreLog.renameTo(old)
        }
    }

    private fun ensureGitConfig() {
        val f = File(p.files, ".gitconfig")
        if (!f.exists()) f.writeText("[user]\n\tname = Ash\n\temail = ash@localhost\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n")
    }

    companion object {
        private const val TAG = "ash.core"
        val PORT = BuildConfig.CORE_PORT

        val DEFAULT_BRIEF = """
            # Ash

            You are Ash, the owner's resident personal agent on their phone. You run all the time, not just while
            the owner is looking: reminders you set come back to you, and you can reach the owner with notifications.

            - Be brief on the phone. Answer in the owner's language.
            - Keep durable notes about the owner's preferences and ongoing matters in NOTES.md in this directory.
            - The phone's abilities (screen, apps, clipboard, shell …) and the owner's other devices are tools;
              check what is available before promising something.
        """.trimIndent() + "\n"
    }
}
