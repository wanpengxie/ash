package ai.ash.senses

import org.json.JSONObject

/**
 * Which location providers to ask and when a fix is good enough. Pure, so it is tested on its own; [LocationReader]
 * does the asking.
 *
 * The fused provider alone is not enough: on some phones it never answers (seen with GPS switched off by the system
 * while location is on and only the network provider allowed). An on-demand request asks every usable provider at
 * once and takes the first acceptable fix; background recording asks one provider (battery) and only falls back to
 * all of them after it failed repeatedly.
 */
object LocationPolicy {
    const val FUSED = "fused"
    const val GPS = "gps"
    const val NETWORK = "network"
    const val PASSIVE = "passive"

    /** What the phone has: providers present, providers enabled, and whether precise location is granted (GPS needs it). */
    data class Providers(val present: Set<String>, val enabled: Set<String>, val precise: Boolean) {
        fun toJson(): JSONObject = JSONObject().apply {
            for (p in listOf(FUSED, GPS, NETWORK)) put(p, JSONObject().put("present", p in present).put("enabled", p in enabled)
                .apply { reason(this@Providers, p)?.let { put("unusable", it) } })
        }
    }

    enum class Mode(val id: String) { ON_DEMAND("on_demand"), BACKGROUND("background"), BACKGROUND_FALLBACK("background_fallback") }

    /** The providers to ask, and why each other candidate was not asked. */
    data class Plan(val ask: List<String>, val skipped: Map<String, String>)

    // Why a provider gave nothing (codes; [explain] says them in words).
    const val NOT_PRESENT = "not_present"
    const val DISABLED = "disabled"
    const val NOT_ALLOWED = "not_allowed"
    const val TIMEOUT = "timeout"
    const val REFUSED = "refused"
    const val DISABLED_WHILE_WAITING = "disabled_while_waiting"

    /** Why [p] cannot be asked now, or null when it can. */
    fun reason(p: Providers, provider: String): String? = when {
        provider !in p.present -> NOT_PRESENT
        provider == GPS && !p.precise -> NOT_ALLOWED
        provider !in p.enabled -> DISABLED
        else -> null
    }

    /** The order providers are tried in for one accuracy (the first usable one is background recording's choice). */
    fun order(accuracy: String): List<String> = when (accuracy) {
        "high" -> listOf(GPS, FUSED, NETWORK)
        "low" -> listOf(NETWORK, FUSED, GPS)
        else -> listOf(FUSED, NETWORK, GPS)
    }

    fun plan(p: Providers, accuracy: String, mode: Mode): Plan {
        val usable = order(accuracy).filter { reason(p, it) == null }
        val ask = when (mode) {
            Mode.BACKGROUND -> usable.take(1)
            // Every provider at once: the first acceptable fix wins. Low accuracy leaves GPS out unless nothing else is there.
            Mode.ON_DEMAND -> if (accuracy == "low") usable.filter { it != GPS }.ifEmpty { usable } else usable
            // After the usual provider kept failing: the cheap ones together, GPS only when high accuracy is asked or nothing else is there.
            Mode.BACKGROUND_FALLBACK -> if (accuracy == "high") usable else usable.filter { it != GPS }.ifEmpty { usable }
        }
        val skipped = linkedMapOf<String, String>()
        for (c in listOf(FUSED, GPS, NETWORK)) if (c !in ask) reason(p, c)?.let { skipped[c] = it }
        return Plan(ask, skipped)
    }

    /** The accuracy (metres) that ends the wait at once. */
    fun target(accuracy: String): Double = when (accuracy) { "high" -> 25.0; "low" -> Double.MAX_VALUE; else -> 100.0 }

    /**
     * After the first fix that misses the target, how long to keep listening for a better one: high waits the whole
     * timeout for GPS, but only while GPS is among the providers asked (without it nothing gets much better).
     */
    fun graceMs(accuracy: String, asked: Collection<String>): Long = when {
        accuracy == "low" -> 0L
        accuracy == "high" && GPS in asked -> Long.MAX_VALUE
        else -> 10_000L
    }

    /** A fix is "now" only if it is at most this old. */
    const val FRESH_MS = 2 * 60_000L

    /** One fix with how old it is (from the phone's elapsed clock, not the fix's own time). */
    data class Candidate(val fix: Fix, val ageMs: Long)

    /** The more accurate of two (the newer on a tie). */
    fun better(a: Candidate?, b: Candidate): Candidate =
        if (a == null || b.fix.accuracyM < a.fix.accuracyM || (b.fix.accuracyM == a.fix.accuracyM && b.ageMs < a.ageMs)) b else a

