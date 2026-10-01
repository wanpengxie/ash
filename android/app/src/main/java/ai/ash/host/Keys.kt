package ai.ash.host

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** The phone's gateway identity lives in Android Keystore; ash core never receives the private key. */
object Keys {
    private const val ALIAS = "ash-owner"

    private fun store(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized
    fun ensure() {
        if (store().containsAlias(ALIAS)) return
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        kpg.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .build(),
        )
        kpg.generateKeyPair()
    }

    fun publicKey(): String = b64u(store().getCertificate(ALIAS).publicKey.encoded)

    fun id(): String = b64u(MessageDigest.getInstance("SHA-256").digest(store().getCertificate(ALIAS).publicKey.encoded)).substring(0, 22)

    fun sign(data: ByteArray): String {
        val key = store().getKey(ALIAS, null) as PrivateKey
        return b64u(Signature.getInstance("SHA256withECDSA").run { initSign(key); update(data); sign() })
    }

    fun b64u(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun unb64u(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
