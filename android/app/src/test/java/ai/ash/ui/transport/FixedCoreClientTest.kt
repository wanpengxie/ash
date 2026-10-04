package ai.ash.ui.transport

import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class FixedCoreClientTest {
    private val token = "SYNTHETIC_NATIVE_ONLY_OWNER"
    private fun send(path: String = "/api/send") = CoreUiRequest("POST", path, mapOf("content-type" to "application/json"), "{}".toByteArray())

    @Test fun privateBootstrapUrlIsParsedOnlyAtTheNativeBoundary() {
        assertEquals(token, ownerBearerFromPrivateUiUrl("http://127.0.0.1:14763/?token=$token\n", 14763))
        for (record in listOf("http://localhost:14763/?token=$token", "http://127.0.0.1:4700/?token=$token",
            "http://127.0.0.1:14763/?token=$token&other=1", "http://127.0.0.1:14763/?token=$token#fragment")) {
            assertFails { ownerBearerFromPrivateUiUrl(record, 14763) }
        }
    }

    @Test fun invalidTransportStatusCannotBecomeBrowserSuccess() {
        val client = FixedCoreClient(14763, { token }, CoreHttpTransport { _, _, _ ->
            CoreHttpReply(0, "text/plain", "unexpected".toByteArray())
        })
        assertFails { client.execute(client.beginPage(true), send()) }
    }

    @Test fun fixedOriginAndNoBearerInReply() {
        var called = 0
        val client = FixedCoreClient(14763, { token }, CoreHttpTransport { request, _, _ ->
            called++
            assertEquals("http://127.0.0.1:14763/api/send", request.url.toString())
            assertEquals("Bearer $token", request.headers["authorization"])
            CoreHttpReply(200, "application/json", "{\"accepted\":true}".toByteArray())
        })
        assertFails { client.execute(1, send()) }
        val epoch = client.beginPage(true)
        val reply = client.execute(epoch, send())
        assertEquals(200, reply.status)
        assertFalse(reply.body.toString(Charsets.UTF_8).contains(token))
        assertEquals(1, called)
        assertFails { client.execute(epoch, send("//127.0.0.1:9999/api/send")) }
        assertFails { client.execute(epoch, CoreUiRequest("POST", "/api/send", mapOf("authorization" to "x"), byteArrayOf(1))) }
    }

    @Test fun nativeProofIsInjectedByTransportAndCannotBeSuppliedByPage() {
        val client = FixedCoreClient(14763, { token }, CoreHttpTransport { request, _, _ ->
            assertEquals("SYNTHETIC_ANDROID_PROOF", request.headers["x-ash-native-ui"])
            CoreHttpReply(200, "application/json", "{}".toByteArray())
        }, nativeUiToken = "SYNTHETIC_ANDROID_PROOF")
        val epoch = client.beginPage(true)
        client.execute(epoch, send())
        assertFails { client.execute(epoch, CoreUiRequest("POST", "/api/send", mapOf("x-ash-native-ui" to "forged"), "{}".toByteArray())) }
    }

    @Test fun bytesArePreservedAndOnlyTheCoreAddressIsReachable() {
        val source = byteArrayOf(0, 1, 2, -1)
        val seen = mutableListOf<String>()
        val client = FixedCoreClient(14763, { token }, CoreHttpTransport { request, _, _ ->
            seen += request.url.toString()
            CoreHttpReply(200, "application/octet-stream", source)
        })
        val epoch = client.beginPage(true)
        assertArrayEquals(source, client.execute(epoch, CoreUiRequest("GET", "/api/workspaces/home/files?path=notes%2Ftoday.txt")).body)
        // Any path on the core is carried; the core decides whether it is allowed.
        client.execute(epoch, CoreUiRequest("GET", "/api/vault"))
        assertEquals(listOf("http://127.0.0.1:14763/api/workspaces/home/files?path=notes%2Ftoday.txt", "http://127.0.0.1:14763/api/vault"), seen)
        // But never another place.
        for (path in listOf("//evil/api/send", "http://127.0.0.1:9999/api/send", "/a\\b", "/a#b", "no-slash"))
            assertFails { client.execute(epoch, CoreUiRequest("GET", path)) }
        assertFails { client.execute(epoch, CoreUiRequest("GET", "/api/send", mapOf("cookie" to "x"))) }
    }

    @Test fun navigationAbortsAndDropsLateReply() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val client = FixedCoreClient(14763, { token }, CoreHttpTransport { _, _, _ ->
            entered.countDown()
            release.await(2, TimeUnit.SECONDS)
            CoreHttpReply(200, "text/plain", "late".toByteArray())
        })
        val epoch = client.beginPage(true)
        var delivered = false
        val worker = thread {
            try { client.execute(epoch, send()); delivered = true } catch (_: IOException) { }
        }
        assertTrue(entered.await(1, TimeUnit.SECONDS))
        client.invalidate()
        release.countDown()
        worker.join(2_000)
        assertFalse(worker.isAlive)
        assertFalse(delivered)
        assertFails { client.execute(epoch, send()) }
    }

    @Test fun nativeCredentialNeverReturnsInBodyOrSplitStreamChunks() {
        val bodyClient = FixedCoreClient(14763, { token }, CoreHttpTransport { _, _, _ ->
            CoreHttpReply(200, "text/plain", "echo:$token".toByteArray())
        })
        val bodyEpoch = bodyClient.beginPage(true)
        assertFails { bodyClient.execute(bodyEpoch, send()) }

        val chunks = mutableListOf<ByteArray>()
        val streamClient = FixedCoreClient(14763, { token }, CoreHttpTransport { _, _, onChunk ->
            onChunk("prefix:$token".take(15).toByteArray())
            onChunk("prefix:$token".drop(15).toByteArray())
            CoreHttpReply(200, "text/event-stream", byteArrayOf())
        })
        val streamEpoch = streamClient.beginPage(true)
        assertFails { streamClient.execute(streamEpoch, CoreUiRequest("GET", "/api/stream?follow=true")) { chunks.add(it) } }
        assertFalse(chunks.flatMap { it.toList() }.toByteArray().toString(Charsets.UTF_8).contains(token))
    }

    @Test fun directHttpNeverFollowsRedirect() {
        ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { server ->
            val worker = thread {
                server.accept().use { socket ->
                    socket.getInputStream().bufferedReader().readLine()
                    socket.getOutputStream().write(("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").toByteArray())
                    socket.getOutputStream().flush()
                }
            }
            val client = FixedCoreClient(server.localPort, { token })
            val epoch = client.beginPage(true)
            assertFails { client.execute(epoch, CoreUiRequest("GET", "/api/stream?follow=false")) }
            worker.join(2_000)
            assertFalse(worker.isAlive)
        }
    }

    private fun assertFails(block: () -> Unit) {
        try { block(); fail("request should fail closed") } catch (_: IOException) { }
    }
}
