package ai.ash.senses

import ai.ash.senses.health.Ccm
import ai.ash.senses.health.ScaleReading
import ai.ash.senses.health.XiaomiScale
import ai.ash.senses.health.XiaomiScale.hex
import ai.ash.senses.health.XiaomiScaleSource
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The scale's broadcasts and the AES-CCM under them. Every key and address here is made up; the frame layout and the
 * plaintext are those of a real Xiaomi Smart Scale S200 weigh-in (71.65 kg).
 */
class XiaomiScaleTest {
    private val mac = "A4:C1:38:0A:1B:2C"
    private val key = hex("5f3c1a2b4d6e7f8091a2b3c4d5e6f708")
    /** Encrypted weigh-in, no address in the frame (computed once with Python's cryptography AESCCM from the key above). */
    private val frame = hex("4859c9458a436a76c9c94a8bf9174ef92e3b00003678c1e8")
    /** The same weigh-in, with the (reversed) address in the frame. */
    private val frameWithMac = hex("5859c9458a2c1b0a38c1a4436a76c9c94a8bf9174ef92e3b00003678c1e8")
    private val plain = hex("164e0901fd1b00007c59c56a")

    @Test fun ccmMatchesRfc3610PacketVector1() {
        val k = hex("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf")
        val nonce = hex("00000003020100a0a1a2a3a4a5")
        val aad = hex("0001020304050607")
        val msg = hex("08090a0b0c0d0e0f101112131415161718191a1b1c1d1e")
        val sealed = hex("588c979a61c663d2f066d0c2c0f989806d5f6b61dac38417e8d12cfdf926e0")
        assertArrayEquals(sealed, Ccm.encrypt(k, nonce, aad, msg, 8))
        assertArrayEquals(msg, Ccm.decrypt(k, nonce, aad, sealed, 8))
    }

    @Test fun ccmMatchesAReferenceVectorShapedLikeTheScale() {
        // 12-byte nonce (L = 3), 4-byte tag, associated data 0x11: Python cryptography's AESCCM gave this.
        val nonce = hex("2c1b0a38c1a4c9458a3b0000")
        assertArrayEquals(hex("436a76c9c94a8bf9174ef92e3678c1e8"), Ccm.encrypt(key, nonce, byteArrayOf(0x11), plain, 4))
    }

    @Test fun ccmRoundTripsAndRejectsTampering() {
        val k = ByteArray(16) { (it * 7 + 3).toByte() }
        val nonce = ByteArray(12) { (it + 1).toByte() }
        for (len in listOf(0, 1, 15, 16, 17, 40)) {
            val msg = ByteArray(len) { (it * 31).toByte() }
            val sealed = Ccm.encrypt(k, nonce, byteArrayOf(0x11), msg, 4)
            assertEquals(len + 4, sealed.size)
            assertArrayEquals(msg, Ccm.decrypt(k, nonce, byteArrayOf(0x11), sealed, 4))
            for (i in sealed.indices) {
                val bad = sealed.copyOf().also { it[i] = (it[i].toInt() xor 1).toByte() }
                assertNull(Ccm.decrypt(k, nonce, byteArrayOf(0x11), bad, 4))
            }
            assertNull(Ccm.decrypt(k, nonce, byteArrayOf(0x12), sealed, 4))
        }
    }

    @Test fun decodesAWeighIn() {
        val r = XiaomiScale.parse(frame, mac, key)!!
        assertEquals(71.65, r.weightKg, 1e-9)
        assertEquals(1, r.profile)
        assertEquals(0x6ac5597cL * 1000, r.ts)
        assertEquals(r, XiaomiScale.parse(frameWithMac, mac.lowercase(), key))
    }

    @Test fun presenceFramesAreIgnored() {
        // Not encrypted, no object: only the frame counter and the address.
        assertNull(XiaomiScale.parse(hex("1059c94589") + hex("2c1b0a38c1a4"), mac, key))
        assertNull(XiaomiScale.parse(hex("1059c94589"), mac, key))
    }

    @Test fun anotherScaleOrModelIsRejected() {
        assertNull(XiaomiScale.parse(frameWithMac, "A4:C1:38:0A:1B:2D", key))
        // Without the address in the frame the wrong address gives the wrong nonce: the tag fails.
        assertNull(XiaomiScale.parse(frame, "A4:C1:38:0A:1B:2D", key))
        assertNull(XiaomiScale.parse(frame, mac, key, productId = 0x0b48))
        assertNull(XiaomiScale.parse(frame, "not a mac", key))
    }

