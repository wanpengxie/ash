package ai.ash.host.cap

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class MediaArgumentsTest {
    private fun list(input: JSONObject): MediaListArgs? = MediaArguments.list(input, { it }, { null })

    @Test fun listDefaultsToEveryKindNewestFirst() {
        val a = list(JSONObject())!!
        assertEquals(MediaKind.values().toList(), a.kinds)
        assertTrue(a.newestFirst)
        assertEquals(30, a.limit)
        assertEquals(0, a.offset)
        assertFalse(a.withLocation)
        assertNull(a.since)
    }

    @Test fun malformedListNeverReachesTheProvider() {
        val bad = listOf(
            JSONObject().put("type", "photo"),
            JSONObject().put("type", 1),
            JSONObject().put("since_ms", "1800000000000"),
            JSONObject().put("since_ms", -1),
            JSONObject().put("since_ms", 10).put("until_ms", 10),
            JSONObject().put("limit", 0),
            JSONObject().put("limit", 101),
            JSONObject().put("offset", 1.5),
            JSONObject().put("order", "random"),
            JSONObject().put("album", JSONObject()),
            JSONObject().put("name", "x".repeat(201)),
            JSONObject().put("with_location", "yes"),
            JSONObject().put("folder", "DCIM"),
        )
        for (input in bad) assertNull(input.toString(), list(input))
    }

    @Test fun queryUsesTakenTimeElseAddedTime() {
        val a = list(JSONObject().put("type", "image").put("since_ms", 1_800_000_000_500L).put("until_ms", 1_800_000_100_000L))!!
        val q = MediaArguments.query(a)
        assertTrue(q.selection, q.selection.startsWith("media_type IN (1) AND "))
        assertTrue(q.selection.contains("((datetaken > 0 AND datetaken >= ?) OR ((datetaken IS NULL OR datetaken <= 0) AND date_added >= ?))"))
        assertTrue(q.selection.contains("((datetaken > 0 AND datetaken < ?) OR ((datetaken IS NULL OR datetaken <= 0) AND date_added < ?))"))
        // Added time is in seconds: the window rounds outwards so nothing at its edge is lost.
        assertArrayEquals(arrayOf("1800000000500", "1800000000", "1800000100000", "1800000100"), q.args)
        assertEquals("COALESCE(NULLIF(datetaken, 0), date_added * 1000) DESC, _id DESC", q.sortOrder)
        assertEquals("date_added DESC, _id DESC", q.plainSort)
    }

    @Test fun albumAndNameAreEscapedLikePatterns() {
        val a = list(JSONObject().put("type", "any").put("album", "100%_ok").put("name", "a\\b").put("order", "oldest"))!!
        val q = MediaArguments.query(a)
        assertTrue(q.selection.startsWith("media_type IN (1,2,3)"))
        assertTrue(q.selection.contains("bucket_display_name LIKE ? ESCAPE '\\'"))
        assertTrue(q.selection.contains("_display_name LIKE ? ESCAPE '\\'"))
        assertArrayEquals(arrayOf("100\\%\\_ok", "%a\\\\b%"), q.args)
        assertTrue(q.sortOrder.endsWith("ASC, _id ASC"))
        // No user text ever lands in the SQL itself.
        assertFalse(q.selection.contains("100") || q.selection.contains("a\\b"))
    }

    @Test fun takenTimeFallsBackToAdded() {
        assertEquals(5_000L, MediaArguments.takenMs(5_000L, 9L))
        assertEquals(9_000L, MediaArguments.takenMs(0L, 9L))
        assertEquals(9_000L, MediaArguments.takenMs(null, 9L))
        assertNull(MediaArguments.takenMs(null, null))
    }

    @Test fun readNeedsAnIdAndSaneSize() {
        assertEquals(MediaReadArgs(12, 1280, false), MediaArguments.read(JSONObject().put("id", 12), { it }, { null }))
        assertEquals(MediaReadArgs(12, 512, true), MediaArguments.read(JSONObject().put("id", 12).put("max_size", 512).put("copy", true), { it }, { null }))
        for (bad in listOf(JSONObject(), JSONObject().put("id", "12"), JSONObject().put("id", 0), JSONObject().put("id", 1).put("max_size", 100),
            JSONObject().put("id", 1).put("max_size", 4096), JSONObject().put("id", 1).put("copy", 1), JSONObject().put("id", 1).put("path", "/x")))
            assertNull(bad.toString(), MediaArguments.read(bad, { it }, { null }))
    }

    @Test fun saveNeedsExactlyOneSourceAndPlainNames() {
        assertEquals(MediaSaveArgs("/root/work/a.png", null, null, null, "Ash"),
            MediaArguments.save(JSONObject().put("path", "/root/work/a.png"), { it }, { null }))
        assertEquals(MediaSaveArgs(null, "iVBORw0KGgo=", "x.png", "image/png", "Trips"),
            MediaArguments.save(JSONObject().put("data", "iVBORw0KGgo=").put("name", "x.png").put("mime_type", "IMAGE/PNG").put("album", "Trips"), { it }, { null }))
        val bad = listOf(
            JSONObject(),
            JSONObject().put("path", "/a.png").put("data", "AAAA"),
            JSONObject().put("path", "relative.png"),
            JSONObject().put("data", "not base64!"),
            JSONObject().put("path", "/a").put("name", "../x.png"),
            JSONObject().put("path", "/a").put("mime_type", "text/html"),
            JSONObject().put("path", "/a").put("album", "Pictures/Other"),
            JSONObject().put("path", "/a").put("album", ".hidden"),
            JSONObject().put("path", "/a").put("uri", "content://x"),
        )
        for (input in bad) assertNull(input.toString(), MediaArguments.save(input, { it }, { null }))
    }

    @Test fun cameraWaitsWithinTheCallBudget() {
        assertEquals(CameraArgs(null, 120_000, 1280), MediaArguments.camera(JSONObject(), { it }, { null }))
        assertEquals(CameraArgs("拍药盒", 30_000, 800), MediaArguments.camera(JSONObject().put("reason", "拍药盒").put("timeout_s", 30).put("max_size", 800), { it }, { null }))
        for (bad in listOf(JSONObject().put("timeout_s", 151), JSONObject().put("timeout_s", 5), JSONObject().put("reason", 3), JSONObject().put("video", true)))
            assertNull(bad.toString(), MediaArguments.camera(bad, { it }, { null }))
    }

    @Test fun mimeTypesFromNamesAndBytes() {
        assertEquals("image/jpeg", MediaArguments.mimeOf("IMG_1.JPG"))
        assertEquals("video/mp4", MediaArguments.mimeOf("v.mp4"))
        assertNull(MediaArguments.mimeOf("notes.txt"))
        assertEquals("jpg", MediaArguments.extensionFor("image/jpeg"))
        assertEquals("mov", MediaArguments.extensionFor("video/quicktime"))
        assertEquals("png", MediaArguments.extensionFor("image/png"))
        fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }
        assertEquals("image/jpeg", MediaArguments.sniff(bytes(0xff, 0xd8, 0xff, 0xe0)))
        assertEquals("image/png", MediaArguments.sniff(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
        assertEquals("image/webp", MediaArguments.sniff("RIFF\u0000\u0000\u0000\u0000WEBP".toByteArray()))
        assertEquals("image/heic", MediaArguments.sniff("\u0000\u0000\u0000\u0018ftypheic".toByteArray()))
        assertEquals("video/mp4", MediaArguments.sniff("\u0000\u0000\u0000\u0018ftypisom".toByteArray()))
        assertNull(MediaArguments.sniff("hello".toByteArray()))
    }

    @Test fun safeNamesStayOneFile() {
        assertEquals("a_b.png", MediaArguments.safeName("a/b.png"))
        assertEquals("x.jpg", MediaArguments.safeName("..x.jpg"))
        assertEquals("file", MediaArguments.safeName("..."))
        assertEquals(120, MediaArguments.safeName("y".repeat(300)).length)
    }

    @Test fun containerPathsMapToThePhone() {
        val base = Files.createTempDirectory("ash-paths").toFile()
        try {
            val rootfs = File(base, "ubuntu").apply { File(this, "root/work").mkdirs() }
            val tmp = File(base, "tmp").apply { mkdirs() }
            val storage = File(base, "storage").apply { File(this, "DCIM").mkdirs() }.path
            val paths = ContainerPaths(rootfs, tmp, storage)
            assertEquals(File(rootfs, "root/work/a.jpg").canonicalFile, paths.toHost("/root/work/a.jpg"))
            assertEquals(File(rootfs, "root/a.jpg").canonicalFile, paths.toHost("/root/work/../a.jpg"))
            assertEquals(File(tmp, "x.png").canonicalFile, paths.toHost("/tmp/x.png"))
            assertEquals(File(storage, "DCIM/p.jpg").canonicalFile, paths.toHost("/sdcard/DCIM/p.jpg"))
            assertEquals(File(storage, "DCIM/p.jpg").canonicalFile, paths.toHost("$storage/DCIM/p.jpg"))
            assertNull(paths.toHost("/proc/self/environ"))
            assertNull(paths.toHost("/../../etc/passwd"))
            assertNull(paths.toHost("relative.jpg"))
            // A link inside the container that points out of it is refused, not followed.
            val outside = File(base, "secret").apply { writeText("x") }
            Files.createSymbolicLink(File(rootfs, "root/work/link").toPath(), outside.toPath())
            assertNull(paths.toHost("/root/work/link"))

            assertEquals("/root/work/media/1-a.jpg", paths.toAgent(File(rootfs, "root/work/media/1-a.jpg")))
            assertEquals("$storage/DCIM/p.jpg", paths.toAgent(File(storage, "DCIM/p.jpg")))
            assertNull(paths.toAgent(outside))
            assertEquals(File(rootfs, "root/work/media"), paths.exchange)
        } finally {
            base.deleteRecursively()
        }
    }

    @Test fun normalizeNeverClimbsAboveRoot() {
        assertEquals("/a/c", ContainerPaths.normalize("/a/./b/../c"))
        assertEquals("/", ContainerPaths.normalize("/"))
        assertNull(ContainerPaths.normalize("/a/../../b"))
    }
}
