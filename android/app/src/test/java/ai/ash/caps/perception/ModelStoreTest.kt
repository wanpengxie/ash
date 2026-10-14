package ai.ash.caps.perception

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

class ModelStoreTest {
    private lateinit var dir: File
    private lateinit var server: MockWebServer
    private val bytes = ByteArray(200_000) { (it * 31 + it / 7).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

    @Before fun setUp() {
        dir = Files.createTempDirectory("models").toFile()
        server = MockWebServer().apply { start() }
    }

    @After fun tearDown() {
        server.shutdown()
        dir.deleteRecursively()
    }

    private fun model(vararg paths: String, size: Long = bytes.size.toLong(), checksum: String = sha) =
        ModelFile("toy", paths.map { server.url(it).toString() }, size, checksum)

    private fun body(b: ByteArray) = MockResponse().setBody(Buffer().write(b))

    @Test fun aFileIsDownloadedCheckedAndKeptUnderAFixedName() {
        server.enqueue(body(bytes))
        val m = model("/a")
        val got = ModelStore(dir).ensure(listOf(m)).getValue("toy")
        assertEquals(m.fileName, got.name)
        assertEquals(sha, ModelStore.sha256(got))
        assertFalse(File(dir, m.fileName + ".part").exists())
        // Present: no second request is made.
        ModelStore(dir).ensure(listOf(m))
        assertEquals(1, server.requestCount)
        assertTrue(ModelStore(dir).has(listOf(m)))
    }

    @Test fun aWrongFileIsRefusedAndTheNextAddressTried() {
        server.enqueue(body(ByteArray(bytes.size) { 7 }))
        server.enqueue(body(bytes))
        val got = ModelStore(dir).ensure(listOf(model("/bad", "/good"))).getValue("toy")
        assertEquals(sha, ModelStore.sha256(got))
        assertEquals(2, server.requestCount)
    }

    @Test fun whenEveryAddressFailsTheMessageNamesThem() {
        server.enqueue(MockResponse().setResponseCode(503))
        server.enqueue(body(ByteArray(10)))
        try {
            ModelStore(dir).ensure(listOf(model("/a", "/b")))
            fail("nothing good to download")
        } catch (e: ModelUnavailable) {
            assertTrue(e.message!!, e.message!!.contains("HTTP 503"))
            assertTrue(e.message!!, e.message!!.contains("checksum") || e.message!!.contains("more data") )
        }
        assertFalse(ModelStore(dir).has(listOf(model("/a"))))
        assertEquals(0, dir.listFiles { f -> f.name.endsWith(".onnx") }!!.size)
    }

    @Test fun aBrokenDownloadResumesWhereItStopped() {
        File(dir, model("/a").fileName + ".part").writeBytes(bytes.copyOf(50_000))
        server.enqueue(body(bytes.copyOfRange(50_000, bytes.size)).setResponseCode(206))
        val got = ModelStore(dir).ensure(listOf(model("/a"))).getValue("toy")
        assertEquals(sha, ModelStore.sha256(got))
        assertEquals("bytes=50000-", server.takeRequest().getHeader("Range"))
    }

    @Test fun aServerThatIgnoresTheRangeIsStartedAgain() {
        File(dir, model("/a").fileName + ".part").writeBytes(bytes.copyOf(50_000))
        server.enqueue(body(bytes))
        assertEquals(sha, ModelStore.sha256(ModelStore(dir).ensure(listOf(model("/a"))).getValue("toy")))
    }

    @Test fun anOldVersionOfTheSameModelIsRemoved() {
        val old = File(dir, "toy-aaaaaaaaaaaa.onnx").apply { writeBytes(ByteArray(5)) }
        server.enqueue(body(bytes))
        ModelStore(dir).ensure(listOf(model("/a")))
        assertFalse(old.exists())
    }

    @Test fun theWaitIsBounded() {
        server.enqueue(body(bytes))
        var clock = 0L
        try {
            ModelStore(dir).ensure(listOf(model("/a")), deadlineMs = 10) { clock += 100; clock }
            fail("the deadline passes before the first chunk")
        } catch (e: ModelUnavailable) {
            assertTrue(e.message!!, e.message!!.contains("took too long"))
        }
    }

    @Test fun theDictionaryKeepsEveryCharacter() {
        val text = "a\n　\n🛁\n,\n"
        val chars = OcrModels.parseDictionary(text)
        assertEquals(listOf("a", "　", "🛁", ","), chars)
        assertNull(chars.firstOrNull { it.isEmpty() })
    }
}
