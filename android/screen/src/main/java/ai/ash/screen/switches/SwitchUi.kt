package ai.ash.screen.switches

/** One element of the screen, as the flow sees it (the accessibility node, or a fake one in tests). */
interface UiNode {
    val text: String
    val description: String
    val packageName: String
    val checkable: Boolean
    val checked: Boolean
    val clickable: Boolean
    val enabled: Boolean
    val scrollable: Boolean
    fun parent(): UiNode?
    fun children(): List<UiNode>
    /** Like the system's finder: elements under this one whose text contains [text] (case-insensitive). */
    fun findByText(text: String): List<UiNode>
    fun click(): Boolean
    fun scroll(forward: Boolean): Boolean
}

/** What the flow needs of the phone: the screen, and a few ways to move around Settings. */
interface SwitchUi {
    /** The window in front, fresh each call (null while the screen changes). */
    fun root(): UiNode?
    /** Waits for the screen to stop changing. */
    fun settle()
    fun openSettings(): Boolean
    fun openAppDetails(pkg: String): Boolean
    fun back(): Boolean
    /** Brings Ash back to the front as the owner left it, the page the flow was started from on top (the home screen when it cannot). */
    fun returnToAsh()
    fun now(): Long
    fun sleep(ms: Long)
}

/** What the owner reads: the text, else the content description. */
val UiNode.label: String get() = text.ifEmpty { description }
