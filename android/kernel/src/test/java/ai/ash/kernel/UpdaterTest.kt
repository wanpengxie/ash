package ai.ash.kernel

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.security.MessageDigest

/** Downloading, checking and the order of installing, with the network and the installer replaced. */
class UpdaterTest {
    private val dir: File = Files.createTempDirectory("ash-update").toFile()
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** One answer of a fake server: a status, a Location for redirects, a body; it records the headers it was sent. */
    private class Answer(val status: Int, val body: ByteArray = ByteArray(0), val location: String? = null)
    private class FakeConnection(url: URL, private val answer: Answer, val sent: MutableMap<String, String>) : HttpURLConnection(url) {
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun setRequestProperty(key: String, value: String) { sent[key] = value }
        override fun getResponseCode() = answer.status
        override fun getHeaderField(name: String): String? = if (name == "Location") answer.location else null
        override fun getInputStream(): InputStream = ByteArrayInputStream(answer.body)
    }

    private class Net(val answers: Map<String, Answer>) {
        val requests = ArrayList<Pair<String, Map<String, String>>>()
        fun open(url: URL): HttpURLConnection {
            val sent = LinkedHashMap<String, String>()
            requests += url.toString() to sent
            return FakeConnection(url, answers[url.toString()] ?: Answer(404), sent)
        }
    }

    private class FakeInstaller : PackageSetInstaller {
        override val via = "shell"
        val installed = ArrayList<Pair<String, ByteArray>>()
        override fun install(files: List<Pair<String, File>>, report: (String, String) -> Unit) {
            for ((pkg, file) in files) { report("installing", pkg); installed += pkg to file.readBytes() }
        }
    }

    private fun waitFor(updater: Updater, state: String): JSONObject {
        repeat(200) { val s = updater.status(); if (s.getString("state") == state) return s; Thread.sleep(10) }
        fail("never $state: ${updater.status()}"); throw AssertionError()
    }

    @Test fun aPackageIsKeptOnlyWhenItsChecksumHolds() {
        val apk = "the app".toByteArray()
        val net = Net(mapOf("https://github.com/o/r/releases/download/v1.2.3/app.apk" to Answer(200, apk)))
        val updater = Updater(dir, FakeInstaller(), open = net::open)
        val file = File(dir, "x.apk")
        updater.download("https://github.com/o/r/releases/download/v1.2.3/app.apk", null, file, sha(apk))
        assertEquals("the app", file.readText())
        try {
            updater.download("https://github.com/o/r/releases/download/v1.2.3/app.apk", null, file, "0".repeat(64))
            fail("a wrong checksum must fail")
        } catch (e: IOException) { assertTrue(e.message!!.contains("checksum mismatch")) }
        assertFalse("nothing is left to install", file.exists())
    }

    @Test fun aPrivateReleaseIsReadWithTheTokenAtGitHubOnlyNotAtTheStorageItRedirectsTo() {
        val apk = "kernel".toByteArray()
        val api = "https://api.github.com/repos/o/r/releases/assets/9"
        val storage = "https://objects.githubusercontent.com/signed?x=1"
        val net = Net(mapOf(api to Answer(302, location = storage), storage to Answer(200, apk)))
        val updater = Updater(dir, FakeInstaller(), open = net::open)
        updater.download(api, "ghp_secret", File(dir, "k.apk"), sha(apk))
        assertEquals(listOf(api, storage), net.requests.map { it.first })
        assertEquals("Bearer ghp_secret", net.requests[0].second["Authorization"])
        assertEquals("application/octet-stream", net.requests[0].second["Accept"])
        assertNull(net.requests[1].second["Authorization"])
    }

    @Test fun aRedirectAwayFromHttpsIsRefused() {
        val net = Net(mapOf("https://github.com/a" to Answer(302, location = "http://evil.example/a")))
        try { Updater(dir, FakeInstaller(), open = net::open).download("https://github.com/a", null, File(dir, "a"), "0".repeat(64)); fail() }
        catch (e: IOException) { assertTrue(e.message!!.contains("refusing")) }
    }

