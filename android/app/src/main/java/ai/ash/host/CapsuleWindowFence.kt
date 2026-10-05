package ai.ash.host

internal data class ScreenWindowFact(val id: Int, val title: String, val focused: Boolean, val active: Boolean, val bounds: String)

/** Presentation windows are not owner focus changes. Removed-window events keep their old ID. */
internal class CapsuleWindowFence {
    private val own = linkedSetOf<Int>()
    private var previous: Set<ScreenWindowFact>? = null
    fun presentationOnly(id: Int, windows: List<ScreenWindowFact>, topology: Boolean, content: Boolean = false): Boolean {
        windows.filter { it.title == "AshTaskCapsule" }.forEach { own.add(it.id) }
        while (own.size > 64) own.remove(own.first())
        val ordinary = windows.filterNot { it.id in own }.toSet()
        val unchanged = previous != null && ordinary == previous
        previous = ordinary
        val source = windows.find { it.id == id }
        // A progress notification may update inactive status-bar chrome, not the owner's app.
        val passiveContent = content && source != null && !source.active && !source.focused
        return id in own || topology && unchanged || passiveContent
    }
}
