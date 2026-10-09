package ai.ash.host

/**
 * Reinstalling or upgrading Ash can let the phone's own settings put its auto-start back off (ColorOS does), and
 * Android tells no app. So the first start after an install changes (version code or update time) looks again, once:
 * what Ash can read is read again, and the maker's switches, which only the owner's word vouched for, no longer count
 * as on until they are seen on again.
 */
object KeepAliveRecheck {
    data class Install(val versionCode: Long, val updatedAt: Long)

    enum class Offer {
        NONE,
        /** Ash's battery exemption is off: the system's own one-tap question comes first (the switches need it). */
        BATTERY,
        /** The maker's switches may be off: the one-tap fix, which reads each one and turns on only what is off. */
        SWITCHES,
    }

    data class Plan(val forgetWords: Boolean, val offer: Offer)

    /** The entries whose only proof is the owner's word: the maker's auto-start switches for Ash and its helpers. */
    val WORD_KEYS = listOf("autostart", "screen_keepalive", "senses_keepalive")

    /**
     * [previous]: the install seen last time (null on the very first start, which the first-launch guide covers).
     * [batteryExempt]: what Android says of Ash's battery exemption. [makerSwitches]: the phone keeps switches of its
     * own. [oneTap]: the screen helper can run the one-tap fix now.
     */
    fun plan(previous: Install?, now: Install, batteryExempt: Boolean, makerSwitches: Boolean, oneTap: Boolean): Plan {
        if (previous == null || previous == now) return Plan(false, Offer.NONE)
        val offer = when {
            !batteryExempt -> Offer.BATTERY
            makerSwitches && oneTap -> Offer.SWITCHES
            else -> Offer.NONE
        }
        return Plan(forgetWords = makerSwitches, offer = offer)
    }
}
