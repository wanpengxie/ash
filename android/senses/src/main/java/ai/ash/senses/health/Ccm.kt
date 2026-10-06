package ai.ash.senses.health

import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * AES-CCM (RFC 3610) on top of plain AES blocks: Android's "AES/CCM/NoPadding" is not on every phone. CBC-MAC over
 * B0, the associated data and the message gives the tag; CTR mode (counter 0 for the tag, 1… for the message) encrypts.
 * The nonce is 7 to 13 bytes (L = 15 - nonce length), the tag 4 to 16 bytes, even.
 */
object Ccm {
    /** [plain] encrypted, with the [tagLen]-byte tag appended. */
    fun encrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, plain: ByteArray, tagLen: Int): ByteArray {
        val aes = aes(key)
        val tag = mac(aes, nonce, aad, plain, tagLen)
        val out = ctr(aes, nonce, plain)
        return out + xor(tag, block(aes, counter(nonce, 0)), tagLen)
    }

    /** The message of [sealed] (ciphertext and tag); null when the tag does not match. */
    fun decrypt(key: ByteArray, nonce: ByteArray, aad: ByteArray, sealed: ByteArray, tagLen: Int): ByteArray? {
        if (sealed.size < tagLen) return null
        val aes = aes(key)
        val plain = ctr(aes, nonce, sealed.copyOfRange(0, sealed.size - tagLen))
        val expected = xor(mac(aes, nonce, aad, plain, tagLen), block(aes, counter(nonce, 0)), tagLen)
        return if (MessageDigest.isEqual(expected, sealed.copyOfRange(sealed.size - tagLen, sealed.size))) plain else null
    }

    private fun aes(key: ByteArray): Cipher {
        require(key.size == 16 || key.size == 24 || key.size == 32) { "AES key must be 16, 24 or 32 bytes" }
        return Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }
    }

    private fun block(aes: Cipher, b: ByteArray): ByteArray = aes.doFinal(b)

    private fun lengthOf(nonce: ByteArray): Int {
        require(nonce.size in 7..13) { "CCM nonce must be 7 to 13 bytes" }
        return 15 - nonce.size
    }

    /** A_i: flags (L - 1), the nonce, then i in L bytes. */
    private fun counter(nonce: ByteArray, i: Int): ByteArray {
        val l = lengthOf(nonce)
        val a = ByteArray(16)
        a[0] = (l - 1).toByte()
        nonce.copyInto(a, 1)
        for (k in 0 until l) a[15 - k] = (i.toLong() ushr (8 * k)).toByte()
        return a
    }

    private fun ctr(aes: Cipher, nonce: ByteArray, input: ByteArray): ByteArray {
        val out = ByteArray(input.size)
        var i = 0
        while (i < input.size) {
            val s = block(aes, counter(nonce, i / 16 + 1))
            for (k in 0 until minOf(16, input.size - i)) out[i + k] = (input[i + k].toInt() xor s[k].toInt()).toByte()
            i += 16
        }
        return out
    }

    private fun mac(aes: Cipher, nonce: ByteArray, aad: ByteArray, plain: ByteArray, tagLen: Int): ByteArray {
        require(tagLen in 4..16 && tagLen % 2 == 0) { "CCM tag must be 4 to 16 bytes, even" }
        val l = lengthOf(nonce)
        require(l >= 4 || plain.size < (1 shl (8 * l))) { "message too long for this nonce" }
        require(aad.size < 0xFF00) { "associated data too long" }
        val b0 = ByteArray(16)
        b0[0] = ((if (aad.isNotEmpty()) 0x40 else 0) or (((tagLen - 2) / 2) shl 3) or (l - 1)).toByte()
        nonce.copyInto(b0, 1)
        for (k in 0 until l) b0[15 - k] = (plain.size.toLong() ushr (8 * k)).toByte()
        // B0, then the associated data with its 2-byte length, then the message; each part padded to whole blocks.
        val header = if (aad.isEmpty()) ByteArray(0) else byteArrayOf((aad.size ushr 8).toByte(), aad.size.toByte()) + aad
        var x = block(aes, b0)
        for (part in listOf(header, plain)) {
            var i = 0
            while (i < part.size) {
                val y = x.copyOf()
                for (k in 0 until minOf(16, part.size - i)) y[k] = (y[k].toInt() xor part[i + k].toInt()).toByte()
                x = block(aes, y)
                i += 16
            }
        }
        return x.copyOf(tagLen)
    }

    private fun xor(a: ByteArray, b: ByteArray, n: Int) = ByteArray(n) { (a[it].toInt() xor b[it].toInt()).toByte() }
}
