package ai.ash.screen.switches

import ai.ash.bridge.KeepAliveSwitches
import ai.ash.screen.a11y.A11yService
import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo

/** The phone for [SwitchFlow], through the accessibility service: nodes and their own actions, no coordinates. */
class AccessibilityUi(private val ctx: Context, private val service: A11yService) : SwitchUi {
    private class Node(val info: AccessibilityNodeInfo) : UiNode {
        override val text get() = info.text?.toString()?.trim().orEmpty()
        override val description get() = info.contentDescription?.toString()?.trim().orEmpty()
        override val packageName get() = info.packageName?.toString().orEmpty()
        override val checkable get() = info.isCheckable
        override val checked get() = info.isChecked
        override val clickable get() = info.isClickable
        override val enabled get() = info.isEnabled
        override val scrollable get() = info.isScrollable
        override fun parent(): UiNode? = runCatching { info.parent }.getOrNull()?.let { Node(it) }
        override fun children(): List<UiNode> = (0 until info.childCount).mapNotNull { runCatching { info.getChild(it) }.getOrNull()?.let { c -> Node(c) } }
        override fun findByText(text: String): List<UiNode> = runCatching { info.findAccessibilityNodeInfosByText(text) }.getOrNull().orEmpty().map { Node(it) }
        override fun click() = info.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        override fun scroll(forward: Boolean) = info.performAction(if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
        override fun equals(other: Any?) = other is Node && other.info == info
        override fun hashCode() = info.hashCode()
    }

    override fun root(): UiNode? = runCatching { service.root() }.getOrNull()?.let { Node(it) }
    override fun settle() = service.awaitIdle(250, 1000)

    override fun openSettings() = start(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    override fun openAppDetails(pkg: String): Boolean {
        // Only Ash's own apps ever have their page opened.
        if (KeepAliveSwitches.target(pkg) == null) return false
        return start(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    override fun back() = service.global(AccessibilityService.GLOBAL_ACTION_BACK)

    override fun returnToAsh() {
        // Ash's task as the owner left it (the page the flow was started from on top). Its launcher entry is the
        // fallback only: that brings Ash's home page and closes the pages above it.
        val back = Intent().setClassName(KeepAliveSwitches.ASH_PACKAGE, KeepAliveSwitches.RETURN_ACTIVITY).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val launch = ctx.packageManager.getLaunchIntentForPackage(KeepAliveSwitches.ASH_PACKAGE)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (!start(back) && (launch == null || !start(launch))) service.global(AccessibilityService.GLOBAL_ACTION_HOME)
        // Ash is in front when the report reaches it.
        sleep(700)
    }

    private fun start(intent: Intent): Boolean = try { ctx.startActivity(intent); true } catch (_: Exception) { false }
    override fun now() = SystemClock.uptimeMillis()
    override fun sleep(ms: Long) = SystemClock.sleep(ms)
}
