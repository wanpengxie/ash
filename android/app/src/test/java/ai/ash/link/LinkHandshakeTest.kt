package ai.ash.link

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The hand against a fake kernel on a loopback WebSocket: handshake, close codes, reconnecting, heartbeat. */
class LinkHandshakeTest {
    private val link = TestLink()
    @After fun end() = link.close()

    @Test fun helloAnswersTheChallengeAndTheKernelWelcomesTheHand() {
        link.client.start()
        val conn = link.kernel.awaitConn()
        assertEquals("Bearer test-token", conn.authorization)
        val hello = conn.awaitFrame("hello")
        assertEquals("ash-link/2", hello.getString("protocol"))
        val hand = hello.getJSONObject("hand")
        assertEquals("phone", hand.getString("kind"))
        assertEquals(link.identity.publicKey, hand.getString("public_key"))
        assertTrue(hello.getJSONObject("channels").has("device"))
        assertTrue(hello.getJSONObject("channels").has("human"))
        assertEquals("Test phone chat", hello.getJSONObject("channels").getJSONObject("human").getString("label"))
        assertEquals(0, hello.getJSONArray("features").length())
        // The signature is over the nonce the kernel sent.
        assertTrue(link.backend.verify("nonce-1234".toByteArray(), Base64.getUrlDecoder().decode(hello.getString("sig"))))

        conn.welcome()
        awaitTrue("ready") { link.client.state == LinkClient.State.READY }
        awaitTrue("welcomed") { link.handlers.welcomes.get() == 1 }
        assertTrue(link.client.channelOpen("device"))
        assertTrue(link.client.channelOpen("human"))
    }

    @Test fun theTokenIsNotInAnyFrame() {
        val conn = link.connect()
        for (f in conn.frames) assertFalse(f.toString().contains("test-token"))
    }

    @Test fun aKernelOfAnotherProtocolIsAnswered4008AndNotRetried() {
        link.kernel.onOpen = { it.challenge(protocol = "ash-link/9") }
        link.client.start()
        val conn = link.kernel.awaitConn()
        awaitTrue("stopped") { link.client.state == LinkClient.State.STOPPED }
        assertEquals(4008, conn.closedBy ?: awaitClose(conn))
        assertEquals(4008, link.client.stoppedBy)
        assertTrue(conn.framesOf("hello").isEmpty())
    }

    private fun awaitClose(conn: KernelConn): Int { awaitTrue("close") { conn.closedBy != null }; return conn.closedBy!! }

    @Test fun codes4003And4008And4009MeanNeverReconnect() {
        for (code in listOf(4003, 4008, 4009)) {
            TestLink().use { l ->
                l.kernel.onOpen = { it.close(code) }
                l.client.start()
                awaitTrue("stopped by $code") { l.client.state == LinkClient.State.STOPPED }
                assertEquals(code, l.client.stoppedBy)
                assertEquals(code, l.handlers.closes.last().code)
                assertFalse(l.handlers.closes.last().willReconnect)
                l.clock.advance(10 * 60_000)
                Thread.sleep(150)
                assertEquals("no new connection after $code", 1, l.kernel.conns.size)
                assertFalse(l.clock.scheduled.any { it < LinkProtocol.SILENCE_MS })
            }
        }
    }

    @Test fun code4001KeepsRetryingWithBackoff() {
        link.kernel.onOpen = { it.close(4001) }
        link.client.start()
        link.clock.awaitTimer(1000)
        assertEquals(LinkClient.State.WAITING, link.client.state)
        assertTrue(link.handlers.closes.last().willReconnect)
        assertNull(link.client.stoppedBy)
        link.clock.advance(1000)
        awaitTrue("second connection") { link.kernel.conns.size == 2 }
    }

