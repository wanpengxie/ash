package ai.ash.host

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec

/**
 * The phone's gateway identity: one P-256 key in the Android Keystore. ash core never sees the
 * private key; it asks the host bridge to sign (`POST /sign`). The gateway accepts DER signatures.
 *
 * An identity created by the earlier ash-link (a JWK file) is imported once, so a gateway that
 * phone already claimed stays claimed and paired devices stay paired; the file is then deleted.
 */
object Keys {
    private const val TAG = "ash.keys"
    private const val ALIAS = "ash-owner"

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /** Whether the phone's identity is in the Keystore (after which the old key file is not needed). */
    fun present(): Boolean = try { store().containsAlias(ALIAS) } catch (e: Exception) { false }

    @Synchronized
    fun ensure(p: Paths) {
        val ks = store()
        if (ks.containsAlias(ALIAS)) return
        val legacy = File(p.legacyLink, "state/device.jwk")
        if (legacy.exists()) {
            try {
                importJwk(JSONObject(legacy.readText()))
                legacy.delete()
                Log.i(TAG, "imported the earlier gateway identity into the Keystore")
                return
            } catch (e: Exception) {
                Log.w(TAG, "could not import the earlier identity; generating a new one", e)
            }
        }
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        kpg.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        kpg.generateKeyPair()
    }

    /** SubjectPublicKeyInfo DER, base64url — the gateway's `pubkey`. */
    fun publicKey(): String = b64u(store().getCertificate(ALIAS).publicKey.encoded)

    /** Gateway device id: base64url(SHA-256(SPKI)) truncated to 22 characters. */
    fun id(): String = b64u(MessageDigest.getInstance("SHA-256").digest(store().getCertificate(ALIAS).publicKey.encoded)).substring(0, 22)

    fun sign(data: ByteArray): String {
        val key = store().getKey(ALIAS, null) as PrivateKey
        return b64u(Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() })
    }

    // ------------------------------------------------------------------ JWK import

    private fun importJwk(jwk: JSONObject) {
        val params = (KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey).params
        val kf = KeyFactory.getInstance("EC")
        val priv = kf.generatePrivate(ECPrivateKeySpec(BigInteger(1, unb64u(jwk.getString("d"))), params))
        val pub = kf.generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, unb64u(jwk.getString("x"))), BigInteger(1, unb64u(jwk.getString("y")))), params))
        // The Keystore stores private keys only with a certificate chain: a minimal self-signed one.
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(selfSigned(pub.encoded, priv)))
        store().setEntry(ALIAS, KeyStore.PrivateKeyEntry(priv, arrayOf(cert)), KeyProtection.Builder(KeyProperties.PURPOSE_SIGN).setDigests(KeyProperties.DIGEST_SHA256).build())
    }

    private fun selfSigned(spki: ByteArray, priv: PrivateKey): ByteArray {
        val ecdsaSha256 = seq(oid(byteArrayOf(0x2a, 0x86.toByte(), 0x48, 0xce.toByte(), 0x3d, 0x04, 0x03, 0x02)))
        val name = seq(set(seq(oid(byteArrayOf(0x55, 0x04, 0x03)), tlv(0x0c, "ash".toByteArray()))))
        val validity = seq(tlv(0x17, "250101000000Z".toByteArray()), tlv(0x17, "491231235959Z".toByteArray()))
        val tbs = seq(tlv(0xa0, tlv(0x02, byteArrayOf(2))), tlv(0x02, byteArrayOf(1)), ecdsaSha256, name, validity, name, spki)
        val sig = Signature.getInstance("SHA256withECDSA").run { initSign(priv); update(tbs); sign() }
        return seq(tbs, ecdsaSha256, tlv(0x03, byteArrayOf(0) + sig))
    }

    private fun tlv(tag: Int, body: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        val n = body.size
        when {
            n < 0x80 -> out.write(n)
            n < 0x100 -> { out.write(0x81); out.write(n) }
            else -> { out.write(0x82); out.write(n shr 8); out.write(n and 0xff) }
        }
        out.write(body)
        return out.toByteArray()
    }

    private fun seq(vararg parts: ByteArray) = tlv(0x30, parts.fold(ByteArray(0)) { a, b -> a + b })
    private fun set(vararg parts: ByteArray) = tlv(0x31, parts.fold(ByteArray(0)) { a, b -> a + b })
    private fun oid(b: ByteArray) = tlv(0x06, b)

    fun b64u(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun unb64u(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
