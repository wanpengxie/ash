package ai.ash.ui
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.security.MessageDigest
class ResultFileSaveTest {
    private val bytes = "verified result".toByteArray()
    private fun response(name: String = "result.txt", mime: String = "text/plain", size: Long = bytes.size.toLong(), hash: String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }): ByteArray = JSONObject().put("ok", true).put("result", JSONObject().put("asset", JSONObject().put("display_name", name).put("media_type", mime).put("byte_length", size).put("sha256", hash)).put("bytes_base64", java.util.Base64.getEncoder().encodeToString(bytes))).toString().toByteArray()
    private fun parse(raw: ByteArray) = parseResultFileSnapshot(raw) { java.util.Base64.getDecoder().decode(it) }
    @Test fun verifiesBeforePicker() { val snapshot = parse(response()); assertArrayEquals(bytes, snapshot.bytes); assertEquals("result.txt", snapshot.name) }
    @Test fun rejectsHashLengthSizeAndFilenameConfusion() { for(raw in listOf(response(hash = "0".repeat(64)), response(size = bytes.size+1L), response(size = 4194305), response(name = "../result.txt"), response(name = "result.png", mime = "text/plain"))) { assertThrows(IllegalArgumentException::class.java) { parse(raw) } } }
    @Test fun rejectsCoreFailureAndInvalidBase64() { assertThrows(Exception::class.java) { parse("{\"ok\":false}".toByteArray()) }; val objectValue = JSONObject(response().toString(Charsets.UTF_8)); objectValue.getJSONObject("result").put("bytes_base64", "%%%="); assertThrows(IllegalArgumentException::class.java) { parse(objectValue.toString().toByteArray()) } }
    @Test fun fullFourMiBSnapshotParsesRealJsonBase64AndHashWithinWireBound() {
        val full = ByteArray(4_194_304) { (it % 251).toByte() }
        val hash = MessageDigest.getInstance("SHA-256").digest(full).joinToString("") { "%02x".format(it.toInt() and 255) }
        val encoded = java.util.Base64.getEncoder().encodeToString(full)
        assertEquals(5_592_408, encoded.length)
        val raw = JSONObject().put("ok", true).put("auth_scope", "fixture-scope").put("result", JSONObject()
            .put("asset", JSONObject().put("asset_id", "fixture-opaque-asset").put("version", 1)
                .put("display_name", "four-mib-fixture.txt").put("media_type", "text/plain")
                .put("byte_length", full.size).put("sha256", hash))
            .put("bytes_base64", encoded)).toString().toByteArray(Charsets.UTF_8)
        assertTrue("wire bytes ${raw.size} exceed native bound", raw.size <= 5_600_000)
        val snapshot = parse(raw)
        assertEquals("four-mib-fixture.txt", snapshot.name)
        assertEquals(full.size, snapshot.bytes.size)
        assertArrayEquals(full, snapshot.bytes)
    }

    @Test fun streamedResultVerifiesTheFullFileWithoutBase64Frame() {
        val full = ByteArray(4_194_304) { (it % 251).toByte() }
        val hash = MessageDigest.getInstance("SHA-256").digest(full).joinToString("") { "%02x".format(it.toInt() and 255) }
        val asset = JSONObject().put("display_name", "streamed.txt").put("media_type", "text/plain").put("byte_length", full.size).put("sha256", hash)
        assertArrayEquals(full, parseStreamedResultFile(asset, full).bytes)
        assertThrows(IllegalArgumentException::class.java) { parseStreamedResultFile(asset, full.copyOf(full.size - 1)) }
        asset.put("sha256", "0".repeat(64))
        assertThrows(IllegalArgumentException::class.java) { parseStreamedResultFile(asset, full) }
    }

}
