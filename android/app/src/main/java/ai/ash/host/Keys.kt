package ai.ash.host

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.io.File
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

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

    private const val VAULT_ALIAS = "ash-vault-wrap"

    /**
     * The key that seals core's credential vault on disk. It is random, stored only wrapped by a non-exportable
     * Keystore key (file: IV then AES-GCM ciphertext), and handed to core at each start.
     */
    @Synchronized
    fun vaultSealKey(file: File): String {
        val ks = store()
        if (!ks.containsAlias(VAULT_ALIAS)) {
            val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            kg.init(
                KeyGenParameterSpec.Builder(VAULT_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            kg.generateKey()
        }
        val wrap = ks.getKey(VAULT_ALIAS, null) as SecretKey
        if (file.exists()) {
            val sealed = file.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrap, GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            return b64u(cipher.doFinal(sealed.copyOfRange(12, sealed.size)))
        }
        val raw = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrap)
        val sealed = cipher.iv + cipher.doFinal(raw)
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeBytes(sealed)
        if (!tmp.renameTo(file)) throw IllegalStateException("vault key could not be stored")
        return b64u(raw)
    }

    fun b64u(b: ByteArray): String = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun unb64u(s: String): ByteArray = Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
}
