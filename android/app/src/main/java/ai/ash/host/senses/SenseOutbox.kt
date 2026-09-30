package ai.ash.host.senses

import java.security.MessageDigest
import java.util.UUID

/** A tiny durable acknowledgement journal for independently delivered sensor events. */
internal class SenseOutbox(private val store: Store) {
    interface Store {
        fun get(key: String): String?
        fun keys(): Set<String>
        fun commit(puts: Map<String, String> = emptyMap(), removes: Set<String> = emptySet()): Boolean
    }

    private fun digest(key: String): String = MessageDigest.getInstance("SHA-256")
        .digest(key.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private fun prefix(kind: String) = "accepted:$kind:"
    private fun pending(kind: String, key: String) = "pending:$kind:${digest(key)}"
    private fun accepted(kind: String, key: String) = "${prefix(kind)}${digest(key)}"

    fun dispatch(kind: String, key: String, send: (clientId: String) -> Unit): Boolean {
        val ack = accepted(kind, key)
        if (store.get(ack) == "1") return true
        val pending = pending(kind, key)
        val id = store.get(pending) ?: UUID.randomUUID().toString().also {
            if (!store.commit(mapOf(pending to it))) return false
        }
        try { send(id) } catch (_: Exception) { return false }
        return store.commit(mapOf(ack to "1"), setOf(pending))
    }

    /** Call only in the same durable transaction as advancing the corresponding snapshot. */
    fun completedKeys(kind: String): Set<String> = store.keys().filterTo(mutableSetOf()) {
        it.startsWith(prefix(kind)) || it.startsWith("pending:$kind:")
    }

    fun complete(kind: String, key: String): Boolean = store.commit(removes = setOf(accepted(kind, key), pending(kind, key)))
}