    @Test fun aBadTagOrKeyGivesNothing() {
        val bad = frame.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 0x40).toByte() }
        assertNull(XiaomiScale.parse(bad, mac, key))
        val flipped = frame.copyOf().also { it[7] = (it[7].toInt() xor 1).toByte() }
        assertNull(XiaomiScale.parse(flipped, mac, key))
        assertNull(XiaomiScale.parse(frame, mac, ByteArray(16)))
        // An old protocol version is not read.
        assertNull(XiaomiScale.parse(frame.copyOf().also { it[1] = 0x39 }, mac, key))
    }

    @Test fun truncatedFramesGiveNothing() {
        for (n in 0 until frame.size) assertNull(XiaomiScale.parse(frame.copyOf(n), mac, key))
        for (n in 0 until frameWithMac.size) assertNull(XiaomiScale.parse(frameWithMac.copyOf(n), mac, key))
    }

    @Test fun otherObjectsAreSkipped() {
        val nonce = hex("2c1b0a38c1a4c9458a3b0000")
        fun sealed(p: ByteArray): ByteArray {
            val c = Ccm.encrypt(key, nonce, byteArrayOf(0x11), p, 4)
            return hex("4859c9458a") + c.copyOf(c.size - 4) + hex("3b0000") + c.copyOfRange(c.size - 4, c.size)
        }
        // An unknown object first, then the weight.
        assertEquals(71.65, XiaomiScale.parse(sealed(hex("0a1002aabb") + plain), mac, key)!!.weightKg, 1e-9)
        // Only unknown objects, or an object longer than the plaintext: nothing.
        assertNull(XiaomiScale.parse(sealed(hex("0a1002aabb")), mac, key))
        assertNull(XiaomiScale.parse(sealed(hex("164e0901fd1b")), mac, key))
    }

    @Test fun addressAndKeyFormats() {
        assertEquals("D0:7B:6F:49:F5:99", XiaomiScale.normalizeMac("d0:7b:6f:49:f5:99"))
        assertEquals("D0:7B:6F:49:F5:99", XiaomiScale.normalizeMac(" D07B6F49F599 "))
        assertEquals("D0:7B:6F:49:F5:99", XiaomiScale.normalizeMac("d0-7b-6f-49-f5-99"))
        assertNull(XiaomiScale.normalizeMac("D0:7B:6F:49:F5"))
        assertNull(XiaomiScale.normalizeMac("G0:7B:6F:49:F5:99"))
        assertArrayEquals(key, XiaomiScale.parseKey("5F3C1A2B 4D6E7F80 91A2B3C4 D5E6F708"))
        assertNull(XiaomiScale.parseKey("5f3c1a2b4d6e7f8091a2b3c4d5e6f7"))
        assertNull(XiaomiScale.parseKey("5f3c1a2b4d6e7f8091a2b3c4d5e6f70z"))
    }

    @Test fun eachWeighInIsKeyedOnce() {
        val a = XiaomiScale.parse(frame, mac, key)!!
        assertEquals(a.key, XiaomiScale.parse(frameWithMac, mac, key)!!.key)
        assertEquals("${0x6ac5597cL * 1000}|7165|1", a.key)
        assertNotEquals(a.key, a.copy(weightKg = 71.70).key)
        assertNotEquals(a.key, a.copy(profile = 2).key)
        assertNotEquals(a.key, a.copy(ts = a.ts + 1000).key)
    }

    @Test fun aWeighInIsPushedAsWeightInKg() {
        val now = 0x6ac5597cL * 1000 + 5_000
        val row = XiaomiScaleSource.row(ScaleReading(0x6ac5597cL * 1000, 71.65, 1), now)
        val item = row.toEvent()
        assertEquals(setOf("ts", "metric", "value", "unit", "source"), item.keySet())
        assertEquals(0x6ac5597cL * 1000, item.getLong("ts"))
        assertEquals("weight", item.getString("metric"))
        assertEquals(71.65, item.getDouble("value"), 0.0)
        assertEquals("kg", item.getString("unit"))
        assertEquals("xiaomi:yunmai.scales.ms106", item.getString("source"))
        assertEquals(71.7, XiaomiScaleSource.row(ScaleReading(row.ts, 71.699999, 1), now).value, 0.0)
        // A scale clock that is clearly wrong gives way to when the phone heard it.
        assertEquals(now, XiaomiScaleSource.row(ScaleReading(86_400_000L, 71.65, 1), now).ts)
    }
}