    /** The best of the providers' last known fixes that is still fresh; null when none is. */
    fun lastKnown(candidates: List<Candidate>, maxAgeMs: Long = FRESH_MS): Candidate? =
        candidates.filter { it.ageMs in 0..maxAgeMs }.fold(null as Candidate?) { best, c -> better(best, c) }

    /** Stop waiting: the best fix meets the target, the grace after the first fix is over, or no provider is left to answer. */
    fun done(best: Candidate?, firstAt: Long?, now: Long, accuracy: String, asked: Collection<String>, listening: Int): Boolean {
        if (listening == 0) return true
        if (best == null) return false
        if (best.fix.accuracyM <= target(accuracy)) return true
        val grace = graceMs(accuracy, asked)
        return grace != Long.MAX_VALUE && firstAt != null && now - firstAt >= grace
    }

    fun explain(provider: String, code: String, timeoutS: Long): String = when (code) {
        NOT_PRESENT -> "$provider: this phone has no such provider"
        DISABLED -> if (provider == GPS) "gps: switched off by the system (location is on, but only network location is allowed)" else "$provider: switched off by the system"
        NOT_ALLOWED -> "gps: needs precise location, which Ash 感知 is not granted"
        TIMEOUT -> "$provider: no fix within ${timeoutS}s"
        REFUSED -> "$provider: the system refused the request"
        DISABLED_WHILE_WAITING -> "$provider: switched off while waiting"
        else -> "$provider: $code"
    }

    /** For the owner's setup page: what holds the phone's location back, in plain Chinese; null when nothing does. */
    fun ownerNote(p: Providers): String? {
        val usable = listOf(FUSED, GPS, NETWORK).filter { reason(p, it) == null }
        return when {
            usable.isEmpty() -> "系统没有打开任何定位方式，取不到位置"
            GPS in p.present && p.precise && GPS !in p.enabled -> "GPS 被系统关闭了，只能用网络定位（误差几十米）。可在系统定位设置里打开 GPS / 高精度定位"
            else -> null
        }
    }

    /** Every provider's reason, in words: what no_fix and sense.status say. */
    fun explainAll(reasons: Map<String, String>, timeoutS: Long): String = reasons.entries.joinToString("; ") { explain(it.key, it.value, timeoutS) }

    // ---- background recording: one provider, and the fallback after repeated failures ----

    /** Background attempts that failed in a row before recording asks every provider. */
    const val FALLBACK_AFTER = 2
    /** How long the fallback lasts before the usual provider is given another chance. */
    const val FALLBACK_MS = 12 * 3_600_000L

    data class Background(val failures: Int = 0, val fallbackSince: Long = 0L) {
        fun mode(now: Long): Mode = if (failures >= FALLBACK_AFTER && now - fallbackSince < FALLBACK_MS) Mode.BACKGROUND_FALLBACK else Mode.BACKGROUND
        fun toJson(now: Long): JSONObject = JSONObject().put("mode", mode(now).id).put("failures_in_a_row", failures)
            .apply { if (mode(now) == Mode.BACKGROUND_FALLBACK) put("fallback_since", fallbackSince) }
    }

    /** After one background attempt in [mode]: a fix by the usual provider resets the count; its failure adds one. The fallback runs its course. */
    fun after(state: Background, mode: Mode, ok: Boolean, now: Long): Background = when {
        mode == Mode.BACKGROUND && ok -> Background()
        // A failure after an expired fallback goes straight back to it: the usual provider had its second chance.
        mode == Mode.BACKGROUND -> (state.failures + 1).coerceAtMost(FALLBACK_AFTER).let { Background(it, if (it >= FALLBACK_AFTER) now else 0L) }
        else -> state
    }
}

/** One attempt to get a fix, kept for sense.status: what was asked, what answered, and why the others did not. */
data class FixAttempt(
    val ts: Long,
    val mode: String,
    val accuracy: String,
    val asked: List<String>,
    val reasons: Map<String, String>,
    val waitedMs: Long,
    val fix: Fix? = null,
    val ageMs: Long? = null,
    val fromLastKnown: Boolean = false,
    val error: String? = null,
) {
    val accuracyMet: Boolean get() = fix != null && fix.accuracyM <= LocationPolicy.target(accuracy)

    fun toJson(): JSONObject = JSONObject().put("ts", ts).put("mode", mode).put("accuracy", accuracy).put("ok", fix != null)
        .put("providers_asked", org.json.JSONArray(asked)).put("waited_ms", waitedMs)
        .apply {
            if (reasons.isNotEmpty()) put("provider_reasons", JSONObject(reasons as Map<*, *>))
            if (fix != null) put("provider", fix.provider).put("accuracy_m", fix.accuracyM).put("fix_age_s", (ageMs ?: 0) / 1000)
                .put("source", if (fromLastKnown) "last_known" else "live").put("accuracy_met", accuracyMet)
            if (error != null) put("error", error)
        }
}
