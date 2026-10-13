package ai.ash.kernel.host.ctx

/**
 * Starts [ContextProbe] as a child `app_process` of the shell host and starts it again when it exits. Its stdin stays
 * open for as long as this host lives, so the probe exits with the host and the next host starts the next one.
 */
class ContextProbeLauncher(private val apk: String, private val log: (String) -> Unit) {
    fun start() { Thread({ loop() }, "ash-ctx-launcher").apply { isDaemon = true; start() } }

    private fun loop() {
        var backoff = 5_000L
        while (true) {
            val began = System.currentTimeMillis()
            try {
                val pb = ProcessBuilder("/system/bin/app_process", "/system/bin", "--nice-name=ash_ctx", MAIN).redirectErrorStream(true)
                pb.environment()["CLASSPATH"] = apk
                val p = pb.start()
                log("context probe started")
                val tail = ArrayDeque<String>()
                p.inputStream.bufferedReader().forEachLine { tail.addLast(it); if (tail.size > 20) tail.removeFirst() }
                log("context probe exited ${p.waitFor()}: ${tail.joinToString(" / ").take(1500)}")
            } catch (t: Throwable) {
                log("context probe: ${t.message}")
            }
            if (System.currentTimeMillis() - began > 600_000) backoff = 5_000L
            Thread.sleep(backoff)
            backoff = minOf(backoff * 2, 300_000L)
        }
    }

    private companion object { const val MAIN = "ai.ash.kernel.host.ctx.ContextProbe" }
}
