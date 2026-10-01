package ai.ash.host.senses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicReference

class SenseTransportTest {
    @Test fun fakeHostReceivesExactEnvelopeAndHeader() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val received = AtomicReference<Pair<Map<String, String>, JSONObject>>()
            val worker = Thread {
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    assertEquals("POST /api/send HTTP/1.1", input.readLine())
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = input.readLine()
                        if (line.isEmpty()) break
                        val index = line.indexOf(':')
                        if (index > 0) headers[line.substring(0, index).lowercase()] = line.substring(index + 1).trim()
                    }
                    val count = headers.getValue("content-length").toInt()
                    val chars = CharArray(count)
                    var offset = 0
                    while (offset < count) offset += input.read(chars, offset, count - offset)
                    received.set(headers to JSONObject(String(chars)))
                    val response = "{\"id\":\"message-1\",\"seq\":1}"
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${response.length}\r\n\r\n$response".toByteArray())
                }
            }
            worker.start()
            SenseTransport("http://127.0.0.1:${server.localPort}", "test-token")
                .send("sense.battery", JSONObject().put("level", 14), "event-1")
            worker.join(2_000)
            assertFalse(worker.isAlive)
            val (headers, request) = received.get()
            assertEquals("Bearer test-token", headers["authorization"])
            assertTrue(request.isNull("to"))
            assertEquals("event", request.getString("kind"))
            assertEquals("sense.battery", request.getString("word"))
            assertEquals(14, request.getJSONObject("body").getInt("level"))
            assertEquals("event-1", request.getString("client_id"))
            assertFalse(request.has("from"))
            assertFalse(request.has("origin"))
        }
    }

    @Test fun invalidWordAndMissingIdFailClosed() {
        val transport = SenseTransport("http://127.0.0.1:1", "test-token")
        assertThrows(IllegalArgumentException::class.java) { transport.send("say", JSONObject(), "id") }
        assertThrows(IllegalArgumentException::class.java) { transport.send("sense.screen", JSONObject(), "") }
    }

    @Test fun notificationEventUsesExistingAuthenticatedSenseEnvelope() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val received = AtomicReference<JSONObject>()
            val worker = Thread {
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    assertEquals("POST /api/send HTTP/1.1", input.readLine())
                    var count = 0
                    while (true) {
                        val line = input.readLine()
                        if (line.isEmpty()) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) count = line.substringAfter(':').trim().toInt()
                    }
                    val chars = CharArray(count)
                    var offset = 0
                    while (offset < count) offset += input.read(chars, offset, count - offset)
                    received.set(JSONObject(String(chars)))
                    val response = "{\"id\":\"message-2\",\"seq\":2}"
                    socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: ${response.length}\r\n\r\n$response".toByteArray())
                }
            }
            worker.start()
            SenseTransport("http://127.0.0.1:${server.localPort}", "synthetic-token")
                .send("sense.notification", JSONObject().put("app", "test.sender").put("title", "Hello").put("text", "Body"), "notification-1")
            worker.join(2_000)
            assertFalse(worker.isAlive)
            val request = received.get()
            assertTrue(request.isNull("to"))
            assertEquals("event", request.getString("kind"))
            assertEquals("sense.notification", request.getString("word"))
            assertEquals("notification-1", request.getString("client_id"))
            assertEquals("test.sender", request.getJSONObject("body").getString("app"))
            assertFalse(request.has("from"))
        }
    }

    @Test fun fakeHostRejectsWithoutLeakingToken() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { server ->
            val worker = Thread {
                server.accept().use { socket ->
                    val input = socket.getInputStream()
                    val buffer = ByteArray(2048)
                    input.read(buffer)
                    socket.getOutputStream().write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n".toByteArray())
                }
            }
            worker.start()
            val error = assertThrows(IllegalStateException::class.java) {
                SenseTransport("http://127.0.0.1:${server.localPort}", "test-token")
                    .send("sense.screen", JSONObject().put("state", "on").put("away_ms", 0), "event-2")
            }
            worker.join(2_000)
            assertTrue(error.message!!.contains("403"))
            assertFalse(error.message!!.contains("test-token"))
        }
    }
}