    @Test fun theBackoffIs1_2_4_8_16_30SecondsThen30Forever() {
        link.kernel.onOpen = { it.close(4001) }
        link.client.start()
        val expected = listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000, 30000)
        for ((i, delay) in expected.withIndex()) {
            link.clock.awaitTimer(delay)
            assertEquals(delay, link.clock.pending().filter { it < LinkProtocol.SILENCE_MS }.single())
            link.clock.advance(delay)
            awaitTrue("connection ${i + 2}") { link.kernel.conns.size == i + 2 }
        }
        assertEquals(expected, link.clock.scheduled.filter { it < LinkProtocol.SILENCE_MS }.take(expected.size))
    }

    @Test fun theJitterIsPlusOrMinus20Percent() {
        assertEquals(800L, reconnectDelay(0) { 0.0 })
        assertEquals(1200L, reconnectDelay(0) { 1.0 })
        assertEquals(1000L, reconnectDelay(0) { 0.5 })
        assertEquals(24000L, reconnectDelay(5) { 0.0 })
        assertEquals(36000L, reconnectDelay(99) { 1.0 })
    }

    @Test fun aWelcomeStartsTheBackoffOver() {
        link.kernel.onOpen = { it.close(4001) }
        link.client.start()
        link.clock.awaitTimer(1000); link.clock.advance(1000)
        link.clock.awaitTimer(2000)
        link.kernel.onOpen = { it.challenge() }
        link.clock.advance(2000)
        val conn = link.kernel.awaitConn(2)
        conn.awaitFrame("hello"); conn.welcome()
        awaitTrue("ready") { link.client.state == LinkClient.State.READY }
        link.kernel.onOpen = { it.close(4001) }
        conn.close(4500)
        link.clock.awaitTimer(1000)
        link.clock.advance(1000)
        link.clock.awaitTimer(2000) // the second failure of the new run, not the fourth of the old one
    }

    @Test fun aNewAttachReconnectsAtOnceWhetherWaitingOrStopped() {
        link.kernel.onOpen = { it.close(4001) }
        link.client.start()
        link.clock.awaitTimer(1000)
        link.kernel.onOpen = { it.challenge() }
        link.client.reconnectNow()
        awaitTrue("connected without waiting") { link.kernel.conns.size == 2 }

        link.kernel.onOpen = { it.close(4009) }
        link.client.reconnectNow()
        awaitTrue("stopped") { link.client.state == LinkClient.State.STOPPED }
        link.kernel.onOpen = { it.challenge() }
        link.client.reconnectNow()
        awaitTrue("connected again") { link.kernel.conns.size == 4 }
        assertNull(link.client.stoppedBy)
    }

    @Test fun reconnectNowDropsTheLiveConnectionAndUsesTheNewToken() {
        val first = link.connect()
        link.token = "second-token"
        link.client.reconnectNow()
        val second = link.kernel.awaitConn(1)
        assertEquals("Bearer second-token", second.authorization)
        awaitTrue("first closed") { first.closedBy != null }
        assertEquals(1000, first.closedBy)
        second.awaitFrame("hello")
        assertEquals(1, link.handlers.closes.size)
    }

    @Test fun anotherPortOrTokenIsReadOnEveryAttempt() {
        link.token = "one"
        link.kernel.onOpen = { it.close(4001) }
        link.client.start()
        link.clock.awaitTimer(1000)
        link.token = "two"
        link.clock.advance(1000)
        awaitTrue("second attempt") { link.kernel.conns.size == 2 }
        assertEquals("Bearer two", link.kernel.conns[1].authorization)
    }

    @Test fun theKernelsPingIsAnsweredAndTheHandPingsEveryHeartbeat() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "ping").put("at", 7))
        assertEquals(7L, conn.awaitFrame("pong").getLong("at"))
        link.clock.awaitTimer(30_000)
        link.clock.advance(30_000)
        assertNotNull(conn.awaitFrame("ping"))
        link.clock.awaitTimer(30_000)
        link.clock.advance(30_000)
        conn.awaitFrame("ping", 1)
    }

    @Test fun ninetySecondsOfSilenceDropTheConnectionAndItIsRetried() {
        val conn = link.connect()
        // Frames from the kernel keep it alive: 80 s, a ping, another 80 s.
        link.clock.advance(80_000)
        conn.send(JSONObject().put("t", "ping").put("at", 1))
        conn.awaitFrame("pong")
        link.clock.advance(80_000)
        assertEquals(LinkClient.State.READY, link.client.state)
        // Then nothing for 90 s.
        link.clock.advance(LinkProtocol.SILENCE_MS)
        awaitTrue("dropped") { link.client.state == LinkClient.State.WAITING }
        assertTrue(link.handlers.closes.last().willReconnect)
        link.clock.awaitTimer(1000)
        link.clock.advance(1000)
        awaitTrue("reconnected") { link.kernel.conns.size == 2 }
    }

    @Test fun aSilentKernelDuringTheHandshakeIsAlsoDropped() {
        link.kernel.onOpen = { }
        link.client.start()
        link.kernel.awaitConn()
        link.clock.awaitTimer(LinkProtocol.SILENCE_MS)
        link.clock.advance(LinkProtocol.SILENCE_MS)
        awaitTrue("dropped") { link.client.state == LinkClient.State.WAITING }
    }

    @Test fun aFrameThatBreaksTheProtocolIsAnsweredWithAnErrorAnd4400ThenRetried() {
        val conn = link.connect()
        conn.sendRaw("""{"t":"ping","at":1,"extra":true}""")
        val error = conn.awaitFrame("error")
        assertEquals("bad_request", error.getString("code"))
        awaitTrue("closed with 4400") { link.handlers.closes.any { it.code == 4400 } }
        assertTrue(link.handlers.closes.last().willReconnect)
        link.clock.awaitTimer(1000)
    }

    @Test fun aFrameOnlyAHandMaySendIsAProtocolError() {
        val conn = link.connect()
        conn.send(JSONObject().put("t", "result").put("id", "x").put("ok", true).put("content", org.json.JSONArray()))
        awaitTrue("closed with 4400") { link.handlers.closes.any { it.code == 4400 } }
    }

    @Test fun binaryMessagesAreRefused() {
        val conn = link.connect()
        conn.socket!!.send(okio.ByteString.of(1, 2, 3))
        awaitTrue("closed with 4400") { link.handlers.closes.any { it.code == 4400 } }
    }

    @Test fun anUnknownFrameBeforeTheChallengeAnswerIsRefused() {
        link.kernel.onOpen = { it.welcome() }
        link.client.start()
        link.kernel.awaitConn()
        awaitTrue("closed with 4400") { link.handlers.closes.any { it.code == 4400 } }
    }

    @Test fun stopEndsTheClientForGood() {
        val conn = link.connect()
        link.client.stop()
        awaitTrue("closed") { conn.closedBy != null }
        assertEquals(LinkClient.State.STOPPED, link.client.state)
        link.clock.advance(10 * 60_000)
        Thread.sleep(100)
        assertEquals(1, link.kernel.conns.size)
    }

    @Test fun theHumanChannelSendsAWordAndGetsTheResultBack() {
        val conn = link.connect()
        val future = link.client.send(JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say").put("body", JSONObject().put("text", "hi")))
        val sent = conn.awaitFrame("send")
        assertEquals("human", sent.getString("ch"))
        assertEquals("say", sent.getJSONObject("request").getString("word"))
        conn.send(JSONObject().put("t", "send.result").put("id", sent.getString("id")).put("ok", true).put("message", JSONObject().put("id", "m1").put("seq", 4)))
        val result = future.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertEquals(4, result.getJSONObject("message").getInt("seq"))
    }

    @Test fun aSendWithoutAConnectionFails() {
        val future = link.client.send(JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say").put("body", JSONObject()))
        try { future.get(5, java.util.concurrent.TimeUnit.SECONDS); throw AssertionError("should fail") }
        catch (e: java.util.concurrent.ExecutionException) { assertTrue(e.cause is LinkException) }
    }

    @Test fun aSendInFlightWhenTheConnectionDropsFails() {
        val conn = link.connect()
        val future = link.client.send(JSONObject().put("to", "agent:main").put("kind", "request").put("word", "say").put("body", JSONObject()))
        conn.awaitFrame("send")
        conn.close(4500)
        try { future.get(5, java.util.concurrent.TimeUnit.SECONDS); throw AssertionError("should fail") }
        catch (e: java.util.concurrent.ExecutionException) { assertTrue(e.cause is LinkException) }
    }
}
