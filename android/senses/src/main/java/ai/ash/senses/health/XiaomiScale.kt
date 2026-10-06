package ai.ash.senses.health

/** One weigh-in as the scale reported it: when ([ts], ms), the weight, and which of the scale's users stepped on. */
data class ScaleReading(val ts: Long, val weightKg: Double, val profile: Int) {
    /** The same weigh-in is broadcast many times: this names it once. */
    val key: String get() = "$ts|${Math.round(weightKg * 100)}|$profile"
}

/**
 * Xiaomi MiBeacon (v4/v5) advertisements of a Xiaomi scale, as BLE service data under UUID FE95. After each weigh-in
 * the scale repeats one encrypted frame (AES-CCM with the scale's beacon key); in between it only says it is there.
 * Anything that is not a well-formed, authentic weigh-in from the configured scale reads as null: radio noise never
 * throws.
 */
object XiaomiScale {
    const val SERVICE_UUID = "0000fe95-0000-1000-8000-00805f9b34fb"
    /** Xiaomi Smart Scale S200: weight only. */
    const val MODEL = "yunmai.scales.ms106"
    const val PRODUCT_ID = 0x45c9
    const val SOURCE = "xiaomi:$MODEL"
    private const val OBJECT_WEIGHT = 0x4e16
    private const val ENCRYPTED = 0x08
    private const val HAS_MAC = 0x10
    private const val HAS_CAPABILITY = 0x20
    private const val HAS_OBJECT = 0x40

    /** "D0:7B:6F:49:F5:99" (any case, with ':' or '-' or nothing between) as "D0:7B:6F:49:F5:99"; null when it is not one. */
    fun normalizeMac(text: String): String? {
        val hex = text.trim().replace(":", "").replace("-", "").uppercase()
        if (!Regex("[0-9A-F]{12}").matches(hex)) return null
        return hex.chunked(2).joinToString(":")
    }

    /** A 32-hex-digit beacon key as its 16 bytes; null when it is not one. */
    fun parseKey(text: String): ByteArray? {
        val hex = text.replace(" ", "").trim().lowercase()
        if (!Regex("[0-9a-f]{32}").matches(hex)) return null
        return hex(hex)
    }

    /**
     * The weigh-in in [data] (the FE95 service data) from the scale at [mac] with [key]; null for a presence frame,
     * another device, a damaged or forged frame, or an object other than a weight.
     */
    fun parse(data: ByteArray, mac: String, key: ByteArray, productId: Int = PRODUCT_ID): ScaleReading? = try {
        decode(data, mac, key, productId)
    } catch (e: RuntimeException) { null }

    private fun decode(data: ByteArray, mac: String, key: ByteArray, productId: Int): ScaleReading? {
        if (data.size < 5) return null
        val control = u8(data, 0)
        val version = u8(data, 1) ushr 4
        if (version < 4) return null
        if (u16(data, 2) != productId) return null
        if (control and HAS_OBJECT == 0 || control and ENCRYPTED == 0) return null
        val macReversed = hex((normalizeMac(mac) ?: return null).replace(":", "")).reversedArray()
        var pos = 5
        if (control and HAS_MAC != 0) {
            if (data.size < pos + 6 || !data.copyOfRange(pos, pos + 6).contentEquals(macReversed)) return null
            pos += 6
        }
        if (control and HAS_CAPABILITY != 0) {
            if (data.size <= pos) return null
            val capability = u8(data, pos)
            pos += if (capability and 0x20 != 0) 3 else 1
        }
        // Then the ciphertext, a 3-byte extension of the frame counter, and the 4-byte tag.
        if (data.size < pos + 3 + 7) return null
        val cipher = data.copyOfRange(pos, data.size - 7)
        val extCounter = data.copyOfRange(data.size - 7, data.size - 4)
        val tag = data.copyOfRange(data.size - 4, data.size)
        val nonce = macReversed + data.copyOfRange(2, 4) + data[4] + extCounter
        val plain = Ccm.decrypt(key, nonce, byteArrayOf(0x11), cipher + tag, 4) ?: return null
        return weight(plain)
    }

    /** The first weight object of [plain] (objects: id u16 LE, length u8, data); others are skipped. */
    private fun weight(plain: ByteArray): ScaleReading? {
        var pos = 0
        while (pos + 3 <= plain.size) {
            val id = u16(plain, pos)
            val len = u8(plain, pos + 2)
            pos += 3
            if (pos + len > plain.size) return null
            if (id == OBJECT_WEIGHT && len >= 9) {
                val profile = u8(plain, pos)
                val weight = u32(plain, pos + 1)
                val seconds = u32(plain, pos + 5)
                if (weight <= 0 || seconds <= 0) return null
                return ScaleReading(seconds * 1000, weight / 100.0, profile)
            }
            pos += len
        }
        return null
    }

    private fun u8(b: ByteArray, i: Int) = b[i].toInt() and 0xff
    private fun u16(b: ByteArray, i: Int) = u8(b, i) or (u8(b, i + 1) shl 8)
    private fun u32(b: ByteArray, i: Int): Long = (u16(b, i).toLong() or (u16(b, i + 2).toLong() shl 16))

    fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
}
