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
 * the port.
 */
class CoreProcess(private val ctx: Context) {
    private val p = Paths(ctx)
    private val secrets = Secrets(ctx)

    /** Writes ash.json for this start (paths may change across app updates; tokens do not). */
    fun writeConfig(hostPort: Int, proxy: String? = systemProxy()) {
        p.ash.mkdirs()
        p.home.mkdirs()
        // The agent runs as DSH inside the container (proot + Ubuntu) that ContainerInstaller keeps
        // at files/container/main; core starts it and owns its model calls and credentials.
        val agents = JSONArray().put(
            JSONObject().put("id", "agent:main").put("name", "Ash").put("runtime", "container").put("workspace", "home")
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
                "container",
                JSONObject()
                    .put("root", p.containerRoot.path)
                    .put("dns", JSONArray(dnsServers()))
                    // The phone's proxy, so apt/pip/npm/git/curl inside the container take the same way out.
                    .put("env", JSONObject(proxyEnv(proxy))),
            )
            .put("agents", agents)
            .put("host", JSONObject().put("url", "http://127.0.0.1:$hostPort").put("token", secrets.hostToken).put("coreToken", secrets.coreToken))
            .put("policy", JSONObject().put("quietHours", "23:30-07:30"))
        // The JEV key lives in ash's own vault; the core reads it per judgement, so only the address is configured here.
        cfg.put("reflex", JSONObject().put("jev", JSONObject()
            .put("url", "https://openrouter.ai/api/alpha/decisions").put("key_credential", "jev")))
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

    /**
     * DNS servers of the active network (IPv4 first) for the container's resolv.conf: Android has
     * no resolv.conf of its own, and proot's Ubuntu reads only that file. Public resolvers when the
     * network does not say (or no network is up yet).
     */
    fun dnsServers(): List<String> = orderDns(
        try {
            val cm = ctx.getSystemService(android.net.ConnectivityManager::class.java)
            cm.getLinkProperties(cm.activeNetwork)?.dnsServers.orEmpty().mapNotNull { it.hostAddress }
        } catch (_: Exception) {
            emptyList()
        },
    )

    /** The proxy the running core was started with (the supervisor restarts it when this changes). */
    @Volatile var startedWithProxy: String? = null
        private set

    fun environment(proxy: String? = systemProxy()): Map<String, String> {
        val pl = p.payload.path
        p.tmp.mkdirs()
        val cert = "$pl/runtime/etc/tls/cert.pem"
        startedWithProxy = proxy
        return proxyEnv(proxy) + mapOf(
            // Core's own fetch (model calls it forwards for the agent) honours HTTP(S)_PROXY.
            "NODE_USE_ENV_PROXY" to "1",
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
        val proxy = systemProxy()
        writeConfig(hostPort, proxy)
        ensureGitConfig()
        rotateLog()
        val pb = ProcessBuilder(command()).directory(p.home)
        pb.environment().clear()
        pb.environment().putAll(environment(proxy))
        // The vault's seal key, unwrapped by Keystore for this start only. Core is non-dumpable, so the agent container
        // (same Linux user) cannot read it from /proc.
        try { pb.environment()["ASH_VAULT_SEAL_KEY"] = Keys.vaultSealKey(File(p.ash, "vault.key")) }
        catch (e: Exception) { note("vault seal key unavailable: ${e.javaClass.simpleName}") }
        pb.redirectErrorStream(true)
        // A daemon: no stdin (an open pipe nobody writes could stall anything that reads it).
        pb.redirectInput(File("/dev/null"))
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(p.coreLog))
        val proc = pb.start()
        val pid = pidOf(proc)
        try { pidFile.writeText("$pid\n") } catch (e: Exception) { Log.w(TAG, "core pid file", e) }
        Log.i(TAG, "ash core started (pid $pid)")
        return pid
    }

    private val pidFile get() = File(p.ash, "core.pid")

    /** Signal 0 checks a process exists and is ours, without needing to see it in /proc. */
    private fun alive(pid: Int): Boolean = try { Os.kill(pid, 0); true } catch (_: android.system.ErrnoException) { false }

    /**
     * The running ash core. Core marks itself non-dumpable, and Android hides such a process from /proc even for its own
     * user, so it is found through the pid recorded at start: alive and ours (signal 0), and either invisible in /proc
     * (only a non-dumpable process of this user is) or visible with our bundle on its command line. An older core that
     * is still dumpable is found by scanning /proc as before.
     */
    fun pid(): Int? {
        val ours = { cmd: String -> cmd.contains(p.coreBundle.path) || cmd.contains("ash-core.mjs --config ${p.config.path}") }
        scan(ours).firstOrNull()?.let { return it }
        val recorded = try { pidFile.readText().trim().toIntOrNull() } catch (_: Exception) { null } ?: return null
        if (!alive(recorded)) return null
        val cmd = try { File("/proc/$recorded/cmdline").readBytes().toString(Charsets.UTF_8).replace('\u0000', ' ') } catch (_: Exception) { null }
        return if (cmd == null || cmd.isEmpty() || ours(cmd)) recorded else null
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
                if (!alive(pid)) return
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

        /** Public resolvers reachable from mainland China, for when the network names none. */
        val FALLBACK_DNS = listOf("223.5.5.5", "119.29.29.29")

        /** Nameservers for the container: IPv4 first (some IPv6 resolvers are link-local), no duplicates. */
        fun orderDns(hosts: List<String>): List<String> =
            hosts.map { it.trim() }.filter { it.isNotEmpty() }.distinct().sortedBy { if (it.contains(':')) 1 else 0 }.ifEmpty { FALLBACK_DNS }

        /** Proxy variables understood by node (NODE_USE_ENV_PROXY), npm, git, curl, pip — for core and the container. */
        fun proxyEnv(proxy: String?): Map<String, String> {
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
