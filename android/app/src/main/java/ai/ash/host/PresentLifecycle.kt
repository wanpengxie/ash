package ai.ash.host

enum class PresentAdmission { NEW, DUPLICATE, CONFLICT, RETIRED }

/** Presentation ids stay retired after an explicit hide or owner dismissal. */
object PresentLifecycle {
    fun admission(prior: String?, incoming: String, retired: Boolean): PresentAdmission = when {
        retired -> PresentAdmission.RETIRED
        prior == null -> PresentAdmission.NEW
        prior == incoming -> PresentAdmission.DUPLICATE
        else -> PresentAdmission.CONFLICT
    }

    fun restore(retired: Boolean, consumed: Boolean): Boolean = !retired && !consumed
}