    @Test fun aJobDownloadsEverythingFirstThenInstallsInOrderAndReportsWhereItIs() {
        val app = "app".toByteArray(); val kernel = "kernel".toByteArray()
        val net = Net(mapOf("https://github.com/app" to Answer(200, app), "https://github.com/kernel" to Answer(200, kernel)))
        val installer = FakeInstaller()
        val updater = Updater(dir, installer, open = net::open)
        assertEquals("shell", updater.start("1.2.3", listOf(UpdatePackage("ai.ash.agent", "https://github.com/app", sha(app)), UpdatePackage("ai.ash.kernel", "https://github.com/kernel", sha(kernel))), null))
        waitFor(updater, "done")
        assertEquals(listOf("ai.ash.agent", "ai.ash.kernel"), installer.installed.map { it.first })
        assertEquals("1.2.3", updater.status().getString("version"))
    }

    @Test fun aChecksumFailureInstallsNothingAndSaysWhy() {
        val net = Net(mapOf("https://github.com/app" to Answer(200, "app".toByteArray()), "https://github.com/kernel" to Answer(200, "evil".toByteArray())))
        val installer = FakeInstaller()
        val updater = Updater(dir, installer, open = net::open)
        updater.start("1.2.3", listOf(UpdatePackage("ai.ash.agent", "https://github.com/app", sha("app".toByteArray())), UpdatePackage("ai.ash.kernel", "https://github.com/kernel", sha("kernel".toByteArray()))), null)
        val failed = waitFor(updater, "failed")
        assertTrue(failed.getString("message"), failed.getString("message").contains("checksum mismatch"))
        assertTrue(installer.installed.isEmpty())
    }

    // ---- the host methods

    private class FakePort : UpdatePort {
        var started: Triple<String, List<UpdatePackage>, String?>? = null
        override fun start(version: String, packages: List<UpdatePackage>, token: String?): String { started = Triple(version, packages, token); return "installer" }
        override fun status() = JSONObject().put("state", "downloading")
    }

    private fun api(port: FakePort) = HostApi(HostApi.CAPABILITIES + "update", SoftIdentity(), WakeManager(FakeAlarms()), FakePower(), FakeHands(), FakeCallbacks(), update = port)
    private val a = "a".repeat(64)

    @Test fun updateInstallChecksWhatItIsGivenAndPutsTheKernelLast() {
        val port = FakePort()
        val host = api(port)
        val body = """{"version":"0.4.49","token":"t","packages":[{"package":"ai.ash.kernel","url":"https://x/k","sha256":"$a"},{"package":"ai.ash.agent","url":"https://x/a","sha256":"$a"}]}"""
        val r = host.call("update.install", JSONObject(body))
        assertTrue(r.toString(), r.getBoolean("ok"))
        assertEquals("installer", r.getJSONObject("result").getString("via"))
        assertEquals(listOf("ai.ash.agent", "ai.ash.kernel"), port.started!!.second.map { it.pkg })
        assertEquals("t", port.started!!.third)
        assertEquals("downloading", host.call("update.status", JSONObject()).getJSONObject("result").getString("state"))
        for (bad in listOf(
            """{"version":"0.4.49","packages":[{"package":"com.evil","url":"https://x/a","sha256":"$a"}]}""",
            """{"version":"0.4.49","packages":[{"package":"ai.ash.agent","url":"http://x/a","sha256":"$a"}]}""",
            """{"version":"0.4.49","packages":[{"package":"ai.ash.agent","url":"https://x/a","sha256":"xyz"}]}""",
            """{"version":"latest","packages":[{"package":"ai.ash.agent","url":"https://x/a","sha256":"$a"}]}""",
            """{"version":"0.4.49","packages":[]}""",
        )) {
            val e = host.call("update.install", JSONObject(bad))
            assertFalse(bad, e.getBoolean("ok"))
            assertEquals(bad, "bad_request", e.getJSONObject("error").getString("code"))
        }
    }
}
