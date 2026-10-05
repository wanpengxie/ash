package ai.ash.host

/** Pure route construction; notification text and PendingIntent extras never choose the recipient. */
data class PresentRoute(val to: String, val kind: String, val word: String, val replyTo: String? = null,
    val choice: String? = null, val text: String? = null)

object PresentRoutes {
    val member = Regex("^(person|screen|agent|device|service|worker):[A-Za-z0-9_.-]+$")

    fun notificationOptionsValid(ids: List<String>): Boolean = ids.isNotEmpty() && "deny" in ids &&
        ids.size == ids.toSet().size && ids.all { it in setOf("once", "always", "deny") }

    fun approval(replyTo: String, replyTarget: String, offered: Set<String>, choice: String,
        expiresAt: Long, now: Long): PresentRoute {
        require(replyTo.isNotBlank() && member.matches(replyTarget)) { "approval route missing" }
        require(choice in setOf("once", "always", "deny") && choice in offered) { "choice was not offered" }
        require(expiresAt > now) { "approval expired" }
        return PresentRoute(replyTarget, "response", "ask", replyTo = replyTo, choice = choice)
    }

    fun question(replyTo: String, replyTarget: String, offered: Set<String>, choice: String?, text: String?,
        allowCustom: Boolean, expiresAt: Long, now: Long): PresentRoute {
        require(replyTo.isNotBlank() && member.matches(replyTarget) && expiresAt > now) { "question route expired or missing" }
        if (choice == "custom") {
            require(allowCustom && !text.isNullOrBlank() && text.length <= 4000) { "custom answer not allowed" }
            return PresentRoute(replyTarget, "response", "ask", replyTo = replyTo, choice = "custom", text = text.trim())
        }
        require(choice != null && choice in offered) { "choice was not offered" }
        return PresentRoute(replyTarget, "response", "ask", replyTo = replyTo, choice = choice)
    }

    fun reply(text: String): PresentRoute {
        val trimmed = text.trim()
        require(trimmed.isNotEmpty()) { "reply is empty" }
        return PresentRoute("agent:main", "request", "say", text = trimmed)
    }
}
